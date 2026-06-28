"use strict";
// Robot League — zero-build site. Reads ONLY ./data/export.json (the versioned
// site contract) plus optional ./data/scores.json from the frozen scorer.
// Browser-side scores are computed from predictions+results so the site stays
// a pure reader — no compute leaks into presentation (spec §4).

let DB = null;     // export.json
let SCORES = null; // scores.json (optional; null until the scorer has run)
let TICK = null;   // live countdown interval

// Email capture (Kit / ConvertKit). Zero-backend: a plain form POST to the
// Kit inline-form endpoint; double opt-in and sending live on the Kit side.
// Set `action` to the form's endpoint, e.g.
//   https://app.kit.com/forms/1234567/subscriptions
// Empty action -> the capture box renders nowhere (safe to deploy unconfigured).
const EMAIL_FORM = {
  action: "https://app.kit.com/forms/9551637/subscriptions",
};
const app = () => document.getElementById("app");
const el = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const MODEL_LABELS = {
  "claude-fable-5": "Claude Fable 5", "claude-opus-4-8": "Claude Opus 4.8", "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-5.5-2026-04-23": "GPT-5.5", "gpt-5.4-mini-2026-03-17": "GPT-5.4 mini",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro", "gemini-3.5-flash": "Gemini 3.5 Flash",
  "grok-4.3": "Grok 4.3", "deepseek-v4-pro": "DeepSeek v4 Pro", "deepseek-v4-flash": "DeepSeek v4 Flash",
  "B1": "Elo baseline", "B2": "Squad-value baseline",
};
const shortModel = (m) => MODEL_LABELS[m] || (m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
// Plain-language names for the forecasting methods (codes stay in tooltips).
const METHOD_LABELS = {
  M1: "Blind", M2: "Web search", M3: "Ratings engine", M1c: "Blind + standings", M2c: "Search + standings",
  ENS: "Ensemble", B1: "Elo baseline", B2: "Squad-value baseline", MKT: "Betting market",
};
const methodName = (m) => METHOD_LABELS[m] || m;
// Capability-ladder tiers (roster.yaml): flagship / cheaper sibling.
const MODEL_TIERS = {
  "claude-opus-4-8": "flagship", "gpt-5.5-2026-04-23": "flagship", "gemini-3.1-pro-preview": "flagship",
  "grok-4.3": "flagship", "deepseek-v4-pro": "flagship",
  "claude-haiku-4-5": "sibling", "gpt-5.4-mini-2026-03-17": "sibling",
  "gemini-3.5-flash": "sibling", "deepseek-v4-flash": "sibling",
};
// Models hidden from the dashboard (turned off / no longer running). Their locked
// historical forecasts stay in the data; this is a display filter only.
const HIDDEN_MODELS = new Set(["claude-fable-5"]);

// Leaderboard view state: collapsed top-10 with method/tier filters.
const LB_TOP_N = 10;
const LB_TYPES = {
  all: ["All", null], blind: ["Blind", ["M1", "M1c"]], search: ["Web search", ["M2", "M2c"]],
  ratings: ["Ratings engine", ["M3"]], bench: ["Ensemble & baselines", ["ENS", "B1", "B2"]],
};
const LB_TIERS = { all: "All", flagship: "Flagship", sibling: "Fast & cheap" };
const LB_VIEW = { type: "all", tier: "all", expanded: false };
let LB_SORT = null;  // { key, dir } once a leaderboard column is clicked; null = default RPS order

// Betting-returns view (illustrative): staking strategy x odds source.
const RET_STRATS = { value: "Value bets (all +EV)", valbest: "Value (best pick)", pick: "Follow the pick", kelly: "Half-Kelly" };
const RET_SOURCES = { best: "Best available", pinnacle: "Pinnacle", fair: "De-vigged fair" };
const RET_VIEW = { strat: "value", source: "best" };

// Vendored SVG flags (site/vendor/flags, lipis/flag-icons, MIT) — Windows does
// not render country-flag emoji, so images are the only portable option.
const FLAGS = {
  "Algeria": "dz", "Argentina": "ar", "Australia": "au", "Austria": "at", "Belgium": "be",
  "Bosnia & Herzegovina": "ba", "Brazil": "br", "Canada": "ca", "Cape Verde": "cv",
  "Colombia": "co", "Croatia": "hr", "Curaçao": "cw", "Czech Republic": "cz",
  "DR Congo": "cd", "Ecuador": "ec", "Egypt": "eg", "England": "gb-eng", "France": "fr",
  "Germany": "de", "Ghana": "gh", "Haiti": "ht", "Iran": "ir", "Iraq": "iq",
  "Ivory Coast": "ci", "Japan": "jp", "Jordan": "jo", "Mexico": "mx", "Morocco": "ma",
  "Netherlands": "nl", "New Zealand": "nz", "Norway": "no", "Panama": "pa",
  "Paraguay": "py", "Portugal": "pt", "Qatar": "qa", "Saudi Arabia": "sa",
  "Scotland": "gb-sct", "Senegal": "sn", "South Africa": "za", "South Korea": "kr",
  "Spain": "es", "Sweden": "se", "Switzerland": "ch", "Tunisia": "tn", "Turkey": "tr",
  "United States": "us", "Uruguay": "uy", "Uzbekistan": "uz",
};
const flag = (t) => FLAGS[t] ? `<img class="flag" src="./vendor/flags/${FLAGS[t]}.svg" alt="" loading="lazy">` : "";
const team = (t) => `${flag(t)}${esc(t)}`;
const teamLink = (t) => FLAGS[t] ? `<a class="tlink" href="#/team/${encodeURIComponent(t)}">${team(t)}</a>` : esc(t);

const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");
const pct1 = (x) => (x == null ? "—" : (100 * x).toFixed(1) + "%");
const f3 = (x) => (x == null ? "—" : x.toFixed(3));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// All displayed times are the VISITOR'S local time (the record itself stays UTC).
const fmtDT = (iso) => { const d = new Date(iso); return isFinite(d) ? d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : (iso || ""); };
const fmtFull = (iso) => { const d = new Date(iso); return isFinite(d) ? d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : (iso || ""); };
const city = (g) => (g || "").replace(/\s*\(.*\)$/, "");

const CHECKPOINT_ORDER = ["pre-tournament", "md1", "md2", "md3", "group-end", "r32", "r16", "qf", "sf", "final"];
function orderCheckpoints(values) {
  const known = CHECKPOINT_ORDER.filter(c => values.includes(c));
  const extra = values.filter(v => !CHECKPOINT_ORDER.includes(v)).sort();
  return [...known, ...extra];
}

// --- scoring ---
function devig(o) { const inv = [1 / o.o_home, 1 / o.o_draw, 1 / o.o_away]; const s = inv[0] + inv[1] + inv[2]; return inv.map(x => x / s); }
function mktVector(mid) {
  const all = DB._oddsByMatch[mid] || [];
  const rows = all.some(r => r.snapshot === "T-3h") ? all.filter(r => r.snapshot === "T-3h") : all;
  const latest = (re) => rows.filter(r => re.test(r.source))
    .sort((a, b) => (a.captured_at || "").localeCompare(b.captured_at || "")).pop();
  const pref = latest(/pinnacle/i) || latest(/betfair/i);
  if (pref) return { source: pref.source, p: devig(pref) };
  // No sharp book: de-vigged consensus of the remaining books (prereg amendment 2026-06-13).
  const bySource = new Map();
  for (const r of rows.slice().sort((a, b) => (a.captured_at || "").localeCompare(b.captured_at || "")))
    bySource.set(r.source, r);  // latest capture per source wins
  const soft = [...bySource.values()];
  if (!soft.length) return null;
  const vecs = soft.map(devig);
  const p = [0, 1, 2].map(i => vecs.reduce((s, v) => s + v[i], 0) / vecs.length);
  return { source: `Consensus (${[...bySource.keys()].sort().join(", ")})`, p };
}
function outcomeVec(fx) {
  const r = fx.result; if (!r || r.home_goals == null) return null;
  if (r.home_goals > r.away_goals) return [1, 0, 0];
  if (r.home_goals < r.away_goals) return [0, 0, 1];
  return [0, 1, 0];
}
function rps(p, o) { let cp = 0, co = 0, s = 0; for (let i = 0; i < 2; i++) { cp += p[i]; co += o[i]; s += (cp - co) ** 2; } return s / 2; }

function seriesMeta(p) {
  const isLLM = p.model != null;
  return {
    key: isLLM ? `${p.method}·${p.model}` : p.method,
    label: isLLM ? `${methodName(p.method)} · ${shortModel(p.model)}` : methodName(p.method),
    kind: (p.method === "B1" || p.method === "B2") ? "base" : (p.method === "ENS" ? "ens" : "m"),
  };
}
function pillClass(kind) { return ({ base: "base", mkt: "mkt", ens: "ens" })[kind] || "m"; }

function playedFixtures() {
  return DB.fixtures.filter(fx => outcomeVec(fx))
    .sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""));
}

function leaderboard() {
  const series = {};
  const add = (key, label, kind, mid, pvec) => {
    const fx = DB._fixById[mid]; const o = outcomeVec(fx); if (!o) return;
    (series[key] ||= { label, kind, rpss: [], byMid: {} }).rpss.push(rps(pvec, o));
    series[key].byMid[mid] = rps(pvec, o);
  };
  for (const p of DB.predictions) {
    if (p.p_home == null) continue;
    if (HIDDEN_MODELS.has(p.model)) continue;
    const m = seriesMeta(p);
    add(m.key, m.label, m.kind, p.match_id, [p.p_home, p.p_draw, p.p_away]);
  }
  for (const fx of DB.fixtures) { const m = mktVector(fx.match_id); if (m) add("MKT", `Betting market (${m.source})`, "mkt", fx.match_id, m.p); }
  const mktMean = mean(series.MKT ? series.MKT.rpss : []);
  const rows = Object.entries(series).map(([k, v]) => ({ key: k, label: v.label, kind: v.kind, rps: mean(v.rpss), n: v.rpss.length, byMid: v.byMid }));
  rows.forEach(r => r.skill = (mktMean != null && r.key !== "MKT") ? (mktMean - r.rps) : null);
  rows.sort((a, b) => a.rps - b.rps);
  return { rows, mktMean };
}

// Knockout advancement leaderboard: Brier on who advances (companion to the 1X2
// board; prereg §3 / 2026-06-27 amendment). 0.5 = a coin flip.
const brierBin = (p, o) => (p[0] - (o === 0 ? 1 : 0)) ** 2 + (p[1] - (o === 1 ? 1 : 0)) ** 2;
function advancementLeaderboard() {
  const adv = {};  // match_id -> 0 (home advanced) | 1 (away advanced)
  for (const fx of DB.fixtures) {
    const a = fx.stage === "knockout" && fx.result && fx.result.advanced_team;
    if (a) adv[fx.match_id] = a === fx.home ? 0 : a === fx.away ? 1 : null;
  }
  const series = {};
  for (const p of DB.predictions) {
    if (p.p_advance_home == null || HIDDEN_MODELS.has(p.model)) continue;
    const o = adv[p.match_id];
    if (o == null) continue;
    const m = seriesMeta(p);
    (series[m.key] ||= { label: m.label, kind: m.kind, b: [] }).b.push(brierBin([p.p_advance_home, p.p_advance_away], o));
  }
  return Object.entries(series).map(([key, v]) => ({ key, label: v.label, kind: v.kind, brier: mean(v.b), n: v.b.length }))
    .sort((a, b) => a.brier - b.brier);
}

