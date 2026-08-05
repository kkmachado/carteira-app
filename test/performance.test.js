import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dailyReturns,
  accumulate,
  twrSeries,
  cdiAccumulated,
  cdiSeries,
  ipcaAccumulated,
  ibovSeries,
  ibovAccumulated,
  percentOfCdi,
  irAliquot,
  grossUp,
  monthlyBreakdown,
  periodStartISO,
  snapshotToDay,
  accumulateRange,
  sumIncomeRange,
  daysByGroup,
  grossUpFactorWeighted,
} from "../lib/performance.js";

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `esperado ≈ ${b}, veio ${a}`);

/* ---------- TWR ---------- */

test("primeiro dia da série: só base, sem retorno", () => {
  const days = [{ date: "2026-07-01", gross: 1000, original: 1000 }];
  assert.deepEqual(dailyReturns(days), []);
  assert.equal(accumulate([]), 0);
  assert.deepEqual(twrSeries(days), [{ date: "2026-07-01", acc: 0 }]);
});

test("rendimento sem aporte: r = Δgross / gross anterior", () => {
  const days = [
    { date: "2026-07-01", gross: 1000, original: 1000 },
    { date: "2026-07-02", gross: 1010, original: 1000 },
  ];
  const rets = dailyReturns(days);
  assert.equal(rets.length, 1);
  close(rets[0].r, 0.01);
  close(rets[0].income, 10);
  assert.equal(rets[0].flow, 0);
});

test("aporte no meio do período é neutralizado (TWR ≠ variação de saldo)", () => {
  const days = [
    { date: "2026-07-01", gross: 1000, original: 1000 },
    { date: "2026-07-02", gross: 1005, original: 1000 }, // rende 5
    { date: "2026-07-03", gross: 2015, original: 2000 }, // aporte 1000, rende 10
  ];
  const rets = dailyReturns(days);
  close(rets[0].r, 0.005);
  assert.equal(rets[1].flow, 1000);
  close(rets[1].income, 10);
  close(rets[1].r, 10 / 2005); // Modified Dietz: denominador = gross anterior + aporte
  const acc = accumulate(rets);
  close(acc, 1.005 * (1 + 10 / 2005) - 1);
  // a variação ingênua de saldo daria 1,5% — o aporte inflaria o "rendimento"
  assert.ok(acc < 0.015);
});

test("resgate total de um ativo (com assets): sai pelo bruto, sem artefato", () => {
  const days = [
    {
      date: "2026-07-01",
      gross: 1600,
      original: 1500,
      assets: [
        { id: "A", gross: 1100, original: 1000 },
        { id: "B", gross: 500, original: 500 },
      ],
    },
    {
      date: "2026-07-02",
      gross: 502,
      original: 500,
      assets: [{ id: "B", gross: 502, original: 500 }],
    },
  ];
  const [ret] = dailyReturns(days);
  assert.equal(ret.flow, -1100); // valor bruto do ativo A, não os 1000 de principal
  close(ret.income, 2); // só o rendimento do B
  close(ret.r, 2 / 500);
});

test("resgate total sem assets (fallback Δoriginal) não quebra, mas gera artefato", () => {
  const days = [
    { date: "2026-07-01", gross: 1600, original: 1500 },
    { date: "2026-07-02", gross: 502, original: 500 },
  ];
  const [ret] = dailyReturns(days);
  assert.equal(ret.flow, -1000);
  close(ret.income, -98); // rendimento acumulado do ativo resgatado vira "perda"
  assert.ok(Number.isFinite(ret.r));
});

test("resgate da carteira inteira: denominador 0 ⇒ r = 0, sem NaN", () => {
  const days = [
    { date: "2026-07-01", gross: 1050, original: 1000, assets: [{ id: "A", gross: 1050, original: 1000 }] },
    { date: "2026-07-02", gross: 0, original: 0, assets: [] },
    { date: "2026-07-03", gross: 0, original: 0, assets: [] },
  ];
  const rets = dailyReturns(days);
  assert.deepEqual(rets.map((r) => r.r), [0, 0]);
  assert.equal(accumulate(rets), 0);
});

