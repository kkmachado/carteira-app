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
  CREATE TABLE IF NOT EXISTS manual_assets (
    id TEXT PRIMARY KEY,             -- "manual:<slug>"
    name TEXT NOT NULL,
    issuer TEXT,
    subtype TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived_at TEXT                 -- null = na carteira
  );
  CREATE TABLE IF NOT EXISTS manual_values (
    asset_id TEXT NOT NULL,
    date TEXT NOT NULL,              -- data de referência da marcação (YYYY-MM-DD)
    balance REAL NOT NULL,           -- saldo lido no app da instituição
    original REAL NOT NULL,          -- total aportado até a data
    PRIMARY KEY (asset_id, date)
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

/* Lista vazia é sinal de falha da Pluggy (item desconectado, resposta parcial),
   não de carteira zerada: resgate real vem com os ativos em TOTAL_WITHDRAWAL, não
   com a lista sumindo. Gravar zeros corromperia o histórico de forma permanente —
   o snapshot fica salvo e vira um par aporte/retirada fantasma nas barras mensais. */
function saveSnapshot(investments, lastUpdatedAt) {
  if (!investments.length) {
    console.warn("Snapshot ignorado: a Pluggy devolveu lista vazia de investimentos");
    return null;
  }
  const date = snapshotDateFor(lastUpdatedAt);
  const payload = [...investments, ...manualInvestments(date)];
  const totals = totalsOf(payload);
  writeSnapshot(date, payload, totals);

  /* Snapshot datado DEPOIS da última coleta da Pluggy não pode ter dado próprio:
     só nasceu da datagem por relógio que existia antes (app aberto de madrugada
     gravava o dia novo com os números da véspera). Sobra como um dia de
     rendimento zero no gráfico. Só rows futuras em relação a esta coleta são
     apagadas — o passado fica como está, e as marcações manuais sobrevivem em
     `manual_values`, então o próximo snapshot do dia as recupera. */
  const fantasmas = db.prepare("SELECT date FROM snapshots WHERE date > ?").all(date);
  if (fantasmas.length) {
    db.prepare("DELETE FROM snapshots WHERE date > ?").run(date);
    console.log(`🧹 Snapshots sem coleta própria removidos: ${fantasmas.map((r) => r.date).join(", ")}`);
  }

  return { date, payload, ...totals };
}

/* Data do snapshot = o dia em que a Pluggy COLETOU o dado, não o dia do relógio.
   O item sincroniza 1x/dia por volta das 11:13: entre a meia-noite e o auto-sync,
   a carteira devolvida ainda é a de ontem. Datando pelo relógio, abrir o app à
   0h30 gravava um snapshot de hoje com os números de ontem — um ponto novo no
   gráfico sem dado novo, e um dia de rendimento zero no TWR. Datando pela coleta,
   essa mesma abertura só reescreve o snapshot de ontem, com o mesmo conteúdo.
   Sem `lastUpdatedAt` (falha ao ler o item), cai no dia corrente. */
function snapshotDateFor(lastUpdatedAt) {
  const hoje = todaySP();
  if (!lastUpdatedAt) return hoje;
  const t = Date.parse(lastUpdatedAt);
  if (Number.isNaN(t)) return hoje;
  const dia = new Date(t).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  // relógio do container adiantado/atrasado não pode datar snapshot no futuro
  return dia > hoje ? hoje : dia;
}

function totalsOf(investments) {
  const active = investments.filter((a) => a.status === "ACTIVE");
  return {
    total_balance: active.reduce((s, a) => s + (a.balance || 0), 0),
    total_original: active.reduce((s, a) => s + (a.amountOriginal || 0), 0),
    total_gross: active.reduce((s, a) => s + (a.amount || 0), 0),
  };
}

function writeSnapshot(date, payload, totals) {
  db.prepare(
    `INSERT INTO snapshots (date, total_balance, total_original, total_gross, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       total_balance=excluded.total_balance,
       total_original=excluded.total_original,
       total_gross=excluded.total_gross,
       payload=excluded.payload`
  ).run(date, totals.total_balance, totals.total_original, totals.total_gross, JSON.stringify(payload));
}

/* ---------- Ativos manuais (previdência) ----------
   A Pluggy não representa previdência: `type` só aceita MUTUAL_FUND, SECURITY,
   EQUITY, FIXED_INCOME, ETF, COE e OTHER, e nenhum conector do Itaú traz produto
   de seguros/previdência. A saída é marcar o saldo à mão, de tempos em tempos.

   Os ativos manuais entram no payload do snapshot no formato da Pluggy, com
   `source: "manual"` — assim /api/history, os KPIs e a lista de ativos herdam a
   previdência sem contrato novo, e quem precisa separar filtra pela flag. */
const isManual = (a) => a.source === "manual";

const manualRow = (id) =>
  db.prepare("SELECT * FROM manual_assets WHERE id = ? AND archived_at IS NULL").get(id);

/* Marcação vigente numa data: a mais recente com date ≤ ref (carry-forward do
   último valor conhecido, como o app já faz com a Pluggy fora). Antes da primeira
   marcação o ativo simplesmente não existe — não se inventa passado. */
function manualInvestments(refISO) {
  const assets = db
    .prepare("SELECT * FROM manual_assets WHERE archived_at IS NULL ORDER BY name")
    .all();
  const vigente = db.prepare(
    "SELECT date, balance, original FROM manual_values WHERE asset_id = ? AND date <= ? ORDER BY date DESC LIMIT 1"
  );
  const primeira = db.prepare("SELECT MIN(date) AS d FROM manual_values WHERE asset_id = ?");
  const out = [];
  for (const asset of assets) {
    const v = vigente.get(asset.id, refISO);
    if (!v) continue;
    out.push({
      id: asset.id,
      name: asset.name,
      issuer: asset.issuer || null,
      type: "PENSION",
      subtype: asset.subtype,
      status: "ACTIVE",
      balance: v.balance,
      // previdência não tem IR provisionado como os CDBs (a tributação incide no
      // resgate): bruto = líquido é mais honesto que inventar uma provisão
      amount: v.balance,
      amountOriginal: v.original,
      amountProfit: null,
      taxes: null,
      taxes2: null,
      rate: null,
      rateType: null,
      fixedAnnualRate: null,
      dueDate: null,
      issueDate: primeira.get(asset.id).d,
      source: "manual",
      markedAt: v.date,
    });
  }
  return out;
}

/* Reescreve a parte manual dos snapshots a partir de `fromISO`. Uma marcação nova
   (ou corrigida) vale para todos os dias a partir da data dela: sem isso a
   previdência apareceria só no snapshot do dia em que foi digitada e o gráfico de
   patrimônio ganharia um degrau falso. Os ativos da Pluggy não são tocados. */
function rebuildManualInSnapshots(fromISO) {
  const rows = db
    .prepare("SELECT date, payload FROM snapshots WHERE date >= ? ORDER BY date ASC")
    .all(fromISO || "0000-00-00");
  db.transaction(() => {
    for (const row of rows) {
      const payload = [
        ...JSON.parse(row.payload).filter((a) => !isManual(a)),
        ...manualInvestments(row.date),
      ];
      writeSnapshot(row.date, payload, totalsOf(payload));
    }
  })();
  return rows.length;
}

/* ---------- API ---------- */
const app = express();
app.use(express.json({ limit: "64kb" }));
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
      dataDate: last.date,
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
    const snap = saveSnapshot(investments, item?.lastUpdatedAt);
    res.json({
      syncedAt: new Date().toISOString(),
      // dia a que os números se referem (a coleta da Pluggy), que entre a
      // meia-noite e o auto-sync ainda é ontem — o cabeçalho mostra este
      dataDate: snap ? snap.date : snapshotDateFor(item?.lastUpdatedAt),
      sync: item && {
        lastUpdatedAt: item.lastUpdatedAt || null,
        nextAutoSyncAt: item.nextAutoSyncAt || null,
        status: item.status || null,
        connector: item.connector?.name || null,
      },
      // os manuais só entram pelo snapshot: se ele não foi gravado (lista vazia da
      // Pluggy), a carteira devolvida é a da Pluggy, sem inventar composição
      investments: snap ? snap.payload : investments,
    });
  } catch (err) {
    // fallback: último snapshot salvo, para o app abrir mesmo sem internet/Pluggy fora
    const last = db.prepare("SELECT * FROM snapshots ORDER BY date DESC LIMIT 1").get();
    if (last) {
      return res.json({
        syncedAt: `${last.date}T12:00:00Z`, // meio-dia UTC: exibe o dia certo no fuso de SP
        dataDate: last.date,
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

/* ---------- Ativos manuais: CRUD ---------- */

const MANUAL_SUBTYPES = new Set(["PENSION", "OTHER"]);
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const isManualId = (s) => /^manual:[a-z0-9-]{1,48}$/.test(s);

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const slugify = (s) =>
  "manual:" +
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

// Lista os ativos manuais com o histórico completo de marcações (para o painel).
app.get("/api/manual", (_req, res) => {
  const assets = db
    .prepare("SELECT * FROM manual_assets WHERE archived_at IS NULL ORDER BY name")
    .all();
  const values = db.prepare(
    "SELECT date, balance, original FROM manual_values WHERE asset_id = ? ORDER BY date DESC"
  );
  res.json({
    assets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      issuer: a.issuer,
      subtype: a.subtype,
      values: values.all(a.id),
    })),
  });
});

app.post("/api/manual", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const issuer = String(req.body?.issuer || "").trim().slice(0, 80) || null;
  const subtype = String(req.body?.subtype || "PENSION").toUpperCase();
  if (!name) return res.status(400).json({ error: "nome obrigatório" });
  if (!MANUAL_SUBTYPES.has(subtype)) return res.status(400).json({ error: "subtype inválido" });
  const id = slugify(name);
  if (id === "manual:") return res.status(400).json({ error: "nome sem caracteres utilizáveis" });

  /* Mesmo nome de um ativo arquivado: reativa em vez de recusar. O id vem do nome,
     então bloquear deixaria o nome queimado para sempre — e reativar devolve o
     histórico de marcações, que é justamente o que se quer ao readicionar. */
  const existente = db.prepare("SELECT * FROM manual_assets WHERE id = ?").get(id);
  if (existente && !existente.archived_at)
    return res.status(409).json({ error: "já existe um ativo manual com esse nome" });
  if (existente) {
    db.prepare("UPDATE manual_assets SET archived_at = NULL, issuer = ?, subtype = ? WHERE id = ?")
      .run(issuer, subtype, id);
  } else {
    db.prepare(
      "INSERT INTO manual_assets (id, name, issuer, subtype, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, name, issuer, subtype, new Date().toISOString());
  }
  const values = db
    .prepare("SELECT date, balance, original FROM manual_values WHERE asset_id = ? ORDER BY date DESC")
    .all(id);
  // reativação traz marcações de volta: os snapshots a partir da 1ª precisam refletir
  if (values.length) rebuildManualInSnapshots(values[values.length - 1].date);
  res.json({ id, name, issuer, subtype, values });
});

/* Nova marcação. Data no futuro é recusada: o carry-forward passaria a valer para
   snapshots que ainda não existem e o valor "vazaria" para trás no rebuild. */
app.post("/api/manual/:id/values", (req, res) => {
  const { id } = req.params;
  if (!isManualId(id)) return res.status(400).json({ error: "id inválido" });
  if (!manualRow(id)) return res.status(404).json({ error: "ativo manual não encontrado" });

  const date = String(req.body?.date || "").slice(0, 10);
  const balance = num(req.body?.balance);
  const original = num(req.body?.original);
  if (!isISODate(date)) return res.status(400).json({ error: "data inválida (use AAAA-MM-DD)" });
  if (date > todaySP()) return res.status(400).json({ error: "data no futuro" });
  if (balance == null || balance < 0) return res.status(400).json({ error: "saldo inválido" });
  if (original == null || original < 0) return res.status(400).json({ error: "aplicado inválido" });

  db.prepare(
    `INSERT INTO manual_values (asset_id, date, balance, original) VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_id, date) DO UPDATE SET balance=excluded.balance, original=excluded.original`
  ).run(id, date, balance, original);
  const snapshots = rebuildManualInSnapshots(date);
  res.json({ ok: true, date, balance, original, snapshots });
});

app.delete("/api/manual/:id/values/:date", (req, res) => {
  const { id, date } = req.params;
  if (!isManualId(id)) return res.status(400).json({ error: "id inválido" });
  if (!isISODate(date)) return res.status(400).json({ error: "data inválida" });
  const { changes } = db
    .prepare("DELETE FROM manual_values WHERE asset_id = ? AND date = ?")
    .run(id, date);
  if (!changes) return res.status(404).json({ error: "marcação não encontrada" });
  res.json({ ok: true, snapshots: rebuildManualInSnapshots(date) });
});

/* Arquiva (não apaga): o ativo some da carteira de hoje em diante, mas as
   marcações ficam no banco e o histórico já gravado nos snapshots continua de pé.
   Um DELETE de verdade reescreveria o passado. */
app.delete("/api/manual/:id", (req, res) => {
  const { id } = req.params;
  if (!isManualId(id)) return res.status(400).json({ error: "id inválido" });
  if (!manualRow(id)) return res.status(404).json({ error: "ativo manual não encontrado" });
  db.prepare("UPDATE manual_assets SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  res.json({ ok: true, snapshots: rebuildManualInSnapshots(todaySP()) });
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
    const raw = db.prepare("SELECT date, payload FROM snapshots ORDER BY date ASC").all();
    if (!raw.length) return res.json({ empty: true });

    /* Ativo manual é marcado de tempos em tempos, não todo dia: entre duas
       marcações o valor fica parado e salta no dia da próxima. Nas SÉRIES DIÁRIAS
       (hero, TWR, barras mensais) isso viraria um degrau — semanas de rendimento
       caindo num dia só —, então `rows` exclui os manuais. Na tabela por categoria
       eles ficam: as janelas são intervalos (mês, ano, 12m), e o total acumulado
       de um intervalo que contém a marcação está certo. O patrimônio de
       /api/history e os KPIs continuam com tudo.
       Totais recalculados do payload filtrado — as colunas total_* incluem os
       manuais, e snapshotToDay/daysByGroup só as usam quando presentes. */
    const rowsAll = raw.map((r) => ({ date: r.date, payload: JSON.parse(r.payload) }));
    const rows = rowsAll.map((r) => ({ date: r.date, payload: r.payload.filter((a) => !isManual(a)) }));

    const days = rows.map(snapshotToDay);
    const rets = dailyReturns(days);
    const lastISO = days[days.length - 1].date;
    const lastAll = rowsAll[rowsAll.length - 1].payload.filter((a) => a.status === "ACTIVE");
    const lastActive = lastAll.filter((a) => !isManual(a));
    const manualNow = lastAll.filter(isManual);

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
    // falha de uma fonte não derruba a resposta, mas precisa deixar rastro no log:
    // o SGS recusa esporadicamente e a série some da tela sem explicação
    if (isStale(db)) {
      const { errors } = await updateBenchmarks(db, { startISO: firstSnapshotDate() });
      for (const [serie, msg] of Object.entries(errors)) console.error(`Falha ao atualizar ${serie}:`, msg);
    }
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
    const totalBalance = lastAll.reduce((s, a) => s + (a.balance || 0), 0);
    const catDays = daysByGroup(rowsAll, (a) => a.subtype);
    const categories = [...catDays]
      .map(([subtype, ds]) => {
        const assets = lastAll.filter((a) => a.subtype === subtype);
        const balance = assets.reduce((s, a) => s + (a.balance || 0), 0);
        const factor = ISENTOS.has(subtype) && assets.length ? grossUpFactorWeighted(assets, lastISO) : 1;
        return {
          subtype,
          balance,
          share: totalBalance > 0 ? balance / totalBalance : 0,
          isento: ISENTOS.has(subtype),
          manual: assets.length > 0 && assets.every(isManual),
          windows: windowsFor(dailyReturns(ds), factor, ranges),
          assetIds: assets.map((a) => a.id),
        };
      })
      .filter((c) => c.balance > 0)
      .sort((a, b) => b.balance - a.balance);

    const assetDays = daysByGroup(rowsAll, (a) => a.id);
    const assets = {};
    for (const a of lastAll) {
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
      // fora do hero/TWR acima — o frontend precisa dizer isso na tela
      manualExcluded: {
        count: manualNow.length,
        balance: manualNow.reduce((s, a) => s + (a.balance || 0), 0),
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Healthcheck do Docker: não depende da Pluggy
app.get("/api/health", (_req, res) => {
  const last = db.prepare("SELECT date, total_balance FROM snapshots ORDER BY date DESC LIMIT 1").get();
  res.json({ ok: true, uptime: Math.round(process.uptime()), lastSnapshot: last?.date || null });
});

/* Não existe rota de sync sob demanda: o item MeuPluggy é proxy da conexão original
   e a Pluggy recusa o PATCH ("MeuPluggy item cant be updated"). O frescor dos dados
   vem em `sync` no /api/portfolio. */

/* ---------- Coleta automática (12:00 e 19:00) ----------
   12:00 fica depois do auto-sync do item na Pluggy (~11:13, ciclo de 24h ancorado
   na última coleta): é a passada que define o snapshot do dia.

   19:00 existe pelos benchmarks, não pela carteira — o item só sincroniza 1x/dia,
   então a carteira vem igual. O que muda à tarde: o SGS publica parte das séries
   depois do meio-dia (a Selic sai à tarde) e a B3 só fecha às 17h, com leilão até
   ~17:05 — o IBOV coletado ao meio-dia é cotação com pregão aberto, e às 19:00 já
   é fechamento consolidado. De quebra, é uma segunda chance para o snapshot quando
   a Pluggy está fora ao meio-dia; o upsert por data mantém um snapshot por dia. */
async function coletaDiaria(hora) {
  try {
    // o item vem junto só pela data da coleta: um dia em que a Pluggy não
    // sincronizou reescreve o snapshot daquele dia em vez de criar um ponto novo
    const [investments, item] = await Promise.all([
      fetchInvestments(),
      pluggy(`/items/${PLUGGY_ITEM_ID}`).catch(() => null),
    ]);
    const snap = saveSnapshot(investments, item?.lastUpdatedAt);
    if (snap) console.log(`📸 [${hora}] Snapshot ${snap.date}: R$ ${snap.total_balance.toFixed(2)}`);
    else console.error(`[${hora}] Snapshot não gravado: lista de investimentos vazia`);
  } catch (err) {
    console.error(`[${hora}] Falha no snapshot:`, err.message);
  }
  const { errors } = await updateBenchmarks(db, { startISO: firstSnapshotDate() });
  for (const [serie, msg] of Object.entries(errors)) console.error(`[${hora}] Falha ao atualizar ${serie}:`, msg);
}

if (!DEMO) {
  cron.schedule("0 12 * * *", () => coletaDiaria("12:00"), { timezone: "America/Sao_Paulo" });
  cron.schedule("0 19 * * *", () => coletaDiaria("19:00"), { timezone: "America/Sao_Paulo" });
}

app.listen(PORT, () => console.log(`Carteira rodando em http://0.0.0.0:${PORT}`));