// Biggest upsets: decisive results (group win or knockout advance) the models'
// consensus most underrated. Group + knockout, ranked by how unlikely the winner was.
function topUpsets(limit = 6) {
  const out = [];
  for (const fx of DB.fixtures) {
    const o = outcomeVec(fx); if (!o) continue;
    const preds = (DB._predsByMatch[fx.match_id] || []).filter(p => p.model && !HIDDEN_MODELS.has(p.model));
    const ko = fx.stage === "knockout";
    let pwin, winner, favorite;
    if (ko) {
      const ap = preds.filter(p => p.p_advance_home != null), adv = fx.result.advanced_team;
      if (!ap.length || !adv) continue;
      const advHome = adv === fx.home, cHome = mean(ap.map(p => p.p_advance_home));
      pwin = advHome ? cHome : 1 - cHome; winner = adv; favorite = advHome ? fx.away : fx.home;
    } else {
      const wi = o[0] ? 0 : o[2] ? 2 : null; if (wi == null) continue;  // draws aren't upsets
      const xp = preds.filter(p => p.p_home != null); if (!xp.length) continue;
      const c = [0, 1, 2].map(i => mean(xp.map(p => [p.p_home, p.p_draw, p.p_away][i])));
      pwin = c[wi]; winner = wi === 0 ? fx.home : fx.away; favorite = wi === 0 ? fx.away : fx.home;
    }
    if (pwin == null || pwin >= 0.45) continue;  // only genuinely surprising winners
    out.push({ fx, winner, favorite, pwin, ko, score: `${fx.result.home_goals}–${fx.result.away_goals}` });
  }
  return out.sort((a, b) => a.pwin - b.pwin).slice(0, limit);
}

function sparkline(values, color = "#7aa2ff") {
  if (!values || values.length < 2) return "";
  const w = 64, h = 16, lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 2) + 1;
    const y = h - 2 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

function rpsSeriesOverTime() {
  const played = playedFixtures();
  if (played.length < 2) return null;
  // One line per active model (within-model mean across its M1/M2/M3 arms per
  // match), plus the ensemble, baselines, and market as reference lines.
  const ARMS = ["M1", "M2", "M3"];
  const refs = new Map([
    ["ENS", { key: "Ensemble", color: WCViz.SERIES_COLORS.ENS }],
    ["B1", { key: "Elo baseline", color: WCViz.SERIES_COLORS.B1 }],
    ["B2", { key: "Squad-value baseline", color: WCViz.SERIES_COLORS.B2 }],
    ["MKT", { key: "Betting market", color: WCViz.SERIES_COLORS.MKT }],
  ]);
  const models = [...new Set(DB.predictions
    .filter(p => p.model && !HIDDEN_MODELS.has(p.model) && ARMS.includes(p.method))
    .map(p => p.model))];
  const acc = new Map([...refs.keys(), ...models.map(m => `MODEL·${m}`)]
    .map(k => [k, { sum: 0, n: 0, points: [] }]));
  const push = (key, value) => {
    const a = acc.get(key); if (!a) return;
    a.sum += value; a.n += 1; a.points.push({ x: a.n, y: a.sum / a.n });
  };
  for (const fx of played) {
    const o = outcomeVec(fx);
    const preds = DB._predsByMatch[fx.match_id] || [];
    for (const p of preds) {
      if (p.p_home == null || p.model != null || !refs.has(p.method)) continue; // ENS/B1/B2
      push(p.method, rps([p.p_home, p.p_draw, p.p_away], o));
    }
    const mk = mktVector(fx.match_id);
    if (mk) push("MKT", rps(mk.p, o));
    for (const m of models) {
      const arms = preds.filter(p => p.model === m && p.p_home != null && ARMS.includes(p.method));
      if (arms.length) push(`MODEL·${m}`, mean(arms.map(p => rps([p.p_home, p.p_draw, p.p_away], o))));
    }
  }
  const series = [];
  for (const m of models) {
    const a = acc.get(`MODEL·${m}`);
    if (a.points.length >= 2) series.push({ key: shortModel(m), color: WCViz.modelColor(m), points: a.points });
  }
  for (const [k, meta] of refs) {
    const a = acc.get(k);
    if (a.points.length >= 2) series.push({ key: meta.key, color: meta.color, points: a.points });
  }
  return series.length ? series : null;
}

// --- forecast helpers (latest checkpoint; consensus = the 10 AI models only) ---
function latestForecast() {
  const all = (DB.tournament_forecast || []).filter(f => f.reach);
  if (!all.length) return { rows: [], models: [], baselines: [], cps: [], latest: null, all };
  const cps = orderCheckpoints([...new Set(all.map(f => f.as_of))]);
  const latest = cps[cps.length - 1];
  const rows = all.filter(f => f.as_of === latest);
  return {
    rows, cps, latest, all,
    models: rows.filter(f => f.method === "M3" && !HIDDEN_MODELS.has(f.model)),
    baselines: rows.filter(f => f.method === "B1" || f.method === "B2"),
  };
}
function consensusReach(modelRows) {
  const by = {};
  for (const f of modelRows) (by[f.team] ||= []).push(f.reach);
  const out = {};
  for (const [t, rs] of Object.entries(by)) {
    out[t] = {};
    for (const k of ["win_group", "runner_up", "third", "reach_r32", "reach_r16", "reach_qf", "reach_sf", "reach_final", "champion"])
      out[t][k] = mean(rs.map(r => r[k]).filter(v => v != null));
  }
  return out;
}
function groupMembers() {
  const groups = {};
  for (const fx of DB.fixtures) {
    if (fx.stage !== "group" || !fx.group) continue;
    const letter = fx.group.replace("Group", "").trim();
    (groups[letter] ||= new Set()).add(fx.home); groups[letter].add(fx.away);
  }
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]]));
}

// --- bracket projection (consensus of the 10 models) ---
function buildBracket() {
  const kos = DB.fixtures.filter(fx => fx.stage === "knockout");
  if (!kos.length) return null;
  const { models } = latestForecast();
  const reach = consensusReach(models);
  const groups = groupMembers();
  const teamSet = new Set(Object.values(groups).flat());
  const standings = groupStandings();

  // A group is "decided" once all its group matches have a result; then the
  // bracket ranks by REAL standings (points, GD, GF) instead of the forecast.
  const groupFixtures = {};
  for (const fx of DB.fixtures)
    if (fx.stage === "group" && fx.group) (groupFixtures[fx.group.replace("Group", "").trim()] ||= []).push(fx);
  const groupDecided = (L) => (groupFixtures[L] || []).length > 0 && groupFixtures[L].every(outcomeVec);
  const allDecided = Object.keys(groups).every(groupDecided);
  const realKey = (t) => { const s = standings[t]; return s ? s.p * 1e6 + s.gd * 1e3 + s.gf : 0; };
  const rankByStandings = (teams) => teams.slice().sort((a, b) => {
    const sa = standings[a] || { p: 0, gd: 0, gf: 0 }, sb = standings[b] || { p: 0, gd: 0, gf: 0 };
    return (sb.p - sa.p) || (sb.gd - sa.gd) || (sb.gf - sa.gf)
      || (((reach[b] || {}).reach_r32 || 0) - ((reach[a] || {}).reach_r32 || 0));
  });

  const proj = {};
  for (const [letter, teams] of Object.entries(groups)) {
    if (groupDecided(letter)) {
      const o = rankByStandings(teams);
      proj[letter] = { first: o[0], second: o[1], third: o[2], decided: true };
    } else {
      const left = [...teams];
      const take = (key) => {
        left.sort((a, b) => ((reach[b] || {})[key] || 0) - ((reach[a] || {})[key] || 0));
        return left.shift();
      };
      proj[letter] = { first: take("win_group"), second: take("runner_up"), third: take("third"), decided: false };
    }
  }
  // Best-thirds: real standings once the group stage is complete, else forecast.
  const thirdSlots = {};
  const thirdCodes = [...new Set(kos.flatMap(fx => [fx.home, fx.away]))].filter(c => /^3/.test(c));
  const candidates = Object.entries(proj)
    .map(([letter, p]) => ({ letter, team: p.third,
      p: allDecided ? realKey(p.third) : ((reach[p.third] || {}).third || 0) }))
    .sort((a, b) => b.p - a.p);
  const usedLetters = new Set();
  for (const cand of candidates) {
    const slot = thirdCodes.find(c => !thirdSlots[c] && c.slice(1).split("/").includes(cand.letter));
    if (slot && !usedLetters.has(cand.letter)) { thirdSlots[slot] = cand.team; usedLetters.add(cand.letter); }
  }

  const byNum = {};
  for (const fx of kos) {
    const m = fx.match_id.match(/^M(\d+)$/);
    if (m) byNum[+m[1]] = fx;
  }
  const final = kos.find(fx => /^W10[12]$/i.test(fx.home));
  const third = kos.find(fx => /^L10[12]$/i.test(fx.home));
  const nextKey = (num) => num <= 88 ? "reach_r16" : num <= 96 ? "reach_qf" : num <= 100 ? "reach_sf" : "reach_final";

  const memo = {};
  function resolve(code) {
    if (code in memo) return memo[code];
    let r = { team: null, projected: true };
    let m;
    if (teamSet.has(code)) r = { team: code, projected: false };
    else if ((m = code.match(/^1([A-L])$/))) r.team = proj[m[1]] && proj[m[1]].first;
    else if ((m = code.match(/^2([A-L])$/))) r.team = proj[m[1]] && proj[m[1]].second;
    else if (/^3/.test(code)) r.team = thirdSlots[code];
    else if ((m = code.match(/^([WL])(\d+)$/i))) {
      const fx = byNum[+m[2]];
      if (fx) {
        const a = resolve(fx.home), b = resolve(fx.away);
        const o = outcomeVec(fx), adv = (fx.result || {}).advanced_team;
        let win = null;
        if (adv) win = adv === a.team ? a : adv === b.team ? b : null;  // covers ET/penalties
        else if (o && o[0] === 1) win = a;                             // home win in 90'
        else if (o && o[2] === 1) win = b;                             // away win in 90'
        if (!win) {                                                    // unplayed (or 90' draw not yet resolved) -> forecast
          const key = nextKey(+m[2]);
          const pa = a.team ? ((reach[a.team] || {})[key] || 0) : 0;
          const pb = b.team ? ((reach[b.team] || {})[key] || 0) : 0;
          win = pa >= pb ? a : b;
        }
        const lose = win === a ? b : a;
        r.team = m[1].toUpperCase() === "W" ? win.team : lose.team;
      }
    }
    memo[code] = r;
    return r;
  }

  function tie(fx, key) {
    const a = resolve(fx.home), b = resolve(fx.away);
    const o = outcomeVec(fx);
    if (o) {  // played: show the real result and winner, not advance probabilities
      const adv = (fx.result || {}).advanced_team;
      const winner = adv ? (adv === a.team ? "a" : adv === b.team ? "b" : null)
        : o[0] === 1 ? "a" : o[2] === 1 ? "b" : null;
      return { fx, a, b, pa: null, pb: null, projected: false, decided: true, winner,
        score: `${fx.result.home_goals}–${fx.result.away_goals}`, shootout: !!(adv && o[1] === 1) };
    }
    const pa = a.team ? ((reach[a.team] || {})[key] || 0) : 0;
    const pb = b.team ? ((reach[b.team] || {})[key] || 0) : 0;
    const tot = pa + pb;
    return { fx, a, b, pa: tot ? pa / tot : null, pb: tot ? pb / tot : null, projected: a.projected || b.projected };
  }

  const refs = (fx) => [fx.home, fx.away].map(c => (c.match(/^[WL](\d+)$/i) || [])[1]).filter(Boolean).map(Number);
  const sf = final ? refs(final).map(n => byNum[n]) : [byNum[101], byNum[102]].filter(Boolean);
  const qf = sf.flatMap(fx => refs(fx).map(n => byNum[n]));
  const r16 = qf.flatMap(fx => refs(fx).map(n => byNum[n]));
  const r32 = r16.flatMap(fx => refs(fx).map(n => byNum[n]));
  const num = (fx) => +(fx.match_id.match(/^M(\d+)$/) || [])[1];

  // Flow-chart edges: group -> R32 (from slot codes; dashed while projected),
  // then each tie -> the tie that consumes its winner.
  const teamGroup = {};
  for (const [letter, teams] of Object.entries(groups)) for (const t of teams) teamGroup[t] = letter;
  const edges = [];
  const groupEdge = (code, fx) => {
    let m, letter = null, dashed = true;
    if (teamSet.has(code)) { letter = teamGroup[code]; dashed = false; }      // slot resolved to a real team
    else if ((m = code.match(/^[12]([A-L])$/))) letter = m[1];
    else if (/^3/.test(code)) { const t = thirdSlots[code]; letter = t ? teamGroup[t] : null; }
    if (letter) edges.push({ from: `G-${letter}`, to: fx.match_id, dashed });
  };
  for (const fx of [...r32, ...r16, ...qf, ...sf, ...(final ? [final] : [])]) {
    for (const code of [fx.home, fx.away]) {
      const m = code.match(/^W(\d+)$/i);
      if (m && byNum[+m[1]]) edges.push({ from: byNum[+m[1]].match_id, to: fx.match_id, dashed: false });
      else groupEdge(code, fx);
    }
  }
  if (third) {
    // The third-place match is structurally fed by the semifinal losers.
    const unresolved = !teamSet.has(third.home);
    for (const n of [101, 102]) if (byNum[n])
      edges.push({ from: byNum[n].match_id, to: third.match_id, dashed: unresolved, loser: true });
  }

  return {
    projected: !allDecided,  // once every group is decided, the R32 pairings are real
    proj, thirdSlots, reach, edges,
    rounds: [
      { title: "Round of 32", ties: r32.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Round of 16", ties: r16.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Quarterfinals", ties: qf.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Semifinals", ties: sf.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Final", ties: final ? [tie(final, "champion")] : [] },
    ],
    thirdPlace: third ? tie(third, "reach_sf") : null,
  };
}

