/* Gera um banco de DEMONSTRAÇÃO com histórico fictício, só para validar telas e
   gráficos antes de existir histórico real. Nunca escreve no banco de produção:
   o destino padrão é data/demo.db e o script recusa gravar em carteira.db.

   Uso:  npm run seed:demo         → data/demo.db (14 meses de histórico)
         npm run demo              → sobe o app apontado para esse banco

   O histórico exercita de propósito os casos difíceis: aporte no meio do período,
   aporte adicional em ativo existente, resgate total de um ativo, dias sem
   snapshot (fim de semana, feriado e "falhas") e o primeiro dia da série.
   Os benchmarks são REAIS (SGS/Yahoo) — só a carteira é fictícia. */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initBenchmarks, updateBenchmarks } from "../lib/benchmarks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "demo.db"));

if (path.basename(OUT) === "carteira.db") {
  console.error("✗ recusando gravar em carteira.db — este script é só para o banco de demo");
  process.exit(1);
}

const START = "2025-06-02";
const END = new Date().toISOString().slice(0, 10);

/* Feriados e "falhas de coleta": dias úteis que não viram snapshot. */
const SEM_SNAPSHOT = new Set([
  "2025-07-09", "2025-09-07", "2025-10-12", "2025-11-20", "2025-12-25",
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-04-03", "2026-05-01",
  "2025-08-14", "2026-03-11", "2026-06-23", // falhas simuladas
]);

const aa = (taxa) => (1 + taxa) ** (1 / 252) - 1; // taxa anual → diária (252 úteis)
const CDI_DIA = aa(0.1275);

/* Ativos no formato do payload da Pluggy. `desde` é quando entra na carteira. */
const ATIVOS = [
  { id: "dm-cdb-itau", subtype: "CDB", issuer: "ITAU UNIBANCO S.A.", rateType: "CDI", rate: 100,
    fixedAnnualRate: null, dueDate: "2029-05-08", desde: START, aplicado: 30000, diaria: CDI_DIA * 1.0 },
  { id: "dm-cdb-c6", subtype: "CDB", issuer: "BANCO C6 S.A.", rateType: "CDI", rate: 115,
    fixedAnnualRate: null, dueDate: "2030-04-01", desde: START, aplicado: 25000, diaria: CDI_DIA * 1.15 },
  { id: "dm-lca-sicredi", subtype: "LCA", issuer: "BANCO COOPERATIVO SICREDI", rateType: null, rate: null,
    fixedAnnualRate: 11.59, dueDate: "2027-10-25", desde: START, aplicado: 28000, diaria: aa(0.1159) },
  { id: "dm-tesouro-ipca", subtype: "TREASURY", issuer: null, rateType: "IPCA", rate: 6.2,
    fixedAnnualRate: 6.2, dueDate: "2032-08-15", desde: START, aplicado: 40000, diaria: aa(0.1130) },
  { id: "dm-tesouro-pre", subtype: "TREASURY", issuer: null, rateType: null, rate: null,
    fixedAnnualRate: 14.49, dueDate: "2032-01-01", desde: START, aplicado: 35000, diaria: aa(0.1449) },
  { id: "dm-deb-localiza", subtype: "DEBENTURES", issuer: "LOCALIZA RENT A CAR", rateType: "IPCA", rate: 7.0,
    fixedAnnualRate: 7.0, dueDate: "2028-09-15", desde: START, aplicado: 22000, diaria: aa(0.1210),
    resgateEm: "2026-03-20" }, // resgate TOTAL no meio da série
  { id: "dm-cdb-btg", subtype: "CDB", issuer: "BANCO BTG PACTUAL", rateType: null, rate: null,
    fixedAnnualRate: 13.5, dueDate: "2028-09-15", desde: "2025-09-15", aplicado: 20000, diaria: aa(0.135) },
  { id: "dm-lci-inter", subtype: "LCI", issuer: "BANCO INTER", rateType: "CDI", rate: 95,
    fixedAnnualRate: null, dueDate: "2028-01-05", desde: "2026-01-05", aplicado: 15000, diaria: CDI_DIA * 0.95 },
];

/* Aportes adicionais em ativo que já existe (Δ amountOriginal sem ativo novo). */
const APORTES_EXTRA = [{ id: "dm-cdb-itau", data: "2026-05-04", valor: 10000 }];

