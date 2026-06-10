"use strict";
// Robot League — zero-build site. Reads ONLY ./data/export.json (the versioned
// site contract) plus optional ./data/scores.json from the frozen scorer.
// Browser-side scores are computed from predictions+results so the site stays
// a pure reader — no compute leaks into presentation (spec §4).

let DB = null;     // export.json
let SCORES = null; // scores.json (optional; null until the scorer has run)
let TICK = null;   // live countdown interval
const app = () => document.getElementById("app");
const el = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const MODEL_LABELS = {
  "claude-fable-5": "Fable 5", "claude-opus-4-8": "Opus 4.8", "claude-haiku-4-5": "Haiku 4.5",
  "gpt-5.5-2026-04-23": "GPT-5.5", "gpt-5.4-mini-2026-03-17": "GPT-5.4 mini",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro", "gemini-3.5-flash": "Gemini 3.5 Flash",
  "grok-4.3": "Grok 4.3", "deepseek-v4-pro": "DeepSeek v4 Pro", "deepseek-v4-flash": "DeepSeek v4 Flash",
};
const shortModel = (m) => MODEL_LABELS[m] || (m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");

const FLAGS = {
  "Algeria": "🇩🇿", "Argentina": "🇦🇷", "Australia": "🇦🇺", "Austria": "🇦🇹", "Belgium": "🇧🇪",
  "Bosnia & Herzegovina": "🇧🇦", "Brazil": "🇧🇷", "Canada": "🇨🇦", "Cape Verde": "🇨🇻",
  "Colombia": "🇨🇴", "Croatia": "🇭🇷", "Curaçao": "🇨🇼", "Czech Republic": "🇨🇿",
  "DR Congo": "🇨🇩", "Ecuador": "🇪🇨", "Egypt": "🇪🇬", "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "France": "🇫🇷",
  "Germany": "🇩🇪", "Ghana": "🇬🇭", "Haiti": "🇭🇹", "Iran": "🇮🇷", "Iraq": "🇮🇶",
  "Ivory Coast": "🇨🇮", "Japan": "🇯🇵", "Jordan": "🇯🇴", "Mexico": "🇲🇽", "Morocco": "🇲🇦",
  "Netherlands": "🇳🇱", "New Zealand": "🇳🇿", "Norway": "🇳🇴", "Panama": "🇵🇦",
  "Paraguay": "🇵🇾", "Portugal": "🇵🇹", "Qatar": "🇶🇦", "Saudi Arabia": "🇸🇦",
  "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "Senegal": "🇸🇳", "South Africa": "🇿🇦", "South Korea": "🇰🇷",
  "Spain": "🇪🇸", "Sweden": "🇸🇪", "Switzerland": "🇨🇭", "Tunisia": "🇹🇳", "Turkey": "🇹🇷",
  "United States": "🇺🇸", "Uruguay": "🇺🇾", "Uzbekistan": "🇺🇿",
};
const flag = (t) => FLAGS[t] ? `<span class="flag">${FLAGS[t]}</span>` : "";
const team = (t) => `${flag(t)}${esc(t)}`;

const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");
const pct1 = (x) => (x == null ? "—" : (100 * x).toFixed(1) + "%");
const f3 = (x) => (x == null ? "—" : x.toFixed(3));
const f4 = (x) => (x == null ? "—" : x.toFixed(4));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const kickoffDate = (s) => (s || "").replace("T", " ").replace("Z", "Z");
const shortDate = (s) => { const m = (s || "").match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/); return m ? `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[1]]} ${+m[2]} · ${m[3]}Z` : s; };
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
  const pref = rows.find(r => /pinnacle/i.test(r.source)) || rows.find(r => /betfair/i.test(r.source));
  return pref ? { source: pref.source, p: devig(pref) } : null;
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
    label: isLLM ? `${p.method} · ${shortModel(p.model)}` : p.method,
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
    const m = seriesMeta(p);
    add(m.key, m.label, m.kind, p.match_id, [p.p_home, p.p_draw, p.p_away]);
  }
  for (const fx of DB.fixtures) { const m = mktVector(fx.match_id); if (m) add("MKT", `MKT · ${m.source}`, "mkt", fx.match_id, m.p); }
  const mktMean = mean(series.MKT ? series.MKT.rpss : []);
  const rows = Object.entries(series).map(([k, v]) => ({ key: k, label: v.label, kind: v.kind, rps: mean(v.rpss), n: v.rpss.length, byMid: v.byMid }));
  rows.forEach(r => r.skill = (mktMean != null && r.key !== "MKT") ? (mktMean - r.rps) : null);
  rows.sort((a, b) => a.rps - b.rps);
  return { rows, mktMean };
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
  const primary = (SCORES && SCORES.primary_model) || "claude-fable-5";
  const wanted = new Map([
    [`M1·${primary}`, { key: `M1 · ${shortModel(primary)}`, color: WCViz.SERIES_COLORS.M1 }],
    [`M2·${primary}`, { key: `M2 · ${shortModel(primary)}`, color: WCViz.SERIES_COLORS.M2 }],
    [`M3·${primary}`, { key: `M3 · ${shortModel(primary)}`, color: WCViz.SERIES_COLORS.M3 }],
    ["ENS", { key: "ENS", color: WCViz.SERIES_COLORS.ENS }],
    ["B1", { key: "B1 Elo", color: WCViz.SERIES_COLORS.B1 }],
    ["B2", { key: "B2 value", color: WCViz.SERIES_COLORS.B2 }],
    ["MKT", { key: "MKT", color: WCViz.SERIES_COLORS.MKT }],
  ]);
  const acc = new Map([...wanted.keys()].map(k => [k, { sum: 0, n: 0, points: [] }]));
  for (const fx of played) {
    const o = outcomeVec(fx);
    for (const p of (DB._predsByMatch[fx.match_id] || [])) {
      if (p.p_home == null) continue;
      const key = p.model != null ? `${p.method}·${p.model}` : p.method;
      const a = acc.get(key); if (!a) continue;
      a.sum += rps([p.p_home, p.p_draw, p.p_away], o); a.n += 1;
      a.points.push({ x: a.n, y: a.sum / a.n });
    }
    const m = mktVector(fx.match_id);
    if (m) { const a = acc.get("MKT"); a.sum += rps(m.p, o); a.n += 1; a.points.push({ x: a.n, y: a.sum / a.n }); }
  }
  const series = [...acc.entries()].filter(([, a]) => a.points.length >= 2)
    .map(([k, a]) => ({ key: wanted.get(k).key, color: wanted.get(k).color, points: a.points }));
  return series.length ? series : null;
}

