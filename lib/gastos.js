/* Análise de gastos (conta corrente, poupança e cartão) a partir das transações
   da Pluggy. Funções puras: o server.js lê o SQLite, monta os objetos `tx` e
   entrega aqui; o frontend só apresenta o que sai de `buildGastos`.

   Formato de `tx` (normalizado de /v2/transactions):
     { id, accountId, accountType: 'BANK'|'CREDIT', date: ISO, amount, status,
       categoryId, description, billId, billForecast: 'YYYY-MM', cardNumber,
       currency, amountBrl, instN, instTotal }
   Sinais como vêm da Pluggy: no cartão compra é positiva e pagamento/estorno
   negativo; na conta débito é negativo e crédito positivo. */

const OUTROS = "Outros";
export const FATURA_EXTERNA = "Faturas de outros cartões";

/* Pagamento de fatura na conta corrente não tem categoria confiável: nos dados
   reais o débito da mesma fatura veio como "Credit card payment", como
   "Investments" e sem categoria. O que não falha é o valor: o débito tem
   exatamente o total de uma fatura que vence por perto. */
const BILL_MATCH_DAYS = 10;

/* Movimentação de investimento que a Pluggy categoriza como consumo: a compra de
   Tesouro Direto pela corretora ("Saída COR ITAUCOR COMPRA TD") vem como
   "Shopping", e resgate de fundo como transferência. */
const INVEST_DESC = /ITAUCOR|COMPRA TD|^aplica[çc][ãa]o\b|^resgate\b|\bVGBL\b|\bPGBL\b/i;

/* Transferência entre as próprias contas que a Pluggy não marca como tal
   ("TRANSF SALDO BASE DIA 1" sai da corrente e entra na poupança, categoria
   Transferências): débito e crédito de mesmo valor, em contas diferentes, com até
   3 dias de distância. */
export function mirroredIds(txs) {
  const bank = txs.filter((t) => t.accountType !== "CREDIT");
  const credits = bank.filter((t) => t.amount > 0);
  const out = new Set();
  for (const d of bank.filter((t) => t.amount < 0)) {
    const c = credits.find((c) => !out.has(c.id) && c.accountId !== d.accountId &&
      Math.abs(c.amount + d.amount) < 0.005 && daysBetween(c.date, d.date) <= 3);
    if (c) { out.add(c.id); out.add(d.id); }
  }
  return out;
}

const dayOf = (iso) => String(iso || "").slice(0, 10);
const monthOf = (iso) => String(iso || "").slice(0, 7);
const daysBetween = (a, b) => Math.abs(Date.parse(`${dayOf(a)}T12:00:00Z`) - Date.parse(`${dayOf(b)}T12:00:00Z`)) / 86400000;
export const addMonth = (ym, k = 1) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return d.toISOString().slice(0, 7);
};
const round2 = (v) => Math.round(v * 100) / 100;

/* Classifica um lançamento. Só `gasto`, `estorno` e `fatura_externa` entram no
   total de gastos; `receita` aparece à parte como entradas.
   - cartão: negativo é pagamento (categoria 05100000, ou família de
     transferências com "PAGAMENTO" — o débito automático vem como
     "Transfer - Internal") ou estorno (abate da categoria da compra);
   - conta: transferência entre contas próprias (04*) e investimento (03*,
     inclusive VGBL) não são gasto. Pagamento da fatura de um cartão analisado
     sairia em dobro (a compra já está no cartão) e é reconhecido pelo valor.
     Fatura de cartão que NÃO está na análise (BTG, Uniclass) conta como gasto:
     é o único rastro daquele consumo. */
export function classify(tx, bills = [], mirrored = new Set()) {
  const cat = tx.categoryId || "";
  if (tx.accountType === "CREDIT") {
    if (tx.amount >= 0) return "gasto";
    if (cat === "05100000" || (cat.startsWith("05") && /PAGAMENTO/i.test(tx.description))) return "pagamento";
    return "estorno";
  }
  if (cat.startsWith("04") || mirrored.has(tx.id)) return "transferencia_propria";
  if (tx.amount > 0) return cat.startsWith("03") || INVEST_DESC.test(tx.description) ? "investimento" : "receita";
  const valor = -tx.amount;
  if (bills.some((b) => Math.abs(b.totalAmount - valor) < 0.01 && daysBetween(b.dueDate, tx.date) <= BILL_MATCH_DAYS))
    return "pagamento_fatura";
  if (cat === "05100000" || /fatura/i.test(tx.description)) return "fatura_externa";
  if (cat.startsWith("03") || INVEST_DESC.test(tx.description)) return "investimento";
  return "gasto";
}