const ISENTOS = new Set(["LCA", "LCI"]);
const aliquota = (dias) => (dias <= 180 ? 0.225 : dias <= 360 ? 0.2 : dias <= 720 ? 0.175 : 0.15);
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const proximoDia = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

/* Ruído determinístico: a mesma seed sempre gera o mesmo histórico. */
let seed = 42;
const ruido = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return (seed / 2147483648 - 0.5) * 0.0004; // ±0,02% ao dia
};

const estado = new Map(); // id → { bruto, aplicado }
const linhas = [];

for (let d = START; d <= END; d = proximoDia(d)) {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  const util = dow >= 1 && dow <= 5;

  // rende só em dia útil, mesmo que o dia não vire snapshot
  for (const a of ATIVOS) {
    if (d < a.desde) continue;
    if (a.resgateEm && d >= a.resgateEm) { estado.delete(a.id); continue; }
    if (!estado.has(a.id)) estado.set(a.id, { bruto: a.aplicado, aplicado: a.aplicado });
    const e = estado.get(a.id);
    const extra = APORTES_EXTRA.find((x) => x.id === a.id && x.data === d);
    if (extra) { e.bruto += extra.valor; e.aplicado += extra.valor; }
    if (util) e.bruto *= 1 + a.diaria + ruido();
  }

  if (!util || SEM_SNAPSHOT.has(d)) continue;

  const payload = [];
  for (const a of ATIVOS) {
    const e = estado.get(a.id);
    if (!e) continue;
    const lucro = Math.max(e.bruto - e.aplicado, 0);
    const ir = ISENTOS.has(a.subtype) ? 0 : lucro * aliquota(diasEntre(a.desde, d));
    payload.push({
      id: a.id, status: "ACTIVE", subtype: a.subtype, issuer: a.issuer, name: `${a.subtype} demo`,
      amount: +e.bruto.toFixed(2), amountOriginal: +e.aplicado.toFixed(2), amountProfit: null,
      balance: +(e.bruto - ir).toFixed(2), taxes: +ir.toFixed(2), taxes2: 0,
      rate: a.rate, rateType: a.rateType, fixedAnnualRate: a.fixedAnnualRate,
      dueDate: `${a.dueDate}T00:00:00.000Z`, issueDate: `${a.desde}T00:00:00.000Z`,
    });
  }
  linhas.push({
    date: d,
    total_balance: payload.reduce((s, a) => s + a.balance, 0),
    total_original: payload.reduce((s, a) => s + a.amountOriginal, 0),
    total_gross: payload.reduce((s, a) => s + a.amount, 0),
    payload: JSON.stringify(payload),
  });
}