// --- consensus forecast helpers (latest checkpoint) ---
function latestForecast() {
  const all = (DB.tournament_forecast || []).filter(f => f.reach);
  if (!all.length) return { rows: [], cps: [], latest: null, all };
  const cps = orderCheckpoints([...new Set(all.map(f => f.as_of))]);
  const latest = cps[cps.length - 1];
  return { rows: all.filter(f => f.as_of === latest), cps, latest, all };
}
function consensusReach(rows) {
  const by = {};
  for (const f of rows) (by[f.team] ||= []).push(f.reach);
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

// --- bracket projection ---
function buildBracket() {
  const kos = DB.fixtures.filter(fx => fx.stage === "knockout");
  if (!kos.length) return null;
  const { rows } = latestForecast();
  const reach = consensusReach(rows);
  const groups = groupMembers();
  const teamSet = new Set(Object.values(groups).flat());

  // Group projections: 1st = top win_group; 2nd = top runner_up among rest; 3rd likewise.
  const proj = {};
  for (const [letter, teams] of Object.entries(groups)) {
    const left = [...teams];
    const take = (key) => {
      left.sort((a, b) => ((reach[b] || {})[key] || 0) - ((reach[a] || {})[key] || 0));
      return left.shift();
    };
    proj[letter] = { first: take("win_group"), second: take("runner_up"), third: take("third") };
  }
  // Best-third slots: assign highest consensus `third` candidates to compatible slots.
  const thirdSlots = {};
  const thirdCodes = [...new Set(kos.flatMap(fx => [fx.home, fx.away]))].filter(c => /^3/.test(c));
  const candidates = Object.entries(proj)
    .map(([letter, p]) => ({ letter, team: p.third, p: (reach[p.third] || {}).third || 0 }))
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
  const final = kos.find(fx => /^W10[12]$/i.test(fx.home) || (teamSet.has(fx.home) && !byNum[104] && /w101/i.test(fx.match_id)));
  const third = kos.find(fx => /^L10[12]$/i.test(fx.home) || /l101/i.test(fx.match_id));
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
        const key = nextKey(+m[2]);
        const pa = a.team ? ((reach[a.team] || {})[key] || 0) : 0;
        const pb = b.team ? ((reach[b.team] || {})[key] || 0) : 0;
        const winner = pa >= pb ? a : b, loser = pa >= pb ? b : a;
        r.team = m[1].toUpperCase() === "W" ? winner.team : loser.team;
      }
    }
    memo[code] = r;
    return r;
  }

  function tie(fx, key) {
    const a = resolve(fx.home), b = resolve(fx.away);
    const pa = a.team ? ((reach[a.team] || {})[key] || 0) : 0;
    const pb = b.team ? ((reach[b.team] || {})[key] || 0) : 0;
    const tot = pa + pb;
    return {
      fx, a, b,
      pa: tot ? pa / tot : null, pb: tot ? pb / tot : null,
      projected: a.projected || b.projected,
    };
  }

  // Column layout from the final backwards: each round in the order its parents consume it.
  const refs = (fx) => [fx.home, fx.away].map(c => (c.match(/^[WL](\d+)$/i) || [])[1]).filter(Boolean).map(Number);
  const sf = final ? refs(final).map(n => byNum[n]) : [byNum[101], byNum[102]].filter(Boolean);
  const qf = sf.flatMap(fx => refs(fx).map(n => byNum[n]));
  const r16 = qf.flatMap(fx => refs(fx).map(n => byNum[n]));
  const r32 = r16.flatMap(fx => refs(fx).map(n => byNum[n]));
  const num = (fx) => +(fx.match_id.match(/^M(\d+)$/) || [])[1];

  return {
    projected: Object.keys(byNum).length && kos.some(fx => !teamSet.has(fx.home)),
    rounds: [
      { title: "Round of 32", ties: r32.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Round of 16", ties: r16.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Quarterfinals", ties: qf.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Semifinals", ties: sf.map(fx => tie(fx, nextKey(num(fx)))) },
      { title: "Final", ties: final ? [tie(final, "champion")] : [] },
    ],
    thirdPlace: third ? tie(third, "reach_final") : null,
  };
}

