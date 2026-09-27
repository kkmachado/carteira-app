import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, mirroredIds, normalizeMerchant, cityOf, topCategory, buildGastos, addMonth } from "../lib/gastos.js";

const cats = new Map([
  ["18000000", { name: "Saúde" }],
  ["18030000", { name: "Ótica", parentId: "18000000" }],
  ["10000000", { name: "Supermercado" }],
  ["05000000", { name: "Transferências" }],
  ["05100000", { name: "Pagamento de cartão de crédito", parentId: "05000000" }],
  ["05050000", { name: "Transferência - Mesma instituição", parentId: "05000000" }],
  ["08000000", { name: "Compras" }],
  ["03000000", { name: "Investimentos" }],
  ["04000000", { name: "Transferência mesma titularidade" }],
  ["07000000", { name: "Serviços" }],
  ["07010000", { name: "Telecomunicação", parentId: "07000000" }],
]);

const card = (o) => ({ accountType: "CREDIT", accountId: "c", status: "POSTED", currency: "BRL", ...o });
const bank = (o) => ({ accountType: "BANK", accountId: "b", status: "POSTED", currency: "BRL", ...o });

const BILLS = [
  { id: "b-jul", accountId: "c", dueDate: "2026-07-06T00:00:00.000Z", totalAmount: 300 },
  { id: "b-ago", accountId: "c", dueDate: "2026-08-06T00:00:00.000Z", totalAmount: 10000 },
];

test("addMonth vira o ano", () => {
  assert.equal(addMonth("2026-12"), "2027-01");
  assert.equal(addMonth("2026-01", -1), "2025-12");
});

test("classify: pagamento de fatura no cartão, pelas duas formas que a Pluggy usa", () => {
  assert.equal(classify(card({ amount: -300, categoryId: "05100000", description: "Pagamento recebido" })), "pagamento");
  assert.equal(classify(card({ amount: -300, categoryId: "05050000", description: "PAGAMENTO DEBITO AUTOMATICO" })), "pagamento");
  assert.equal(classify(card({ amount: -40.23, categoryId: "08000000", description: "CANCELAMENTO PARCIAL DE COMPRA" })), "estorno");
  assert.equal(classify(card({ amount: 50, categoryId: "08000000", description: "X" })), "gasto");
});

test("classify: fatura paga pela conta é reconhecida pelo valor, qualquer que seja a categoria", () => {
  // nos dados reais a mesma fatura veio como Investments, sem categoria e como Credit card payment
  for (const categoryId of ["03000000", null, "05100000"])
    assert.equal(classify(bank({ amount: -10000, categoryId, description: "Débito automático FATURA", date: "2026-08-06T10:00:00Z" }), BILLS), "pagamento_fatura");
  // cartão fora da análise: é gasto (único rastro daquele consumo)
  assert.equal(classify(bank({ amount: -8000, categoryId: "03000000", description: "Pagamento de boleto Fatura Cartao BTG Pactual", date: "2026-08-03T10:00:00Z" }), BILLS), "fatura_externa");
  assert.equal(classify(bank({ amount: -50, categoryId: "05100000", description: "Débito automático ITAU BLACK", date: "2026-01-06T10:00:00Z" }), BILLS), "fatura_externa");
});

test("classify: conta — transferência própria, investimento, receita e gasto", () => {
  assert.equal(classify(bank({ amount: -500, categoryId: "04000000", description: "Transferência enviada" })), "transferencia_propria");
  assert.equal(classify(bank({ amount: -1000, categoryId: "03000000", description: "Saída PREMIO VGBL" })), "investimento");
  assert.equal(classify(bank({ amount: 35000, categoryId: "03000000", description: "Resgate CDB DI" })), "investimento");
  assert.equal(classify(bank({ amount: 100, categoryId: "05000000", description: "Pix recebido" })), "receita");
  assert.equal(classify(bank({ amount: -80, categoryId: "05000000", description: "Pix enviado Fulana" })), "gasto");
});

test("topCategory sobe até o nível 1", () => {
  assert.equal(topCategory("18030000", cats), "Saúde");
  assert.equal(topCategory("99", cats), "Outros");
  assert.equal(topCategory(null, cats), "Outros");
  assert.equal(topCategory("03000000", cats, "fatura_externa"), "Faturas de outros cartões");
});

