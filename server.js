import express from "express";
import Database from "better-sqlite3";
import cron from "node-cron";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { initBenchmarks, updateBenchmarks, getBenchmarks, isStale } from "./lib/benchmarks.js";
import {
  snapshotToDay,
  dailyReturns,
  accumulate,
  accumulateRange,
  sumIncomeRange,
  rateSeries,
  ibovSeries,
  percentOfCdi,
  monthlyBreakdown,
  periodStartISO,
  daysByGroup,
  grossUpFactorWeighted,
} from "./lib/performance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_ID, PORT = 3000, DB_PATH } = process.env;

/* Modo demo (`npm run demo`): serve um banco de dados fictício e nunca chama a
   Pluggy — nem credenciais, nem escrita no banco real. Só para validar telas. */
const DEMO = process.env.DEMO === "1";

if (!DEMO && (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET || !PLUGGY_ITEM_ID)) {
  console.warn("⚠️  Defina PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITEM_ID no .env");
}

/* ---------- SQLite: snapshots diários ---------- */
const db = new Database(DB_PATH || path.join(__dirname, "data", "carteira.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD
    total_balance REAL NOT NULL,
    total_original REAL NOT NULL,
    total_gross REAL NOT NULL,
    payload TEXT NOT NULL            -- JSON completo do dia
  );
  CREATE TABLE IF NOT EXISTS investment_txs (
    investment_id TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,        -- ISO da última busca na Pluggy
    payload TEXT NOT NULL            -- JSON das movimentações (mais recente primeiro)
  );
`);
initBenchmarks(db);

/* Dia corrente em São Paulo. `toISOString()` daria o dia UTC, que a partir das 21h
   (BRT) já virou: o snapshot da noite nasceria datado de amanhã e o gráfico
   ganharia um ponto no futuro. */
const todaySP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

function firstSnapshotDate() {
  return db.prepare("SELECT MIN(date) AS d FROM snapshots").get()?.d || null;
}

/* ---------- Auth Pluggy (apiKey expira em 2h) ---------- */
let cachedKey = null;
let cachedKeyAt = 0;

async function getApiKey() {
  const AGE_LIMIT = 110 * 60 * 1000; // renova antes das 2h
  if (cachedKey && Date.now() - cachedKeyAt < AGE_LIMIT) return cachedKey;
  const res = await fetch("https://api.pluggy.ai/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Pluggy /auth ${res.status}: ${await res.text()}`);
  const { apiKey } = await res.json();
  cachedKey = apiKey;
  cachedKeyAt = Date.now();
  return apiKey;
}

