/* Preço oficial dos títulos do Tesouro Direto (Tesouro Transparente).
   Módulo puro: parse do CSV público e reprecificação de um ativo no formato da
   Pluggy. Não conhece SQLite nem rede.

   Por que existe: o preço dos Tesouros que chega pela Pluggy (MeuPluggy → Open
   Finance do Itaú) congelou. Em out/2026 o PU do Prefixado 2032 ficou em ~499
   enquanto o oficial passava de 530 — o `date` do ativo vinha atualizado todo dia,
   só o `value` era velho, e a carteira ficou R$ 8,5 mil abaixo do app do Itaú.
   CDB/LCA andam na curva (conta fixa) e não sofrem disso; título marcado a mercado
   depende de alguém publicar o preço do dia, e é esse elo que falhou. */

import { irAliquot } from "./performance.js";

export const TESOURO_CSV_URL =
  "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv";

/* Preço oficial mais velho que isso (em relação à data do snapshot) não substitui
   o da Pluggy: o CSV sai com 1 dia útil de atraso, então feriado + fim de semana
   dá até 4 dias corridos; acima disso é a fonte oficial que está parada. */
export const MAX_DEFASAGEM_DIAS = 5;

const brToISO = (s) => {
  const [d, m, y] = String(s).trim().split("/");
  return `${y}-${m}-${d}`;
};
const num = (s) => Number(String(s).trim().replace(/\./g, "").replace(",", "."));

/* Linhas do CSV → [{ tipo, vencimento, date, pu, taxa }]. `pu` é o PU Base
   (= PU de venda, o valor de resgate antecipado que os bancos usam para marcar a
   posição); `taxa` é a taxa de venda. Linhas com data anterior a `desdeISO` ficam
   de fora — o arquivo tem o histórico desde 2002. */
export function parseTesouroCsv(text, desdeISO = "0000-00-00") {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(";").map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const iTipo = col("Tipo Titulo");
  const iVenc = col("Data Vencimento");
  const iData = col("Data Base");
  const iTaxa = col("Taxa Venda Manha");
  const iPu = col("PU Base Manha");
  if ([iTipo, iVenc, iData, iPu].some((i) => i < 0)) throw new Error("CSV do Tesouro: cabeçalho inesperado");

  const out = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(";");
    if (c.length <= iPu) continue;
    const date = brToISO(c[iData]);
    if (date < desdeISO) continue;
    const pu = num(c[iPu]);
    if (!(pu > 0)) continue;
    out.push({
      tipo: c[iTipo].trim(),
      vencimento: brToISO(c[iVenc]),
      date,
      pu,
      taxa: iTaxa >= 0 ? num(c[iTaxa]) : null,
    });
  }
  return out;
}

/* Chave do título no CSV a partir do ativo da Pluggy: tipo = nome sem o ano final
   ("Tesouro IPCA+ 2032" → "Tesouro IPCA+"), vencimento = dueDate. As datas da
   Pluggy vêm com hora colada (T03:00Z / T00:00Z): vale só a parte ISO. */
export function tituloKey(asset) {
  if (asset?.subtype !== "TREASURY" || !asset.name || !asset.dueDate) return null;
  const tipo = String(asset.name).replace(/\s+\d{4}\s*$/, "").trim();
  return { tipo, vencimento: String(asset.dueDate).slice(0, 10) };
}

const diasEntre = (aISO, bISO) =>
  Math.round((Date.parse(`${bISO}T12:00:00Z`) - Date.parse(`${aISO}T12:00:00Z`)) / 86400000);

/* Reprecifica um Tesouro com o PU oficial. Sempre parte dos números ORIGINAIS da
   Pluggy (guardados em `pluggy` na primeira passada), então é idempotente: rodar
   de novo sobre um snapshot já ajustado dá o mesmo resultado.

   - amount  = quantidade × PU oficial
   - taxes   = IR provisionado recalculado sobre o novo lucro, pela alíquota efetiva
               que a própria Pluggy usou (taxes ÷ lucro); sem lucro anterior para
               medir, pela tabela regressiva a partir de issueDate.
   - balance = amount − taxes − outras deduções. "Outras" (custódia etc.) são o que
               sobra de amount − balance − taxes na Pluggy e ficam como estão.

   `preco` = { date, pu }. Sem quantidade ou sem preço, devolve o ativo intacto. */
export function repricedAsset(asset, preco, refISO) {
  const orig = asset.pluggy || {
    amount: asset.amount,
    balance: asset.balance,
    taxes: asset.taxes,
    value: asset.value,
  };
  const base = { ...asset, ...orig };
  delete base.pluggy;
  delete base.priceSource;
  delete base.priceDate;
  const qty = Number(asset.quantity);
  if (!preco || !(qty > 0) || !(preco.pu > 0)) return base;

  const amount = round2(qty * preco.pu);
  const original = asset.amountOriginal || 0;
  const lucroPluggy = (orig.amount || 0) - original;
  const ir = orig.taxes || 0;
  const aliq =
    lucroPluggy > 0 && ir > 0
      ? ir / lucroPluggy
      : irAliquot(diasEntre(String(asset.issueDate || asset.purchaseDate || refISO).slice(0, 10), refISO));
  const taxes = round2(Math.max(amount - original, 0) * aliq);
  const outras = (orig.amount || 0) - (orig.balance || 0) - ir;
  const balance = round2(amount - taxes - outras);

  return {
    ...base,
    amount,
    balance,
    amountWithdrawal: asset.amountWithdrawal != null ? balance : asset.amountWithdrawal,
    taxes,
    value: preco.pu,
    pluggy: orig,
    priceSource: "tesouro",
    priceDate: preco.date,
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/* PU vigente numa data: o mais recente com date ≤ ref, desde que não esteja
   defasado além de MAX_DEFASAGEM_DIAS. `precos` = linhas do título ordenadas por data. */
export function precoVigente(precos, refISO) {
  let best = null;
  for (const p of precos) {
    if (p.date > refISO) break;
    best = p;
  }
  if (!best || diasEntre(best.date, refISO) > MAX_DEFASAGEM_DIAS) return null;
  return best;
}

/* Aplica o preço oficial em todos os Tesouros ACTIVE de um payload.
   `lookup(tipo, vencimento)` devolve as linhas do título ordenadas por data. */
export function repriceTreasuries(payload, refISO, lookup) {
  return payload.map((a) => {
    if (a.status !== "ACTIVE") return a;
    const key = tituloKey(a);
    if (!key) return a;
    return repricedAsset(a, precoVigente(lookup(key.tipo, key.vencimento), refISO), refISO);
  });
}
