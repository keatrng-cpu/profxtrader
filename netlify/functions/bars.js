// bars.js
// ProFX Trading — market data source for the Replay engine.
//
// Why this exists: Replay used to require the user to hand-export a TradingView
// CSV. That gated the whole feature behind a manual step. This function fetches
// real OHLC bars for FX, real CME/CBOT/NYMEX/COMEX futures, and crypto so anyone can
// open a replay session immediately.
//
// ACCURACY: this function does NO analysis and computes NO derived figure. It
// normalizes upstream OHLC into one shape and returns it. Every statistic in the
// app is computed from these bars in deterministic client-side JS.
//
// GRACEFUL DEGRADATION: always HTTP 200 for data problems. A missing key, a
// rate limit, or a slow upstream returns { ok:false, reason } and the UI falls
// back to CSV upload. (Auth failures are the exception — see AUTH below.)
//
// AUTH: every function in this app that spends an upstream API call now sits
// behind a Supabase sign-in, because most features are paywalled. This one
// fetches billable Databento / Alpha Vantage data, so it verifies the caller's
// Supabase access token (Authorization: Bearer <token>) against Supabase's own
// /auth/v1/user endpoint — the same pattern checkout.js / portal.js /
// professor.js use — and returns 401 for anonymous callers. The public
// marketing page teases Replay with a small bundle of sample bars shipped in
// the page itself (no call to this function), so gating here costs the
// marketing page nothing while closing the endpoint to anonymous abuse.
//
// COST CONTROL: a shared in-memory response cache (cacheGet/cacheSet). The
// first signed-in visitor to request a given symbol/interval/month pays the
// upstream call; everyone asking for the same thing within the TTL is served
// from memory. This is usually the bigger cost saver, since "load the most
// recent ES 5min bars" is what most sessions ask for.
//
// HONEST CAVEAT: the cache is a plain module-level Map, not Redis/Postgres, so
// it's scoped to one warm Lambda container — Netlify may run several at once,
// each with its own cache, so the effective hit rate is best-effort, not
// exact. Fine at this scale: zero new infra, zero dependencies, still a real
// saving. Move it to Supabase only if the in-memory version proves insufficient.

'use strict';

const AV_URL = 'https://www.alphavantage.co/query';
const HANDLER_BUDGET_MS = 9200;   // stay under Netlify's ~10s cap
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BARS = 6000;            // plenty for a replay session; keeps payload sane

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=900',   // bars are historical; cache 15 min
  'X-Content-Type-Options': 'nosniff'
};

// ---- utils ---------------------------------------------------------------

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, Math.max(1, timeoutMs));
  return fetch(url, Object.assign({}, options || {}, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

function clean(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).replace(/[^A-Za-z0-9._:\/-]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function ok(body) {
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(body) };
}

// Auth failures return a real 401 (not the 200-with-reason envelope) so the
// front end can tell "you're signed out" apart from "no data for that symbol"
// and prompt a sign-in instead of offering the CSV fallback.
function unauthorized(reason) {
  return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ ok: false, reason: reason, requiresAuth: true }) };
}

// ---- auth ----------------------------------------------------------------
// Verifies the caller's Supabase access token against Supabase's own
// /auth/v1/user endpoint rather than decoding the JWT locally, so a
// stolen/expired/tampered token is rejected by Supabase, not by weaker local
// logic. Mirrors verifySupabaseUser in checkout.js / portal.js / professor.js.
async function verifySupabaseUser(token, deadline) {
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  const r = await fetchWithTimeout(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_ANON_KEY }
  }, Math.min(4000, deadline - Date.now()));
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.id ? d : null;
}

// ---- response cache ------------------------------------------------------
// Module-level Map, scoped to one warm Lambda container (see HONEST CAVEAT in
// the file header). Keyed by the exact request shape so two callers asking for
// the same window share one upstream fetch. TTL matches the Cache-Control
// max-age above (historical bars don't change), with a hard entry cap so a
// long-lived container can't leak memory across many distinct symbols.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const _cache = new Map();

function cacheKey(symbol, interval, month, full, from, to) {
  return symbol + '|' + interval + '|' + (month || '') + '|' + (full ? '1' : '0') + '|' + (from || '') + '|' + (to || '');
}

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return hit.body;
}

function cacheSet(key, body) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest inserted entry (Map preserves insertion order).
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { ts: Date.now(), body: body });
}

