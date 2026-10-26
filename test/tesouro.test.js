import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTesouroCsv,
  tituloKey,
  repricedAsset,
  precoVigente,
  repriceTreasuries,
  parseAnbimaMs,
  anbimaUrl,
} from "../lib/tesouro.js";

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `esperado ≈ ${b}, veio ${a}`);

const CSV = [
  "Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha",
  "Tesouro Prefixado;01/01/2032;15/10/2026;12,87;12,99;534,47;531,28;531,28",
  "Tesouro IPCA+;15/08/2032;15/10/2026;6,80;6,92;3256,04;3233,78;3233,78",
  "Tesouro Prefixado;01/01/2032;02/10/2026;14,15;14,27;502,06;499,06;499,06",
  "Tesouro Selic;01/03/2027;10/01/2020;0,01;0,02;10097,80;10086,80;10086,80",
  "",
].join("\r\n");

// Prefixado 2032 como a Pluggy devolveu em 16/10/2026: PU congelado em 499,85
const PREFIXADO = {
  id: "dc23",
  name: "Tesouro Prefixado 2032",
  subtype: "TREASURY",
  status: "ACTIVE",
  dueDate: "2032-01-01T03:00:00.000Z",
  issueDate: "2026-07-10T03:00:00.000Z",
  quantity: 153.89,
  value: 499.85,
  amount: 76753.5,
  balance: 76132.57,
  amountWithdrawal: 76132.57,
  taxes: 620.93,
  amountOriginal: 73505.5585,
};

test("parse do CSV: PU base, datas ISO e corte por data", () => {
  const rows = parseTesouroCsv(CSV, "2026-01-01");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    tipo: "Tesouro Prefixado",
    vencimento: "2032-01-01",
    date: "2026-10-15",
    pu: 531.28,
    taxa: 12.99,
  });
});

test("cabeçalho diferente do esperado é erro, não lista vazia", () => {
  assert.throws(() => parseTesouroCsv("a;b;c\n1;2;3"), /cabeçalho/);
});

test("chave do título: nome sem o ano e vencimento pela parte ISO", () => {
  assert.deepEqual(tituloKey(PREFIXADO), { tipo: "Tesouro Prefixado", vencimento: "2032-01-01" });
  assert.deepEqual(
    tituloKey({ ...PREFIXADO, name: "Tesouro IPCA+ 2032", dueDate: "2032-08-15T00:00:00.000Z" }),
    { tipo: "Tesouro IPCA+", vencimento: "2032-08-15" }
  );
  assert.equal(tituloKey({ ...PREFIXADO, subtype: "CDB" }), null);
});

test("reprecifica: quantidade × PU, IR pela alíquota efetiva da Pluggy", () => {
  const r = repricedAsset(PREFIXADO, { date: "2026-10-15", pu: 531.28 }, "2026-10-16");
  assert.equal(r.amount, 81758.68);
  const aliq = 620.93 / (76753.5 - 73505.5585);
  assert.ok(Math.abs(r.taxes - (81758.68 - 73505.5585) * aliq) < 0.01);
  // sem outras deduções na Pluggy (amount − balance = taxes): líquido = bruto − IR
  assert.ok(Math.abs(r.balance - (r.amount - r.taxes)) < 0.01);
  assert.equal(r.amountWithdrawal, r.balance);
  assert.equal(r.value, 531.28);
  assert.equal(r.priceSource, "tesouro");
  assert.equal(r.priceDate, "2026-10-15");
  assert.deepEqual(r.pluggy, { amount: 76753.5, balance: 76132.57, taxes: 620.93, value: 499.85 });
});

test("outras deduções (custódia) da Pluggy são preservadas no líquido", () => {
  const a = { ...PREFIXADO, balance: 76100 }; // 32,57 a mais descontados além do IR
  const r = repricedAsset(a, { date: "2026-10-15", pu: 531.28 }, "2026-10-16");
  assert.ok(Math.abs(r.amount - r.taxes - r.balance - 32.57) < 0.01);
});

test("idempotente: reprecificar de novo parte dos números originais da Pluggy", () => {
  const p1 = repricedAsset(PREFIXADO, { date: "2026-10-15", pu: 531.28 }, "2026-10-16");
  const p2 = repricedAsset(p1, { date: "2026-10-15", pu: 531.28 }, "2026-10-16");
  assert.deepEqual(p2, p1);
});

test("sem preço vigente: volta ao valor original da Pluggy", () => {
  const p1 = repricedAsset(PREFIXADO, { date: "2026-10-15", pu: 531.28 }, "2026-10-16");
  const back = repricedAsset(p1, null, "2026-10-16");
  assert.equal(back.amount, 76753.5);
  assert.equal(back.value, 499.85);
  assert.equal(back.pluggy, undefined);
  assert.equal(back.priceSource, undefined);
});

test("prejuízo: IR zera, sem crédito negativo", () => {
  const r = repricedAsset(PREFIXADO, { date: "2026-10-15", pu: 400 }, "2026-10-16");
  assert.equal(r.taxes, 0);
});

const PRE = { tipo: "Tesouro Prefixado", vencimento: "2032-01-01" };
const OFICIAL_PRE = [
  { date: "2026-10-02", pu: 499.06, taxa: 14.27 },
  { date: "2026-10-15", pu: 531.28, taxa: 12.99 },
];
// taxa indicativa ANBIMA da LTN 01/01/2032 (arquivos ms261016…ms261023)
const ANBIMA_LTN = [
  { date: "2026-10-16", taxa: 13.0248, pu: 530.697398 },
  { date: "2026-10-20", taxa: 12.8874, pu: 534.562392 },
  { date: "2026-10-23", taxa: 12.8817, pu: 535.473735 },
];