test("normalizeMerchant limpa cidade, país, parcela e subadquirente", () => {
  assert.equal(normalizeMerchant("AMAZON BR              SAO PAULO     BRA"), "AMAZON BR");
  assert.equal(normalizeMerchant("LITE   *VivoEasyAn12/12"), "VIVOEASYAN");
  assert.equal(normalizeMerchant("OBA HORTIFRUTI SANTANASAO PAULOBRA"), "OBA HORTIFRUTI SANTANA");
  assert.equal(normalizeMerchant("TagItau*CARLOSMACHADO"), "TAGITAU*CARLOSMACHADO");
  assert.equal(normalizeMerchant("Compra débito Vitoralvaro"), "VITORALVARO");
  assert.equal(normalizeMerchant("Pix enviado Paula Gomes"), "PAULA GOMES");
});

test("normalizeMerchant: formato fixo e colado caem no mesmo nome", () => {
  const fixo = "PETZ DIGITAL           EMBU          BRA";
  assert.equal(fixo.length, 40);
  assert.equal(cityOf(fixo), "EMBU");
  assert.equal(normalizeMerchant(fixo), "PETZ DIGITAL");
  assert.equal(normalizeMerchant("PETZ DIGITALEMBUBRA", ["EMBU"]), "PETZ DIGITAL");
  assert.equal(normalizeMerchant("8400  GRSA CARBON BLIN BARUERI       BRA"), "GRSA CARBON BLIN");
  assert.equal(normalizeMerchant("MERCADOLIVRE*MERCADOL  Jundia        BRA"), "MERCADOLIVRE");
  assert.equal(normalizeMerchant("PET SHOP DO SHEIK LTD  SAO PAULO     BRA"), "PET SHOP DO SHEIK LTD");
  assert.equal(normalizeMerchant("TagItau     *RecargaSAO PAULOBRA"), "TAGITAU*RECARGA");
});

test("buildGastos (cartão): reconcilia com a fatura, exclui pagamento, abate estorno e acha o outlier", () => {
  const txs = [
    card({ id: "1", amount: 300, categoryId: "10000000", description: "MERCADO A", billId: "b-jul", date: "2026-06-10T03:00:00Z", cardNumber: "2505" }),
    card({ id: "2", amount: -300, categoryId: "05100000", description: "Pagamento recebido", billId: "b-ago", date: "2026-07-06T03:00:00Z" }),
    card({ id: "3", amount: 8000, categoryId: "18030000", description: "LEMMAR", billId: "b-ago", date: "2026-07-27T03:00:00Z", cardNumber: "2505" }),
    card({ id: "4", amount: 2040, categoryId: "10000000", description: "MERCADO A", billId: "b-ago", date: "2026-07-20T03:00:00Z", cardNumber: "2618" }),
    card({ id: "5", amount: -40, categoryId: "10000000", description: "CANCELAMENTO", billId: "b-ago", date: "2026-07-21T03:00:00Z", cardNumber: "2618" }),
    // fatura aberta (setembro) e uma compra que a Pluggy previu para a fatura já fechada
    card({ id: "6", amount: 100, categoryId: "10000000", description: "MERCADO A", billForecast: "2026-09", status: "PENDING", date: "2026-08-10T03:00:00Z", cardNumber: "2618" }),
    card({ id: "7", amount: 60, categoryId: "08000000", description: "SHEIN", billForecast: "2026-08", status: "PENDING", date: "2026-08-17T03:00:00Z", cardNumber: "2618" }),
    // parcela futura
    card({ id: "8", amount: 30, categoryId: "07010000", description: "LITE *Vivo 12/12", billForecast: "2027-01", status: "PENDING", date: "2027-01-06T03:00:00Z", cardNumber: "2618", instN: 12, instTotal: 12 }),
    // internacional: vale o valor convertido
    card({ id: "9", amount: 10.8, amountBrl: 58, currency: "USD", categoryId: "08000000", description: "OPENROUTER, INCNEW YORKUSA", billId: "b-ago", date: "2026-07-15T03:00:00Z", cardNumber: "2505" }),
  ];
  const holders = { 2505: "Carlos", 2618: "Juliana" };
  const g = buildGastos({ txs, bills: BILLS, cats, fonte: "cartao", n: 2, holders, today: "2026-08-20" });

  assert.equal(g.openMonth, "2026-09");
  // janela numérica = só faturas fechadas
  assert.deepEqual(g.periods.map((p) => p.key), ["2026-07", "2026-08"]);
  const [jul, ago] = g.periods;
  const atual = buildGastos({ txs, bills: BILLS, cats, fonte: "cartao", n: "atual", holders, today: "2026-08-20" });
  assert.deepEqual(atual.periods.map((p) => p.key), ["2026-09"]);
  const set = atual.periods[0];
  assert.equal(set.label, "venc. 06/09"); // dia do vencimento herdado da última fechada
  assert.deepEqual(atual.ref.map((r) => [r.key, r.total]), [["2026-06", 0], ["2026-07", 300], ["2026-08", 10058]]);
  assert.equal(jul.total, 300);
  assert.equal(jul.diff, 0);
  assert.equal(ago.total, 8000 + 2040 - 40 + 58);
  assert.equal(ago.pluggyTotal, 10000);
  assert.equal(ago.diff, 10000 - 10058);
  assert.equal(ago.count, 3); // estorno não conta como lançamento
  assert.equal(ago.outlier.merchant, "LEMMAR");
  assert.equal(ago.outlier.cat, "Saúde");
  assert.equal(ago.internacional, 58);
  assert.equal(set.aberta, true);
  assert.equal(set.total, 160); // inclui a compra que a Pluggy previu para a fatura fechada
  assert.deepEqual(g.futuras.map((f) => [f.key, f.total]), [["2027-01", 30]]);
  assert.equal(g.categories[0].name, "Saúde");
  assert.equal(g.merchants.find((m) => m.name === "LEMMAR").atipico, true);
  assert.deepEqual(g.holders.map((h) => h.name), ["Carlos", "Juliana"]);
  assert.equal(g.holders[0].total, 8058 + 300);
  // lista completa: o pagamento aparece, marcado como fora do total
  const pag = g.txs.find((t) => t.k === "pagamento");
  assert.equal(pag.fora, true);
  assert.equal(g.txs.filter((t) => !t.fora).length, 5);
  // MERCADO A aparece nas duas faturas fechadas: recorrente
  assert.deepEqual(g.recurring.map((r) => r.name), ["MERCADO A"]);
  assert.equal(g.totals.fora.pagamentos, 300);
});