// --- components ---
function hdaBar(ph, pd, pa) {
  return `<div class="bar"><span class="h" style="width:${ph * 100}%"></span><span class="d" style="width:${pd * 100}%"></span><span class="a" style="width:${pa * 100}%"></span></div>`;
}
function tableWrap(html) { return `<div class="tablewrap">${html}</div>`; }
function chartBox(id, h = 320) { return `<div class="chartbox" style="height:${h}px"><canvas id="${id}"></canvas></div>`; }

function tieCard(t, { final = false } = {}) {
  const row = (side, p) => {
    const fav = p != null && p >= 0.5;
    const name = side.team ? team(side.team) : `<span class="dim">TBD</span>`;
    return `<div class="tie-team ${fav ? "fav" : "outp"}">${name}<span class="p">${p == null ? "" : pct(p)}</span></div>`;
  };
  const fx = t.fx;
  return `<div class="tie${final ? " final" : ""}">
    <div class="meta">${esc(fx.match_id)} · ${esc(shortDate(fx.kickoff_utc))}${fx.ground ? " · " + esc(city(fx.ground)) : ""}</div>
    ${row(t.a, t.pa)}${row(t.b, t.pb)}
  </div>`;
}

function probStrip(preds, mkt) {
  const rowFor = (label, idx) => {
    const dots = preds.map(p => {
      const v = [p.p_home, p.p_draw, p.p_away][idx];
      const color = WCViz.SERIES_COLORS[p.method.replace(/c$/, "")] || "#8b94a7";
      const name = p.model ? `${p.method} · ${shortModel(p.model)}` : p.method;
      return `<span class="dotp" style="left:${v * 100}%; background:${color}" title="${esc(name)}: ${pct1(v)}"></span>`;
    }).join("");
    const mark = mkt ? `<span class="mktmark" style="left:${mkt.p[idx] * 100}%" title="MKT · ${esc(mkt.source)}: ${pct1(mkt.p[idx])}"></span>` : "";
    return `<div class="striprow"><span class="striplabel">${label}</span><div class="striptrack">${dots}${mark}</div></div>`;
  };
  return `<div class="strip">${rowFor("Home", 0)}${rowFor("Draw", 1)}${rowFor("Away", 2)}
    <div class="legend">
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.M1}"></span>M1 blind</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.M2}"></span>M2 search</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.M3}"></span>M3 engine</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.ENS}"></span>ENS</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.B1}"></span>B1/B2</span>
      <span><span class="dot mktdot"></span>MKT</span>
    </div></div>`;
}