test("preço vigente: oficial do próprio dia é usado como está", () => {
  assert.deepEqual(precoVigente(OFICIAL_PRE, "2026-10-15", PRE), OFICIAL_PRE[1]);
  assert.equal(precoVigente(OFICIAL_PRE, "2026-10-01", PRE), null); // antes do primeiro
});

test("sem oficial do dia nem ANBIMA: carrego à taxa da âncora", () => {
  const p = precoVigente(OFICIAL_PRE, "2026-10-16", PRE);
  assert.equal(p.estimado, true);
  assert.equal(p.base, "2026-10-15");
  assert.equal(p.taxaDate, null);
  // 1 dia a 12,99% a.a.
  close(p.pu, 531.28 * Math.pow(1.1299, 1 / 365.25), 1e-4);
});

test("estimado pela ANBIMA: taxa caiu, preço sobe — e fica perto do PU da ANBIMA", () => {
  const p = precoVigente(OFICIAL_PRE, "2026-10-25", { ...PRE, anbima: ANBIMA_LTN });
  assert.equal(p.taxaDate, "2026-10-23");
  assert.ok(p.pu > 531.28);
  // r1 = 12,99 − 0,1431 ≈ 12,85% ⇒ ~536; a ANBIMA marcava 535,47 a 12,88% em 23/10
  assert.ok(Math.abs(p.pu - 535.47) / 535.47 < 0.005, `PU ${p.pu}`);
});

test("âncora sem taxa ANBIMA do dia: interpola os vizinhos", () => {
  const anbima = [{ date: "2026-10-14", taxa: 12.7806 }, ...ANBIMA_LTN];
  const p = precoVigente(OFICIAL_PRE, "2026-10-25", { ...PRE, anbima });
  // âncora ANBIMA = (12,7806 + 13,0248)/2 = 12,9027 ⇒ Δ até 23/10 = −0,021: sobe pouco
  const n0 = (Date.parse("2032-01-01") - Date.parse("2026-10-15")) / 86400000 / 365.25;
  const n1 = (Date.parse("2032-01-01") - Date.parse("2026-10-25")) / 86400000 / 365.25;
  const r1 = 0.1299 + (12.8817 - 12.9027) / 100;
  close(p.pu, (531.28 * Math.pow(1.1299, n0)) / Math.pow(1 + r1, n1), 1e-5);
});

test("IPCA+: VNA anda com o IPCA mensal no período", () => {
  const ipca = { tipo: "Tesouro IPCA+", vencimento: "2032-08-15" };
  const of = [{ date: "2026-10-15", pu: 3233.78, taxa: 6.92 }];
  const sem = precoVigente(of, "2026-11-14", ipca);
  const com = precoVigente(of, "2026-11-14", { ...ipca, ipcaMensal: 0.5 });
  close(com.pu / sem.pu, Math.pow(1.005, 30 / 30.4375), 1e-9);
});

test("âncora velha demais: sem estimativa (fica a Pluggy)", () => {
  assert.equal(precoVigente(OFICIAL_PRE, "2026-12-15", PRE), null);
});

test("parse do arquivo da ANBIMA: datas, taxa indicativa e PU", () => {
  const txt = [
    "ANBIMA - Associa\u00e7\u00e3o Brasileira",
    "",
    "Titulo@Data Referencia@Codigo SELIC@Data Base/Emissao@Data Vencimento@Tx. Compra@Tx. Venda@Tx. Indicativas@PU@Desvio padrao",
    "LTN@20261023@100000@20250110@20320101@12,8869@12,8754@12,8817@535,473735@0,00094",
    "NTN-B@20261023@760199@20000715@20320815@6,7349@6,7068@6,72@4674,360248@0",
  ].join("\r\n");
  assert.deepEqual(parseAnbimaMs(txt), [
    { titulo: "LTN", vencimento: "2032-01-01", date: "2026-10-23", taxa: 12.8817, pu: 535.473735 },
    { titulo: "NTN-B", vencimento: "2032-08-15", date: "2026-10-23", taxa: 6.72, pu: 4674.360248 },
  ]);
  assert.equal(anbimaUrl("2026-10-23"), "https://www.anbima.com.br/informacoes/merc-sec/arqs/ms261023.txt");
});

test("ativo estimado sai marcado e guarda a âncora", () => {
  const p = precoVigente(OFICIAL_PRE, "2026-10-25", { ...PRE, anbima: ANBIMA_LTN });
  const r = repricedAsset(PREFIXADO, p, "2026-10-25");
  assert.equal(r.priceSource, "estimado");
  assert.equal(r.priceBase, "2026-10-15");
  assert.equal(r.priceRateDate, "2026-10-23");
  // voltar a um preço oficial limpa os campos da estimativa
  const o = repricedAsset(r, OFICIAL_PRE[1], "2026-10-15");
  assert.equal(o.priceSource, "tesouro");
  assert.equal(o.priceBase, undefined);
});

test("payload: só Tesouro ACTIVE com preço é tocado", () => {
  const rows = parseTesouroCsv(CSV);
  const lookup = (tipo, venc) => rows.filter((r) => r.tipo === tipo && r.vencimento === venc).sort((a, b) => (a.date < b.date ? -1 : 1));
  const cdb = { id: "x", subtype: "CDB", status: "ACTIVE", amount: 100 };
  const resgatado = { ...PREFIXADO, id: "y", status: "TOTAL_WITHDRAWAL" };
  const out = repriceTreasuries([PREFIXADO, cdb, resgatado], "2026-10-15", lookup);
  assert.equal(out[0].amount, 81758.68);
  assert.equal(out[1], cdb);
  assert.equal(out[2], resgatado);
});