test("buildGastos (tudo): mês civil nas duas fontes, e a fatura paga pela conta não conta em dobro", () => {
  const txs = [
    card({ id: "1", amount: 10000, categoryId: "10000000", description: "MERCADO", billId: "b-ago", date: "2026-07-20T03:00:00Z" }),
    card({ id: "1b", amount: 70, categoryId: "10000000", description: "MERCADO", billForecast: "2026-09", status: "PENDING", date: "2026-08-12T03:00:00Z" }),
    bank({ id: "2", amount: -10000, categoryId: "03000000", description: "Débito automático FATURA ITAU PERSON", date: "2026-08-06T10:00:00Z" }),
    bank({ id: "3", amount: -8000, categoryId: "03000000", description: "Pagamento de boleto Fatura Cartao BTG Pactual", date: "2026-08-03T10:00:00Z" }),
    bank({ id: "4", amount: -120, categoryId: "08000000", description: "Compra débito Loja", date: "2026-08-10T10:00:00Z" }),
    bank({ id: "5", amount: 5000, categoryId: "05000000", description: "TED recebida", date: "2026-08-05T10:00:00Z" }),
  ];
  const jul = buildGastos({ txs, bills: BILLS, cats, fonte: "tudo", n: 1, today: "2026-08-20" }).periods[0];
  const g = buildGastos({ txs, bills: BILLS, cats, fonte: "tudo", n: "atual", today: "2026-08-20" });
  assert.equal(jul.key, "2026-07");
  const [ago] = g.periods;
  assert.equal(ago.key, "2026-08");
  assert.equal(jul.total, 10000); // compra de julho, embora a fatura vença em agosto
  assert.equal(ago.total, 70 + 8000 + 120);
  assert.equal(ago.entradas, 5000);
  assert.ok(ago.byCategory.some((c) => c.name === "Faturas de outros cartões" && c.value === 8000));
  assert.equal(g.totals.fora.pagamentos, 10000);
});

test("classify: investimento pela descrição e transferência espelhada entre contas", () => {
  assert.equal(classify(bank({ amount: -49996.61, categoryId: "08000000", description: "Saída COR ITAUCOR COMPRA TD" })), "investimento");
  assert.equal(classify(bank({ amount: 9924.98, categoryId: "05000000", description: "Resgate INT RESGATE GOLDMFICFI" })), "investimento");
  const txs = [
    bank({ id: "d", accountId: "corrente", amount: -22898.05, categoryId: "05000000", description: "Transferência enviada TRANSF SALDO BASE DIA 1", date: "2026-08-01T10:00:00Z" }),
    bank({ id: "c", accountId: "poupanca", amount: 22898.05, categoryId: "05000000", description: "Transferência recebida TRANSF SALDO BASE DIA", date: "2026-08-01T11:00:00Z" }),
    bank({ id: "x", accountId: "corrente", amount: -80, categoryId: "05000000", description: "Pix enviado Fulana", date: "2026-08-01T10:00:00Z" }),
  ];
  const m = mirroredIds(txs);
  assert.deepEqual([...m].sort(), ["c", "d"]);
  assert.equal(classify(txs[0], [], m), "transferencia_propria");
  assert.equal(classify(txs[2], [], m), "gasto");
});
