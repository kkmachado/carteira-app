import express from "express";
import Database from "better-sqlite3";
import cron from "node-cron";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_ID, PORT = 3000 } = process.env;

if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET || !PLUGGY_ITEM_ID) {
  console.warn("⚠️  Defina PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITEM_ID no .env");
}

/* ---------- SQLite: snapshots diários ---------- */
const db = new Database(path.join(__dirname, "data", "carteira.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD
    total_balance REAL NOT NULL,
    total_original REAL NOT NULL,
    total_gross REAL NOT NULL,
    payload TEXT NOT NULL            -- JSON completo do dia
  );
`);

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
  const date = new Date().toISOString().slice(0, 10);
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

// Carteira atual (dados da Pluggy) + grava snapshot do dia
app.get("/api/portfolio", async (_req, res) => {
  try {
    const investments = await fetchInvestments();
    saveSnapshot(investments);
    res.json({ syncedAt: new Date().toISOString(), investments });
  } catch (err) {
    // fallback: último snapshot salvo, para o app abrir mesmo sem internet/Pluggy fora
    const last = db.prepare("SELECT * FROM snapshots ORDER BY date DESC LIMIT 1").get();
    if (last) {
      return res.json({
        syncedAt: `${last.date}T00:00:00Z`,
        stale: true,
        error: String(err.message || err),
        investments: JSON.parse(last.payload),
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

// Dispara nova sincronização do item na Pluggy (busca dados frescos no banco)
app.post("/api/refresh", async (_req, res) => {
  try {
    await pluggy(`/items/${PLUGGY_ITEM_ID}`, { method: "PATCH", body: JSON.stringify({}) });
    res.json({ ok: true, message: "Sincronização disparada. Os dados novos chegam em alguns minutos." });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});

/* ---------- Snapshot automático diário (08:30) ---------- */
cron.schedule("30 8 * * *", async () => {
  try {
    const investments = await fetchInvestments();
    const snap = saveSnapshot(investments);
    console.log(`📸 Snapshot ${snap.date}: R$ ${snap.total_balance.toFixed(2)}`);
  } catch (err) {
    console.error("Falha no snapshot diário:", err.message);
  }
}, { timezone: "America/Sao_Paulo" });

app.listen(PORT, () => console.log(`Carteira rodando em http://0.0.0.0:${PORT}`));