test("dia sem snapshot (feriado/falha): vira um único período, produto inalterado", () => {
  const semGap = [
    { date: "2026-07-01", gross: 1000, original: 1000 },
    { date: "2026-07-02", gross: 1005, original: 1000 },
    { date: "2026-07-03", gross: 1010.025, original: 1000 },
  ];
  const comGap = [semGap[0], semGap[2]]; // faltou o snapshot do dia 2
  close(accumulate(dailyReturns(comGap)), accumulate(dailyReturns(semGap)));
  const serie = twrSeries(comGap);
  assert.deepEqual(serie.map((p) => p.date), ["2026-07-01", "2026-07-03"]);
});

/* ---------- Benchmarks ---------- */

test("CDI acumula só dias úteis do range (from exclusivo, to inclusivo)", () => {
  const rows = [
    { date: "2026-07-01", value: 0.05 },
    { date: "2026-07-02", value: 0.05 },
    { date: "2026-07-03", value: 0.05 },
    { date: "2026-07-06", value: 0.05 }, // pula fim de semana
  ];
  close(cdiAccumulated(rows, "2026-07-01", "2026-07-06"), 1.0005 ** 3 - 1);
  const serie = cdiSeries(rows, "2026-07-01", "2026-07-03");
  assert.deepEqual(serie.map((p) => p.date), ["2026-07-02", "2026-07-03"]);
  close(serie[1].acc, 1.0005 ** 2 - 1);
});

test("IPCA mensal em degrau: mês parcial do início fica de fora", () => {
  const rows = [
    { date: "2026-06-01", value: 0.3 },
    { date: "2026-07-01", value: 0.4 },
  ];
  close(ipcaAccumulated(rows, "2026-06-15", "2026-08-01"), 0.004);
});

test("IBOV: variação relativa ao fechamento que abre o range", () => {
  const rows = [
    { date: "2026-07-01", value: 120000 },
    { date: "2026-07-02", value: 121200 },
    { date: "2026-07-03", value: 118800 },
  ];
  close(ibovAccumulated(rows, "2026-07-01", "2026-07-03"), -0.01);
  const serie = ibovSeries(rows, "2026-07-01", "2026-07-03");
  assert.equal(serie.length, 2); // o próprio dia da base fica de fora, como nas taxas
  close(serie[0].acc, 0.01);
  close(serie[1].acc, -0.01);
});

test("IBOV: range que abre em dia sem pregão usa o fechamento anterior como base", () => {
  const rows = [
    { date: "2026-07-31", value: 120000 }, // sexta
    { date: "2026-08-03", value: 121200 }, // segunda
    { date: "2026-08-04", value: 118800 },
  ];
  // from = domingo: sem base anterior, o primeiro dia do range aparecia zerado
  const serie = ibovSeries(rows, "2026-08-02", "2026-08-04");
  close(serie[0].acc, 0.01);
  close(serie[1].acc, -0.01);
  close(ibovAccumulated(rows, "2026-08-02", "2026-08-04"), -0.01);
});

test("IBOV: sem fechamento anterior ao range, o primeiro de dentro vira base", () => {
  const rows = [
    { date: "2026-08-03", value: 120000 },
    { date: "2026-08-04", value: 121200 },
  ];
  const serie = ibovSeries(rows, "2026-08-02", "2026-08-04");
  close(serie[0].acc, 0);
  close(serie[1].acc, 0.01);
});

test("% do CDI", () => {
  close(percentOfCdi(0.012, 0.01), 120);
  assert.equal(percentOfCdi(0.012, 0), null);
  assert.equal(percentOfCdi(0.012, undefined), null);
});