function groupsGrid() {
  const groups = groupMembers();
  if (!Object.keys(groups).length) return "";
  const { rows } = latestForecast();
  const reach = consensusReach(rows);
  const stats = {};
  for (const fx of DB.fixtures) {
    if (fx.stage !== "group" || !outcomeVec(fx)) continue;
    const r = fx.result;
    for (const [t, gf, ga] of [[fx.home, r.home_goals, r.away_goals], [fx.away, r.away_goals, r.home_goals]]) {
      const s = (stats[t] ||= { p: 0, w: 0, d: 0, l: 0, gd: 0 });
      s.gd += gf - ga;
      if (gf > ga) { s.p += 3; s.w++; } else if (gf === ga) { s.p += 1; s.d++; } else s.l++;
    }
  }
  const anyPlayed = Object.keys(stats).length > 0;
  const cards = Object.keys(groups).sort().map(letter => {
    const teams = groups[letter].slice().sort((a, b) => {
      const sa = stats[a] || { p: 0, gd: 0 }, sb = stats[b] || { p: 0, gd: 0 };
      return (sb.p - sa.p) || (sb.gd - sa.gd) || (((reach[b] || {}).reach_r32 || 0) - ((reach[a] || {}).reach_r32 || 0));
    });
    const rows = teams.map(t => {
      const s = stats[t], adv = (reach[t] || {}).reach_r32;
      return `<div class="grow">
        <span class="gname">${team(t)}</span>
        <span class="gpts" title="W-D-L">${s ? `${s.w}-${s.d}-${s.l}` : "—"}</span>
        <span class="gpts" title="points">${s ? s.p : "·"}</span>
        <span class="gbar" title="consensus P(reach R32): ${pct1(adv)}"><span style="width:${(adv || 0) * 100}%"></span></span>
      </div>`;
    }).join("");
    return `<div class="group-card"><h3>Group ${letter}</h3>${rows}</div>`;
  }).join("");
  return `<h2>Groups — ${anyPlayed ? "standings + consensus advance odds" : "consensus advance odds (no matches played yet)"}</h2>
    <div class="groups">${cards}</div>`;
}

// --- ticker + nav ---
function fillTicker() {
  const t = document.getElementById("ticker");
  if (!t) return;
  const captured = new Set(DB.predictions.filter(p => p.as_of === "T-3h").map(p => p.match_id)).size;
  const next = DB.fixtures.filter(fx => fx.stage === "group" && !outcomeVec(fx))
    .sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""))[0];
  const played = playedFixtures().length;
  const parts = [
    `<b>RECORD</b> ${esc(DB.generated_at)}`,
    `<b>T−3h LOCKS</b> ${captured}/72`,
    played ? `<b>PLAYED</b> ${played}` : null,
    next ? `<b>NEXT</b> ${flag(next.home)}${esc(next.home)} v ${esc(next.away)}${flag(next.away)} · ${esc(shortDate(next.kickoff_utc))}` : null,
    `<b>10 MODELS</b> 5 labs · M1 blind / M2 search / M3 engine`,
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
  const { rows } = latestForecast();
  const reach = consensusReach(rows);
  const fav = Object.entries(reach).sort((a, b) => (b[1].champion || 0) - (a[1].champion || 0))[0];
  const { rows: lb } = leaderboard();
  const leaderCard = lb.length
    ? (() => { const top = lb.find(r => r.key !== "MKT") || lb[0]; return `
      <div class="hero-card">
        <div class="hero-kicker">Leading the market race</div>
        <div class="hero-big">${esc(top.label)}</div>
        <div class="hero-sub">RPS <span class="mono">${f3(top.rps)}</span> over ${top.n} matches ·
          skill vs MKT <span class="${top.skill >= 0 ? "good" : "bad"} mono">${top.skill >= 0 ? "+" : ""}${f3(top.skill)}</span></div>
      </div>`; })()
    : (fav ? `
      <div class="hero-card">
        <div class="hero-kicker">Consensus title favorite</div>
        <div class="hero-big">${team(fav[0])}</div>
        <div class="hero-sub">P(champion) <span class="mono">${pct1(fav[1].champion)}</span> · mean of 10 models, 50,000-run brackets</div>
      </div>` : "");
  const locked = next && (DB._predsByMatch[next.match_id] || []).some(p => p.as_of === "T-3h");
  const nextCard = next ? `
    <div class="hero-card alt">
      <div class="hero-kicker">${locked ? "Forecasts locked ✓ · kickoff in" : "Next forecasts lock in"}</div>
      <div class="countdown" id="countdown" data-kickoff="${esc(next.kickoff_utc)}" data-locked="${locked ? 1 : 0}">—</div>
      <div class="hero-sub">${flag(next.home)}${esc(next.home)} v ${esc(next.away)}${flag(next.away)} · ${esc(shortDate(next.kickoff_utc))}${next.ground ? " · " + esc(city(next.ground)) : ""}</div>
    </div>` : "";
  return (leaderCard || nextCard) ? `<div class="hero">${leaderCard}${nextCard}</div>` : "";
}