fs.rmSync(OUT, { force: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const db = new Database(OUT);
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    date TEXT PRIMARY KEY,
    total_balance REAL NOT NULL,
    total_original REAL NOT NULL,
    total_gross REAL NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS investment_txs (
    investment_id TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);
initBenchmarks(db);

const stmt = db.prepare(
  "INSERT INTO snapshots (date, total_balance, total_original, total_gross, payload) VALUES (?, ?, ?, ?, ?)"
);
db.transaction((rs) => {
  for (const r of rs) stmt.run(r.date, r.total_balance, r.total_original, r.total_gross, r.payload);
})(linhas);

/* Movimentações fictícias no formato da Pluggy, para o detalhe do ativo ter o que
   mostrar na demo: a aplicação inicial, os aportes extras e o resgate total. */
const stmtTx = db.prepare(
  "INSERT INTO investment_txs (investment_id, fetched_at, payload) VALUES (?, ?, ?)"
);
const agora = new Date().toISOString();
db.transaction(() => {
  for (const a of ATIVOS) {
    const movs = [
      { id: `${a.id}-buy`, type: "BUY", movementType: "CREDIT", date: `${a.desde}T00:00:00.000Z`,
        tradeDate: `${a.desde}T00:00:00.000Z`, amount: a.aplicado, netAmount: a.aplicado,
        quantity: a.aplicado, value: 1, description: null },
      ...APORTES_EXTRA.filter((x) => x.id === a.id).map((x) => ({
        id: `${a.id}-buy-${x.data}`, type: "BUY", movementType: "CREDIT", date: `${x.data}T00:00:00.000Z`,
        tradeDate: `${x.data}T00:00:00.000Z`, amount: x.valor, netAmount: x.valor,
        quantity: x.valor, value: 1, description: null,
      })),
    ];
    if (a.resgateEm) {
      movs.push({ id: `${a.id}-sell`, type: "SELL", movementType: "DEBIT",
        date: `${a.resgateEm}T00:00:00.000Z`, tradeDate: `${a.resgateEm}T00:00:00.000Z`,
        amount: a.aplicado, netAmount: a.aplicado, quantity: a.aplicado, value: 1, description: null });
    }
    movs.sort((x, y) => y.tradeDate.localeCompare(x.tradeDate));
    stmtTx.run(a.id, agora, JSON.stringify(movs));
  }
})();

/* ---------- Gastos fictícios (conta corrente + cartão) ----------
   Formato das tabelas que o server.js espelha da Pluggy (/v2/transactions,
   /bills, /categories). Exercita os casos da tela: fatura com lançamento
   atípico, estorno, compra internacional, parcelas futuras, fatura aberta,
   pagamento da fatura pela conta (não pode contar em dobro) e aplicação. */
db.exec(`
  CREATE TABLE IF NOT EXISTS bank_accounts (id TEXT PRIMARY KEY, type TEXT NOT NULL, subtype TEXT, name TEXT,
    number TEXT, balance REAL, credit_data TEXT, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bank_txs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date TEXT NOT NULL,
    amount REAL NOT NULL, status TEXT, category_id TEXT, description TEXT, bill_id TEXT, bill_forecast TEXT,
    card_number TEXT, currency TEXT, amount_brl REAL, installment_n INTEGER, installment_total INTEGER,
    payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS card_bills (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, due_date TEXT NOT NULL,
    total_amount REAL NOT NULL, min_payment REAL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tx_categories (id TEXT PRIMARY KEY, parent_id TEXT, name_pt TEXT, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gastos_sync (id INTEGER PRIMARY KEY CHECK (id = 1), last_sync_at TEXT, last_error TEXT);
`);

// PRNG determinístico: a demo sai igual a cada seed
let semente = 42;
const rnd = () => ((semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648);
const entre = (a, b) => Math.round((a + rnd() * (b - a)) * 100) / 100;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const CATS = [
  ["01000000", null, "Renda"], ["01010000", "01000000", "Salário"],
  ["03000000", null, "Investimentos"], ["03020000", "03000000", "Renda fixa"],
  ["04000000", null, "Transferência mesma titularidade"],
  ["05000000", null, "Transferências"], ["05100000", "05000000", "Pagamento de cartão de crédito"],
  ["08000000", null, "Compras"], ["08010000", "08000000", "Compras online"],
  ["09000000", null, "Serviços digitais"], ["10000000", null, "Supermercado"],
  ["11000000", null, "Alimentos e bebidas"], ["11010000", "11000000", "Restaurantes, bares e lanchonetes"],
  ["17000000", null, "Moradia"], ["17010000", "17000000", "Aluguel"], ["17020000", "17000000", "Serviços de utilidade pública"],
  ["17020002", "17020000", "Eletricidade"], ["18000000", null, "Saúde"], ["18020000", "18000000", "Farmácia"],
  ["18040000", "18000000", "Hospitais, clínicas e laboratórios"], ["19000000", null, "Transporte"],
  ["19050001", "19000000", "Postos de gasolina"], ["07000000", null, "Serviços"], ["07030000", "07000000", "Educação"],
];
const LOJAS = [
  ["SUPERMERCADO DEMO", "10000000", 80, 600], ["HORTIFRUTI EXEMPLO", "10000000", 40, 250],
  ["RESTAURANTE FICTICIO", "11010000", 60, 280], ["PADARIA MODELO", "11010000", 15, 60],
  ["POSTO TESTE", "19050001", 150, 320], ["DROGARIA DEMO", "18020000", 30, 180],
  ["LOJA ONLINE DEMO", "08010000", 50, 400], ["LIVRARIA EXEMPLO", "08000000", 40, 150],
];
const CARTAO = "demo-cartao", CONTA = "demo-conta";
const addDias = (iso, d) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const fatura = (ym) => `${ym}-06`; // vencimento
const hojeISO = new Date().toISOString().slice(0, 10);
const mesDe = (k) => { const d = new Date(`${hojeISO.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7); };

const txsG = [];
const billsG = [];
const tx = (o) => txsG.push({ status: "POSTED", currency: "BRL", ...o });
let nTx = 0;
const id = () => `demo-tx-${++nTx}`;

// faturas fechadas: 7 meses até a do mês corrente (se já venceu) + a aberta
const ultimaFechada = Number(hojeISO.slice(8, 10)) >= 6 ? 0 : -1;
const meses = Array.from({ length: 7 }, (_, i) => mesDe(ultimaFechada - 6 + i));
const aberta = mesDe(ultimaFechada + 1);
let anterior = null;
for (const [i, ym] of [...meses, aberta].entries()) {
  const venc = fatura(ym);
  const fech = addDias(venc, -8);
  const ini = addDias(fech, -30);
  const isAberta = ym === aberta;
  const billId = isAberta ? null : `demo-bill-${ym}`;
  const cc = (extra = {}) => ({ accountId: CARTAO, billId, billForecast: ym, ...extra });
  let soma = 0;
  const compra = (desc, cat, valor, dia, card = pick(["1111", "1111", "2222"]), extra = {}) => {
    soma += valor;
    tx({ id: id(), ...cc(), date: `${addDias(ini, dia)}T03:00:00.000Z`, amount: valor, categoryId: cat,
      description: desc, cardNumber: card, status: isAberta ? "PENDING" : "POSTED", ...extra });
  };
  const n = isAberta ? 25 : 45 + Math.floor(rnd() * 20);
  for (let k = 0; k < n; k++) {
    const [loja, cat, a, b] = pick(LOJAS);
    compra(loja, cat, entre(a, b), Math.floor(rnd() * 30));
  }
  compra("STREAMING DEMO", "09000000", 39.9, 3, "1111"); // recorrente
  compra("ACADEMIA EXEMPLO", "07000000", 189.9, 5, "2222");
  if (i === 3) compra("CLINICA FICTICIA", "18040000", 7200, 12, "1111"); // pico atípico
  if (i === 5) {
    // compra em dólar: `amount` na moeda original, a fatura cobra `amountBrl` (soma já leva os reais)
    compra("DEVTOOLS INC", "09000000", 110.4, 8, "1111", { currency: "USD", amountBrl: 110.4, amount: 20 });
  }
  if (i === 2) { tx({ id: id(), ...cc(), date: `${addDias(ini, 20)}T03:00:00.000Z`, amount: -85, categoryId: "08010000",
    description: "CANCELAMENTO DE COMPRA - LOJA ONLINE DEMO", cardNumber: "1111" }); soma -= 85; }
  // pagamento da fatura anterior cai nesta fatura como crédito
  if (anterior) tx({ id: id(), ...cc(), date: `${fatura(anterior.ym)}T03:00:00.000Z`, amount: -anterior.total,
    categoryId: "05100000", description: "Pagamento recebido", cardNumber: null });
  if (!isAberta) {
    const total = Math.round(soma * 100) / 100;
    billsG.push({ id: billId, dueDate: `${venc}T00:00:00.000Z`, totalAmount: total, minimumPaymentAmount: Math.round(total * 10) / 100 });
    anterior = { ym, total };
  }
}
// parcelado em 10x na fatura aberta: 3 parcelas já lançadas nas faturas seguintes
for (let k = 1; k <= 3; k++) {
  const ym = mesDe(ultimaFechada + 1 + k);
  tx({ id: id(), accountId: CARTAO, billForecast: ym, date: `${fatura(ym)}T03:00:00.000Z`, amount: 320,
    categoryId: "08000000", description: `LOJA DE MOVEIS DEMO ${String(k + 1).padStart(2, "0")}/10`,
    cardNumber: "2222", status: "PENDING", instN: k + 1, instTotal: 10 });
}

// conta corrente: salário, aluguel, luz, pix, débito, fatura paga, aplicação
for (const ym of [...meses, mesDe(0)].filter((v, i, a) => a.indexOf(v) === i && v <= hojeISO.slice(0, 7))) {
  const d = (dia) => `${ym}-${String(dia).padStart(2, "0")}T13:00:00.000Z`;
  const ok = (dia) => `${ym}-${String(dia).padStart(2, "0")}` <= hojeISO;
  if (ok(5)) tx({ id: id(), accountId: CONTA, date: d(5), amount: 15000, categoryId: "01010000", description: "Pix recebido EMPRESA DEMO LTDA" });
  if (ok(10)) tx({ id: id(), accountId: CONTA, date: d(10), amount: -3500, categoryId: "17010000", description: "Pix enviado IMOBILIARIA EXEMPLO" });
  if (ok(15)) tx({ id: id(), accountId: CONTA, date: d(15), amount: -entre(180, 320), categoryId: "17020002", description: "Débito automático DA ENERGIA DEMO 1234" });
  if (ok(12)) tx({ id: id(), accountId: CONTA, date: d(12), amount: -1200, categoryId: "07030000", description: "Pagamento de boleto ESCOLA FICTICIA" });
  if (ok(20)) tx({ id: id(), accountId: CONTA, date: d(20), amount: -2000, categoryId: "03020000", description: "Aplicação CDB DI" });
  if (ok(22)) tx({ id: id(), accountId: CONTA, date: d(22), amount: -entre(40, 400), categoryId: "05000000", description: "Pix enviado FULANO DE TAL" });
  if (ok(18)) tx({ id: id(), accountId: CONTA, date: d(18), amount: -entre(20, 90), categoryId: "11010000", description: "Compra débito PADARIA MODELO" });
  const b = billsG.find((x) => x.dueDate.startsWith(ym));
  if (b && ok(6)) tx({ id: id(), accountId: CONTA, date: d(6), amount: -b.totalAmount, categoryId: "03000000", description: "Débito automático FATURA DEMO BLACK" });
}

const agoraG = new Date().toISOString();
db.transaction(() => {
  const insAcc = db.prepare("INSERT INTO bank_accounts (id, type, subtype, name, number, balance, credit_data, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insAcc.run(CARTAO, "CREDIT", "CREDIT_CARD", "DEMO BLACK", null, 5000, JSON.stringify({ creditLimit: 30000, availableCreditLimit: 24000, balanceDueDate: `${fatura(aberta)}` }), agoraG);
  insAcc.run(CONTA, "BANK", "CHECKING_ACCOUNT", "conta demo", null, 4200, null, agoraG);
  const insTx = db.prepare(`INSERT INTO bank_txs (id, account_id, date, amount, status, category_id, description, bill_id,
    bill_forecast, card_number, currency, amount_brl, installment_n, installment_total, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of txsG)
    insTx.run(t.id, t.accountId, t.date, t.amount, t.status, t.categoryId, t.description, t.billId || null,
      t.accountId === CARTAO ? t.billForecast : null, t.cardNumber || null, t.currency, t.amountBrl ?? null,
      t.instN ?? null, t.instTotal ?? null, JSON.stringify(t), agoraG);
  const insBill = db.prepare("INSERT INTO card_bills (id, account_id, due_date, total_amount, min_payment, payload) VALUES (?, ?, ?, ?, ?, ?)");
  for (const b of billsG) insBill.run(b.id, CARTAO, b.dueDate, b.totalAmount, b.minimumPaymentAmount, JSON.stringify(b));
  const insCat = db.prepare("INSERT INTO tx_categories (id, parent_id, name_pt, fetched_at) VALUES (?, ?, ?, ?)");
  for (const [cid, parent, nome] of CATS) insCat.run(cid, parent, nome, agoraG);
  db.prepare("INSERT INTO gastos_sync (id, last_sync_at) VALUES (1, ?)").run(agoraG);
})();
console.log(`✓ ${txsG.length} lançamentos fictícios de conta/cartão e ${billsG.length} faturas`);

const primeira = linhas[0];
const ultima = linhas[linhas.length - 1];
console.log(`✓ ${linhas.length} snapshots de ${primeira.date} a ${ultima.date} em ${OUT}`);
console.log(`  saldo final R$ ${ultima.total_balance.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
console.log(`  aplicado    R$ ${ultima.total_original.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);

console.log("→ buscando benchmarks reais (SGS/Yahoo) para o mesmo período…");
const { errors } = await updateBenchmarks(db, { startISO: primeira.date });
for (const [serie, msg] of Object.entries(errors)) console.warn(`  ⚠️  ${serie}: ${msg}`);
const total = db.prepare("SELECT COUNT(*) AS n FROM benchmarks").get().n;
console.log(`✓ ${total} pontos de benchmark gravados`);
console.log("\nSuba a demo com:  npm run demo");