/* ---------- Gross up ---------- */

test("tabela regressiva de IR por prazo decorrido", () => {
  assert.equal(irAliquot(100), 0.225);
  assert.equal(irAliquot(180), 0.225);
  assert.equal(irAliquot(181), 0.2);
  assert.equal(irAliquot(360), 0.2);
  assert.equal(irAliquot(361), 0.175);
  assert.equal(irAliquot(720), 0.175);
  assert.equal(irAliquot(721), 0.15);
});

test("gross up de isento: rendimento ÷ (1 − alíquota)", () => {
  close(grossUp(100, 100), 100 / 0.775);
  close(grossUp(100, 800), 100 / 0.85);
});

/* ---------- Evolução patrimonial mensal ---------- */

test("monthlyBreakdown: patrimônio, rendimentos, aportes e impostos por mês", () => {
  const days = [
    { date: "2026-06-29", gross: 1000, original: 1000, balance: 998, taxes: 2 },
    { date: "2026-06-30", gross: 1001, original: 1000, balance: 998.8, taxes: 2.2 },
    { date: "2026-07-15", gross: 2006, original: 2000, balance: 2003, taxes: 3 },
    { date: "2026-07-31", gross: 2016, original: 2000, balance: 2012, taxes: 4 },
  ];
  const [jun, jul] = monthlyBreakdown(days);
  assert.equal(jun.month, "2026-06");
  close(jun.patrimonio, 998.8);
  close(jun.rendimentos, 1);
  assert.equal(jun.aportes, 0);
  close(jun.impostos, 0.2);
  assert.equal(jul.month, "2026-07");
  close(jul.patrimonio, 2012);
  close(jul.rendimentos, 15); // 5 no dia do aporte + 10 no fim do mês
  assert.equal(jul.aportes, 1000);
  assert.equal(jul.retiradas, 0);
  close(jul.impostos, 1.8);
});

test("monthlyBreakdown: retirada aparece como valor negativo", () => {
  const days = [
    { date: "2026-07-01", gross: 2000, original: 2000 },
    { date: "2026-07-02", gross: 1502, original: 1500 }, // resgate 500, rende 2
  ];
  const [jul] = monthlyBreakdown(days);
  assert.equal(jul.retiradas, -500);
  close(jul.rendimentos, 2);
  assert.equal(jul.impostos, null); // sem taxes nos dias
});

test("monthlyBreakdown: menos de dois snapshots ⇒ sem barras", () => {
  assert.deepEqual(monthlyBreakdown([]), []);
  assert.deepEqual(monthlyBreakdown([{ date: "2026-07-01", gross: 1000, original: 1000 }]), []);
});

/* ---------- Seletor de período ---------- */

test("periodStartISO", () => {
  assert.equal(periodStartISO("ytd", "2026-08-02"), "2026-01-01");
  assert.equal(periodStartISO("3m", "2026-08-02"), "2026-05-02");
  assert.equal(periodStartISO("12m", "2026-08-02"), "2025-08-02");
  assert.equal(periodStartISO("max", "2026-08-02"), null);
  assert.equal(periodStartISO(undefined, "2026-08-02"), null);
});

/* ---------- Janelas de datas ---------- */

test("accumulateRange e sumIncomeRange: só retornos em (from, to]", () => {
  const rets = [
    { date: "2026-07-01", r: 0.01, income: 10 },
    { date: "2026-07-02", r: 0.01, income: 10 },
    { date: "2026-07-03", r: 0.01, income: 10 },
  ];
  close(accumulateRange(rets, "2026-07-01", "2026-07-03"), 1.01 ** 2 - 1);
  assert.equal(sumIncomeRange(rets, "2026-07-01", "2026-07-03"), 20);
  assert.equal(accumulateRange(rets, "2026-07-03", "2026-07-03"), 0);
});

/* ---------- Agrupamento por categoria/ativo ---------- */