function startCountdown() {
  const node = document.getElementById("countdown");
  if (!node) return;
  const kick = Date.parse(node.dataset.kickoff);
  if (!isFinite(kick)) { node.textContent = "—"; return; }
  const locked = node.dataset.locked === "1";
  const target = locked ? kick : kick - 3 * 3600 * 1000;
  const tick = () => {
    const ms = target - Date.now();
    if (ms <= 0) { node.textContent = locked ? "KICKOFF" : "LOCKING…"; return; }
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24,
      m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    node.textContent = `${d ? d + "d " : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  tick();
  TICK = setInterval(tick, 1000);
}

function viewLeaderboard() {
  const { rows, mktMean } = leaderboard();
  const lede = `<p class="lede">Ten frontier models forecast every match three ways, against an ensemble, two baselines, and the de-vigged market. Ranked Probability Score — lower is better; skill is improvement over the market. The market is the benchmark, not a competitor.</p>`;
  if (!rows.length) {
    const node = el(`<section>
      <h1>Leaderboard</h1>${lede}${heroStrip()}
      <div class="note">No completed matches yet — the board fills in after the first final whistle. The models' pre-committed views are on <a href="#/bracket">Bracket</a>, <a href="#/forecast">Forecast</a>, and <a href="#/matches">Matches</a>.</div>
      ${groupsGrid()}
    </section>`);
    node._after = startCountdown;
    return node;
  }
  const trendable = playedFixtures().map(fx => fx.match_id);
  const body = rows.map((r, i) => {
    const skill = r.skill == null ? `<span class="muted">benchmark</span>`
      : `<span class="${r.skill >= 0 ? "good" : "bad"}">${r.skill >= 0 ? "+" : ""}${f3(r.skill)}</span>`;
    const seq = trendable.map(mid => r.byMid[mid]).filter(v => v != null).slice(-14);
    return `<tr${i === 0 ? ` class="lead"` : ""}>
      <td class="num muted">${r.key === "MKT" ? "—" : i + 1}</td>
      <td><span class="pill ${pillClass(r.kind)}">${esc(r.label)}</span></td>
      <td class="num">${r.n}</td>
      <td class="num">${f3(r.rps)}</td>
      <td class="num">${skill}</td>
      <td>${sparkline(seq)}</td>
    </tr>`;
  }).join("");

  const h1 = SCORES && SCORES.h1;
  const h1Panel = h1 ? `
    <h2>H1 — does web search change forecast skill?</h2>
    <div class="note">Paired RPS(M2) − RPS(M1) for <strong>${esc(shortModel(h1.model))}</strong> over ${h1.n} matches
      (negative = search <em>helps</em>): <strong class="${h1.mean < 0 ? "good" : "bad"}">${h1.mean >= 0 ? "+" : ""}${f4(h1.mean)}</strong>,
      95% CI [${f4(h1.ci_low)}, ${f4(h1.ci_high)}], two-sided p = ${h1.p_two_sided.toFixed(4)}
      <span class="muted">(clustered bootstrap, n_boot=${h1.n_boot}, frozen pre-kickoff)</span>.</div>` : "";

  const node = el(`<section>
    <h1>Leaderboard</h1>${lede}${heroStrip()}
    ${tableWrap(`<table><thead><tr><th class="num">#</th><th>Series</th><th class="num">n</th><th class="num">RPS</th><th class="num">vs MKT</th><th>trend</th></tr></thead><tbody>${body}</tbody></table>`)}
    <p class="muted" style="margin-top:10px">M1 blind · M2 web search · M3 ratings→engine · ENS ensemble · B1 Elo · B2 squad value · MKT de-vigged market${mktMean != null ? ` (mean RPS ${f3(mktMean)})` : ""}.</p>
    ${h1Panel}
    <h2>The race</h2>
    ${chartBox("rps-over-time", 340)}
    ${SCORES && SCORES.leaderboard && SCORES.leaderboard.length ? `<h2>Skill vs market — official scorer, 95% CI</h2>${chartBox("skill-bars", 430)}` : ""}
    ${groupsGrid()}
  </section>`);

  node._after = () => {
    startCountdown();
    const series = rpsSeriesOverTime();
    const box = node.querySelector("#rps-over-time");
    if (series && box) WCViz.rpsOverTime(box, series);
    else if (box) box.closest(".chartbox").outerHTML = `<div class="note">The cumulative-RPS race appears once at least two matches are scored.</div>`;
    const sb = node.querySelector("#skill-bars");
    if (sb) WCViz.skillBars(sb, SCORES.leaderboard.map(r => ({
      ...r, label: r.model ? `${r.method} · ${shortModel(r.model)}` : r.method,
    })));
  };
  return node;
}

function viewBracket() {
  const b = buildBracket();
  if (!b) {
    return el(`<section><h1>Bracket</h1><div class="note">No knockout fixtures in this export yet.</div></section>`);
  }
  const cols = b.rounds.map(rd => `
    <div class="round">
      <div class="round-title">${esc(rd.title)}</div>
      ${rd.ties.map(t => tieCard(t, { final: rd.title === "Final" })).join("")}
    </div>`).join("");
  const node = el(`<section>
    <h1>Bracket</h1>
    <p class="lede">${b.projected
      ? "Slots resolve as the group stage completes — until then this is the <strong>consensus projection</strong>: ten models' most likely qualifier per slot, advancing whoever carries the higher mean reach probability. Percentages are head-to-head consensus within each tie."
      : "The knockout bracket, with the models' consensus advancement odds per tie."}</p>
    <div class="bracket-scroll"><div class="bracket">${cols}</div></div>
    ${b.thirdPlace ? `<h2>Third-place match</h2><div style="max-width:280px">${tieCard(b.thirdPlace)}</div>` : ""}
    ${groupsGrid()}
  </section>`);
  return node;
}

function viewMatches() {
  const groupCards = (list) => list.map(fx => {
    const ens = (DB._predsByMatch[fx.match_id] || []).find(p => p.method === "ENS" && p.p_home != null);
    const bar = ens ? hdaBar(ens.p_home, ens.p_draw, ens.p_away) : "";
    const res = fx.result && fx.result.home_goals != null ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span>` : `<span class="muted">scheduled</span>`;
    return `<a class="card" href="#/match/${encodeURIComponent(fx.match_id)}">
      <div class="teams">${team(fx.home)} <span class="dim">v</span> ${team(fx.away)}</div>
      <div class="meta">${esc(fx.group || fx.stage)} · ${esc(shortDate(fx.kickoff_utc))} · ${res}</div>
      ${bar}
    </a>`;
  }).join("");
  const grp = DB.fixtures.filter(fx => fx.stage === "group");
  const ko = DB.fixtures.filter(fx => fx.stage === "knockout");
  return el(`<section><h1>Matches</h1>
    <p class="lede">Pre-committed probability vectors per fixture, locked at T−3h. Bar shows the ensemble (blue home / grey draw / red away).</p>
    <div class="cards">${groupCards(grp)}</div>
    ${ko.length ? `<h2>Knockout — slots resolve after the group stage · see the <a href="#/bracket">Bracket</a></h2><div class="cards">${groupCards(ko)}</div>` : ""}
  </section>`);
}