async function pluggy(pathAndQuery, options = {}) {
  const apiKey = await getApiKey();
  const res = await fetch(`https://api.pluggy.ai${pathAndQuery}`, {
    ...options,
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Pluggy ${pathAndQuery} ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ---------- Núcleo ---------- */
async function fetchInvestments() {
  const data = await pluggy(`/investments?itemId=${PLUGGY_ITEM_ID}&pageSize=500`);
  return data.results || [];
}

function saveSnapshot(investments) {
  const active = investments.filter((a) => a.status === "ACTIVE");
  const total_balance = active.reduce((s, a) => s + (a.balance || 0), 0);
  const total_original = active.reduce((s, a) => s + (a.amountOriginal || 0), 0);
  const total_gross = active.reduce((s, a) => s + (a.amount || 0), 0);
  const date = todaySP();
  db.prepare(
    `INSERT INTO snapshots (date, total_balance, total_original, total_gross, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       total_balance=excluded.total_balance,
       total_original=excluded.total_original,
       total_gross=excluded.total_gross,
       payload=excluded.payload`
  ).run(date, total_balance, total_original, total_gross, JSON.stringify(investments));
  return { date, total_balance };
}

/* ---------- API ---------- */
const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Carteira atual (dados da Pluggy) + grava snapshot do dia.
// `sync` descreve o frescor do lado do banco: quando a Pluggy coletou pela última
// vez e quando coletará de novo. Falha ao ler o item não derruba a carteira.
app.get("/api/portfolio", async (_req, res) => {
  if (DEMO) {
    const last = db.prepare("SELECT * FROM snapshots ORDER BY date DESC LIMIT 1").get();
    if (!last) return res.status(503).json({ error: "banco demo vazio: rode `npm run seed:demo`" });
    return res.json({
      syncedAt: `${last.date}T12:00:00Z`,
      demo: true,
      sync: { lastUpdatedAt: `${last.date}T14:13:00Z`, nextAutoSyncAt: null, status: "UPDATED", connector: "Demo" },
      investments: JSON.parse(last.payload),
    });
  }
  try {
    const [investments, item] = await Promise.all([
      fetchInvestments(),
      pluggy(`/items/${PLUGGY_ITEM_ID}`).catch(() => null),
    ]);
    saveSnapshot(investments);
    res.json({
      syncedAt: new Date().toISOString(),
      sync: item && {
        lastUpdatedAt: item.lastUpdatedAt || null,
        nextAutoSyncAt: item.nextAutoSyncAt || null,
        status: item.status || null,
        connector: item.connector?.name || null,
      },
      investments,
    });
  } catch (err) {
    // fallback: último snapshot salvo, para o app abrir mesmo sem internet/Pluggy fora
    const last = db.prepare("SELECT * FROM snapshots ORDER BY date DESC LIMIT 1").get();
    if (last) {
      return res.json({
        syncedAt: `${last.date}T12:00:00Z`, // meio-dia UTC: exibe o dia certo no fuso de SP
        stale: true,
        error: String(err.message || err),
        investments: JSON.parse(last.payload),
      });
    }
    res.status(502).json({ error: String(err.message || err) });
  }
});

/* Movimentações de um ativo (aplicações/resgates) — `/investments/{id}/transactions`.
   O detalhe do ativo só é aberto sob toque, então a busca é sob demanda e fica em
   cache no SQLite: a lista quase nunca muda (só quando há aporte ou resgate) e o
   item só sincroniza 1x/dia. Pluggy fora → devolve o cache marcado como `stale`. */
const TX_TTL_MS = 12 * 60 * 60 * 1000;

app.get("/api/investments/:id/transactions", async (req, res) => {
  const id = req.params.id;
  // o id vai concatenado na URL da Pluggy: só aceita o formato de id que ela emite
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).json({ error: "id inválido" });

  const cached = db.prepare("SELECT fetched_at, payload FROM investment_txs WHERE investment_id = ?").get(id);
  const fresh = cached && Date.now() - Date.parse(cached.fetched_at) < TX_TTL_MS;
  if (DEMO || fresh) {
    return res.json({
      transactions: cached ? JSON.parse(cached.payload) : [],
      cachedAt: cached?.fetched_at || null,
      ...(DEMO ? { demo: true } : {}),
    });
  }

  try {
    const data = await pluggy(`/investments/${id}/transactions?pageSize=200`);
    const txs = (data.results || []).sort((a, b) =>
      String(b.tradeDate || b.date || "").localeCompare(String(a.tradeDate || a.date || ""))
    );
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO investment_txs (investment_id, fetched_at, payload) VALUES (?, ?, ?)
       ON CONFLICT(investment_id) DO UPDATE SET fetched_at=excluded.fetched_at, payload=excluded.payload`
    ).run(id, now, JSON.stringify(txs));
    res.json({ transactions: txs, cachedAt: now });
  } catch (err) {
    if (cached) {
      return res.json({
        transactions: JSON.parse(cached.payload),
        cachedAt: cached.fetched_at,
        stale: true,
        error: String(err.message || err),
      });
    }
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Histórico para o gráfico de evolução
app.get("/api/history", (_req, res) => {
  const rows = db
    .prepare("SELECT date, total_balance, total_original, total_gross FROM snapshots ORDER BY date ASC")
    .all();
  res.json(rows);
});

// Séries de benchmarks (CDI/IPCA/Selic via SGS, IBOV via Yahoo) do cache SQLite.
// Se o cache não foi atualizado hoje, busca incremental antes de responder;
// falha em uma fonte não impede a resposta (vai o que houver em cache + erros).
app.get("/api/benchmarks", async (req, res) => {
  const from = req.query.from || firstSnapshotDate() || undefined;
  let errors = {};
  if (isStale(db)) {
    ({ errors } = await updateBenchmarks(db, { startISO: from }));
  }
  const data = getBenchmarks(db, from);
  res.json({ ...data, ...(Object.keys(errors).length ? { errors } : {}) });
});

/* ---------- Rentabilidade (spec-rentabilidade.md) ---------- */

const ISENTOS = new Set(["LCA", "LCI"]);
const minusDayISO = (iso) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

// Janelas da tabela por categoria: [from exclusivo, to inclusivo]
function windowRanges(lastISO) {
  const startOfMonth = `${lastISO.slice(0, 7)}-01`;
  const prevMonthEnd = minusDayISO(startOfMonth);
  const prevPrevEnd = minusDayISO(`${prevMonthEnd.slice(0, 7)}-01`);
  return {
    mesAtual: [prevMonthEnd, lastISO],
    mesAnterior: [prevPrevEnd, prevMonthEnd],
    m12: [periodStartISO("12m", lastISO), lastISO],
    ano: [`${Number(lastISO.slice(0, 4)) - 1}-12-31`, lastISO],
  };
}

// Rendimento, TWR e TWR com gross up em cada janela. Para um grupo homogêneo
// (categoria isenta ou ativo), gross up escala o rendimento ⇒ r_g = r × fator.
function windowsFor(rets, factor, ranges) {
  const out = {};
  for (const [key, [from, to]] of Object.entries(ranges)) {
    const acc = accumulateRange(rets, from, to);
    out[key] = {
      income: sumIncomeRange(rets, from, to),
      acc,
      accGrossUp:
        factor === 1
          ? acc
          : rets.reduce((f, r) => (r.date > from && r.date <= to ? f * (1 + r.r * factor) : f), 1) - 1,
    };
  }
  return out;
}

/* Retornos da carteira com gross up: o rendimento diário das categorias isentas
   é bruto-equivalizado pelo fator da categoria; o denominador não muda. */
function grossedReturns(rows, rets, lastActive, refISO) {
  const factors = new Map();
  for (const sub of ISENTOS) {
    const assets = lastActive.filter((a) => a.subtype === sub);
    if (assets.length) factors.set(sub, grossUpFactorWeighted(assets, refISO));
  }
  if (!factors.size) return rets;
  const catDays = daysByGroup(rows, (a) => a.subtype);
  const incomeByCat = new Map(
    [...factors.keys()].map((sub) => [
      sub,
      new Map(dailyReturns(catDays.get(sub) || []).map((r) => [r.date, r.income])),
    ])
  );
  return rets.map((r) => {
    let income = r.income;
    for (const [sub, f] of factors) income += (incomeByCat.get(sub).get(r.date) || 0) * (f - 1);
    return { date: r.date, income, r: r.denom > 0 ? income / r.denom : 0 };
  });
}

const accSeries = (fromISO, rets) => {
  const out = [{ date: fromISO, acc: 0 }];
  let f = 1;
  for (const r of rets) {
    f *= 1 + r.r;
    out.push({ date: r.date, acc: f - 1 });
  }
  return out;
};

// Tudo que o frontend de rentabilidade precisa para um período:
// hero (Rendeu, % do CDI), séries do gráfico 1, barras mensais, tabela por categoria.
// Gross up não é parâmetro: a resposta traz as duas versões e o toggle é client-side.
app.get("/api/performance", async (req, res) => {
  try {
    const period = String(req.query.period || "max");
    const rows = db
      .prepare("SELECT date, total_balance, total_original, total_gross, payload FROM snapshots ORDER BY date ASC")
      .all();
    if (!rows.length) return res.json({ empty: true });

    const days = rows.map(snapshotToDay);
    const rets = dailyReturns(days);
    const lastISO = days[days.length - 1].date;
    const lastActive = JSON.parse(rows[rows.length - 1].payload).filter((a) => a.status === "ACTIVE");

    // recorte do período: baseline = último snapshot ≤ início pedido (ou o 1º da série)
    const startWanted = periodStartISO(period, lastISO);
    let baseIdx = 0;
    if (startWanted) for (let i = 0; i < days.length; i++) if (days[i].date <= startWanted) baseIdx = i;
    const fromISO = days[baseIdx].date;

    const gRets = grossedReturns(rows, rets, lastActive, lastISO);
    const periodRets = rets.filter((r) => r.date > fromISO);
    const gPeriodRets = gRets.filter((r) => r.date > fromISO);
    const acc = accumulate(periodRets);
    const accGrossUp = accumulate(gPeriodRets);
    const income = periodRets.reduce((s, r) => s + r.income, 0);

    // benchmarks no mesmo range (cache SQLite; atualiza 1x/dia se defasado)
    if (isStale(db)) await updateBenchmarks(db, { startISO: firstSnapshotDate() });
    const bench = getBenchmarks(db, fromISO);
    const benchmarks = {
      cdi: rateSeries(bench.cdi || [], fromISO, lastISO),
      selic: rateSeries(bench.selic || [], fromISO, lastISO),
      ipca: rateSeries(bench.ipca || [], fromISO, lastISO),
      ibov: ibovSeries(bench.ibov || [], fromISO, lastISO),
    };
    const cdiAcc = benchmarks.cdi.length ? benchmarks.cdi[benchmarks.cdi.length - 1].acc : 0;

    // tabela por categoria (subtype) e por ativo
    const ranges = windowRanges(lastISO);
    const totalBalance = lastActive.reduce((s, a) => s + (a.balance || 0), 0);
    const catDays = daysByGroup(rows, (a) => a.subtype);
    const categories = [...catDays]
      .map(([subtype, ds]) => {
        const assets = lastActive.filter((a) => a.subtype === subtype);
        const balance = assets.reduce((s, a) => s + (a.balance || 0), 0);
        const factor = ISENTOS.has(subtype) && assets.length ? grossUpFactorWeighted(assets, lastISO) : 1;
        return {
          subtype,
          balance,
          share: totalBalance > 0 ? balance / totalBalance : 0,
          isento: ISENTOS.has(subtype),
          windows: windowsFor(dailyReturns(ds), factor, ranges),
          assetIds: assets.map((a) => a.id),
        };
      })
      .filter((c) => c.balance > 0)
      .sort((a, b) => b.balance - a.balance);

    const assetDays = daysByGroup(rows, (a) => a.id);
    const assets = {};
    for (const a of lastActive) {
      const ds = assetDays.get(a.id);
      if (!ds) continue;
      const factor = ISENTOS.has(a.subtype) ? grossUpFactorWeighted([a], lastISO) : 1;
      assets[a.id] = { windows: windowsFor(dailyReturns(ds), factor, ranges) };
    }

    res.json({
      period,
      from: fromISO,
      to: lastISO,
      historySince: days[0].date,
      hero: {
        income,
        acc,
        accGrossUp,
        cdi: cdiAcc,
        pctCdi: percentOfCdi(acc, cdiAcc),
        pctCdiGrossUp: percentOfCdi(accGrossUp, cdiAcc),
      },
      twr: accSeries(fromISO, periodRets),
      twrGrossUp: accSeries(fromISO, gPeriodRets),
      benchmarks,
      monthly: monthlyBreakdown(days),
      categories,
      assets,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Healthcheck do Coolify: não depende da Pluggy
app.get("/api/health", (_req, res) => {
  const last = db.prepare("SELECT date, total_balance FROM snapshots ORDER BY date DESC LIMIT 1").get();
  res.json({ ok: true, uptime: Math.round(process.uptime()), lastSnapshot: last?.date || null });
});

/* Não existe rota de sync sob demanda: o item MeuPluggy é proxy da conexão original
   e a Pluggy recusa o PATCH ("MeuPluggy item cant be updated"). O frescor dos dados
   vem em `sync` no /api/portfolio. */

/* ---------- Snapshot automático diário (12:00) ----------
   Depois do auto-sync do item na Pluggy (~11:13, ciclo de 24h ancorado na última
   coleta): assim o snapshot do dia reflete a coleta do próprio dia. */
if (!DEMO) cron.schedule("0 12 * * *", async () => {
  try {
    const investments = await fetchInvestments();
    const snap = saveSnapshot(investments);
    console.log(`📸 Snapshot ${snap.date}: R$ ${snap.total_balance.toFixed(2)}`);
  } catch (err) {
    console.error("Falha no snapshot diário:", err.message);
  }
  const { errors } = await updateBenchmarks(db, { startISO: firstSnapshotDate() });
  for (const [serie, msg] of Object.entries(errors)) console.error(`Falha ao atualizar ${serie}:`, msg);
}, { timezone: "America/Sao_Paulo" });

app.listen(PORT, () => console.log(`Carteira rodando em http://0.0.0.0:${PORT}`));
