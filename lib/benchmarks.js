/* Benchmarks brasileiros: CDI, IPCA e Selic via SGS/Bacen, IBOV via Yahoo Finance.
   Séries cacheadas na tabela `benchmarks`; atualização incremental a partir da
   última data cacheada. Nenhuma fonte exige chave de API. */

const SGS_SERIES = { cdi: 12, ipca: 433, selic: 11 };
const ALL_SERIES = [...Object.keys(SGS_SERIES), "ibov"];
const DEFAULT_LOOKBACK_DAYS = 40; // margem para pegar o mês anterior do IPCA

export function initBenchmarks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmarks (
      series TEXT NOT NULL,
      date   TEXT NOT NULL,            -- YYYY-MM-DD
      value  REAL NOT NULL,            -- SGS: % no período; IBOV: pontos de fechamento
      PRIMARY KEY (series, date)
    );
    CREATE TABLE IF NOT EXISTS benchmarks_meta (
      series     TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL         -- ISO da última atualização bem-sucedida
    );
  `);
}

const toISO = (ddmmyyyy) => {
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y}-${m}-${d}`;
};
const toBR = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const daysAgoISO = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const minusDaysISO = (iso, days) =>
  new Date(new Date(`${iso}T12:00:00Z`).getTime() - days * 86400000).toISOString().slice(0, 10);

function upsertRows(db, series, rows) {
  if (!rows.length) return;
  const stmt = db.prepare(
    "INSERT INTO benchmarks (series, date, value) VALUES (?, ?, ?) ON CONFLICT(series, date) DO UPDATE SET value=excluded.value"
  );
  const tx = db.transaction((rs) => {
    for (const r of rs) stmt.run(series, r.date, r.value);
    db.prepare(
      "INSERT INTO benchmarks_meta (series, updated_at) VALUES (?, ?) ON CONFLICT(series) DO UPDATE SET updated_at=excluded.updated_at"
    ).run(series, new Date().toISOString());
  });
  tx(rows);
}

function lastCachedDate(db, series) {
  const row = db.prepare("SELECT MAX(date) AS d FROM benchmarks WHERE series = ?").get(series);
  return row?.d || null;
}

async function fetchSgs(code, fromISO) {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=${toBR(fromISO)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SGS ${code} HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`SGS ${code}: resposta inesperada`);
  return data
    .map((r) => ({ date: toISO(r.data), value: Number(r.valor) }))
    .filter((r) => Number.isFinite(r.value));
}

async function fetchIbov(fromISO) {
  const period1 = Math.floor(new Date(`${fromISO}T00:00:00-03:00`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ^BVSP HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ^BVSP: ${json?.chart?.error?.description || "resposta vazia"}`);
  const closes = result.indicators?.quote?.[0]?.close || [];
  return (result.timestamp || [])
    .map((ts, i) => ({
      date: new Date(ts * 1000).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }),
      value: closes[i],
    }))
    .filter((r) => Number.isFinite(r.value));
}

/* Atualiza todas as séries de forma incremental. Falha em uma fonte não derruba
   as demais: retorna { errors: { serie: mensagem } } com o que deu errado. */
export async function updateBenchmarks(db, { startISO } = {}) {
  // margem antes do primeiro snapshot: garante o mês anterior do IPCA e evita
  // range vazio no SGS (que responde 404 sem dados)
  const fallbackStart = startISO
    ? minusDaysISO(startISO, DEFAULT_LOOKBACK_DAYS)
    : daysAgoISO(DEFAULT_LOOKBACK_DAYS);
  const errors = {};

  await Promise.all(
    ALL_SERIES.map(async (series) => {
      try {
        const last = lastCachedDate(db, series);
        // recomeça no próprio último dia (upsert cobre revisão de valor)
        const from = last && last > fallbackStart ? last : fallbackStart;
        const rows = series === "ibov" ? await fetchIbov(from) : await fetchSgs(SGS_SERIES[series], from);
        upsertRows(db, series, rows);
      } catch (err) {
        errors[series] = String(err.message || err);
      }
    })
  );
  return { errors };
}

export function getBenchmarks(db, fromISO) {
  const out = {};
  for (const series of ALL_SERIES) {
    out[series] = db
      .prepare("SELECT date, value FROM benchmarks WHERE series = ? AND date >= ? ORDER BY date ASC")
      .all(series, fromISO || "0000");
  }
  const meta = db.prepare("SELECT MIN(updated_at) AS u FROM benchmarks_meta").get();
  out.updatedAt = meta?.u || null;
  return out;
}

/* Cache é considerado defasado se a última atualização não foi hoje (horário de SP). */
export function isStale(db) {
  const meta = db.prepare("SELECT MAX(updated_at) AS u FROM benchmarks_meta").get();
  if (!meta?.u) return true;
  const todaySP = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const updatedSP = new Date(meta.u).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  return updatedSP < todaySP;
}
