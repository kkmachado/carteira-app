import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTesouroCsv,
  tituloKey,
  repricedAsset,
  precoVigente,
  repriceTreasuries,
} from "../lib/tesouro.js";

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

test("preço vigente: último ≤ data, recusado se defasado demais", () => {
  const precos = [
    { date: "2026-10-02", pu: 499.06 },
    { date: "2026-10-15", pu: 531.28 },
  ];
  assert.equal(precoVigente(precos, "2026-10-16").pu, 531.28);
  assert.equal(precoVigente(precos, "2026-10-05").pu, 499.06); // fim de semana: carrega sexta
  assert.equal(precoVigente(precos, "2026-10-10"), null); // 8 dias sem preço
  assert.equal(precoVigente(precos, "2026-10-01"), null); // antes do primeiro
});

test("payload: só Tesouro ACTIVE com preço é tocado", () => {
  const rows = parseTesouroCsv(CSV);
  const lookup = (tipo, venc) => rows.filter((r) => r.tipo === tipo && r.vencimento === venc).sort((a, b) => (a.date < b.date ? -1 : 1));
  const cdb = { id: "x", subtype: "CDB", status: "ACTIVE", amount: 100 };
  const resgatado = { ...PREFIXADO, id: "y", status: "TOTAL_WITHDRAWAL" };
  const out = repriceTreasuries([PREFIXADO, cdb, resgatado], "2026-10-16", lookup);
  assert.equal(out[0].amount, 81758.68);
  assert.equal(out[1], cdb);
  assert.equal(out[2], resgatado);
});