// ---- instrument catalogue -------------------------------------------------
// Futures now come from Databento — real CME/CBOT/NYMEX/COMEX data via the
// GLBX.MDP3 dataset, continuous front-month contracts (e.g. ES.c.0). This
// replaces the earlier ETF-proxy approximation (NQ via QQQ, etc.) with the
// actual instrument. FX and crypto stay on Alpha Vantage below — Databento's
// dataset catalog covers equities, futures, and options; it does not carry
// spot FX or crypto, so there is no like-for-like swap for those here.

const CATALOG = {
  // FX majors — spot FX from Alpha Vantage
  EURUSD: { kind: 'fx', from: 'EUR', to: 'USD', label: 'EUR/USD' },
  GBPUSD: { kind: 'fx', from: 'GBP', to: 'USD', label: 'GBP/USD' },
  USDJPY: { kind: 'fx', from: 'USD', to: 'JPY', label: 'USD/JPY' },
  AUDUSD: { kind: 'fx', from: 'AUD', to: 'USD', label: 'AUD/USD' },
  USDCAD: { kind: 'fx', from: 'USD', to: 'CAD', label: 'USD/CAD' },
  USDCHF: { kind: 'fx', from: 'USD', to: 'CHF', label: 'USD/CHF' },
  NZDUSD: { kind: 'fx', from: 'NZD', to: 'USD', label: 'NZD/USD' },
  EURJPY: { kind: 'fx', from: 'EUR', to: 'JPY', label: 'EUR/JPY' },
  GBPJPY: { kind: 'fx', from: 'GBP', to: 'JPY', label: 'GBP/JPY' },

  // index & commodity futures — real CME/CBOT/NYMEX/COMEX data via Databento,
  // continuous front-month contract (root symbol + ".c.0")
  NQ:  { kind: 'futures', root: 'NQ',  label: 'NQ E-mini Nasdaq (CME, continuous front month)' },
  MNQ: { kind: 'futures', root: 'MNQ', label: 'MNQ Micro Nasdaq (CME, continuous front month)' },
  ES:  { kind: 'futures', root: 'ES',  label: 'ES E-mini S&P (CME, continuous front month)' },
  MES: { kind: 'futures', root: 'MES', label: 'MES Micro S&P (CME, continuous front month)' },
  YM:  { kind: 'futures', root: 'YM',  label: 'YM E-mini Dow (CBOT, continuous front month)' },
  RTY: { kind: 'futures', root: 'RTY', label: 'RTY E-mini Russell (CME, continuous front month)' },
  CL:  { kind: 'futures', root: 'CL',  label: 'CL Crude (NYMEX, continuous front month)' },
  GC:  { kind: 'futures', root: 'GC',  label: 'GC Gold (COMEX, continuous front month)' },

  // crypto
  BTCUSD: { kind: 'crypto', coin: 'BTC', label: 'BTC/USD' },
  ETHUSD: { kind: 'crypto', coin: 'ETH', label: 'ETH/USD' }
};

const DATABENTO_DATASET = 'GLBX.MDP3';   // CME Globex MDP 3.0: CME, CBOT, NYMEX, COMEX

const INTERVALS = { '1min': 1, '5min': 5, '15min': 15, '30min': 30, '60min': 60, daily: 1440 };

// ---- upstream series parsing ---------------------------------------------
// Alpha Vantage nests the series under a human-readable key that varies by
// endpoint. Rather than hardcode each spelling, find the first object-valued
// key that isn't the metadata block.

