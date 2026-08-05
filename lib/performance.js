/* Cálculos de rentabilidade e evolução patrimonial — spec-rentabilidade.md.
   Módulo puro: recebe arrays ordenados por data, não conhece SQLite nem Pluggy.

   Representação de um dia (adaptada dos snapshots pelo chamador ou via snapshotToDay):
     { date: "YYYY-MM-DD", gross, original, balance?, taxes?, assets? }
   assets (opcional): [{ id, gross, original }] — só os ATIVE do dia. Quando presente,
   o fluxo do dia é calculado por ativo, o que trata corretamente resgates totais
   (o dinheiro sai pelo valor BRUTO, não pelo principal). */

/* ---------- Fluxos e retornos diários (TWR / Modified Dietz simples) ---------- */

/* Aporte/retirada entre dois dias. Com ativos: aporte de ativo novo entra pelo
   amountOriginal, resgate de ativo que sumiu sai pelo gross do dia anterior,
   ativo presente nos dois dias contribui com Δoriginal (aporte adicional).
   Sem ativos: fallback Δtotal_original (spec) — sujeito a artefato em resgate total. */
export function flowBetween(prev, curr) {
  if (prev.assets && curr.assets) {
    const prevById = new Map(prev.assets.map((a) => [a.id, a]));
    const currIds = new Set(curr.assets.map((a) => a.id));
    let flow = 0;
    for (const c of curr.assets) {
      const p = prevById.get(c.id);
      flow += p ? c.original - p.original : c.original;
    }
    for (const p of prev.assets) if (!currIds.has(p.id)) flow -= p.gross;
    return flow;
  }
  return curr.original - prev.original;
}

/* Retornos entre snapshots consecutivos. Dia sem snapshot (feriado/falha) vira um
   único período maior — o produto acumulado não é afetado. O primeiro dia da série
   é só a base: não gera retorno. Denominador ≤ 0 (carteira zerada) ⇒ r = 0. */
export function dailyReturns(days) {
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const curr = days[i];
    const flow = flowBetween(prev, curr);
    const income = curr.gross - prev.gross - flow;
    const denom = prev.gross + flow;
    const r = denom > 0 ? income / denom : 0;
    out.push({ date: curr.date, flow, income, denom, r });
  }
  return out;
}

/* ∏(1 + r) − 1. Aceita números ou objetos { r }. */
export function accumulate(returns) {
  return returns.reduce((acc, x) => acc * (1 + (typeof x === "number" ? x : x.r)), 1) - 1;
}

/* ∏(1 + r) − 1 apenas dos retornos com data em (fromISO, toISO]. Mesma convenção
   dos benchmarks: o retorno datado em `d` cobre o período que TERMINA em `d`. */
export function accumulateRange(rets, fromISO, toISO) {
  return rets.reduce((f, r) => (r.date > fromISO && r.date <= toISO ? f * (1 + r.r) : f), 1) - 1;
}

/* Soma dos rendimentos em R$ com data em (fromISO, toISO]. */
export function sumIncomeRange(rets, fromISO, toISO) {
  return rets.reduce((s, r) => (r.date > fromISO && r.date <= toISO ? s + r.income : s), 0);
}

/* Série acumulada para o gráfico: [{ date, acc }], começando em 0 no primeiro dia. */
export function twrSeries(days) {
  if (!days.length) return [];
  const out = [{ date: days[0].date, acc: 0 }];
  let factor = 1;
  for (const ret of dailyReturns(days)) {
    factor *= 1 + ret.r;
    out.push({ date: ret.date, acc: factor - 1 });
  }
  return out;
}

/* ---------- Benchmarks acumulados no mesmo período ---------- */
/* Convenção de range: (from, to] — o retorno da carteira entre o snapshot de `from`
   e o de `to` cobre os dias APÓS `from`, então o índice acumula nas mesmas datas. */

/* CDI/Selic: séries SGS diárias (% ao dia útil); só existem linhas em dia útil. */
export function rateSeries(rows, fromISO, toISO) {
  const out = [];
  let factor = 1;
  for (const row of rows) {
    if (row.date <= fromISO || row.date > toISO) continue;
    factor *= 1 + row.value / 100;
    out.push({ date: row.date, acc: factor - 1 });
  }
  return out;
}