/* Categoria de nível 1 da Pluggy, em português (a hierarquia vem de /categories).
   Fatura de cartão fora da análise vira categoria própria: jogá-la em
   "Transferências" esconderia que ali tem consumo. */
export function topCategory(categoryId, cats, kind) {
  if (kind === "fatura_externa") return FATURA_EXTERNA;
  let c = cats.get(categoryId);
  if (!c) return OUTROS;
  for (let i = 0; c.parentId && cats.has(c.parentId) && i < 5; i++) c = cats.get(c.parentId);
  return c.name || OUTROS;
}

/* Nome do estabelecimento para agrupar. A descrição do cartão vem em dois
   formatos: largura fixa ("PETZ DIGITAL           EMBU          BRA" — nome em
   23 colunas, cidade em 14, país em 3) e o mesmo texto sem os espaços
   ("PETZ DIGITALEMBUBRA"). No colado não dá para saber onde o nome acaba: as
   cidades vistas no formato fixo (`cities`) servem de dicionário. Fora isso: sufixo
   de parcela ("12/12"), código de loja na frente ("8400  GRSA…"), subadquirente
   ("LITE *Vivo" → "VIVO"), marketplace (vendedor varia, a loja é a mesma) e, na
   conta, o tipo da operação ("Compra débito …", "Pix enviado …"). */
const MARKETPLACES = /^(MERCADOLIVRE|MERCADOPAGO|SHOPEE|PAYPAL|ALIEXPRESS|SHEIN)\*/i;

export function cityOf(desc) {
  const s = String(desc || "");
  if (s.length !== 40 || !/^[A-Z]{3}$/.test(s.slice(37))) return null;
  return s.slice(23, 37).trim().toUpperCase() || null;
}

export function normalizeMerchant(desc, cities = []) {
  const raw = String(desc || "").trim();
  let s = raw;
  if (raw.length === 40 && /\s[A-Z]{3}$/.test(raw) && /\s{2,}/.test(raw)) s = raw.slice(0, 23);
  else if (/[a-z]?[A-Z]{3}$/.test(raw) && !/\s{2,}/.test(raw)) {
    // formato colado: tira país e, se reconhecer, a cidade
    const up = raw.toUpperCase();
    if (/(BRA|USA)$/.test(up)) {
      const semPais = raw.slice(0, -3);
      const c = [...cities, "SAO PAULO"].sort((a, b) => b.length - a.length)
        .find((c) => c && semPais.toUpperCase().endsWith(c) && semPais.length > c.length + 2);
      s = c ? semPais.slice(0, -c.length) : semPais;
    }
  }
  s = s.replace(/^(compra (no )?d[eé]bito|d[eé]bito autom[aá]tico( da)?|pix enviado|pagamento de pix( qr code)?|pagamento de boleto|pagamento de|transfer[eê]ncia enviada|ted enviada)\s+/i, "");
  s = s.replace(/^\d{3,}\s+/, ""); // código de loja
  s = s.replace(/\s*\*\s*/g, "*");
  s = s.split(/\s{2,}/).find((p) => p.trim()) || s;
  const mkt = s.match(MARKETPLACES);
  if (mkt) s = mkt[1];
  const star = s.match(/^([^*]{1,4})\*(.+)$/); // "LITE*VivoEasy" → "VivoEasy"
  if (star) s = star[2];
  s = s.replace(/\s*\d{1,2}\/\d{1,2}$/, ""); // parcela
  s = s.replace(/\s+\d{4,}$/, ""); // nº de contrato/conta no débito automático
  return s.trim().toUpperCase() || raw.toUpperCase();
}

/* Valor do lançamento como gasto, em reais e positivo. Compra internacional usa
   o valor convertido (amountInAccountCurrency); estorno sai negativo. */
export function spendValue(tx, kind) {
  const brl = tx.currency && tx.currency !== "BRL" && tx.amountBrl != null ? tx.amountBrl : tx.amount;
  if (tx.accountType === "CREDIT") return kind === "estorno" ? -Math.abs(brl) : brl;
  return -brl;
}

