#!/usr/bin/env node
/**
 * kalshi-feed — pulls public Kalshi market prices on a schedule, saves them
 * to ./data, and (optionally) pushes them to a private GitHub repo so Claude
 * can read them from any chat.
 *
 * No API key needed: Kalshi's market-data endpoints are public.
 * Requires Node 18+ (uses built-in fetch). No npm packages.
 *
 * Usage:
 *   node kalshi-feed.js --discover basketball   # find series tickers
 *   node kalshi-feed.js --once                  # one snapshot, then exit
 *   node kalshi-feed.js                         # run forever (use PM2)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA = path.join(ROOT, 'data');
const API = 'https://api.elections.kalshi.com/trade-api/v2';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP ----------
async function get(pathAndQuery, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(API + pathAndQuery, { headers: { accept: 'application/json' } });
      if (res.status === 429) { await sleep(2000 * i); continue; }   // rate limited
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathAndQuery}`);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(1000 * i);
    }
  }
}

// Page through /markets for one series (status=open by default).
async function marketsForSeries(seriesTicker) {
  const out = [];
  let cursor = '';
  do {
    const q = new URLSearchParams({ series_ticker: seriesTicker, limit: '1000' });
    if (config.status) q.set('status', config.status);
    if (cursor) q.set('cursor', cursor);
    const j = await get('/markets?' + q.toString());
    out.push(...(j.markets || []));
    cursor = j.cursor || '';
    await sleep(250); // be polite
  } while (cursor);
  return out;
}

// ---------- normalize ----------
// Kalshi has returned prices both as integer cents (yes_ask: 52) and as
// dollar strings (yes_ask_dollars: "0.52"). Handle both -> cents (0-100).
function cents(m, field) {
  if (typeof m[field] === 'number') return m[field];
  const d = m[field + '_dollars'];
  if (d !== undefined && d !== null && d !== '') return Math.round(parseFloat(d) * 100);
  return null;
}

function normalize(m, seriesTicker) {
  const yesAsk = cents(m, 'yes_ask');
  const noAsk = cents(m, 'no_ask');
  return {
    series: seriesTicker,
    event_ticker: m.event_ticker,
    ticker: m.ticker,
    title: m.title,
    yes_label: m.yes_sub_title || m.subtitle || '',
    no_label: m.no_sub_title || '',
    yes_bid: cents(m, 'yes_bid'),
    yes_ask: yesAsk,                 // what it costs to BUY Yes, in cents
    no_bid: cents(m, 'no_bid'),
    no_ask: noAsk,                   // what it costs to BUY No, in cents
    last: cents(m, 'last_price'),
    // Kalshi app "payout multiplier" ≈ 100 / price (before fees)
    yes_mult: yesAsk ? +(100 / yesAsk).toFixed(2) : null,
    no_mult: noAsk ? +(100 / noAsk).toFixed(2) : null,
    volume: m.volume ?? null,
    open_interest: m.open_interest ?? null,
    close_time: m.close_time || m.expected_expiration_time || null,
    status: m.status,
  };
}

// ---------- writing ----------
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const CSV_COLS = ['series', 'event_ticker', 'ticker', 'title', 'yes_label', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'last', 'yes_mult', 'no_mult', 'volume', 'close_time'];

function writeCSV(file, rows) {
  const lines = [CSV_COLS.join(',')].concat(rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(',')));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function appendHistoryRows(rows, at) {
  const day = at.slice(0, 10);
  const file = path.join(DATA, 'history', `${day}.csv`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = 'time,ticker,yes_bid,yes_ask,no_ask,last,volume\n';
  if (!fs.existsSync(file)) fs.writeFileSync(file, header);
  const body = rows.map((r) => [at, r.ticker, r.yes_bid, r.yes_ask, r.no_ask, r.last, r.volume].map(csvCell).join(',')).join('\n');
  fs.appendFileSync(file, body + '\n');
}

// Gzip any history file older than today, and delete files (csv or csv.gz) older than keepDays.
function pruneHistory() {
  const dir = path.join(DATA, 'history');
  if (!fs.existsSync(dir)) return;
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = Date.now() - (config.historyKeepDays || 60) * 86400000;
  for (const f of fs.readdirSync(dir)) {
    const day = f.replace(/\.csv(\.gz)?$/, '');
    const t = Date.parse(day);
    if (isNaN(t)) continue;
    const full = path.join(dir, f);
    if (t < cutoff) { fs.unlinkSync(full); continue; }
    if (day !== today && f.endsWith('.csv')) {
      fs.writeFileSync(full + '.gz', zlib.gzipSync(fs.readFileSync(full)));
      fs.unlinkSync(full);
    }
  }
}

// ---------- change-only history + permanent archive ----------
let lastHistoryBaselineAt = 0;
const historyLastValues = new Map(); // ticker -> last written {yes_bid, yes_ask, last}

const ARCHIVE_DIR = path.join(DATA, 'archive');
const ARCHIVE_STATE_PATH = path.join(ARCHIVE_DIR, 'state.json');
let archiveState = {};
try { archiveState = JSON.parse(fs.readFileSync(ARCHIVE_STATE_PATH, 'utf8')); } catch (_) { archiveState = {}; }

// Sport comes from the series prefix (longest/most specific prefix first).
function sportFromSeries(series) {
  if (series.startsWith('KXNCAAMB')) return 'ncaamb';
  if (series.startsWith('KXNCAAF')) return 'ncaaf';
  if (series.startsWith('KXNFL')) return 'nfl';
  if (series.startsWith('KXNBA')) return 'nba';
  if (series.startsWith('KXMLB')) return 'mlb';
  return series.toLowerCase();
}

// Season label by sport, from the UTC date a market was first seen.
// nfl/ncaaf: season = the fall it started (Jan/Feb playoffs belong to the
// prior year's season). nba/ncaamb: "YYYY-YY" starting in October, same
// reasoning for the spring half of the season. Everything else (mlb etc):
// plain calendar year.
function seasonFor(sport, atIso) {
  const d = new Date(atIso);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (sport === 'nfl' || sport === 'ncaaf') return String(month >= 8 ? year : year - 1);
  if (sport === 'nba' || sport === 'ncaamb') {
    const startYear = month >= 10 ? year : year - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  return String(year);
}

// Markets already open when archive tracking first went live — their
// first_seen/first_yes_ask reflect that moment, not when the market
// actually opened, so callers can tell the difference.
const ARCHIVE_TRACKING_START = '2026-11-27T03:29:47.291Z';

const ARCHIVE_COLS = ['ticker', 'event_ticker', 'yes_label', 'first_seen', 'first_yes_ask', 'first_seen_is_tracking_start', 'last_seen', 'last_yes_bid', 'last_yes_ask', 'last_last', 'min_yes_bid', 'max_yes_bid', 'rows_recorded', 'result', 'settled_at'];

function appendArchiveRow(entry) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const file = path.join(ARCHIVE_DIR, `${entry.sport}-markets-${entry.season}.csv`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, ARCHIVE_COLS.join(',') + '\n');
  fs.appendFileSync(file, ARCHIVE_COLS.map((c) => csvCell(entry[c])).join(',') + '\n');
}

// All markets for one event, for checking settlement of a batch of closed
// markets at once instead of one API call per market.
async function marketsForEvent(eventTicker) {
  const out = [];
  let cursor = '';
  do {
    const q = new URLSearchParams({ event_ticker: eventTicker, limit: '1000' });
    if (cursor) q.set('cursor', cursor);
    const j = await get('/markets?' + q.toString());
    out.push(...(j.markets || []));
    cursor = j.cursor || '';
    await sleep(100);
  } while (cursor);
  return out;
}

const SETTLEMENT_GIVEUP_MS = 7 * 86400000; // give up waiting for a result after 7 days
const MAX_EVENT_LOOKUPS_PER_CYCLE = 40; // cap settlement-lookup work per cycle so a big settlement wave can't block the 5-min loop

// For series in historySeries: write a history row only when yes_bid, yes_ask
// or last changed since that ticker's last written row, except once every
// historyEveryMinutes when every tracked market gets a full baseline row.
// Also maintains data/archive/state.json: once a market drops out of the
// open-markets list (skipped for series whose fetch errored this cycle, so a
// transient API failure doesn't look like every market on it closing), it's
// grouped with other pending markets by event_ticker and checked once a
// cycle (one API call per event, capped at MAX_EVENT_LOOKUPS_PER_CYCLE
// events/cycle — leftovers just wait in state.json for the next cycle) until
// it reports an official result, which is when it's finalized into
// data/archive/<sport>-markets-<season>.csv. After 7 days of no result, it's
// finalized anyway as result=unsettled.
async function syncHistoryAndArchive(rows, at, okSeries) {
  const only = config.historySeries && config.historySeries.length ? new Set(config.historySeries) : null;
  const filtered = only ? rows.filter((r) => only.has(r.series)) : rows;

  const now = Date.now();
  const isBaseline = now - lastHistoryBaselineAt >= (config.historyEveryMinutes || 30) * 60000;
  if (isBaseline) lastHistoryBaselineAt = now;

  const toWrite = [];
  const seenTickers = new Set();

  for (const r of filtered) {
    seenTickers.add(r.ticker);
    const prev = historyLastValues.get(r.ticker);
    const changed = !prev || prev.yes_bid !== r.yes_bid || prev.yes_ask !== r.yes_ask || prev.last !== r.last;
    const write = isBaseline || changed;
    if (write) toWrite.push(r);
    historyLastValues.set(r.ticker, { yes_bid: r.yes_bid, yes_ask: r.yes_ask, last: r.last });

    let a = archiveState[r.ticker];
    if (!a) {
      const sport = sportFromSeries(r.series);
      a = archiveState[r.ticker] = {
        series: r.series,
        sport,
        season: seasonFor(sport, at),
        event_ticker: r.event_ticker,
        yes_label: r.yes_label,
        first_seen: at,
        first_yes_ask: r.yes_ask,
        first_seen_is_tracking_start: at === ARCHIVE_TRACKING_START ? 'Y' : 'N',
        min_yes_bid: r.yes_bid,
        max_yes_bid: r.yes_bid,
        rows_recorded: 0,
      };
    }
    a.last_seen = at;
    a.last_yes_bid = r.yes_bid;
    a.last_yes_ask = r.yes_ask;
    a.last_last = r.last;
    if (r.yes_bid !== null) {
      if (a.min_yes_bid === null || r.yes_bid < a.min_yes_bid) a.min_yes_bid = r.yes_bid;
      if (a.max_yes_bid === null || r.yes_bid > a.max_yes_bid) a.max_yes_bid = r.yes_bid;
    }
    if (write) a.rows_recorded += 1;
  }

  if (toWrite.length) appendHistoryRows(toWrite, at);

  // Group every market that's dropped out of the open list by event, so
  // settlement can be checked with one API call per event instead of one
  // per market.
  const pendingByEvent = new Map(); // event_ticker -> [ticker, ...]
  for (const ticker of Object.keys(archiveState)) {
    const a = archiveState[ticker];
    if (seenTickers.has(ticker)) {
      if (a.disappeared_at) delete a.disappeared_at; // reappeared: wasn't actually closed
      continue;
    }
    if (!a.disappeared_at) {
      if (!okSeries.has(a.series)) continue; // series fetch failed this cycle, don't judge yet
      a.disappeared_at = at;
    }
    if (!pendingByEvent.has(a.event_ticker)) pendingByEvent.set(a.event_ticker, []);
    pendingByEvent.get(a.event_ticker).push(ticker);
  }

  // Oldest-checked-first: an event's priority is the oldest last_checked_at
  // among its pending tickers (never-checked = 0, i.e. highest priority), so
  // one event that keeps coming back unsettled can't starve events that
  // haven't had a turn in longer.
  const oldestCheck = (tickers) => Math.min(...tickers.map((t) => {
    const lc = archiveState[t].last_checked_at;
    return lc ? Date.parse(lc) : 0;
  }));

  const settleStart = Date.now();
  const events = [...pendingByEvent.keys()]
    .sort((e1, e2) => oldestCheck(pendingByEvent.get(e1)) - oldestCheck(pendingByEvent.get(e2)))
    .slice(0, MAX_EVENT_LOOKUPS_PER_CYCLE);
  let marketsChecked = 0;
  let finalized = 0;

  for (const eventTicker of events) {
    const tickers = pendingByEvent.get(eventTicker);
    let markets = [];
    try {
      markets = await marketsForEvent(eventTicker);
    } catch (e) {
      log(`settlement fetch failed for event ${eventTicker}:`, e.message);
    }
    const byTicker = new Map(markets.map((m) => [m.ticker, m]));

    for (const ticker of tickers) {
      const a = archiveState[ticker];
      const m = byTicker.get(ticker);
      marketsChecked++;
      a.last_checked_at = at;

      const settled = m && (m.result === 'yes' || m.result === 'no');
      const giveUp = Date.now() - Date.parse(a.disappeared_at) >= SETTLEMENT_GIVEUP_MS;

      if (settled) {
        appendArchiveRow({ ...a, ticker, result: m.result, settled_at: m.settlement_ts || at });
      } else if (giveUp) {
        appendArchiveRow({ ...a, ticker, result: 'unsettled', settled_at: '' });
      } else {
        continue; // still pending settlement, now at the back of next cycle's queue
      }
      delete archiveState[ticker];
      historyLastValues.delete(ticker);
      finalized++;
    }
  }

  if (events.length) {
    log(`settlement check: ${events.length} events, ${marketsChecked} markets checked, ${finalized} finalized, ${Date.now() - settleStart}ms`);
  }

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(ARCHIVE_STATE_PATH, JSON.stringify(archiveState));

  if (isBaseline) pruneHistory();
}

// ---------- revive dropped series ----------
const CLAUDE_INSTRUCTIONS_PATH = path.join(ROOT, 'CLAUDE-INSTRUCTIONS.md');
const ANYTD = 'KXNFLANYTD';

// KXNFLANYTD was dropped 2026-11-26 for returning 0 open markets. Once a day,
// check whether it has open markets again; only then add it back.
async function checkAnytdRevival() {
  if (config.series.includes(ANYTD)) return;
  let markets;
  try {
    markets = await marketsForSeries(ANYTD);
  } catch (e) {
    return log('KXNFLANYTD revival check failed:', e.message);
  }
  if (!markets.length) return log('KXNFLANYTD revival check: still 0 open markets, not re-adding');

  config.series.push(ANYTD);
  if (!config.historySeries.includes(ANYTD)) config.historySeries.push(ANYTD);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  updateClaudeInstructionsForAnytd();
  log(`KXNFLANYTD revived: ${markets.length} open markets found, added back to series + historySeries`);
}

function updateClaudeInstructionsForAnytd() {
  if (!fs.existsSync(CLAUDE_INSTRUCTIONS_PATH)) return;
  let txt = fs.readFileSync(CLAUDE_INSTRUCTIONS_PATH, 'utf8');
  txt = txt.replace(
    '- `KXNFLPASSYDS`, `KXNFLRSHYDS`, `KXNFLRECYDS`, `KXNFLREC`: NFL passing yards / rushing yards / receiving yards / receptions (player props)',
    '- `KXNFLANYTD`, `KXNFLPASSYDS`, `KXNFLRSHYDS`, `KXNFLRECYDS`, `KXNFLREC`: NFL anytime TD / passing yards / rushing yards / receiving yards / receptions (player props)'
  );
  txt = txt.replace(
    /\*\*Dropped 2026-11-26\*\*[^\n]*\n/,
    `**Dropped 2026-11-26** (0 markets for 24h+, removed from \`config.json\`): \`KXNBAPTS\`, \`KXNBAREB\`, \`KXNBAAST\`, \`KXNBA3PT\`. \`KXNFLANYTD\` was re-added automatically on ${new Date().toISOString().slice(0, 10)} once it started returning open markets again.\n`
  );
  fs.writeFileSync(CLAUDE_INSTRUCTIONS_PATH, txt);
}

// ---------- git ----------
function sh(cmd) { return execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString().trim(); }

// Each push replaces the repo with a single commit instead of stacking a new
// one on top, so the repo only ever holds the current snapshot (no history growth).
function gitPush(at) {
  if (!config.git || !config.git.enabled) return;
  const branch = config.git.branch || 'main';
  try {
    const changed = sh('git status --porcelain data');
    if (!changed) return log('git: nothing new');
    try { sh('git branch -D __snapshot'); } catch (_) {}
    sh('git checkout --orphan __snapshot --quiet');
    sh('git add -A');
    sh(`git commit -m "snapshot ${at}" --quiet`);
    sh(`git branch -M ${branch}`);
    sh(`git push --force --quiet origin ${branch}`);
    sh('git reflog expire --expire=now --all');
    sh('git gc --prune=now --aggressive --quiet');
    log('git: pushed (squashed)');
  } catch (e) {
    log('git push failed:', (e.stderr || e.message || '').toString().slice(0, 300));
  }
}

// ---------- one snapshot ----------
let lastPushAt = 0;
let lastAnytdCheckAt = 0;

async function snapshot() {
  const at = new Date().toISOString();

  const now0 = Date.now();
  if (now0 - lastAnytdCheckAt >= 86400000) {
    await checkAnytdRevival();
    lastAnytdCheckAt = now0;
  }

  const all = [];
  const counts = {};
  for (const s of config.series) {
    try {
      const rows = (await marketsForSeries(s)).map((m) => normalize(m, s));
      counts[s] = rows.length;
      all.push(...rows);
      writeJSON(path.join(DATA, 'latest', `${s}.json`), { updated_at: at, series: s, markets: rows });
    } catch (e) {
      counts[s] = 'ERROR: ' + e.message;
      log(`series ${s} failed:`, e.message);
    }
  }

  // One combined file + CSV — the files Claude reads first.
  writeJSON(path.join(DATA, 'latest.json'), { updated_at: at, counts, markets: all });
  writeCSV(path.join(DATA, 'latest.csv'), all);
  writeJSON(path.join(DATA, 'status.json'), { updated_at: at, counts, interval_minutes: config.intervalMinutes });

  const okSeries = new Set(config.series.filter((s) => typeof counts[s] === 'number'));
  await syncHistoryAndArchive(all, at, okSeries);

  const now = Date.now();
  log(`snapshot: ${all.length} markets`, JSON.stringify(counts));

  if (now - lastPushAt >= (config.git?.pushEveryMinutes || 15) * 60000) {
    gitPush(at);
    lastPushAt = now;
  }
}

// ---------- discover ----------
async function discover(keyword) {
  const kw = (keyword || '').toLowerCase();
  const j = await get('/series');
  const list = (j.series || []).filter((s) =>
    !kw || `${s.ticker} ${s.title} ${s.category} ${(s.tags || []).join(' ')}`.toLowerCase().includes(kw));
  for (const s of list) console.log(`${s.ticker.padEnd(28)} ${s.category || ''} | ${s.title}`);
  console.log(`\n${list.length} series matched "${keyword || '*'}". Copy the tickers you want into config.json -> "series".`);
}

// ---------- main ----------
(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--discover') return discover(args.slice(1).join(' '));
  if (args[0] === '--once') { await snapshot(); return; }

  log(`kalshi-feed started: ${config.series.length} series every ${config.intervalMinutes} min`);
  for (;;) {
    try { await snapshot(); } catch (e) { log('snapshot failed:', e.message); }
    await sleep(config.intervalMinutes * 60000);
  }
})().catch((e) => { console.error(e); process.exit(1); });