export function rateAccumulated(rows, fromISO, toISO) {
  const serie = rateSeries(rows, fromISO, toISO);
  return serie.length ? serie[serie.length - 1].acc : 0;
}

export const cdiSeries = rateSeries;
export const cdiAccumulated = rateAccumulated;

/* IPCA: série SGS 433 mensal (% a.m., datada no dia 1º do mês de referência).
   Degrau mensal; o mês parcial do início do range fica de fora. */
export const ipcaSeries = rateSeries;
export const ipcaAccumulated = rateAccumulated;

/* IBOV: pontos de fechamento. A base é o último fechamento ATÉ `fromISO` — fora do
   range, como o snapshot que abre o período — e a série cobre (from, to], igual às
   taxas. Usar o primeiro fechamento DE DENTRO do range jogava fora a variação do
   primeiro dia sempre que `fromISO` caía em fim de semana ou feriado.
   Sem fechamento anterior ao range, o primeiro de dentro vira base (e vale 0). */
export function ibovSeries(rows, fromISO, toISO) {
  let base = null;
  const out = [];
  for (const r of rows) {
    if (r.date <= fromISO) {
      base = r.value;
      continue;
    }
    if (r.date > toISO) break;
    if (base == null) {
      base = r.value;
      out.push({ date: r.date, acc: 0 });
      continue;
    }
    out.push({ date: r.date, acc: base > 0 ? r.value / base - 1 : 0 });
  }
  return out;
}

export function ibovAccumulated(rows, fromISO, toISO) {
  const serie = ibovSeries(rows, fromISO, toISO);
  return serie.length ? serie[serie.length - 1].acc : 0;
}

/* % do CDI: rentabilidade da carteira ÷ CDI acumulado × 100. */
export function percentOfCdi(accCarteira, accCdi) {
  if (!(accCdi > 0)) return null;
  return (accCarteira / accCdi) * 100;
}

/* ---------- Gross up (tabela regressiva de IR) ---------- */

export function irAliquot(daysHeld) {
  if (daysHeld <= 180) return 0.225;
  if (daysHeld <= 360) return 0.2;
  if (daysHeld <= 720) return 0.175;
  return 0.15;
}

/* Rendimento equivalente bruto de um ativo isento (LCA/LCI). */
export function grossUp(income, daysHeld) {
  return income / (1 - irAliquot(daysHeld));
}

/* Fator médio de gross up de um conjunto de ativos isentos (payload da Pluggy),
   ponderado pelo rendimento acumulado de cada um (fallback: valor bruto). Prazo
   decorrido a partir de issueDate/date; sem data ⇒ alíquota conservadora de 15%. */
export function grossUpFactorWeighted(assets, refISO) {
  let wSum = 0;
  let fSum = 0;
  for (const a of assets) {
    const startISO = String(a.issueDate || a.date || "").slice(0, 10);
    const held = startISO
      ? Math.round((Date.parse(`${refISO}T12:00:00Z`) - Date.parse(`${startISO}T12:00:00Z`)) / 86400000)
      : Infinity;
    const f = 1 / (1 - irAliquot(held));
    const w = Math.max((a.amount || 0) - (a.amountOriginal || 0), 0) || a.amount || 1;
    wSum += w;
    fSum += w * f;
  }
  return wSum > 0 ? fSum / wSum : 1;
}

/* ---------- Evolução patrimonial decomposta (barras mensais, estilo BTG) ---------- */

/* Agrega os dias por mês: patrimônio = último balance (fallback gross) do mês,
   rendimentos/aportes/retiradas = somas dos dias do mês, impostos = Δ(taxes) entre
   o fim do mês e o fim do mês anterior (baseline: primeiro dia da série). */
