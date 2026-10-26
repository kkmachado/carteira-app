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

   `preco` = { date, pu, estimado?, base?, taxaDate? } (ver precoVigente). Sem
   quantidade ou sem preço, devolve o ativo intacto. */
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
  delete base.priceBase;
  delete base.priceRateDate;
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
    priceSource: preco.estimado ? "estimado" : "tesouro",
    priceDate: preco.date,
    ...(preco.estimado ? { priceBase: preco.base, priceRateDate: preco.taxaDate || null } : {}),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/* ---------- ANBIMA: taxa indicativa diária ----------
   O CSV do Tesouro Transparente é a referência (é o PU que o Itaú usa), mas pode
   parar: em out/2026 o site passou a responder 429 ("volume atípico de requisições
   a partir da sua rede") e o app ficou sem preço oficial. Voltar ao valor da
   Pluggy não serve — ela segue congelada —, então o preço passa a ser ESTIMADO a
   partir do último PU oficial, movido pela variação da taxa indicativa da ANBIMA
   (arquivo diário msAAMMDD.txt, ~7 KB, só os últimos ~7 dias úteis ficam no ar). */

export const anbimaUrl = (iso) =>
  `https://www.anbima.com.br/informacoes/merc-sec/arqs/ms${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}.txt`;

/* Título do Tesouro Direto → papel da ANBIMA com o mesmo vencimento. A ANBIMA não
   lista NTN-B Principal (Tesouro IPCA+ sem cupom): a NTN-B com cupom do mesmo
   vencimento serve de proxy da VARIAÇÃO da taxa real — o nível vem do PU oficial. */
export const ANBIMA_TITULO = {
  "Tesouro Prefixado": "LTN",
  "Tesouro Prefixado com Juros Semestrais": "NTN-F",
  "Tesouro IPCA+": "NTN-B",
  "Tesouro IPCA+ com Juros Semestrais": "NTN-B",
};
const INDEXADO_IPCA = new Set(["Tesouro IPCA+", "Tesouro IPCA+ com Juros Semestrais"]);

/* Linhas "Titulo@Data Referencia@Codigo SELIC@Data Base/Emissao@Data Vencimento@
   Tx. Compra@Tx. Venda@Tx. Indicativas@PU@…" → [{ titulo, vencimento, date, taxa, pu }].
   O arquivo vem em latin1 com duas linhas de cabeçalho; só as de papel interessam. */
export function parseAnbimaMs(text) {
  const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split("@");
    if (c.length < 9 || !/^\d{8}$/.test(c[1]) || !/^\d{8}$/.test(c[4])) continue;
    const taxa = num(c[7]);
    if (!Number.isFinite(taxa)) continue;
    out.push({ titulo: c[0].trim(), vencimento: ymd(c[4]), date: ymd(c[1]), taxa, pu: num(c[8]) });
  }
  return out;
}

/* Depois disso sem nenhum PU oficial novo a estimativa vira chute: devolve null e
   fica o valor da Pluggy. */
export const MAX_ESTIMATIVA_DIAS = 45;

const anos = (deISO, ateISO) => diasEntre(deISO, ateISO) / 365.25;

/* PU de um título numa data.
   - Há PU oficial NA data → ele.
   - Senão, parte do último oficial (âncora: data d0, PU0, taxa de venda r0) e
     estima: r1 = r0 + Δ(taxa ANBIMA entre d0 e a última data ≤ ref), e
       PU = PU0 × (1+r0)^n0 ÷ (1+r1)^n1 × inflação
     com n = anos até o vencimento. Com Δ = 0 é só o carrego do papel à taxa da
     compra; o Δ traz a marcação a mercado. Inflação = IPCA mensal mais recente
     composto no período (só IPCA+: o VNA anda com o IPCA). O prazo em anos
     corridos no lugar de du/252 erra pouco porque entra igual nos dois lados.
   - Taxa ANBIMA de d0: a do próprio dia; faltando (o arquivo da ANBIMA só fica no
     ar por uma semana, a primeira âncora pode não ter par), interpolada entre os
     vizinhos de até 4 dias. Pegar só um vizinho errava o sinal: em 15/10/2026 a
     taxa foi de 12,78% (14) a 13,02% (16), e ancorar no dia 14 transformava a
     queda seguinte em alta.

   `precos` = PUs oficiais do título ordenados por data; `opts` = { tipo,
   vencimento, anbima (linhas do papel correspondente, ordenadas), ipcaMensal (%) }. */