function viewMatch(id) {
  const fx = DB._fixById[id];
  if (!fx) return el(`<section><a class="back" href="#/matches">← Matches</a><p>Unknown match.</p></section>`);
  const preds = (DB._predsByMatch[id] || []).filter(p => p.p_home != null);
  const o = outcomeVec(fx);
  const rowFor = (label, kind, p, hash) => {
    const r = o ? rps([p.p_home, p.p_draw, p.p_away], o) : null;
    return `<tr><td><span class="pill ${pillClass(kind)}">${esc(label)}</span></td>
      <td class="num">${pct(p.p_home)}</td><td class="num">${pct(p.p_draw)}</td><td class="num">${pct(p.p_away)}</td>
      <td class="shapecol">${hdaBar(p.p_home, p.p_draw, p.p_away)}</td>
      <td class="num">${f3(r)}</td>
      <td class="mono muted hashcol">${hash ? esc(hash.slice(0, 10)) : ""}</td></tr>`;
  };
  const predRows = preds.map(p => {
    const m = seriesMeta(p);
    return rowFor(m.label, m.kind, p, p.input_hash);
  }).join("");
  const m = mktVector(id);
  const mktRow = m ? rowFor(`MKT · ${m.source}`, "mkt", { p_home: m.p[0], p_draw: m.p[1], p_away: m.p[2] }, null) : "";
  const oddsRows = (DB._oddsByMatch[id] || []).map(r => `<tr><td>${esc(r.source)}</td><td class="muted">${esc(r.snapshot)}</td><td class="num">${r.o_home}</td><td class="num">${r.o_draw}</td><td class="num">${r.o_away}</td></tr>`).join("");
  const resultLine = o
    ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span> · <span class="win">${["home win", "draw", "away win"][o[0] ? 0 : o[1] ? 1 : 2]}</span>`
    : `<span class="muted">not yet played</span>`;
  return el(`<section>
    <a class="back" href="#/matches">← Matches</a>
    <h1>${team(fx.home)} <span class="dim">v</span> ${team(fx.away)}</h1>
    <p class="lede">${esc(fx.group || fx.stage)} · ${esc(kickoffDate(fx.kickoff_utc))}${fx.ground ? " · " + esc(fx.ground) : ""} · Result: ${resultLine}</p>
    ${preds.length ? `<h2>Where every series stands</h2>${probStrip(preds, m)}` : ""}
    <h2>Pre-committed forecasts</h2>
    ${tableWrap(`<table><thead><tr><th>Series</th><th class="num">Home</th><th class="num">Draw</th><th class="num">Away</th><th>shape</th><th class="num">RPS</th><th class="hashcol">hash</th></tr></thead>
      <tbody>${predRows || `<tr><td colspan="7" class="muted">Forecasts lock at T−3h before kickoff.</td></tr>`}${mktRow}</tbody></table>`)}
    <h2>Raw market odds</h2>
    ${tableWrap(`<table><thead><tr><th>Book</th><th>snapshot</th><th class="num">Home</th><th class="num">Draw</th><th class="num">Away</th></tr></thead><tbody>${oddsRows || `<tr><td colspan="5" class="muted">none captured yet — captured at T−3h before kickoff</td></tr>`}</tbody></table>`)}
  </section>`);
}

function viewForecast() {
  const { rows: fc, cps, latest, all: fcAll } = latestForecast();
  if (!fc.length) {
    return el(`<section><h1>Forecast</h1>
      <div class="note">No tournament forecast in this export yet.</div></section>`);
  }
  const models = [...new Set(fc.map(f => f.model))];
  const champ = fc.some(f => f.reach.champion != null);
  const key = champ ? "champion" : "reach_r32";

  const consensus = {};
  for (const f of fc) (consensus[f.team] ||= []).push(f.reach[key] || 0);
  const teamsByConsensus = Object.entries(consensus).map(([t, v]) => ({ t, m: mean(v) })).sort((a, b) => b.m - a.m);
  const topTeam = teamsByConsensus[0] && teamsByConsensus[0].t;

  const rows = fc.slice().sort((a, b) => b.reach[key] - a.reach[key]).map((f, i) => {
    const r = f.reach;
    const tail = champ
      ? `<td class="num">${pct(r.reach_sf)}</td><td class="num">${pct(r.reach_final)}</td>
         <td class="num">${pct(r.champion)}</td>
         <td class="shapecol"><div class="bar brand"><span class="h" style="width:${r.champion * 100}%"></span></div></td>`
      : `<td class="shapecol"><div class="bar brand"><span class="h" style="width:${r.reach_r32 * 100}%"></span></div></td>`;
    return `<tr>
      <td class="num muted">${i + 1}</td>
      <td>${team(f.team)}${models.length > 1 ? ` <span class="dim mono">${esc(shortModel(f.model))}</span>` : ""}</td>
      <td class="num">${pct(r.win_group)}</td>
      <td class="num">${pct(r.reach_r32)}</td>
      ${tail}
    </tr>`;
  }).join("");
  const head = champ
    ? `<th class="num">#</th><th>Team</th><th class="num">Win group</th><th class="num">R32</th><th class="num">Semi</th><th class="num">Final</th><th class="num">Champion</th><th>title odds</th>`
    : `<th class="num">#</th><th>Team</th><th class="num">Win group</th><th class="num">Reach R32</th><th>shape</th>`;

  const teamOptions = teamsByConsensus.map(({ t }) => `<option value="${esc(t)}"${t === topTeam ? " selected" : ""}>${esc(t)}</option>`).join("");

  const node = el(`<section>
    <h1>Forecast</h1>
    <p class="lede">What ten models believe: a 50,000-run Monte Carlo over each model's M3 ratings — group round-robins (FIFA tiebreakers + 8 best thirds) into the bracket. Checkpoint <code>${esc(latest)}</code>.</p>
    ${champ ? `<h2>The title race — bars = consensus, dots = each model</h2>${chartBox("title-race", 430)}` : ""}
    <h2>Road to the final · <select id="team-pick" class="picker">${teamOptions}</select></h2>
    ${chartBox("reach-curves", 300)}
    ${cps.length > 1 ? `<h2>Champion-odds trajectory by checkpoint</h2>${chartBox("trajectory", 300)}` : ""}
    ${ratingsHeatmap()}
    <h2>Full table</h2>
    <div class="note">Champion probability is n=1 and unfalsifiable — tracked as a trajectory vs. the market's futures, never scored. Third-place R32 slotting uses a valid assignment respecting FIFA's constraints (the exact combination table is approximated).</div>
    ${tableWrap(`<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`)}
  </section>`);

  node._after = () => {
    const tr = node.querySelector("#title-race");
    if (tr && champ) WCViz.titleRace(tr, fc.map(f => ({ team: f.team, model: f.model, p_champion: f.reach.champion || 0 })), shortModel);
    const rc = node.querySelector("#reach-curves");
    const drawReach = (t) => rc && WCViz.reachCurves(rc, fc.filter(f => f.team === t), shortModel);
    drawReach(topTeam);
    const pick = node.querySelector("#team-pick");
    if (pick) pick.addEventListener("change", () => drawReach(pick.value));
    const tj = node.querySelector("#trajectory");
    if (tj) {
      const byCp = {};
      for (const f of fcAll) (byCp[f.as_of] ||= []).push({ model: f.model, team: f.team, p_champion: f.reach.champion });
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
    `<div class="hm-cell hm-team">${team(x.t)}</div>` +
    models.map(mo => {
      const v = x.m[mo];
      return v == null
        ? `<div class="hm-cell hm-miss">·</div>`
        : `<div class="hm-cell" style="background:${shade(v)}" title="${esc(shortModel(mo))} · ${esc(x.t)}: ${v.toFixed(1)}">${Math.round(v)}</div>`;
    }).join("")
  ).join("");
  return `<h2>Model ratings — where the ten models disagree</h2>
    <p class="muted">M3 mean ratings (0–100), checkpoint <code>${esc(latest)}</code>, sorted by consensus. Brighter = stronger.</p>
    <div class="hm-scroll"><div class="hm" style="grid-template-columns: minmax(130px, 180px) repeat(${models.length}, minmax(46px, 1fr))">${head}${body}</div></div>`;
}

function viewVerify() {
  const rows = DB.predictions.filter(p => p.input_hash).slice(0, 200).map(p =>
    `<tr><td class="mono">${esc(p.match_id)}</td><td><span class="pill ${pillClass(p.model ? "m" : "base")}">${esc(p.method)}${p.model ? " · " + esc(shortModel(p.model)) : ""}</span></td><td class="mono muted hashfull">${esc(p.input_hash)}</td></tr>`).join("");
  return el(`<section>
    <h1>Verify</h1>
    <p class="lede">Every forecast is committed before kickoff and carries a SHA-256 of its inputs. Each T−3h batch is one append-only git commit on the public record, so the history proves a prediction existed before the match.</p>
    <div class="note">How to check: <code>git log</code> the capture commit for a matchday, recompute the SHA-256 of a prediction's canonical inputs, and confirm it matches the manifest in the commit message — dated before the match. GitHub's push receive-time is an external timestamp the committer cannot back-date.</div>
    ${tableWrap(`<table><thead><tr><th>match_id</th><th>series</th><th>input_hash (SHA-256)</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="muted">Per-match predictions arrive with the first T−3h capture batch.</td></tr>`}</tbody></table>`)}
  </section>`);
}

function viewAbout() {
  return el(`<section>
    <h1>About</h1>
    <p class="lede">The real question isn't who wins the World Cup — it's <strong>when an LLM's probability estimates can be trusted</strong>. This is a preregistered, leakage-proof experiment that scores frontier-model forecasts against a near-efficient betting market.</p>
    <h2>How it works</h2>
    <div class="kv">
      <div>Spine</div><div>RPS on the 90-minute 1X2 result; Brier &amp; log-loss as companions.</div>
      <div>Primary question</div><div>M2−M1: does web search change forecast skill? (paired, within-model, group stage)</div>
      <div>Roster</div><div>10 pinned models, 5 labs: Fable 5 · Opus 4.8 · Haiku 4.5 · GPT-5.5 · GPT-5.4 mini · Gemini 3.1 Pro · Gemini 3.5 Flash · Grok 4.3 · DeepSeek v4 Pro · v4 Flash.</div>
      <div>Methods</div><div>M1 blind · M2 web search · M3 ratings→Dixon-Coles · ENS · B1 Elo · B2 squad value · MKT market.</div>
      <div>Pre-commitment</div><div>Locked at T−3h, SHA-256 hashed, append-only public git history.</div>
      <div>Honesty</div><div>Losses to the market are featured, not hidden — the honesty is the product.</div>
    </div>
    <div class="note" style="margin-top:18px">Forecasts and odds lock at T−3h before each kickoff; results and scores fill in as matches finish. This site reads only the committed JSON record — no backend.</div>
  </section>`);
}

// --- router ---
function render() {
  if (TICK) { clearInterval(TICK); TICK = null; }
  const h = location.hash || "#/";
  const m = h.match(/^#\/match\/(.+)$/);
  let node;
  if (m) node = viewMatch(decodeURIComponent(m[1]));
  else if (h.startsWith("#/bracket")) node = viewBracket();
  else if (h.startsWith("#/matches")) node = viewMatches();
  else if (h.startsWith("#/forecast")) node = viewForecast();
  else if (h.startsWith("#/verify")) node = viewVerify();
  else if (h.startsWith("#/about")) node = viewAbout();
  else node = viewLeaderboard();
  app().replaceChildren(node);
  if (node._after) node._after();
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
  document.getElementById("genmeta").textContent = `export ${DB.schema_version} · ${DB.generated_at}`;
  fillTicker();
  window.addEventListener("hashchange", render);
  render();
}
main();