// Measured SVG overlay connecting the wallchart cards. Re-drawn on resize.
function drawBracketLines(container) {
  const edges = container._edges || [];
  let svg = container.querySelector("svg.bk-lines");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "bk-lines");
    container.prepend(svg);
  }
  const W = container.scrollWidth, H = container.scrollHeight;
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const base = container.getBoundingClientRect();
  const anchor = (id) => {
    const n = container.querySelector(`[data-bk="${id}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {
      right: { x: r.right - base.x + container.scrollLeft, y: r.y - base.y + r.height / 2 },
      left: { x: r.x - base.x + container.scrollLeft, y: r.y - base.y + r.height / 2 },
    };
  };
  const paths = [];
  for (const e of edges) {
    const a = anchor(e.from), b = anchor(e.to);
    if (!a || !b) continue;
    const x1 = a.right.x, y1 = a.right.y, x2 = b.left.x, y2 = b.left.y;
    const dx = Math.max(14, (x2 - x1) / 2);
    paths.push(`<path${e.loser ? ` class="loser"` : ""} d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"${e.dashed ? ` stroke-dasharray="4 4"` : ""}/>`);
  }
  svg.innerHTML = paths.join("");
}

// --- components ---
function hdaBar(ph, pd, pa) {
  return `<div class="bar"><span class="h" style="width:${ph * 100}%"></span><span class="d" style="width:${pd * 100}%"></span><span class="a" style="width:${pa * 100}%"></span></div>`;
}
function tableWrap(html) { return `<div class="tablewrap">${html}</div>`; }

// Click-to-sort for static tables. Reads cell text (or data-sort override),
// sorts numerically when every value is a number, else alphabetically; clicking
// a column again reverses it. Headers marked `.nosort` are skipped.
function attachSort(table) {
  const head = table.tHead; if (!head) return;
  const ths = [...head.rows[0].cells];
  ths.forEach((th, idx) => {
    if (th.classList.contains("nosort")) return;
    th.classList.add("sortable");
    th.addEventListener("click", () => {
      const tbody = table.tBodies[0]; if (!tbody) return;
      const rows = [...tbody.rows].filter(r => r.cells.length === ths.length);
      if (rows.length < 2) return;
      const dir = th.classList.contains("sort-asc") ? -1 : 1;
      ths.forEach(h => h.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(dir === 1 ? "sort-asc" : "sort-desc");
      const vals = rows.map(r => {
        const td = r.cells[idx];
        const raw = (td && td.dataset.sort != null ? td.dataset.sort : td ? td.textContent.trim() : "");
        return { r, raw, num: parseFloat(raw) };
      });
      const numeric = vals.some(v => isFinite(v.num))
        && vals.every(v => v.raw === "" || v.raw === "—" || isFinite(v.num));
      vals.sort((a, b) => {
        if (numeric) {
          const an = isFinite(a.num) ? a.num : Infinity, bn = isFinite(b.num) ? b.num : Infinity;
          return an === bn ? 0 : (an - bn) * dir;
        }
        return a.raw.localeCompare(b.raw) * dir;
      });
      vals.forEach(v => tbody.appendChild(v.r));
    });
  });
}
function chartBox(id, h = 320) { return `<div class="chartbox" style="height:${h}px"><canvas id="${id}"></canvas></div>`; }

function tieCard(t, { final = false } = {}) {
  const row = (side, p, win) => {
    const name = side.team ? teamLink(side.team) : `<span class="dim">To be decided</span>`;
    const cls = t.decided ? (win ? "fav" : "outp") : (p != null && p >= 0.5 ? "fav" : "outp");
    const tail = t.decided
      ? (win ? `<span class="p win">✓</span>` : `<span class="p"></span>`)
      : `<span class="p">${p == null ? "" : pct(p)}</span>`;
    return `<div class="tie-team ${cls}">${name}${tail}</div>`;
  };
  const fx = t.fx;
  const meta = t.decided
    ? `<span class="bk-score">${esc(t.score)}</span>${t.shootout ? ` <span class="dim">pens</span>` : ""}`
    : `${esc(fmtDT(fx.kickoff_utc))}${fx.ground ? " · " + esc(city(fx.ground)) : ""}`;
  // div, not <a>: team names inside are links to team pages; clicking anywhere
  // else opens the match page (delegated handler on the bracket container).
  return `<div class="tie${final ? " final" : ""}${t.decided ? " decided" : ""}" data-bk="${esc(fx.match_id)}" data-href="#/match/${encodeURIComponent(fx.match_id)}" title="Open match page">
    <div class="meta">${meta}</div>
    ${row(t.a, t.pa, t.winner === "a")}${row(t.b, t.pb, t.winner === "b")}
  </div>`;
}

// Probability strip: dots ride in per-family lanes (Blind / Web search /
// Ratings engine / Ensemble+baselines) so agreement doesn't pile dots on top
// of each other; legend chips toggle families on and off.
const STRIP_FAMS = [
  ["M1", "Blind", () => WCViz.SERIES_COLORS.M1],
  ["M2", "Web search", () => WCViz.SERIES_COLORS.M2],
  ["M3", "Ratings engine", () => WCViz.SERIES_COLORS.M3],
  ["OTH", "Ensemble + baselines", () => WCViz.SERIES_COLORS.B1],
];
const FAM_LANE = { M1: 18, M2: 41, M3: 64, OTH: 86 };
const famOf = (method) => { const m = method.replace(/c$/, ""); return FAM_LANE[m] != null ? m : "OTH"; };

function probStrip(preds, mkt) {
  const rowFor = (label, idx) => {
    const dots = preds.map(p => {
      const v = [p.p_home, p.p_draw, p.p_away][idx];
      const fam = famOf(p.method);
      const color = WCViz.SERIES_COLORS[p.method.replace(/c$/, "")] || WCViz.SERIES_COLORS.B1;
      const name = p.model ? `${methodName(p.method)} · ${shortModel(p.model)}` : methodName(p.method);
      return `<span class="dotp" data-fam="${fam}" style="left:${v * 100}%; top:${FAM_LANE[fam]}%; background:${color}" title="${esc(name)}: ${pct1(v)}"></span>`;
    }).join("");
    const mark = mkt ? `<span class="mktmark" style="left:${mkt.p[idx] * 100}%" title="Betting market (${esc(mkt.source)}): ${pct1(mkt.p[idx])}"></span>` : "";
    return `<div class="striprow"><span class="striplabel">${label}</span><div class="striptrack">${dots}${mark}</div></div>`;
  };
  const chips = STRIP_FAMS.map(([fam, label, color]) =>
    `<button class="lg" data-fam="${fam}" type="button" title="Click to hide or show"><span class="dot" style="background:${color()}"></span>${label}</button>`).join("");
  return `<div class="strip">${rowFor("Home", 0)}${rowFor("Draw", 1)}${rowFor("Away", 2)}
    <div class="legend">${chips}<span><span class="dot mktdot"></span>Betting market</span></div></div>`;
}

function wireStripToggles(node) {
  node.querySelectorAll(".strip").forEach(strip => {
    strip.addEventListener("click", (e) => {
      const btn = e.target.closest(".lg");
      if (!btn) return;
      btn.classList.toggle("off");
      strip.classList.toggle(`off-${btn.dataset.fam}`);
    });
  });
}

function groupStandings() {
  const stats = {};
  for (const fx of DB.fixtures) {
    if (fx.stage !== "group" || !outcomeVec(fx)) continue;
    const r = fx.result;
    for (const [t, gf, ga] of [[fx.home, r.home_goals, r.away_goals], [fx.away, r.away_goals, r.home_goals]]) {
      const s = (stats[t] ||= { p: 0, w: 0, d: 0, l: 0, gd: 0, gf: 0, ga: 0 });
      s.gd += gf - ga; s.gf += gf; s.ga += ga;
      if (gf > ga) { s.p += 3; s.w++; } else if (gf === ga) { s.p += 1; s.d++; } else s.l++;
    }
  }
  return stats;
}

function groupsGrid() {
  const groups = groupMembers();
  if (!Object.keys(groups).length) return "";
  const { models } = latestForecast();
  const reach = consensusReach(models);
  const stats = groupStandings();
  const anyPlayed = Object.keys(stats).length > 0;
  const cards = Object.keys(groups).sort().map(letter => {
    const teams = groups[letter].slice().sort((a, b) => {
      const sa = stats[a] || { p: 0, gd: 0 }, sb = stats[b] || { p: 0, gd: 0 };
      return (sb.p - sa.p) || (sb.gd - sa.gd) || (((reach[b] || {}).reach_r32 || 0) - ((reach[a] || {}).reach_r32 || 0));
    });
    const rows = teams.map(t => {
      const s = stats[t], adv = (reach[t] || {}).reach_r32;
      return `<div class="grow">
        <span class="gname">${teamLink(t)}</span>
        <span class="gpts" title="wins-draws-losses">${s ? `${s.w}-${s.d}-${s.l}` : "—"}</span>
        <span class="gpts" title="points">${s ? s.p : "·"}</span>
        <span class="gbar" title="Average chance of reaching the knockout round (10 AI models): ${pct1(adv)}"><span style="width:${(adv || 0) * 100}%"></span></span>
      </div>`;
    }).join("");
    return `<div class="group-card"><h3><a class="glink" href="#/group/${esc(letter)}">Group ${letter} →</a></h3>${rows}</div>`;
  }).join("");
  return `<h2>The twelve groups</h2>
    <p class="muted">${anyPlayed ? "Live standings, with each team's chance of reaching the knockout round (green bar — the average view of the ten AI models)." : "No matches played yet. The green bar is each team's chance of reaching the knockout round — the average view of the ten AI models."} Click a group for its full breakdown.</p>
    <div class="groups">${cards}</div>`;
}

function emailCapture() {
  if (!EMAIL_FORM.action) return "";
  return `<div class="capture">
    <div>
      <div class="hero-kicker">Follow the race</div>
      <div class="capture-head">One email per match day.</div>
      <div class="hero-sub">Which AI is beating the market, the day's locked forecasts before kickoff, and the biggest disagreements. No spam — unsubscribe anytime.</div>
    </div>
    <form class="capture-form" action="${esc(EMAIL_FORM.action)}" method="post" target="_blank" rel="noopener">
      <input type="email" name="email_address" required placeholder="you@example.com" autocomplete="email" aria-label="Email address">
      <button type="submit">Get the recaps</button>
    </form>
  </div>`;
}

// Compact one-line variant for high on the page; the full box stays at the bottom.
function emailSlim() {
  if (!EMAIL_FORM.action) return "";
  return `<form class="capture-slim" action="${esc(EMAIL_FORM.action)}" method="post" target="_blank" rel="noopener">
    <span class="hero-kicker">Follow the race</span>
    <span class="slim-copy">One email per match day — who's beating the market, forecasts locked before kickoff.</span>
    <input type="email" name="email_address" required placeholder="you@example.com" autocomplete="email" aria-label="Email address">
    <button type="submit">Sign up</button>
  </form>`;
}

// --- ticker + nav ---
function fillTicker() {
  const t = document.getElementById("ticker");
  if (!t) return;
  const captured = new Set(DB.predictions.filter(p => p.as_of === "T-3h").map(p => p.match_id)).size;
  const next = DB.fixtures.filter(fx => !outcomeVec(fx) && fx.kickoff_utc && FLAGS[fx.home] && FLAGS[fx.away])
    .sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""))[0];
  const played = playedFixtures().length;
  const parts = [
    `<b>UPDATED</b> ${esc(fmtDT(DB.generated_at))}`,
    `<b>LOCKED FORECASTS</b> ${captured} of ${DB.fixtures.length} matches`,
    played ? `<b>PLAYED</b> ${played}` : null,
    next ? `<b>NEXT</b> ${flag(next.home)}${esc(next.home)} v ${flag(next.away)}${esc(next.away)} · ${esc(fmtDT(next.kickoff_utc))}` : null,
    `<b>10 AI MODELS</b> from 5 labs`,
  ].filter(Boolean);
  t.innerHTML = parts.join(`<span class="sep">│</span>`);
}
function markNav() {
  const h = location.hash || "#/";
  document.querySelectorAll("#nav a").forEach(a => {
    const target = a.getAttribute("href");
    const on = target === "#/" ? (h === "#/" || h === "" || h === "#") : h.startsWith(target);
    a.classList.toggle("on", on);
  });
}