function findSeries(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const keys = Object.keys(payload);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (/meta ?data/i.test(k)) continue;
    const v = payload[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

function pick(row, names) {
  for (let i = 0; i < names.length; i++) {
    const keys = Object.keys(row);
    for (let j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase().indexOf(names[i]) !== -1) {
        const n = parseFloat(row[keys[j]]);
        if (isFinite(n)) return n;
      }
    }
  }
  return NaN;
}

// Normalize to the exact shape replay.js already consumes: {t,o,h,l,c,v}
function normalize(series) {
  const stamps = Object.keys(series).sort();       // ascending, oldest first
  const bars = [];
  for (let i = 0; i < stamps.length; i++) {
    const row = series[stamps[i]];
    if (!row || typeof row !== 'object') continue;
    const o = pick(row, ['open']), h = pick(row, ['high']),
          l = pick(row, ['low']),  c = pick(row, ['close']);
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    // Alpha Vantage returns "YYYY-MM-DD HH:MM:SS" in US/Eastern for intraday
    // and plain "YYYY-MM-DD" for daily. Treat both as UTC-stamped instants; the
    // app only needs monotonic ordering and correct spacing, not tz conversion.
    const iso = stamps[i].indexOf(' ') === -1 ? stamps[i] + 'T00:00:00Z'
                                             : stamps[i].replace(' ', 'T') + 'Z';
    const t = Date.parse(iso);
    if (!isFinite(t)) continue;
    const v = pick(row, ['volume']);
    bars.push({ t: t, o: o, h: h, l: l, c: c, v: isFinite(v) ? v : 0 });
  }
  return bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars;
}

/** Builds the Alpha Vantage URL for FX or crypto. Futures never reach this —
 *  the handler branches to fetchDatabento() and returns before this is called. */
function buildUrl(inst, interval, key, full, month) {
  const size = full ? 'full' : 'compact';
  if (inst.kind === 'fx') {
    if (interval === 'daily') {
      return AV_URL + '?function=FX_DAILY&from_symbol=' + inst.from + '&to_symbol=' + inst.to +
             '&outputsize=' + size + '&apikey=' + key;
    }
    // FX_INTRADAY has no `month` parameter in Alpha Vantage's API — only recent
    // trailing data is available. A month value here is silently ignored
    // rather than erroring, since the handler already explains the limit.
    return AV_URL + '?function=FX_INTRADAY&from_symbol=' + inst.from + '&to_symbol=' + inst.to +
           '&interval=' + interval + '&outputsize=' + size + '&apikey=' + key;
  }
  // crypto — the only remaining kind, since futures already returned above.
  if (interval === 'daily') {
    return AV_URL + '?function=DIGITAL_CURRENCY_DAILY&symbol=' + inst.coin +
           '&market=USD&apikey=' + key;
  }
  // Same limit as FX: CRYPTO_INTRADAY has no `month` parameter.
  return AV_URL + '?function=CRYPTO_INTRADAY&symbol=' + inst.coin + '&market=USD' +
         '&interval=' + interval + '&outputsize=' + size + '&apikey=' + key;
}

// ---- Databento: real CME/CBOT/NYMEX/COMEX futures ------------------------
//
// HTTP API confirmed from Databento's own docs (databento.com/docs/api-
// reference-historical): RPC-style GET at https://hist.databento.com/v0/
// METHOD, HTTP Basic Auth with the API key as username and an empty
// password, dataset=GLBX.MDP3 for CME Globex, continuous front-month
// contracts via stype_in=continuous with symbols like "ES.c.0".
//
// HONEST CAVEAT: the docs I could reach show the Python/C++/Rust client
// signatures in full but not a literal curl example for the streaming HTTP
// endpoint's query parameters. The dataset, schema, symbology, and CSV
// column shape below are all directly confirmed from documented examples;
// the exact query-string encoding for timeseries.get_range over plain HTTP
// (encoding=csv vs. an Accept header) is my best-verified construction, not
// something I could test end-to-end without a key. If the first real call
// fails, check this function against a fresh curl example from the docs
// before assuming the rest of the integration is wrong.

const DATABENTO_URL = 'https://hist.databento.com/v0/timeseries.get_range';

function databentoAuthHeader(key) {
  // HTTP Basic Auth: API key as username, empty password.
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

function databentoRange(month, from, to) {
  if (from) {
    // `to` is inclusive as a calendar date from the caller's point of view —
    // Databento's range end is exclusive, so push it to the start of the
    // following day rather than making the caller do that arithmetic.
    const start = new Date(from + 'T00:00:00Z');
    const end = new Date((to || from) + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (month) {
    const [y, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // No range specified: most recent available window. GLBX historical data
  // typically lags live by under a day, so anchor "now" a day back to avoid
  // requesting a range the dataset doesn't have yet.
  const end = new Date(Date.now() - 24 * 3600 * 1000);
  const start = new Date(end.getTime() - 5 * 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function buildDatabentoUrl(inst, month, from, to) {
  const { start, end } = databentoRange(month, from, to);
  const symbol = inst.root + '.c.0';   // continuous front-month contract
  const params = new URLSearchParams({
    dataset: DATABENTO_DATASET,
    symbols: symbol,
    schema: 'ohlcv-1m',       // finest native OHLCV schema; the app aggregates up client-side
    stype_in: 'continuous',
    start, end,
    encoding: 'csv',
    pretty_px: 'true',
    pretty_ts: 'true'
  });
  return DATABENTO_URL + '?' + params.toString();
}

/**
 * Parses Databento's CSV output. Reads the header row to find column
 * positions rather than assuming a fixed order, since the documented
 * examples show map_symbols adding a trailing `symbol` column and different
 * schemas carry different fields.
 */
function parseDatabentoCsv(text) {
  const lines = text.split(/\r?\n/).filter(function (l) { return l.length > 0; });
  if (!lines.length) return [];
  const header = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
  const idx = {};
  ['ts_event', 'ts_recv', 'open', 'high', 'low', 'close', 'volume'].forEach(function (name) {
    const i = header.indexOf(name);
    if (i !== -1) idx[name] = i;
  });
  const tsCol = idx.ts_event !== undefined ? idx.ts_event : idx.ts_recv;
  if (tsCol === undefined || idx.open === undefined || idx.close === undefined) return [];

  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const t = Date.parse(cells[tsCol]);
    const o = parseFloat(cells[idx.open]), h = parseFloat(cells[idx.high]),
          l = parseFloat(cells[idx.low]), c = parseFloat(cells[idx.close]);
    if (!isFinite(t) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    const v = idx.volume !== undefined ? parseFloat(cells[idx.volume]) : 0;
    bars.push({ t: t, o: o, h: h, l: l, c: c, v: isFinite(v) ? v : 0 });
  }
  bars.sort(function (a, b) { return a.t - b.t; });
  return bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars;
}

async function fetchDatabento(inst, month, from, to, key, deadline) {
  const budget = Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now());
  if (budget < 500) return { ok: false, reason: 'Out of time budget. Try again.' };
  let r;
  try {
    r = await fetchWithTimeout(buildDatabentoUrl(inst, month, from, to), {
      headers: { Authorization: databentoAuthHeader(key) }
    }, budget);
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, reason: timedOut ? 'Databento request timed out. Try again.' : 'Could not reach Databento.' };
  }
  if (!r.ok) {
    // Map Databento's documented HTTP error codes to plain language.
    const byCode = {
      401: 'Databento key is invalid — check DATABENTO_API_KEY in Netlify.',
      402: 'Databento payment issue on this account — check billing in the Databento portal.',
      403: 'This Databento key doesn\u2019t have access to CME Globex (GLBX.MDP3) data.',
      404: 'Databento has no data for that symbol.',
      422: 'Databento could not process that request as formed.',
      429: 'Databento rate limit reached. Wait a moment and retry.'
    };
    return { ok: false, reason: byCode[r.status] || ('Databento upstream returned ' + r.status + '.') };
  }
  const text = await r.text();
  const bars = parseDatabentoCsv(text);
  if (bars.length < 120) {
    return { ok: false, reason: 'Not enough bars returned for that window — try a wider date range or a different month.' };
  }
  return { ok: true, bars: bars, intervalMin: 1 };
}

// ---- handler --------------------------------------------------------------

exports.handler = async function (event) {
  const deadline = Date.now() + HANDLER_BUDGET_MS;

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  // Require a signed-in Supabase user for the whole endpoint (catalog listing
  // included) — the app only ever calls this while authenticated, so there's
  // no reason to leave any path open to anonymous callers.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return unauthorized('Sign in to load market data.');
  let user;
  try { user = await verifySupabaseUser(token, deadline); }
  catch (e) { return unauthorized('Could not verify your session. Sign in again.'); }
  if (!user) return unauthorized('Your session has expired — sign in again.');

  let q = event.queryStringParameters || {};
  if (event.httpMethod === 'POST' && event.body) {
    try { q = Object.assign({}, q, JSON.parse(event.body)); } catch (e) { /* keep query params */ }
  }

  const symbol = clean(q.symbol, 12).toUpperCase();
  const interval = clean(q.interval, 8) || '5min';
  const full = String(q.full || '') === '1';
  const monthRaw = clean(q.month, 7);
  const month = /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : null;
  const fromRaw = clean(q.from, 10), toRaw = clean(q.to, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : null;

  if (symbol === 'CATALOG' || q.catalog) {
    return ok({
      ok: true,
      instruments: Object.keys(CATALOG).map(function (k) {
        return {
          id: k, label: CATALOG[k].label, kind: CATALOG[k].kind,
          // Futures get a real date range at any interval, straight from
          // Databento. FX/crypto only get a real date range on Daily (full
          // history, sliced server-side) \u2014 intraday FX/crypto is a recent-
          // only Alpha Vantage endpoint with no historical range at all.
          historicalMonths: CATALOG[k].kind === 'futures',
          historicalRangeDailyOnly: CATALOG[k].kind !== 'futures'
        };
      }),
      intervals: Object.keys(INTERVALS)
    });
  }

  const inst = CATALOG[symbol];
  if (!inst) {
    return ok({ ok: false, reason: 'Unknown symbol. Ask for the catalog, or upload a CSV instead.' });
  }
  if (!INTERVALS[interval]) {
    return ok({ ok: false, reason: 'Unsupported interval.' });
  }
  if (monthRaw && !month) {
    return ok({ ok: false, reason: 'Month must be in YYYY-MM format.' });
  }
  if ((fromRaw && !from) || (toRaw && !to)) {
    return ok({ ok: false, reason: 'Start/end date must be in YYYY-MM-DD format.' });
  }
  if (from && to && from > to) {
    return ok({ ok: false, reason: 'Start date is after end date.' });
  }
  const wantsRange = !!(month || from);
  if (wantsRange && inst.kind !== 'futures' && interval !== 'daily') {
    return ok({
      ok: false,
      reason: 'A specific historical window isn\u2019t available for ' + inst.label + ' at this timeframe' +
        ' \u2014 FX and crypto intraday data here only covers recent trading. Pick Daily for a full-history ' +
        'date range, or export a CSV from TradingView and drop it in instead.'
    });
  }

  // Serve a shared cached response if this exact window was fetched recently,
  // before spending an upstream call. Only successful { ok:true } payloads are
  // cached (cacheSet is called only on the success paths below), so an error
  // never sticks.
  const ck = cacheKey(symbol, interval, month, full, from, to);
  const cached = cacheGet(ck);
  if (cached) return ok(cached);

  // ---- futures: Databento ----
  if (inst.kind === 'futures') {
    const dbKey = process.env.DATABENTO_API_KEY;
    if (!dbKey) {
      return ok({ ok: false, reason: 'No Databento key configured on this site. Upload a CSV export instead.' });
    }
    const res = await fetchDatabento(inst, month, from, to, dbKey, deadline);
    if (!res.ok) return ok({ ok: false, reason: res.reason });
    const body = {
      ok: true,
      symbol: symbol,
      month: month || null,
      range: from ? { from: from, to: to || from } : null,
      label: inst.label,
      proxy: false,
      interval: '1min',
      intervalMin: res.intervalMin,
      count: res.bars.length,
      first: new Date(res.bars[0].t).toISOString(),
      last: new Date(res.bars[res.bars.length - 1].t).toISOString(),
      bars: res.bars
    };
    cacheSet(ck, body);
    return ok(body);
  }

  // ---- FX / crypto: Alpha Vantage ----
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) {
    return ok({ ok: false, reason: 'No market-data key configured on this site. Upload a CSV export instead.' });
  }

  try {
    const budget = Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now());
    if (budget < 500) return ok({ ok: false, reason: 'Out of time budget. Try again.' });

    const r = await fetchWithTimeout(buildUrl(inst, interval, key, full, month), null, budget);
    if (!r.ok) return ok({ ok: false, reason: 'Market data upstream returned ' + r.status + '.' });

    const payload = await r.json();

    // Alpha Vantage signals problems in-band with 200s.
    if (payload && payload.Note) {
      return ok({ ok: false, reason: 'Market data rate limit reached. Wait a minute and retry, or upload a CSV.' });
    }
    if (payload && (payload['Error Message'] || payload.Information)) {
      return ok({ ok: false, reason: 'Market data unavailable for that symbol and interval right now.' });
    }

    const series = findSeries(payload);
    if (!series) return ok({ ok: false, reason: 'Market data returned no series for that request.' });

    let bars = normalize(series);
    // Alpha Vantage has no server-side date-range filter — outputsize=full
    // (already requested above) returns the whole daily history, so a
    // requested [from,to] window is sliced out of it here rather than
    // relying on the client to do it after downloading everything.
    if (from) {
      const startMs = Date.parse(from + 'T00:00:00Z');
      const endMs = Date.parse((to || from) + 'T23:59:59Z');
      bars = bars.filter(function (b) { return b.t >= startMs && b.t <= endMs; });
    }
    if (bars.length < 120) {
      return ok({
        ok: false,
        reason: from
          ? 'Not enough bars in that date range to seed a replay session — try a wider window.'
          : 'Not enough bars returned to seed a replay session.'
      });
    }

    const body = {
      ok: true,
      symbol: symbol,
      month: month || null,
      range: from ? { from: from, to: to || from } : null,
      label: inst.label,
      proxy: false,
      interval: interval,
      intervalMin: INTERVALS[interval],
      count: bars.length,
      first: new Date(bars[0].t).toISOString(),
      last: new Date(bars[bars.length - 1].t).toISOString(),
      bars: bars
    };
    cacheSet(ck, body);
    return ok(body);
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return ok({
      ok: false,
      reason: timedOut ? 'Market data timed out. Try again, or upload a CSV export.'
                       : 'Could not reach market data. Upload a CSV export instead.'
    });
  }
};