test("daysByGroup: agrega por subtype; categoria resgatada vira dia zerado", () => {
  const mk = (date, assets) => ({ date, payload: JSON.stringify(assets) });
  const rows = [
    mk("2026-07-01", [
      { id: "A", status: "ACTIVE", subtype: "CDB", amount: 1000, amountOriginal: 1000, balance: 1000 },
      { id: "B", status: "ACTIVE", subtype: "LCA", amount: 500, amountOriginal: 500, balance: 500 },
    ]),
    mk("2026-07-02", [
      { id: "A", status: "ACTIVE", subtype: "CDB", amount: 1001, amountOriginal: 1000, balance: 1000.8 },
      { id: "B", status: "TOTAL_WITHDRAWAL", subtype: "LCA", amount: 501, amountOriginal: 500, balance: 501 },
    ]),
  ];
  const groups = daysByGroup(rows, (a) => a.subtype);
  assert.deepEqual([...groups.keys()].sort(), ["CDB", "LCA"]);
  const cdb = groups.get("CDB");
  assert.equal(cdb[1].gross, 1001);
  close(dailyReturns(cdb)[0].r, 0.001);
  const lca = groups.get("LCA");
  assert.equal(lca[1].gross, 0);
  assert.deepEqual(lca[1].assets, []);
  // resgate da categoria inteira: fluxo sai pelo bruto anterior, r = 0 (denom 0)
  const [ret] = dailyReturns(lca);
  assert.equal(ret.flow, -500);
  assert.equal(ret.r, 0);
});

test("grossUpFactorWeighted: pondera pelo rendimento e usa a tabela regressiva", () => {
  // 100 dias corridos ⇒ 22,5%; sem data ⇒ conservador 15%
  const novo = { amount: 1100, amountOriginal: 1000, issueDate: "2026-04-23" }; // 101 dias até 2026-08-02
  close(grossUpFactorWeighted([novo], "2026-08-02"), 1 / 0.775);
  const antigo = { amount: 1300, amountOriginal: 1000, issueDate: "2023-01-01" }; // >720d ⇒ 15%
  close(grossUpFactorWeighted([antigo], "2026-08-02"), 1 / 0.85);
  const semData = { amount: 1100, amountOriginal: 1000 };
  close(grossUpFactorWeighted([semData], "2026-08-02"), 1 / 0.85);
  // ponderação: rendimentos 100 (22,5%) e 300 (15%)
  const f = grossUpFactorWeighted([novo, antigo], "2026-08-02");
  close(f, (100 * (1 / 0.775) + 300 * (1 / 0.85)) / 400);
  assert.equal(grossUpFactorWeighted([], "2026-08-02"), 1);
});

/* ---------- Adaptador de snapshot ---------- */

test("snapshotToDay: filtra ACTIVE, soma taxes e extrai assets do payload", () => {
  const payload = JSON.stringify([
    { id: "A", status: "ACTIVE", amount: 1100, amountOriginal: 1000, balance: 1080, taxes: 15, taxes2: 5 },
    { id: "B", status: "TOTAL_WITHDRAWAL", amount: 500, amountOriginal: 500, balance: 500, taxes: 9 },
  ]);
  const day = snapshotToDay({ date: "2026-07-01", payload });
  assert.equal(day.gross, 1100);
  assert.equal(day.original, 1000);
  assert.equal(day.balance, 1080);
  assert.equal(day.taxes, 20);
  assert.deepEqual(day.assets, [{ id: "A", gross: 1100, original: 1000 }]);
});

test("snapshotToDay: usa os totais da linha quando presentes", () => {
  const day = snapshotToDay({
    date: "2026-07-01",
    total_gross: 999,
    total_original: 900,
    total_balance: 990,
    payload: "[]",
  });
  assert.equal(day.gross, 999);
  assert.equal(day.original, 900);
  assert.equal(day.balance, 990);
});