// --- views ---
function heroStrip() {
  const next = DB.fixtures.filter(fx => !outcomeVec(fx))
    .sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""))[0];
  const { models } = latestForecast();
  const reach = consensusReach(models);
  const fav = Object.entries(reach).sort((a, b) => (b[1].champion || 0) - (a[1].champion || 0))[0];
  const { rows: lb } = leaderboard();
  const leaderCard = lb.length
    ? (() => { const top = lb.find(r => r.key !== "MKT") || lb[0]; return `
      <div class="hero-card">
        <div class="hero-kicker">Best forecaster so far</div>
        <div class="hero-big">${esc(top.label)}</div>
        <div class="hero-sub">average forecast error <span class="mono">${f3(top.rps)}</span> over ${top.n} matches ·
          vs the betting market: <span class="${top.skill >= 0 ? "good" : "bad"} mono">${top.skill >= 0 ? "ahead +" : "behind "}${f3(top.skill)}</span></div>
      </div>`; })()
    : (fav ? `
      <div class="hero-card">
        <div class="hero-kicker">The models' title favorite</div>
        <div class="hero-big">${teamLink(fav[0])}</div>
        <div class="hero-sub">${pct1(fav[1].champion)} chance to win it all — the average of ten AI models, each simulating the tournament 50,000 times</div>
      </div>` : "");
  const locked = next && (DB._predsByMatch[next.match_id] || []).some(p => p.as_of === "T-3h");
  const playing = next && Date.parse(next.kickoff_utc) <= Date.now();
  const kicker = playing ? "Match in progress"
    : locked ? "Forecasts locked ✓ · kickoff in"
      : "Next forecasts lock in";
  const homeTok = next && FLAGS[next.home]
    ? `<a class="tlink" href="#/team/${encodeURIComponent(next.home)}">${flag(next.home)}${esc(next.home)}</a>` : next ? esc(next.home) : "";
  const awayTok = next && FLAGS[next.away]
    ? `<a class="tlink" href="#/team/${encodeURIComponent(next.away)}">${flag(next.away)}${esc(next.away)}</a>` : next ? esc(next.away) : "";
  const nextCard = next ? `
    <div class="hero-card alt" data-href="#/match/${encodeURIComponent(next.match_id)}" title="Open match page">
      <div class="hero-kicker">${kicker}</div>
      <div class="countdown" id="countdown" data-kickoff="${esc(next.kickoff_utc)}" data-locked="${locked ? 1 : 0}">—</div>
      <div class="hero-sub">${homeTok} v ${awayTok} · ${esc(fmtFull(next.kickoff_utc))}${next.ground ? " · " + esc(city(next.ground)) : ""}</div>
    </div>` : "";
  return (leaderCard || nextCard) ? `<div class="hero">${leaderCard}${nextCard}</div>` : "";
}