export function precoVigente(precos, refISO, opts = {}) {
  let ancora = null;
  for (const p of precos) {
    if (p.date > refISO) break;
    ancora = p;
  }
  if (!ancora) return null;
  if (ancora.date === refISO) return ancora;
  if (diasEntre(ancora.date, refISO) > MAX_ESTIMATIVA_DIAS || !opts.vencimento) return null;

  const r0 = (ancora.taxa ?? NaN) / 100;
  if (!Number.isFinite(r0)) return null;

  const anbima = opts.anbima || [];
  const taxa0 = taxaAnbimaEm(anbima, ancora.date);
  let a1 = null;
  for (const a of anbima) {
    if (a.date > refISO) break;
    if (a.date > ancora.date) a1 = a;
  }
  const delta = taxa0 != null && a1 ? (a1.taxa - taxa0) / 100 : 0;
  const r1 = r0 + delta;

  const n0 = anos(ancora.date, opts.vencimento);
  const n1 = anos(refISO, opts.vencimento);
  const infl = INDEXADO_IPCA.has(opts.tipo) && Number.isFinite(opts.ipcaMensal)
    ? Math.pow(1 + opts.ipcaMensal / 100, diasEntre(ancora.date, refISO) / 30.4375)
    : 1;
  const pu = (ancora.pu * Math.pow(1 + r0, n0)) / Math.pow(1 + r1, n1) * infl;

  return {
    date: refISO,
    pu: Math.round(pu * 1e6) / 1e6,
    estimado: true,
    base: ancora.date,
    taxaDate: delta !== 0 ? a1.date : null,
  };
}

/* Taxa ANBIMA numa data: exata, ou interpolada linearmente entre o último dia
   antes e o primeiro depois (até 4 dias de cada lado); só um lado ⇒ ele. */
function taxaAnbimaEm(anbima, iso) {
  let antes = null;
  let depois = null;
  for (const a of anbima) {
    if (a.date === iso) return a.taxa;
    if (a.date < iso && diasEntre(a.date, iso) <= 4) antes = a;
    if (a.date > iso && !depois && diasEntre(iso, a.date) <= 4) depois = a;
  }
  if (antes && depois) {
    const w = diasEntre(antes.date, iso) / diasEntre(antes.date, depois.date);
    return antes.taxa + (depois.taxa - antes.taxa) * w;
  }
  return (antes || depois)?.taxa ?? null;
}

/* Aplica o preço oficial (ou estimado) em todos os Tesouros ACTIVE de um payload.
   `lookup(tipo, vencimento)` devolve os PUs oficiais do título ordenados por data;
   `anbimaLookup(titulo, vencimento)` as taxas ANBIMA do papel correspondente. */
export function repriceTreasuries(payload, refISO, lookup, { anbimaLookup, ipcaMensal } = {}) {
  return payload.map((a) => {
    if (a.status !== "ACTIVE") return a;
    const key = tituloKey(a);
    if (!key) return a;
    const titulo = ANBIMA_TITULO[key.tipo];
    const preco = precoVigente(lookup(key.tipo, key.vencimento), refISO, {
      tipo: key.tipo,
      vencimento: key.vencimento,
      anbima: titulo && anbimaLookup ? anbimaLookup(titulo, key.vencimento) : [],
      ipcaMensal,
    });
    return repricedAsset(a, preco, refISO);
  });
}
