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
`);
initBenchmarks(db);

const stmt = db.prepare(
  "INSERT INTO snapshots (date, total_balance, total_original, total_gross, payload) VALUES (?, ?, ?, ?, ?)"
);
db.transaction((rs) => {
  for (const r of rs) stmt.run(r.date, r.total_balance, r.total_original, r.total_gross, r.payload);
})(linhas);

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