function startCountdown() {
  const node = document.getElementById("countdown");
  if (!node) return;
  const card = node.closest("[data-href]");
  if (card) card.addEventListener("click", (e) => {
    if (e.target.closest("a")) return; // team links navigate themselves
    location.hash = card.dataset.href;
  });
  const kick = Date.parse(node.dataset.kickoff);
  if (!isFinite(kick)) { node.textContent = "—"; return; }
  if (Date.now() >= kick) { node.classList.add("live"); node.textContent = "● LIVE"; return; } // match underway
  const locked = node.dataset.locked === "1";
  const target = locked ? kick : kick - 3 * 3600 * 1000;
  const tick = () => {
    const ms = target - Date.now();
    if (ms <= 0) {
      if (locked) { node.classList.add("live"); node.textContent = "● LIVE"; }
      else node.textContent = "LOCKING…";
      return;
    }
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24,
      m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    node.textContent = `${d ? d + "d " : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  tick();
  TICK = setInterval(tick, 1000);
}

function viewLeaderboard() {
  LB_SORT = null;  // each visit starts in the default RPS order (header indicator fresh)
  const { rows, mktMean } = leaderboard();
  const lede = `<p class="lede">Ten AI models forecast every match of the World Cup — and we score them against the one opponent that's genuinely hard to beat: <strong>the betting market</strong>. Every forecast is locked and published before kickoff, so nobody can quietly rewrite history.</p>`;
  if (!rows.length) {
    const node = el(`<section>
      <h1>Leaderboard</h1>${lede}${heroStrip()}${emailSlim()}
      <div class="note">No matches have been played yet — the scoreboard starts filling in after the first final whistle. In the meantime: the <a href="#/bracket">projected bracket</a>, the <a href="#/forecast">title odds</a>, and every <a href="#/matches">match forecast</a> are already locked in below.</div>
      ${groupsGrid()}
    </section>`);
    node._after = startCountdown;
    return node;
  }
  const trendable = playedFixtures().map(fx => fx.match_id);
  rows.forEach((r, i) => { r._rank = r.key === "MKT" ? "—" : i + 1; });
  const rowHtml = (r) => {
    const skill = r.skill == null ? `<span class="muted">benchmark</span>`
      : `<span class="${r.skill >= 0 ? "good" : "bad"}">${r.skill >= 0 ? "+" : ""}${f3(r.skill)}</span>`;
    const seq = trendable.map(mid => r.byMid[mid]).filter(v => v != null).slice(-14);
    return `<tr${r === rows[0] ? ` class="lead"` : ""}>
      <td class="num muted">${r._rank}</td>
      <td><span class="pill ${pillClass(r.kind)}" title="${esc(r.key)}">${esc(r.label)}</span></td>
      <td class="num">${r.n}</td>
      <td class="num">${f3(r.rps)}</td>
      <td class="num">${skill}</td>
      <td>${sparkline(seq)}</td>
    </tr>`;
  };
  const filtered = () => {
    const methods = LB_TYPES[LB_VIEW.type][1];
    return rows.filter(r => {
      if (r.key === "MKT") return true; // the benchmark is always on the board
      const [method, model] = r.key.split("·");
      if (methods && !methods.includes(method)) return false;
      if (LB_VIEW.tier !== "all" && MODEL_TIERS[model] !== LB_VIEW.tier) return false;
      return true;
    });
  };
  // The set of rows the table currently shows (filter + sort + top-N/expand).
  // The skill chart mirrors this exact set so the two never disagree.
  const visibleRows = () => {
    let f = filtered();
    if (LB_SORT) {
      const { key, dir } = LB_SORT;
      const num = (r) => key === "rank" ? (typeof r._rank === "number" ? r._rank : Infinity)
        : (r[key] == null ? Infinity : r[key]);
      f = [...f].sort((a, b) => key === "label"
        ? a.label.localeCompare(b.label) * dir
        : (num(a) === num(b) ? 0 : (num(a) - num(b)) * dir));
    }
    const cut = !LB_VIEW.expanded && f.length > LB_TOP_N + 1;
    let vis = cut ? f.slice(0, LB_TOP_N) : f;
    const mkt = f.find(r => r.key === "MKT");
    if (mkt && !vis.includes(mkt)) vis = [...vis, mkt];
    return { vis, total: f.length, cut };
  };
  // The top-N/expand toggle button (shared by the table's morerow and the chart).
  const expandBtnHtml = () => {
    const { total, cut } = visibleRows();
    if (cut) return `<button type="button" data-expand="1">Show all ${total} forecasters ▾</button>`;
    if (total > LB_TOP_N + 1) return `<button type="button" data-expand="0">Show top ${LB_TOP_N} only ▴</button>`;
    return "";
  };
  const tbodyHtml = () => {
    const btn = expandBtnHtml();
    const more = btn ? `<tr class="morerow"><td colspan="6">${btn}</td></tr>` : "";
    return visibleRows().vis.map(rowHtml).join("") + more;
  };
  const pillsHtml = () =>
    `<span class="flabel">Method</span>` +
    Object.entries(LB_TYPES).map(([k, [label]]) =>
      `<button type="button" class="fpill${LB_VIEW.type === k ? " on" : ""}" data-type="${k}">${label}</button>`).join("") +
    `<span class="fsep"></span><span class="flabel">Tier</span>` +
    Object.entries(LB_TIERS).map(([k, label]) =>
      `<button type="button" class="fpill${LB_VIEW.tier === k ? " on" : ""}" data-tier="${k}">${label}</button>`).join("");

  // H1 "official question" panel hidden: it is preregistered for the now-retired
  // primary model (Fable) and is not reattributed to another model.

  const node = el(`<section>
    <h1>Leaderboard</h1>${lede}${heroStrip()}${emailSlim()}
    <div class="lbfilters" id="lb-filters">${pillsHtml()}</div>
    ${tableWrap(`<table id="lb-table"><thead><tr><th class="num sortable" data-key="rank">#</th><th class="sortable" data-key="label">Forecaster</th><th class="num sortable" data-key="n">matches</th><th class="num sortable" data-key="rps" title="Ranked Probability Score">forecast error</th><th class="num sortable" data-key="skill">vs market</th><th>trend</th></tr></thead><tbody id="lb-body">${tbodyHtml()}</tbody></table>`)}
    <p class="muted" style="margin-top:10px">Forecast error is the Ranked Probability Score — how far each probability forecast landed from what actually happened; <strong>lower is better</strong>. “vs market” is how much better (+) or worse (−) than the betting market${mktMean != null ? ` (market average ${f3(mktMean)})` : ""}.</p>
    <h2>The race — who's been closest to reality</h2>
    ${chartBox("rps-over-time", 340)}
    ${SCORES && SCORES.leaderboard && SCORES.leaderboard.length ? `<h2>Official scores with uncertainty ranges</h2>
    <div class="lbfilters">${pillsHtml()}</div>
    ${chartBox("skill-bars", 340)}
    <div class="lbexpand" id="lb-expand-chart">${expandBtnHtml()}</div>` : ""}
    ${(() => { const av = advancementLeaderboard(); return av.length ? `<h2>Knockout advancement — calling the ties</h2>
    <p class="muted">Brier score on <strong>who advances</strong> (lower is better; 0.50 = a coin flip). A companion to the match-result board above — not blended into it.</p>
    ${tableWrap(`<table class="sortable"><thead><tr><th class="num">#</th><th>Forecaster</th><th class="num">ties</th><th class="num" title="Brier on advancement">advance Brier</th><th class="num">vs coin</th></tr></thead><tbody>${av.map((r, i) => `<tr${i === 0 ? ' class="lead"' : ""}><td class="num muted">${i + 1}</td><td><span class="pill ${pillClass(r.kind)}" title="${esc(r.key)}">${esc(r.label)}</span></td><td class="num">${r.n}</td><td class="num">${f3(r.brier)}</td><td class="num ${0.5 - r.brier >= 0 ? "good" : "bad"}">${0.5 - r.brier >= 0 ? "+" : ""}${f3(0.5 - r.brier)}</td></tr>`).join("")}</tbody></table>`)}` : ""; })()}
    ${groupsGrid()}
  </section>`);

  // Skill-vs-market lookup (scores.json) keyed exactly like the table rows, so
  // the chart can mirror the table's visible rows in the same order.
  const skillByKey = new Map();
  if (SCORES && SCORES.leaderboard) for (const r of SCORES.leaderboard) {
    if (HIDDEN_MODELS.has(r.model)) continue;
    skillByKey.set(seriesMeta(r).key, r);
  }
  const drawSkill = () => {
    const sb = node.querySelector("#skill-bars");
    if (!sb) return;
    const data = visibleRows().vis
      .filter(r => r.key !== "MKT")
      .map(r => { const s = skillByKey.get(r.key); return s ? { label: r.label, skill_vs_mkt: s.skill_vs_mkt, skill_ci: s.skill_ci } : null; })
      .filter(Boolean);
    const cb = sb.closest(".chartbox");
    if (cb) cb.style.height = Math.max(160, data.length * 26 + 70) + "px";
    WCViz.skillBars(sb, data);
  };

  node._after = () => {
    startCountdown();
    const tb = node.querySelector("#lb-body");
    // Both control bars (above the table and above the chart) feed one state.
    const refresh = () => {
      node.querySelectorAll(".lbfilters").forEach(f => { f.innerHTML = pillsHtml(); });
      tb.innerHTML = tbodyHtml();
      const ce = node.querySelector("#lb-expand-chart");
      if (ce) ce.innerHTML = expandBtnHtml();
      drawSkill();
    };
    // Delegate filter/expand clicks on the whole view, so the table's and the
    // chart's controls behave identically wherever they live.
    node.addEventListener("click", (e) => {
      const pill = e.target.closest(".fpill");
      if (pill) {
        if (pill.dataset.type) LB_VIEW.type = pill.dataset.type;
        if (pill.dataset.tier) LB_VIEW.tier = pill.dataset.tier;
        LB_VIEW.expanded = false;
        refresh();
        return;
      }
      const exp = e.target.closest("[data-expand]");
      if (exp) { LB_VIEW.expanded = exp.dataset.expand === "1"; refresh(); }
    });
    const lbHead = node.querySelector("#lb-table thead tr");
    lbHead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-key]"); if (!th) return;
      const key = th.dataset.key;
      const dir = (LB_SORT && LB_SORT.key === key && LB_SORT.dir === 1) ? -1 : 1;
      LB_SORT = { key, dir };
      [...lbHead.children].forEach(h => h.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(dir === 1 ? "sort-asc" : "sort-desc");
      tb.innerHTML = tbodyHtml();
      drawSkill();
    });
    const series = rpsSeriesOverTime();
    const box = node.querySelector("#rps-over-time");
    if (series && box) WCViz.rpsOverTime(box, series);
    else if (box) box.closest(".chartbox").outerHTML = `<div class="note">This chart appears once at least two matches have been played.</div>`;
    drawSkill();
  };
  return node;
}

function bracketGroupsColumn(b) {
  const groups = groupMembers();
  const thirdTeams = new Set(Object.values(b.thirdSlots));
  const cards = Object.keys(groups).sort().map(L => {
    const p = b.proj[L] || {};
    const rest = groups[L].filter(t => t !== p.first && t !== p.second)
      .sort((a, c) => ((b.reach[c] || {}).reach_r32 || 0) - ((b.reach[a] || {}).reach_r32 || 0));
    const ordered = [p.first, p.second, ...rest].filter(Boolean);
    const rows = ordered.map(t => {
      const direct = t === p.first || t === p.second;
      const asThird = thirdTeams.has(t);
      const cls = direct ? "fav" : asThird ? "third" : "outp";
      const tip = direct ? "projected to qualify directly (top two)"
        : asThird ? "projected to qualify as one of the eight best third-placed teams"
        : "projected to go out in the group stage";
      return `<div class="tie-team ${cls}" title="${tip}">${teamLink(t)}<span class="p">${pct((b.reach[t] || {}).reach_r32)}</span></div>`;
    }).join("");
    return `<div class="tie bgroup" data-bk="G-${esc(L)}" data-href="#/group/${esc(L)}" title="Open group page"><div class="meta">GROUP ${L} →</div>${rows}</div>`;
  }).join("");
  return `<div class="round groupscol"><div class="round-title">Group stage</div>${cards}</div>`;
}

function viewBracket() {
  const b = buildBracket();
  if (!b) {
    return el(`<section><h1>Bracket</h1><div class="note">No knockout fixtures in this export yet.</div></section>`);
  }
  const cols = bracketGroupsColumn(b) + b.rounds.map(rd => `
    <div class="round">
      <div class="round-title">${esc(rd.title)}</div>
      ${rd.ties.map(t => tieCard(t, { final: rd.title === "Final" })).join("")}
      ${rd.title === "Final" && b.thirdPlace ? `<div class="round-title third-title">Third place</div>${tieCard(b.thirdPlace)}` : ""}
    </div>`).join("");
  const node = el(`<section>
    <h1>Bracket</h1>
    <p class="lede">${b.projected
      ? "The full wallchart, from the twelve groups to the final. Until the group stage decides the real pairings, this is the bracket <strong>the ten AI models collectively expect</strong>. In each group, the <span class='good'>top two</span> advance directly and the teams in <span style='color:#e8b64c'>gold</span> are projected to sneak through as one of the eight best third-placed sides — every percentage is that team's chance of reaching the knockouts. Dashed lines are projections; they turn solid as real results lock the slots in."
      : "The knockout bracket, with the ten models' average view of who advances from each tie."}</p>
    <div class="bracket-scroll"><div class="bracket">${cols}</div></div>
  </section>`);
  node._after = () => {
    const c = node.querySelector(".bracket");
    if (!c) return;
    c._edges = b.edges;
    drawBracketLines(c);
    requestAnimationFrame(() => drawBracketLines(c)); // settle after first paint
    c.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // team links navigate themselves
      const t = e.target.closest("[data-href]");
      if (t) location.hash = t.dataset.href;
    });
  };
  return node;
}

function viewMatches() {
  const groupCards = (list) => list.map(fx => {
    const ens = (DB._predsByMatch[fx.match_id] || []).find(p => p.method === "ENS" && p.p_home != null);
    const bar = ens ? hdaBar(ens.p_home, ens.p_draw, ens.p_away) : "";
    const res = fx.result && fx.result.home_goals != null ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span>` : `<span class="muted">${esc(fmtDT(fx.kickoff_utc))}</span>`;
    return `<a class="card" href="#/match/${encodeURIComponent(fx.match_id)}">
      <div class="teams">${team(fx.home)} <span class="dim">v</span> ${team(fx.away)}</div>
      <div class="meta">${esc(fx.group || "Knockout")} · ${res}</div>
      ${bar}
    </a>`;
  }).join("");
  const grp = DB.fixtures.filter(fx => fx.stage === "group");
  const ko = DB.fixtures.filter(fx => fx.stage === "knockout");
  const upsets = topUpsets();
  const upsetSection = upsets.length ? `<h2>Biggest upsets — results that defied the models</h2>
    <div class="cards">${upsets.map((u, i) => {
      const sur = Math.round((0.5 - u.pwin) * 100);
      return `<a class="card upset${i === 0 ? " big" : ""}" href="#/match/${encodeURIComponent(u.fx.match_id)}">
        <div class="upset-top"><span class="badge">${u.ko ? "Knockout" : "Group stage"}</span><span class="surprise">+${sur}</span></div>
        <div class="teams">${team(u.winner)} <span class="dim">${u.ko ? "advanced past" : "beat"}</span> ${team(u.favorite)}</div>
        <div class="muted" style="font-size:13px;margin-top:4px">models gave <strong>${esc(u.winner)}</strong> only <span class="bad">${pct(u.pwin)}</span> ${u.ko ? "to advance" : "to win"}</div>
        <div class="barrow"><span class="u" style="width:${u.pwin * 100}%"></span><span class="f" style="width:${(1 - u.pwin) * 100}%"></span></div>
        <div class="upset-foot"><span class="result">${u.score}</span></div>
      </a>`;
    }).join("")}</div>` : "";
  return el(`<section><h1>Matches</h1>
    <p class="lede">Every match, every forecast — locked before kickoff. The bar on each card is the combined view of all ten models (blue = home win, grey = draw, red = away win). Click any match for the full breakdown.</p>
    ${upsetSection}
    <div class="cards">${groupCards(grp)}</div>
    ${ko.length ? `<h2>Knockout rounds — pairings settle after the group stage · see the <a href="#/bracket">projected bracket</a></h2><div class="cards">${groupCards(ko)}</div>` : ""}
  </section>`);
}

const advBar = (ph, pa) => `<div class="bar"><span class="h" style="width:${(ph || 0) * 100}%"></span><span class="a" style="width:${(pa || 0) * 100}%"></span></div>`;
function advStrip(preds, home, away, mktAdv) {
  // Left = home, right = away (matches the "Home v Away" title); a home-favored dot
  // sits toward the left, so its position is (1 − p_advance_home).
  const dots = preds.map(p => {
    const v = p.p_advance_home, fam = famOf(p.method);
    const color = WCViz.SERIES_COLORS[p.method.replace(/c$/, "")] || WCViz.SERIES_COLORS.B1;
    const name = p.model ? `${methodName(p.method)} · ${shortModel(p.model)}` : methodName(p.method);
    return `<span class="dotp" data-fam="${fam}" style="left:${(1 - v) * 100}%; top:${FAM_LANE[fam]}%; background:${color}" title="${esc(name)}: ${pct1(v)} ${esc(home)} to advance"></span>`;
  }).join("");
  const mid = `<span class="strip-mid" title="50% — toss-up"></span>`;
  const mk = mktAdv != null ? `<span class="mktmark" style="left:${(1 - mktAdv) * 100}%" title="Betting market (from 1X2): ${pct1(mktAdv)} ${esc(home)} to advance"></span>` : "";
  const chips = STRIP_FAMS.map(([fam, label, color]) => `<button class="lg" data-fam="${fam}" type="button" title="Click to hide or show"><span class="dot" style="background:${color()}"></span>${label}</button>`).join("");
  return `<div class="strip"><div class="striprow"><span class="striplabel">advances</span><div class="striptrack">${mid}${dots}${mk}</div></div>
    <div class="striprow"><span class="striplabel"></span><div class="striptrack" style="height:0"><span style="position:absolute;left:0;color:var(--dim);font:600 11px var(--mono)">${esc(home)}</span><span style="position:absolute;left:50%;transform:translateX(-50%);color:var(--dim);font:600 11px var(--mono)">50%</span><span style="position:absolute;right:0;color:var(--dim);font:600 11px var(--mono)">${esc(away)}</span></div></div>
    <div class="legend">${chips}<span><span class="dot mktdot"></span>Betting market (from 1X2)</span></div></div>`;
}

function viewMatch(id) {
  const fx = DB._fixById[id];
  if (!fx) return el(`<section><a class="back" href="#/matches">← Matches</a><p>Unknown match.</p></section>`);
  const isKO = fx.stage === "knockout";
  const preds = (DB._predsByMatch[id] || []).filter(p => isKO ? p.p_advance_home != null : p.p_home != null);
  const o = outcomeVec(fx);
  // advancement outcome (knockouts): 0 = home advanced, 1 = away advanced, null = unknown
  const adv = isKO && fx.result && fx.result.advanced_team
    ? (fx.result.advanced_team === fx.home ? 0 : fx.result.advanced_team === fx.away ? 1 : null) : null;
  const isLocked = preds.some(p => p.as_of === "T-3h");
  const rowFor = isKO
    ? (label, kind, p, hash, code) => {
        const b = adv != null ? brierBin([p.p_advance_home, p.p_advance_away], adv) : null;
        return `<tr><td><span class="pill ${pillClass(kind)}" title="${esc(code || "")}">${esc(label)}</span></td>
          <td class="num">${pct(p.p_advance_home)}</td><td class="num">${pct(p.p_advance_away)}</td>
          <td class="shapecol">${advBar(p.p_advance_home, p.p_advance_away)}</td>
          <td class="num">${f3(b)}</td>
          <td class="mono muted hashcol">${hash ? esc(hash.slice(0, 10)) : ""}</td></tr>`;
      }
    : (label, kind, p, hash, code) => {
        const r = o ? rps([p.p_home, p.p_draw, p.p_away], o) : null;
        return `<tr><td><span class="pill ${pillClass(kind)}" title="${esc(code || "")}">${esc(label)}</span></td>
          <td class="num">${pct(p.p_home)}</td><td class="num">${pct(p.p_draw)}</td><td class="num">${pct(p.p_away)}</td>
          <td class="shapecol">${hdaBar(p.p_home, p.p_draw, p.p_away)}</td>
          <td class="num">${f3(r)}</td>
          <td class="mono muted hashcol">${hash ? esc(hash.slice(0, 10)) : ""}</td></tr>`;
      };
  const predRows = preds.map(p => { const m = seriesMeta(p); return rowFor(m.label, m.kind, p, p.input_hash, m.key); }).join("");
  const m = mktVector(id);  // de-vigged 1X2 (group AND knockout odds are captured)
  // No "to advance" market is captured (prereg amendment), but we can derive the market's
  // advance probability from its 1X2: P(home advances) = P(home win) + P(draw) split toward
  // the stronger side. This is illustrative (display only), not the scored benchmark.
  const mktAdv = isKO && m ? m.p[0] + m.p[1] * m.p[0] / (m.p[0] + m.p[2]) : null;
  const mktRow = !m ? "" : (isKO
    ? rowFor(`Betting market (from 1X2, ${m.source})`, "mkt", { p_advance_home: mktAdv, p_advance_away: 1 - mktAdv }, null, "derived from 1X2")
    : rowFor(`Betting market (${m.source})`, "mkt", { p_home: m.p[0], p_draw: m.p[1], p_away: m.p[2] }, null, "de-vigged"));
  const oddsRows = (DB._oddsByMatch[id] || []).map(r => `<tr><td>${esc(r.source)}</td><td class="muted" data-sort="${Date.parse(r.captured_at) || 0}">${esc(fmtDT(r.captured_at))}</td><td class="num">${r.o_home}</td><td class="num">${r.o_draw}</td><td class="num">${r.o_away}</td></tr>`).join("");
  const resultLine = o
    ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span> · <span class="win">${isKO ? (adv != null ? `${esc(adv === 0 ? fx.home : fx.away)} advanced` : "decided") : ["home win", "draw", "away win"][o[0] ? 0 : o[1] ? 1 : 2]}</span>`
    : `<span class="muted">${esc(fmtFull(fx.kickoff_utc))}</span>`;
  const rationales = preds.filter(p => p.rationale && p.model && (p.method === "M1" || p.method === "M2"))
    .map(p => `<details><summary>${esc(methodName(p.method))} · ${esc(shortModel(p.model))} — ${isKO ? `${esc(fx.home)} ${pct(p.p_advance_home)} · ${esc(fx.away)} ${pct(p.p_advance_away)}` : `home ${pct(p.p_home)}, draw ${pct(p.p_draw)}, away ${pct(p.p_away)}`}</summary><p>${esc(p.rationale)}</p></details>`).join("");
  const batchNote = preds.length
    ? (isLocked
      ? `<div class="note">These forecasts are <strong>locked</strong> — captured 3 hours before kickoff and published with cryptographic fingerprints before the match started.${isKO ? " A knockout is single-elimination, so the models forecast <strong>who advances</strong> (a 90-minute draw is settled by extra time / penalties)." : ""}</div>`
      : `<div class="note">These are the <strong>pre-tournament forecasts</strong>, made before the World Cup began. They update one final time — and lock for scoring — 3 hours before kickoff.</div>`)
    : "";
  const cols = 7;
  const node = el(`<section>
    <a class="back" href="#/matches">← Matches</a>
    <h1>${teamLink(fx.home)} <span class="dim">v</span> ${teamLink(fx.away)}</h1>
    <p class="lede">${fx.group ? `<a class="tlink" href="#/group/${esc(fx.group.replace("Group", "").trim())}">${esc(fx.group)}</a>` : "Knockout"}${fx.ground ? " · " + esc(fx.ground) : ""} · ${resultLine}</p>
    ${preds.length ? `<h2>Every forecast at a glance</h2><p class="muted">${isKO ? "Each dot is one forecaster's probability that the home side advances." : "Each dot is one forecaster's probability; the white line is the betting market."} Hover any dot for details.</p>${isKO ? advStrip(preds, fx.home, fx.away, mktAdv) : probStrip(preds, m)}` : ""}
    ${batchNote}
    <h2>The forecasts</h2>
    ${tableWrap(`<table class="sortable"><thead><tr><th>Forecaster</th>${isKO ? `<th class="num">${esc(fx.home)} adv</th><th class="num">${esc(fx.away)} adv</th>` : `<th class="num">Home win</th><th class="num">Draw</th><th class="num">Away win</th>`}<th class="nosort">shape</th><th class="num" title="${isKO ? "Brier on advancement — lower is better" : "Ranked Probability Score — lower is better"}">${isKO ? "Brier" : "error"}</th><th class="hashcol nosort">fingerprint</th></tr></thead>
      <tbody>${predRows || `<tr><td colspan="${cols}" class="muted">Forecasts for this match lock 3 hours before kickoff.</td></tr>`}${mktRow}</tbody></table>`)}
    ${rationales ? `<h2>In the models' own words</h2><div class="rationales">${rationales}</div>` : ""}
    <h2>Bookmaker odds, as captured</h2>
    ${tableWrap(`<table class="sortable"><thead><tr><th>Bookmaker</th><th>captured</th><th class="num">Home</th><th class="num">Draw</th><th class="num">Away</th></tr></thead><tbody>${oddsRows || `<tr><td colspan="5" class="muted">Odds are captured 3 hours before kickoff.</td></tr>`}</tbody></table>`)}
  </section>`);
  node._after = () => wireStripToggles(node);
  return node;
}

function viewTeam(name) {
  const t = decodeURIComponent(name);
  if (!FLAGS[t]) return el(`<section><a class="back" href="#/">← Leaderboard</a><p>Unknown team.</p></section>`);
  const groups = groupMembers();
  const letter = Object.keys(groups).find(g => groups[g].includes(t));
  const { models, baselines, cps, all } = latestForecast();
  const reach = consensusReach(models);
  const r = reach[t] || {};
  const ratings = (DB.team_ratings || []).filter(x => x.team === t);
  const rcps = orderCheckpoints([...new Set(ratings.map(x => x.as_of))]);
  const latestRatings = ratings.filter(x => x.as_of === rcps[rcps.length - 1]);
  const ratingMean = mean(latestRatings.map(x => x.rating));
  const fixtures = DB.fixtures.filter(fx => fx.home === t || fx.away === t)
    .sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""));
  const cards = fixtures.map(fx => {
    const ens = (DB._predsByMatch[fx.match_id] || []).find(p => p.method === "ENS" && p.p_home != null);
    const bar = ens ? hdaBar(ens.p_home, ens.p_draw, ens.p_away) : "";
    const res = fx.result && fx.result.home_goals != null ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span>` : `<span class="muted">${esc(fmtDT(fx.kickoff_utc))}</span>`;
    return `<a class="card" href="#/match/${encodeURIComponent(fx.match_id)}">
      <div class="teams">${team(fx.home)} <span class="dim">v</span> ${team(fx.away)}</div>
      <div class="meta">${esc(fx.group || "Knockout")} · ${res}</div>${bar}</a>`;
  }).join("");
  const teamRows = models.filter(f => f.team === t)
    .concat(baselines.filter(f => f.team === t).map(f => ({ ...f, model: f.method })));
  const node = el(`<section>
    <a class="back" href="#/">← Leaderboard</a>
    <h1>${flag(t)}${esc(t)}</h1>
    <p class="lede">${letter ? `<a class="tlink" href="#/group/${esc(letter)}">Group ${esc(letter)}</a> · ` : ""}How the ten AI models — and the non-AI baselines — rate this team's World Cup.</p>
    <div class="hero">
      <div class="hero-card"><div class="hero-kicker">Chance to win the World Cup</div><div class="hero-num">${pct1(r.champion)}</div><div class="hero-sub">average of ten AI models</div></div>
      <div class="hero-card alt"><div class="hero-kicker">Reach the knockouts · strength rating</div><div class="hero-num">${pct(r.reach_r32)} <span class="dim">·</span> ${ratingMean == null ? "—" : ratingMean.toFixed(0)}<span class="hero-sub" style="font-size:16px">/100</span></div><div class="hero-sub">knockout chance · consensus rating</div></div>
    </div>
    <h2>Road through the tournament — every forecaster</h2>
    <p class="muted">How likely each round is, line by line: the ten models in color, the two non-AI baselines in gold.</p>
    ${chartBox("team-reach", 320)}
    <h2>How strong is ${esc(t)}? Each model's rating</h2>
    ${chartBox("team-ratings", Math.max(220, latestRatings.length * 26 + 70))}
    ${cps.length > 1 ? `<h2>Title odds over time</h2>${chartBox("team-traj", 280)}` : ""}
    <h2>${esc(t)}'s matches</h2>
    <div class="cards">${cards}</div>
  </section>`);
  node._after = () => {
    const rc = node.querySelector("#team-reach");
    if (rc && teamRows.length) WCViz.reachCurves(rc, teamRows, shortModel);
    const rb = node.querySelector("#team-ratings");
    if (rb && latestRatings.length) WCViz.ratingBars(rb, latestRatings.map(x => ({ model: x.model, label: shortModel(x.model), rating: x.rating })));
    const tj = node.querySelector("#team-traj");
    if (tj) {
      const byCp = {};
      for (const f of all) if (f.method === "M3") (byCp[f.as_of] ||= []).push({ model: f.model, team: f.team, p_champion: f.reach.champion });
      WCViz.trajectory(tj, cps, byCp, t, shortModel);
    }
  };
  return node;
}

function viewGroup(letter) {
  const L = decodeURIComponent(letter).toUpperCase();
  const groups = groupMembers();
  const members = groups[L];
  if (!members) return el(`<section><a class="back" href="#/">← Leaderboard</a><p>Unknown group.</p></section>`);
  const { models } = latestForecast();
  const reach = consensusReach(models);
  const stats = groupStandings();
  const anyPlayed = members.some(t => stats[t]);
  const order = members.slice().sort((a, b) => {
    const sa = stats[a] || { p: 0, gd: 0, gf: 0 }, sb = stats[b] || { p: 0, gd: 0, gf: 0 };
    return (sb.p - sa.p) || (sb.gd - sa.gd) || (sb.gf - sa.gf)
      || (((reach[b] || {}).reach_r32 || 0) - ((reach[a] || {}).reach_r32 || 0));
  });

  const standingsRows = order.map((t, i) => {
    const s = stats[t], r = reach[t] || {};
    return `<tr${i < 2 ? ` class="lead"` : ""}>
      <td class="num muted">${i + 1}</td>
      <td>${teamLink(t)}</td>
      <td class="num">${s ? `${s.w}-${s.d}-${s.l}` : "—"}</td>
      <td class="num">${s ? (s.gd >= 0 ? "+" : "") + s.gd : "—"}</td>
      <td class="num">${s ? s.p : "—"}</td>
      <td class="num">${pct(r.reach_r32)}</td>
    </tr>`;
  }).join("");

  // Finishing-position distribution (consensus): where each team is expected to land.
  const posBars = order.map(t => {
    const r = reach[t] || {};
    const seg = (v, cls, label) => `<span class="${cls}" style="width:${(v || 0) * 100}%" title="${label}: ${pct1(v)}"></span>`;
    return `<div class="grow posrow">
      <span class="gname">${teamLink(t)}</span>
      <div class="bar posbar">
        ${seg(r.win_group, "g1", "Wins the group")}${seg(r.runner_up, "g2", "Finishes second")}${seg(r.third, "g3", "Finishes third")}${seg(r.fourth, "g4", "Finishes last")}
      </div>
    </div>`;
  }).join("");

  const fixtures = DB.fixtures.filter(fx => fx.group === `Group ${L}`)
    .sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""));
  const cards = fixtures.map(fx => {
    const ens = (DB._predsByMatch[fx.match_id] || []).find(p => p.method === "ENS" && p.p_home != null);
    const bar = ens ? hdaBar(ens.p_home, ens.p_draw, ens.p_away) : "";
    const res = fx.result && fx.result.home_goals != null ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span>` : `<span class="muted">${esc(fmtDT(fx.kickoff_utc))}</span>`;
    return `<a class="card" href="#/match/${encodeURIComponent(fx.match_id)}">
      <div class="teams">${team(fx.home)} <span class="dim">v</span> ${team(fx.away)}</div>
      <div class="meta">${res}${fx.ground ? " · " + esc(city(fx.ground)) : ""}</div>${bar}</a>`;
  }).join("");

  const node = el(`<section>
    <a class="back" href="#/bracket">← Bracket</a>
    <h1>Group ${esc(L)}</h1>
    <p class="lede">${anyPlayed ? "Live standings and what the ten AI models expect from here." : "Nothing decided yet — this is how the ten AI models expect the group to go."} The top two qualify directly; a strong third place can still sneak through as one of the eight best thirds.</p>
    <h2>Standings</h2>
    ${tableWrap(`<table class="sortable"><thead><tr><th class="num">#</th><th>Team</th><th class="num" title="wins-draws-losses">W-D-L</th><th class="num" title="goal difference">+/−</th><th class="num">points</th><th class="num">reaches knockouts</th></tr></thead><tbody>${standingsRows}</tbody></table>`)}
    <h2>Where each team is expected to finish</h2>
    <p class="muted">The models' average view, all four finishing positions per team — hover any segment.</p>
    <div class="group-card posgrid">${posBars}
      <div class="legend">
        <span><span class="dot" style="background:#2bff88"></span>Wins the group</span>
        <span><span class="dot" style="background:#5b8cff"></span>Second</span>
        <span><span class="dot" style="background:#e8b64c"></span>Third</span>
        <span><span class="dot" style="background:#4a566f"></span>Last</span>
      </div>
    </div>
    <h2>Chance to reach the knockouts — bars are the ten-model average, dots are each model</h2>
    ${chartBox("group-quals", 240)}
    <h2>The matches</h2>
    <div class="cards">${cards}</div>
  </section>`);
  node._after = () => {
    const c = node.querySelector("#group-quals");
    if (c) WCViz.titleRace(c, models.filter(f => members.includes(f.team))
      .map(f => ({ team: f.team, model: f.model, p_champion: f.reach.reach_r32 || 0 })), shortModel, 4);
  };
  return node;
}

function viewForecast() {
  const { rows: fcRows, models, baselines, cps, latest, all: fcAll } = latestForecast();
  if (!fcRows.length) {
    return el(`<section><h1>Forecast</h1><div class="note">No tournament forecast in this export yet.</div></section>`);
  }
  const champ = fcRows.some(f => f.reach.champion != null);
  const key = champ ? "champion" : "reach_r32";
  const display = models.concat(baselines.map(f => ({ ...f, model: f.method })));
  const multi = new Set(display.map(f => f.model)).size > 1;

  const consensus = {};
  for (const f of models) (consensus[f.team] ||= []).push(f.reach[key] || 0);
  const teamsByConsensus = Object.entries(consensus).map(([t, v]) => ({ t, m: mean(v) })).sort((a, b) => b.m - a.m);
  const topTeam = teamsByConsensus[0] && teamsByConsensus[0].t;

  const rows = display.slice().sort((a, b) => (b.reach[key] || 0) - (a.reach[key] || 0)).map((f, i) => {
    const r = f.reach;
    const tail = champ
      ? `<td class="num">${pct(r.reach_sf)}</td><td class="num">${pct(r.reach_final)}</td>
         <td class="num">${pct(r.champion)}</td>
         <td class="shapecol"><div class="bar brand"><span class="h" style="width:${r.champion * 100}%"></span></div></td>`
      : `<td class="shapecol"><div class="bar brand"><span class="h" style="width:${r.reach_r32 * 100}%"></span></div></td>`;
    return `<tr>
      <td class="num muted">${i + 1}</td>
      <td>${teamLink(f.team)}${multi ? ` <span class="dim mono">${esc(shortModel(f.model))}</span>` : ""}</td>
      <td class="num">${pct(r.win_group)}</td>
      <td class="num">${pct(r.reach_r32)}</td>
      ${tail}
    </tr>`;
  }).join("");
  const head = champ
    ? `<th class="num">#</th><th>Team</th><th class="num">Wins group</th><th class="num">Knockouts</th><th class="num">Semifinal</th><th class="num">Final</th><th class="num">Champion</th><th class="nosort">title odds</th>`
    : `<th class="num">#</th><th>Team</th><th class="num">Wins group</th><th class="num">Reaches knockouts</th><th class="nosort">shape</th>`;

  const teamOptions = teamsByConsensus.map(({ t }) => `<option value="${esc(t)}"${t === topTeam ? " selected" : ""}>${esc(t)}</option>`).join("");

  const node = el(`<section>
    <h1>Forecast</h1>
    <p class="lede">Before the tournament, each AI rated all 48 teams — then we played the entire World Cup <strong>50,000 times per model</strong> in simulation: every group, every tiebreaker, every knockout round. These are the odds that came out. Two non-AI baselines (Elo ratings and squad market value) run through the exact same simulation, so you can see whether the AIs actually know anything the obvious yardsticks don't.</p>
    ${champ ? `<h2>The title race — bars are the ten-model average; dots are each forecaster</h2>${chartBox("title-race", 430)}` : ""}
    <h2>Road to the final · <select id="team-pick" class="picker">${teamOptions}</select></h2>
    ${chartBox("reach-curves", 300)}
    ${cps.length > 1 ? `<h2>Title odds over time</h2>${chartBox("trajectory", 300)}` : ""}
    ${ratingsHeatmap()}
    <h2>Full table — every forecaster, every team</h2>
    <div class="note">A team's "chance to win it all" can't be proven right or wrong by a single tournament — it's tracked for honesty, not scored. Forecast quality is judged on the match-by-match <a href="#/">leaderboard</a>.</div>
    ${tableWrap(`<table class="sortable"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`)}
  </section>`);

  node._after = () => {
    const tr = node.querySelector("#title-race");
    if (tr && champ) WCViz.titleRace(tr, display.map(f => ({ team: f.team, model: f.model, p_champion: f.reach.champion || 0 })), shortModel);
    const rc = node.querySelector("#reach-curves");
    const drawReach = (t) => rc && WCViz.reachCurves(rc, display.filter(f => f.team === t), shortModel);
    drawReach(topTeam);
    const pick = node.querySelector("#team-pick");
    if (pick) pick.addEventListener("change", () => drawReach(pick.value));
    const tj = node.querySelector("#trajectory");
    if (tj) {
      const byCp = {};
      for (const f of fcAll) if (f.method === "M3") (byCp[f.as_of] ||= []).push({ model: f.model, team: f.team, p_champion: f.reach.champion });
      WCViz.trajectory(tj, cps, byCp, topTeam, shortModel);
    }
  };
  return node;
}

function ratingsHeatmap() {
  const ratings = DB.team_ratings || [];
  if (!ratings.length) return "";
  const cps = orderCheckpoints([...new Set(ratings.map(r => r.as_of))]);
  const latest = cps[cps.length - 1];
  const rows = ratings.filter(r => r.as_of === latest);
  const models = [...new Set(rows.map(r => r.model))];
  const byTeam = {};
  for (const r of rows) (byTeam[r.team] ||= {})[r.model] = r.rating;
  const teams = Object.entries(byTeam)
    .map(([t, m]) => ({ t, mean: mean(Object.values(m)), m }))
    .sort((a, b) => b.mean - a.mean);
  const lo = Math.min(...rows.map(r => r.rating)), hi = Math.max(...rows.map(r => r.rating));
  const shade = (v) => `rgba(43,255,136,${(0.04 + 0.40 * (v - lo) / Math.max(1e-9, hi - lo)).toFixed(3)})`;
  const head = `<div class="hm-cell hm-head hm-team">Team</div>` +
    models.map(m => `<div class="hm-cell hm-head" title="${esc(m)}">${esc(shortModel(m))}</div>`).join("");
  const body = teams.map(x =>
    `<div class="hm-cell hm-team">${teamLink(x.t)}</div>` +
    models.map(mo => {
      const v = x.m[mo];
      return v == null
        ? `<div class="hm-cell hm-miss">·</div>`
        : `<div class="hm-cell" style="background:${shade(v)}" title="${esc(shortModel(mo))} · ${esc(x.t)}: ${v.toFixed(1)}">${Math.round(v)}</div>`;
    }).join("")
  ).join("");
  return `<h2>Where the models disagree</h2>
    <p class="muted">Each AI rated every team's strength from 0 to 100 before the tournament. Brighter green = stronger. Read across a row to spot the teams the models argue about.</p>
    <div class="hm-scroll"><div class="hm" style="grid-template-columns: minmax(150px, 190px) repeat(${models.length}, minmax(46px, 1fr))">${head}${body}</div></div>`;
}

// --- Betting returns engine (illustrative; NOT part of the scored result) ---
function bettingOdds(mid, source) {
  if (source === "fair") { const m = mktVector(mid); return m ? m.p.map(x => 1 / x) : null; }
  const books = {};
  for (const r of (DB._oddsByMatch[mid] || []).filter(r => r.snapshot === "T-3h")
    .sort((a, b) => (a.captured_at || "").localeCompare(b.captured_at || "")))
    books[(r.source || "").toLowerCase()] = [r.o_home, r.o_draw, r.o_away];  // latest per book wins
  if (source === "pinnacle") return books["pinnacle"] || null;
  const all = Object.values(books);
  return all.length ? [0, 1, 2].map(i => Math.max(...all.map(b => b[i]))) : null;  // best available
}
function bettingEntries() {
  const played = new Set(playedFixtures().map(f => f.match_id));
  const ent = {};
  for (const p of DB.predictions) {
    if (p.as_of !== "T-3h" || p.p_home == null || !played.has(p.match_id) || HIDDEN_MODELS.has(p.model)) continue;
    const m = seriesMeta(p);
    (ent[m.key] ||= { key: m.key, label: m.label, kind: m.kind, model: p.model, byMatch: {} })
      .byMatch[p.match_id] = [p.p_home, p.p_draw, p.p_away];
  }
  const mkt = { key: "MKT", label: "Betting market", kind: "mkt", model: null, byMatch: {} };
  for (const f of playedFixtures()) { const v = mktVector(f.match_id); if (v) mkt.byMatch[f.match_id] = v.p; }
  ent.MKT = mkt;
  return Object.values(ent);
}
function bettingResults(strat, source) {
  const played = playedFixtures();
  const rows = bettingEntries().map(e => {
    let pnl = 0, staked = 0, bets = 0, bank = 100, n = 0;
    const points = [];
    for (const f of played) {
      const p = e.byMatch[f.match_id];
      const odds = p ? bettingOdds(f.match_id, source) : null;
      if (p && odds) {
        const win = outcomeVec(f).indexOf(1);
        if (strat === "pick") { const i = p.indexOf(Math.max(...p)); staked += 1; bets += 1; pnl += i === win ? odds[i] - 1 : -1; }
        else if (strat === "value") { for (let i = 0; i < 3; i++) if (p[i] * odds[i] > 1) { staked += 1; bets += 1; pnl += i === win ? odds[i] - 1 : -1; } }
        else {  // valbest / kelly: act on the single best-edge leg
          let bi = -1, be = 1; for (let i = 0; i < 3; i++) { const ev = p[i] * odds[i]; if (ev > be) { be = ev; bi = i; } }
          if (bi >= 0) {
            if (strat === "valbest") { staked += 1; bets += 1; pnl += bi === win ? odds[bi] - 1 : -1; }
            else { const b = odds[bi] - 1, fr = (b * p[bi] - (1 - p[bi])) / b, st = 0.5 * Math.max(0, fr) * bank; staked += st; bets += 1; bank += bi === win ? st * (odds[bi] - 1) : -st; }
          }
        }
      }
      n += 1; points.push({ x: n, y: strat === "kelly" ? bank : pnl });
    }
    const roi = staked > 0 ? pnl / staked : null;
    return { key: e.key, label: e.label, kind: e.kind, model: e.model, bets, staked, pnl, bank, roi, final: strat === "kelly" ? bank : pnl, points };
  });
  rows.sort((a, b) => b.final - a.final);
  return rows;
}

function viewReturns() {
  if (!playedFixtures().length || !DB.market_odds.length)
    return el(`<section><h1>If you'd bet the models</h1><div class="note">Betting returns appear once matches have been played and odds captured.</div></section>`);
  const isKelly = () => RET_VIEW.strat === "kelly";
  const pills = (obj, attr, cur) => Object.entries(obj).map(([k, v]) =>
    `<button type="button" class="fpill${cur === k ? " on" : ""}" data-${attr}="${k}">${esc(v)}</button>`).join("");
  const controlsHtml = () =>
    `<div class="lbfilters"><span class="flabel">Strategy</span>${pills(RET_STRATS, "ret-strat", RET_VIEW.strat)}</div>` +
    `<div class="lbfilters"><span class="flabel">Odds</span>${pills(RET_SOURCES, "ret-source", RET_VIEW.source)}</div>`;
  const tableHtml = () => {
    const rows = bettingResults(RET_VIEW.strat, RET_VIEW.source);
    const body = rows.map((r, i) => {
      const result = isKelly() ? r.bank.toFixed(1) : (r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(2);
      const roi = r.roi == null ? "—" : (r.roi >= 0 ? "+" : "") + (100 * r.roi).toFixed(0) + "%";
      return `<tr class="${r.bets < 5 ? "lown" : ""}">
        <td class="num muted">${i + 1}</td>
        <td><span class="pill ${pillClass(r.kind)}" title="${esc(r.key)}">${esc(r.label)}</span></td>
        <td class="num">${r.bets}</td>
        <td class="num" data-sort="${r.final}">${result}</td>
        <td class="num" data-sort="${r.roi == null ? -999 : r.roi}">${roi}</td>
      </tr>`;
    }).join("");
    return `<table class="sortable"><thead><tr><th class="num">#</th><th>Forecaster</th><th class="num">bets</th><th class="num">${isKelly() ? "final bankroll" : "profit / loss"}</th><th class="num">ROI</th></tr></thead><tbody>${body}</tbody></table>`;
  };
  const node = el(`<section>
    <h1>If you'd bet the models</h1>
    <div class="note">An illustrative lens — <strong>not</strong> part of the scored result. It simulates 1-unit 1X2 bets on each model's pre-kickoff probabilities, settled at the real odds we captured before kickoff. Small samples are very noisy; rows under 5 bets are greyed.</div>
    <div id="ret-controls">${controlsHtml()}</div>
    ${chartBox("returns-chart", 360)}
    <div id="ret-table">${tableWrap(tableHtml())}</div>
    <p class="muted" style="margin-top:10px">“Value bets” stakes 1u on every outcome priced below the model's probability; “best pick” stakes on the single best-value outcome per match; “follow the pick” backs the model's favourite every match; “Half-Kelly” compounds a bankroll from 100. Odds source changes the price each bet is settled at — “best available” shops all four books, so even the market shows a profit there (pure line-shopping); “de-vigged fair” removes the margin, isolating forecasting skill.</p>
  </section>`);
  node._after = () => {
    const drawChart = () => {
      const rows = bettingResults(RET_VIEW.strat, RET_VIEW.source);
      const pick = rows.slice(0, 10);
      for (const k of ["ENS", "MKT"]) { const r = rows.find(x => x.key === k); if (r && !pick.includes(r)) pick.push(r); }
      const series = pick.map(r => ({
        key: r.label,
        color: r.model ? WCViz.modelColor(r.model) : (WCViz.SERIES_COLORS[r.key] || WCViz.SERIES_COLORS.ENS),
        points: r.points,
      }));
      const box = node.querySelector("#returns-chart");
      if (box) WCViz.returnsChart(box, series, isKelly() ? "bankroll (start 100)" : "profit / loss (units)", isKelly() ? 100 : 0);
    };
    drawChart();  // initial table sort is wired by render()'s central attachSort
    node.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ret-strat],[data-ret-source]"); if (!b) return;
      if (b.dataset.retStrat) RET_VIEW.strat = b.dataset.retStrat;
      if (b.dataset.retSource) RET_VIEW.source = b.dataset.retSource;
      node.querySelector("#ret-controls").innerHTML = controlsHtml();
      node.querySelector("#ret-table").innerHTML = tableWrap(tableHtml());
      drawChart();
      node.querySelectorAll("#ret-table table.sortable").forEach(attachSort);
    });
  };
  return node;
}