const COUNTS = new Set(["gasto", "estorno", "fatura_externa"]);

/* Mês de competência de cada lançamento:
   - cartão: mês de VENCIMENTO da fatura (é a fatura que se lê e se paga). Com
     `billId`, o da fatura fechada. Sem, o `billForecastDate` — exceto quando a
     fatura daquele mês já fechou: a Pluggy prevê errado compras feitas depois do
     fechamento, que na verdade caem na fatura aberta;
   - conta: mês civil da data. */
export function periodKeyOf(tx, billById, openMonth) {
  if (tx.accountType !== "CREDIT") return monthOf(tx.date);
  if (tx.billId && billById.has(tx.billId)) return monthOf(billById.get(tx.billId).dueDate);
  const fc = tx.billForecast || monthOf(tx.date);
  return openMonth && fc < openMonth ? openMonth : fc;
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const labelMes = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;
const dBR = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Monta tudo que a tela de Gastos mostra.
 * @param {object} p
 * @param {object[]} p.txs       lançamentos normalizados (todas as contas analisadas)
 * @param {object[]} p.bills     faturas fechadas {id, accountId, dueDate, totalAmount}
 * @param {Map}      p.cats      categoryId → {name, parentId}
 * @param {'cartao'|'conta'|'tudo'} p.fonte
 * @param {number}   p.n         quantidade de períodos
 * @param {object}   p.holders   final do cartão → nome do titular
 * @param {string}   p.today     YYYY-MM-DD
 */
export function buildGastos({ txs, bills, cats, fonte = "cartao", n = 3, holders = {}, today }) {
  const billById = new Map(bills.map((b) => [b.id, b]));
  const cities = [...new Set(txs.map((t) => cityOf(t.description)).filter(Boolean))];
  const merchantOf = (d) => normalizeMerchant(d, cities);
  const cardTxs = txs.filter((t) => t.accountType === "CREDIT");
  const lastClosed = bills.map((b) => monthOf(b.dueDate)).sort().at(-1) || null;
  const pendMonths = cardTxs.filter((t) => !t.billId && t.billForecast).map((t) => t.billForecast).sort();
  const openMonth = cardTxs.length ? (lastClosed ? addMonth(lastClosed) : pendMonths[0] || null) : null;
  const curMonth = monthOf(today);
  const mirrored = mirroredIds(txs);

  // lançamentos enriquecidos, só os da fonte pedida
  const wantCard = fonte !== "conta";
  const wantBank = fonte !== "cartao";
  const all = [];
  for (const t of txs) {
    const isCard = t.accountType === "CREDIT";
    if ((isCard && !wantCard) || (!isCard && !wantBank)) continue;
    const kind = classify(t, bills, mirrored);
    /* Em "tudo" o período é o mês civil para as duas fontes: o cartão entra pelo
       mês da compra (parcela futura, pela data prevista dela). Pela fatura, a
       compra de setembro cairia junto do débito de outubro da conta. */
    const key = isCard && fonte === "tudo" ? monthOf(t.date) : periodKeyOf(t, billById, openMonth);
    all.push({ ...t, kind, key, cat: topCategory(t.categoryId, cats, kind), value: spendValue(t, kind) });
  }

  // parcelas já lançadas em faturas futuras: comprometido, fora dos períodos
  const limite = fonte === "tudo" ? curMonth : openMonth;
  const futuras = new Map();
  for (const t of all)
    if (t.accountType === "CREDIT" && limite && t.key > limite && COUNTS.has(t.kind)) {
      const f = futuras.get(t.key) || { key: t.key, label: labelMes(t.key), total: 0, count: 0 };
      f.total += t.value;
      f.count++;
      futuras.set(t.key, f);
    }

  // último período: o mais recente com dado (fatura aberta do cartão ou mês corrente)
  const ultimo = fonte === "cartao" && openMonth ? openMonth : curMonth;
  const keys = Array.from({ length: n }, (_, i) => addMonth(ultimo, i - n + 1));
  const inWin = new Set(keys);
  const win = all.filter((t) => inWin.has(t.key));
  const gastos = win.filter((t) => COUNTS.has(t.kind));

  const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  const closedBillByMonth = new Map(bills.map((b) => [monthOf(b.dueDate), b]));

  const periods = keys.map((key) => {
    const g = gastos.filter((t) => t.key === key);
    const total = g.reduce((s, t) => s + t.value, 0);
    const byCat = new Map();
    const byCard = new Map();
    for (const t of g) {
      bump(byCat, t.cat, t.value);
      if (t.cardNumber) bump(byCard, t.cardNumber, t.value);
    }
    const bill = fonte === "cartao" ? closedBillByMonth.get(key) : null;
    const compras = g.filter((t) => t.kind !== "estorno");
    const top = [...compras].sort((a, b) => b.value - a.value)[0];
    const aberta = fonte === "cartao" ? key === openMonth : key === curMonth;
    return {
      key,
      label: fonte === "cartao" && bill ? `venc. ${dBR(dayOf(bill.dueDate))}` : fonte === "cartao" ? `${labelMes(key)} · aberta` : labelMes(key),
      dueDate: bill ? dayOf(bill.dueDate) : null,
      aberta,
      total: round2(total),
      count: compras.length,
      ticket: compras.length ? round2(total / compras.length) : 0,
      // só faz sentido comparar com o total da fatura quando a fonte é só o cartão
      pluggyTotal: fonte === "cartao" && bill ? bill.totalAmount : null,
      diff: fonte === "cartao" && bill ? round2(bill.totalAmount - total) : null,
      entradas: round2(win.filter((t) => t.key === key && t.kind === "receita").reduce((s, t) => s + t.amount, 0)),
      internacional: round2(g.filter((t) => t.currency && t.currency !== "BRL").reduce((s, t) => s + t.value, 0)),
      byCategory: [...byCat].map(([name, value]) => ({ name, value: round2(value) })).sort((a, b) => b.value - a.value),
      byCard: [...byCard].map(([final, value]) => ({ final, value: round2(value) })).sort((a, b) => b.value - a.value),
      outlier: null,
      pico: false,
      _top: top,
    };
  });

  /* Lançamento que sozinho é mais de 25% do período (e não é trocado): é o que
     explica um pico. Período-pico: acima de 1,3× a mediana dos demais. */
  const comDado = periods.filter((p) => p.total > 0);
  for (const p of periods) {
    const t = p._top;
    if (t && p.total > 0 && t.value >= 1000 && t.value / p.total > 0.25)
      p.outlier = { description: t.description, merchant: merchantOf(t.description), value: round2(t.value),
        share: t.value / p.total, date: dayOf(t.date), cat: t.cat, semEle: round2(p.total - t.value) };
    const outros = comDado.filter((q) => q !== p && !q.aberta).map((q) => q.total).sort((a, b) => a - b);
    const med = outros.length ? outros[Math.floor(outros.length / 2)] : 0;
    p.pico = !p.aberta && outros.length >= 2 && p.total > med * 1.3;
    delete p._top;
  }

  const total = gastos.reduce((s, t) => s + t.value, 0);
  const comprasWin = gastos.filter((t) => t.kind !== "estorno");
  const outlierIds = new Set(periods.filter((p) => p.outlier).map((p) => `${p.outlier.date}|${p.outlier.value}`));

  // ranking de categorias com a concentração (maior lançamento dentro dela)
  const catMap = new Map();
  for (const t of gastos) {
    const c = catMap.get(t.cat) || { name: t.cat, value: 0, count: 0, top: null };
    c.value += t.value;
    if (t.kind !== "estorno") c.count++;
    if (!c.top || t.value > c.top.value) c.top = t;
    catMap.set(t.cat, c);
  }
  const categories = [...catMap.values()]
    .map((c) => ({
      name: c.name,
      value: round2(c.value),
      count: c.count,
      share: total > 0 ? c.value / total : 0,
      concentracao: c.top && c.value > 0 && c.count > 1 && c.top.value / c.value > 0.5
        ? { merchant: merchantOf(c.top.description), value: round2(c.top.value), share: c.top.value / c.value }
        : null,
    }))
    .sort((a, b) => b.value - a.value);

  // estabelecimentos
  const merch = new Map();
  for (const t of gastos) {
    if (t.kind === "fatura_externa") continue; // "fatura do BTG" não é estabelecimento
    const name = merchantOf(t.description);
    const m = merch.get(name) || { name, count: 0, total: 0, cat: t.cat, keys: new Set(), atipico: false };
    m.total += t.value;
    if (t.kind !== "estorno") m.count++;
    m.keys.add(t.key);
    if (outlierIds.has(`${dayOf(t.date)}|${round2(t.value)}`)) m.atipico = true;
    merch.set(name, m);
  }
  const merchants = [...merch.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((m) => ({ name: m.name, count: m.count, total: round2(m.total), cat: m.cat, atipico: m.atipico }));

  /* Recorrente = aparece em todos os períodos fechados da janela (no mínimo 2).
     A fatura aberta fica de fora: ainda não recebeu tudo do mês. */
  const fechados = periods.filter((p) => !p.aberta).map((p) => p.key);
  const recurring = fechados.length >= 2
    ? [...merch.values()]
        .filter((m) => fechados.every((k) => m.keys.has(k)))
        .sort((a, b) => b.total - a.total)
        .map((m) => ({ name: m.name, count: m.count, total: round2(m.total), cat: m.cat,
          media: round2(m.total / m.keys.size) }))
    : [];

  // quem gastou: titular (CARD_HOLDERS) → cartões
  const byHolder = new Map();
  for (const t of gastos) {
    if (!t.cardNumber) continue;
    const name = holders[t.cardNumber] || `Cartão final ${t.cardNumber}`;
    const h = byHolder.get(name) || { name, total: 0, cards: new Map() };
    h.total += t.value;
    bump(h.cards, t.cardNumber, t.value);
    byHolder.set(name, h);
  }
  const cardTotal = [...byHolder.values()].reduce((s, h) => s + h.total, 0);
  const holdersOut = [...byHolder.values()]
    .sort((a, b) => b.total - a.total)
    .map((h) => ({ name: h.name, total: round2(h.total), share: cardTotal > 0 ? h.total / cardTotal : 0,
      cards: [...h.cards].map(([final, v]) => ({ final, total: round2(v) })).sort((a, b) => b.total - a.total) }));

  const intl = gastos.filter((t) => t.currency && t.currency !== "BRL");
  const maior = [...periods].sort((a, b) => b.total - a.total)[0];

  return {
    fonte,
    n,
    openMonth,
    periods,
    totals: {
      total: round2(total),
      count: comprasWin.length,
      ticket: comprasWin.length ? round2(total / comprasWin.length) : 0,
      maior: maior && maior.total > 0 ? { key: maior.key, label: maior.label, total: maior.total } : null,
      internacional: round2(intl.reduce((s, t) => s + t.value, 0)),
      internacionalMerchants: [...new Set(intl.map((t) => merchantOf(t.description)))],
      entradas: round2(win.filter((t) => t.kind === "receita").reduce((s, t) => s + t.amount, 0)),
      // quanto ficou fora do total por regra (a tela explica)
      fora: {
        // o mesmo pagamento aparece nos dois lados (crédito no cartão, débito na
        // conta): conta um lado só
        pagamentos: round2(win.filter((t) => t.kind === (wantBank ? "pagamento_fatura" : "pagamento")).reduce((s, t) => s + Math.abs(t.amount), 0)),
        transferencias: round2(win.filter((t) => t.kind === "transferencia_propria" && t.amount < 0).reduce((s, t) => s - t.amount, 0)),
        investimentos: round2(win.filter((t) => t.kind === "investimento" && t.amount < 0).reduce((s, t) => s - t.amount, 0)),
      },
    },
    categories,
    merchants,
    recurring,
    holders: holdersOut,
    futuras: [...futuras.values()].sort((a, b) => a.key.localeCompare(b.key)).map((f) => ({ ...f, total: round2(f.total) })),
    // lista compacta para abrir uma categoria na tela (mais recentes primeiro)
    txs: gastos
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map((t) => ({
        d: dayOf(t.date),
        desc: t.description,
        m: t.kind === "fatura_externa" ? t.description : merchantOf(t.description),
        v: round2(t.value),
        cat: t.cat,
        p: t.key,
        card: t.cardNumber || null,
        parc: t.instTotal > 1 ? `${t.instN}/${t.instTotal}` : null,
        intl: t.currency && t.currency !== "BRL" ? t.currency : null,
        conta: t.accountType === "CREDIT" ? "cartao" : "conta",
        pend: t.status === "PENDING",
      })),
  };
}