export function monthlyBreakdown(days) {
  if (days.length < 2) return [];
  const rets = dailyReturns(days);
  const byDate = new Map(rets.map((r) => [r.date, r]));

  const months = new Map(); // "YYYY-MM" → { last: day, rendimentos, aportes, retiradas }
  for (const day of days.slice(1)) {
    const key = day.date.slice(0, 7);
    if (!months.has(key)) months.set(key, { last: day, rendimentos: 0, aportes: 0, retiradas: 0 });
    const m = months.get(key);
    m.last = day;
    const ret = byDate.get(day.date);
    m.rendimentos += ret.income;
    if (ret.flow > 0) m.aportes += ret.flow;
    else m.retiradas += ret.flow;
  }

  const out = [];
  let prevTaxes = days[0].taxes ?? null;
  for (const [month, m] of [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const taxes = m.last.taxes ?? null;
    out.push({
      month,
      patrimonio: m.last.balance ?? m.last.gross,
      rendimentos: m.rendimentos,
      aportes: m.aportes,
      retiradas: m.retiradas,
      impostos: taxes != null && prevTaxes != null ? taxes - prevTaxes : null,
    });
    if (taxes != null) prevTaxes = taxes;
  }
  return out;
}

/* ---------- Períodos do seletor ---------- */

/* Data inicial do período em relação a `refISO` (hoje). "ytd" = 1º de janeiro,
   "Nm" = N meses atrás, "max" = null (todo o histórico). Overflow de fim de mês
   segue o comportamento do Date (31/mai − 3m ⇒ 2/mar ou 3/mar), suficiente aqui. */
export function periodStartISO(period, refISO) {
  if (!period || period === "max") return null;
  if (period === "ytd") return `${refISO.slice(0, 4)}-01-01`;
  const match = /^(\d+)m$/.exec(period);
  if (!match) return null;
  const d = new Date(`${refISO}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - Number(match[1]));
  return d.toISOString().slice(0, 10);
}

/* ---------- Agrupamentos a partir dos payloads ---------- */

/* Constrói uma série de dias por grupo (ex.: keyOf = a ⇒ a.subtype, ou a ⇒ a.id)
   a partir das linhas de snapshot. Grupo ausente num dia vira dia zerado (gross 0),
   o que dá fluxo de resgate correto via assets quando a categoria some. */
export function daysByGroup(rows, keyOf) {
  const keys = new Set();
  const parsed = rows.map((row) => {
    const inv = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const active = (inv || []).filter((a) => a.status === "ACTIVE");
    for (const a of active) keys.add(keyOf(a));
    return { date: row.date, active };
  });
  const out = new Map();
  for (const key of keys) {
    out.set(
      key,
      parsed.map(({ date, active }) => {
        const assets = active.filter((a) => keyOf(a) === key);
        return {
          date,
          gross: assets.reduce((s, a) => s + (a.amount || 0), 0),
          original: assets.reduce((s, a) => s + (a.amountOriginal || 0), 0),
          balance: assets.reduce((s, a) => s + (a.balance || 0), 0),
          taxes: assets.reduce((s, a) => s + (a.taxes || 0) + (a.taxes2 || 0), 0),
          assets: assets.map((a) => ({ id: a.id, gross: a.amount || 0, original: a.amountOriginal || 0 })),
        };
      })
    );
  }
  return out;
}

/* ---------- Adaptador de snapshot ---------- */

/* Converte uma linha da tabela `snapshots` (payload = JSON da Pluggy) num dia.
   Considera só status ACTIVE; taxes = IR provisionado (taxes + taxes2). */
export function snapshotToDay(row) {
  const investments = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  const active = (investments || []).filter((a) => a.status === "ACTIVE");
  return {
    date: row.date,
    gross: row.total_gross ?? active.reduce((s, a) => s + (a.amount || 0), 0),
    original: row.total_original ?? active.reduce((s, a) => s + (a.amountOriginal || 0), 0),
    balance: row.total_balance ?? active.reduce((s, a) => s + (a.balance || 0), 0),
    taxes: active.reduce((s, a) => s + (a.taxes || 0) + (a.taxes2 || 0), 0),
    assets: active.map((a) => ({ id: a.id, gross: a.amount || 0, original: a.amountOriginal || 0 })),
  };
}