function viewVerify() {
  const rows = DB.predictions.filter(p => p.input_hash).slice(0, 200).map(p =>
    `<tr><td class="mono"><a href="#/match/${encodeURIComponent(p.match_id)}">${esc(p.match_id)}</a></td><td><span class="pill ${pillClass(p.model ? "m" : "base")}">${esc(methodName(p.method))}${p.model ? " · " + esc(shortModel(p.model)) : ""}</span></td><td class="mono muted hashfull">${esc(p.input_hash)}</td></tr>`).join("");
  return el(`<section>
    <h1>Verify</h1>
    <p class="lede">Don't take our word for any of this. Every forecast is published to a public git repository <strong>before</strong> the match it predicts, stamped with a cryptographic fingerprint (a SHA-256 hash). GitHub records when each push arrived — a timestamp we can't fake or back-date.</p>
    <div class="note">To check a forecast yourself: open the <a href="https://github.com/nikitamed/Robot-League" target="_blank" rel="noopener">public record</a>, find the commit for a match day in the git history, confirm it's dated before the match was played, and compare the fingerprints in the commit message with the ones below. If we'd changed a single digit of any forecast after the fact, the fingerprints wouldn't match.</div>
    ${tableWrap(`<table class="sortable"><thead><tr><th>match</th><th>forecaster</th><th class="nosort">fingerprint (SHA-256)</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="muted">Per-match fingerprints appear with the first locked batch.</td></tr>`}</tbody></table>`)}
  </section>`);
}

function viewAbout() {
  return el(`<section>
    <h1>How it works</h1>
    <p class="lede">Everyone says AI can predict things. Nobody usually checks. This project takes ten of the world's most advanced AI models, makes them forecast <strong>every match of the 2026 World Cup</strong>, and scores them against the toughest forecaster on Earth: the betting market. In public. With receipts.</p>

    <h2>What happens before every match</h2>
    <div class="kv">
      <div>3 hours before kickoff</div><div>Each AI gives its final probabilities for the match — home win, draw, away win. At the same moment we save the bookmakers' odds. Everything is locked, fingerprinted, and pushed to a public record. After that, nothing can be edited.</div>
      <div>After the final whistle</div><div>The real result comes in, and every forecaster's error gets measured. The <a href="#/">leaderboard</a> updates automatically.</div>
    </div>

    <h2>Each AI forecasts three ways</h2>
    <div class="kv">
      <div>Blind</div><div>Just the fixture — no internet. Pure prior knowledge: what the model already "knows" about football. <span class="dim">(code: M1)</span></div>
      <div>Web search</div><div>The same question, but the model may search the live web first — injuries, lineups, form, news. Comparing this to Blind is the experiment's core question. <span class="dim">(M2)</span></div>
      <div>Ratings engine</div><div>The model rates all 48 teams 0–100, and a classic football statistics engine (the Dixon-Coles model bookmakers' quants grew up on) turns those ratings into match odds and 50,000 simulated tournaments. <span class="dim">(M3)</span></div>
    </div>

    <h2>Who they're up against</h2>
    <div class="kv">
      <div>Betting market</div><div>Bookmaker odds with the built-in profit margin removed — the standard for "the best available forecast." Beating it consistently is genuinely hard. <span class="dim">(MKT, primarily Pinnacle)</span></div>
      <div>Elo baseline</div><div>The classic chess-style rating system applied to national teams. Zero AI involved. If a model can't beat this, it isn't adding anything. <span class="dim">(B1)</span></div>
      <div>Squad-value baseline</div><div>Just the market value of each squad in euros. Embarrassingly simple — embarrassingly hard to beat. <span class="dim">(B2)</span></div>
      <div>Ensemble</div><div>The average of all the AI forecasts — crowds are often wiser than their members. <span class="dim">(ENS)</span></div>
    </div>

    <h2>How scoring works, in plain words</h2>
    <div class="note">Say a model gives Mexico a 60% chance to win, and Mexico wins. Good forecast — small error. If Mexico had lost, that 60% would cost a bigger error. The score (the <strong>Ranked Probability Score</strong>) also cares about <em>how wrong</em>: confidently predicting a home win when the away side wins hurts more than predicting a draw. Every forecaster gets the same matches, so the average error is directly comparable. <strong>Lower is better.</strong></div>

    <h2>Why you can trust it</h2>
    <div class="kv">
      <div>Locked before kickoff</div><div>Forecasts can't be edited after the fact — each batch is published with cryptographic fingerprints before the match starts. <a href="#/verify">Check one yourself</a>.</div>
      <div>Rules fixed in advance</div><div>The methodology — what gets measured, how, and the one official question — was written down, hashed, and published <em>before the first match</em>. No moving the goalposts.</div>
      <div>One official question</div><div>Does giving an AI web search make its forecasts better or worse? (Same model, same match, search on vs. off.) Everything else here is shown for interest, clearly labeled.</div>
      <div>Losses stay up</div><div>If the AIs lose to the bookmakers — or to the embarrassingly simple baselines — that's the result. The honesty is the product.</div>
    </div>

    <h2>The fine print</h2>
    <p class="muted">The full locked protocol (the preregistration), every forecast, the raw captured odds, and this site live in the public record:
    <a href="https://github.com/nikitamed/Robot-League" target="_blank" rel="noopener">github.com/nikitamed/Robot-League</a>.
    The roster: Claude Fable 5, Claude Opus 4.8, Claude Haiku 4.5, GPT-5.5, GPT-5.4 mini, Gemini 3.1 Pro, Gemini 3.5 Flash, Grok 4.3, DeepSeek v4 Pro, DeepSeek v4 Flash — exact model versions pinned in the protocol. Times on this site are shown in your local timezone.</p>
    ${emailCapture()}
  </section>`);
}

// --- router ---
function render() {
  if (TICK) { clearInterval(TICK); TICK = null; }
  const h = location.hash || "#/";
  let m;
  let node;
  if ((m = h.match(/^#\/match\/(.+)$/))) node = viewMatch(decodeURIComponent(m[1]));
  else if ((m = h.match(/^#\/team\/(.+)$/))) node = viewTeam(m[1]);
  else if ((m = h.match(/^#\/group\/(.+)$/))) node = viewGroup(m[1]);
  else if (h.startsWith("#/bracket")) node = viewBracket();
  else if (h.startsWith("#/matches")) node = viewMatches();
  else if (h.startsWith("#/forecast")) node = viewForecast();
  else if (h.startsWith("#/returns")) node = viewReturns();
  else if (h.startsWith("#/verify")) node = viewVerify();
  else if (h.startsWith("#/about")) node = viewAbout();
  else node = viewLeaderboard();
  app().replaceChildren(node);
  if (node._after) node._after();
  node.querySelectorAll("table.sortable").forEach(attachSort);
  markNav();
  window.scrollTo(0, 0);
}

async function main() {
  try {
    const res = await fetch("./data/export.json");
    if (!res.ok) throw new Error(res.status);
    DB = await res.json();
  } catch (e) {
    app().innerHTML = `<div class="note warn">Could not load <code>./data/export.json</code> (${esc(e.message)}). Serve this folder over HTTP: <code>python -m http.server</code> from <code>site/</code>.</div>`;
    return;
  }
  try {
    const res = await fetch("./data/scores.json");
    if (res.ok) SCORES = await res.json();
  } catch { /* optional until the scorer has run */ }
  const skey = (p) => `${p.match_id}|${p.method}|${p.model || ""}`;
  const locked = new Set(DB.predictions.filter(p => p.as_of === "T-3h").map(skey));
  DB.predictions = DB.predictions.filter(p => p.as_of === "T-3h" || !locked.has(skey(p)));
  DB._fixById = Object.fromEntries(DB.fixtures.map(f => [f.match_id, f]));
  DB._oddsByMatch = {}; for (const o of DB.market_odds) (DB._oddsByMatch[o.match_id] ||= []).push(o);
  DB._predsByMatch = {}; for (const p of DB.predictions) (DB._predsByMatch[p.match_id] ||= []).push(p);
  document.getElementById("genmeta").textContent = `record updated ${fmtDT(DB.generated_at)}`;
  fillTicker();
  window.addEventListener("hashchange", render);
  window.addEventListener("resize", () => {
    const c = document.querySelector(".bracket");
    if (c && c._edges) drawBracketLines(c);
  });
  render();
}
main();
