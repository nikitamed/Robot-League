"use strict";
// Zero-build site. Reads ONLY ./data/export.json (the versioned site contract)
// plus the optional ./data/scores.json written by the frozen scorer. Scores on
// the page are computed in the browser from predictions+results so the site
// stays a pure reader — no compute leaks into presentation (spec §4).

let DB = null;     // export.json
let SCORES = null; // scores.json (optional; null until the scorer has run)
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
const pct = (x) => (x == null ? "—" : (100 * x).toFixed(0) + "%");
const pct1 = (x) => (x == null ? "—" : (100 * x).toFixed(1) + "%");
const f3 = (x) => (x == null ? "—" : x.toFixed(3));
const f4 = (x) => (x == null ? "—" : x.toFixed(4));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Checkpoint (as_of) ordering: known protocol labels first, then unknowns.
const CHECKPOINT_ORDER = ["pre-tournament", "md1", "md2", "md3", "group-end", "r32", "r16", "qf", "sf", "final"];
function orderCheckpoints(values) {
  const known = CHECKPOINT_ORDER.filter(c => values.includes(c));
  const extra = values.filter(v => !CHECKPOINT_ORDER.includes(v)).sort();
  return [...known, ...extra];
}

// --- scoring ---
function devig(o) { const inv = [1 / o.o_home, 1 / o.o_draw, 1 / o.o_away]; const s = inv[0] + inv[1] + inv[2]; return inv.map(x => x / s); }
function mktVector(mid) {
  // Scored MKT is the T-3h snapshot (prereg §3); diagnostic snapshots (T-1h,
  // closing) must never leak into the displayed benchmark once they coexist.
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

function leaderboard() {
  const series = {};
  const add = (key, label, kind, mid, pvec) => {
    const fx = DB._fixById[mid]; const o = outcomeVec(fx); if (!o) return;
    (series[key] ||= { label, kind, rpss: [] }).rpss.push(rps(pvec, o));
  };
  for (const p of DB.predictions) {
    if (p.p_home == null) continue; // group-stage 1X2 only
    const m = seriesMeta(p);
    add(m.key, m.label, m.kind, p.match_id, [p.p_home, p.p_draw, p.p_away]);
  }
  for (const fx of DB.fixtures) { const m = mktVector(fx.match_id); if (m) add("MKT", `MKT · ${m.source}`, "mkt", fx.match_id, m.p); }
  const mktMean = mean(series.MKT ? series.MKT.rpss : []);
  const rows = Object.entries(series).map(([k, v]) => ({ key: k, label: v.label, kind: v.kind, rps: mean(v.rpss), n: v.rpss.length }));
  rows.forEach(r => r.skill = (mktMean != null && r.key !== "MKT") ? (mktMean - r.rps) : null);
  rows.sort((a, b) => a.rps - b.rps);
  return { rows, mktMean };
}

// Cumulative mean RPS per series over played matches (kickoff order).
function rpsSeriesOverTime() {
  const played = DB.fixtures.filter(fx => outcomeVec(fx)).sort((a, b) => (a.kickoff_utc || "").localeCompare(b.kickoff_utc || ""));
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

// --- components ---
function hdaBar(ph, pd, pa) {
  return `<div class="bar"><span class="h" style="width:${ph * 100}%"></span><span class="d" style="width:${pd * 100}%"></span><span class="a" style="width:${pa * 100}%"></span></div>`;
}
function pillClass(kind) { return kind === "base" ? "base" : kind === "mkt" ? "mkt" : "m"; }
function tableWrap(html) { return `<div class="tablewrap">${html}</div>`; }
function chartBox(id, h = 320) { return `<div class="chartbox" style="height:${h}px"><canvas id="${id}"></canvas></div>`; }

// Per-match probability strip: every series' probability per outcome, MKT as marker.
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
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.M1}"></span>M1</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.M2}"></span>M2</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.M3}"></span>M3</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.ENS}"></span>ENS</span>
      <span><span class="dot" style="background:${WCViz.SERIES_COLORS.B1}"></span>B1/B2</span>
      <span><span class="dot mktdot"></span>MKT</span>
    </div></div>`;
}

// Ratings heatmap (CSS grid): teams × models, latest checkpoint.
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
    .map(([team, m]) => ({ team, mean: mean(Object.values(m)), m }))
    .sort((a, b) => b.mean - a.mean);
  const lo = Math.min(...rows.map(r => r.rating)), hi = Math.max(...rows.map(r => r.rating));
  const shade = (v) => {
    const t = (v - lo) / Math.max(1e-9, hi - lo);
    return `rgba(91,140,255,${(0.06 + 0.72 * t).toFixed(3)})`;
  };
  const head = `<div class="hm-cell hm-head hm-team">Team</div>` +
    models.map(m => `<div class="hm-cell hm-head" title="${esc(m)}">${esc(shortModel(m))}</div>`).join("");
  const body = teams.map(t =>
    `<div class="hm-cell hm-team">${esc(t.team)}</div>` +
    models.map(mo => {
      const v = t.m[mo];
      return v == null
        ? `<div class="hm-cell hm-miss">·</div>`
        : `<div class="hm-cell" style="background:${shade(v)}" title="${esc(shortModel(mo))} · ${esc(t.team)}: ${v.toFixed(1)}">${Math.round(v)}</div>`;
    }).join("")
  ).join("");
  return `<h2>Model ratings — where the ten models disagree</h2>
    <p class="muted">M3 mean ratings (0–100), checkpoint <code>${esc(latest)}</code>, sorted by consensus. Darker = stronger.</p>
    <div class="hm-scroll"><div class="hm" style="grid-template-columns: minmax(110px, 160px) repeat(${models.length}, minmax(44px, 1fr))">${head}${body}</div></div>`;
}

// --- views ---
function viewLeaderboard() {
  const { rows, mktMean } = leaderboard();
  const lede = `<p class="lede">Every method, baseline, and the market on one board, ranked by Ranked Probability Score (lower is better). Skill is RPS improvement over the de-vigged market (positive = beats the market). The market is the benchmark, not a competitor.</p>`;
  if (!rows.length) {
    const node = el(`<section>
      <h1>Leaderboard</h1>${lede}
      <div class="note">No completed matches yet — the leaderboard fills in after the first final whistle (June 11). Pre-committed forecasts are already on the <a href="#/matches">Matches</a> page, and the models' tournament views are on <a href="#/forecast">Forecast</a>.</div>
    </section>`);
    return node;
  }
  const body = rows.map((r, i) => {
    const skill = r.skill == null ? `<span class="muted">benchmark</span>`
      : `<span class="${r.skill >= 0 ? "good" : "bad"}">${r.skill >= 0 ? "+" : ""}${f3(r.skill)}</span>`;
    return `<tr>
      <td class="num muted">${r.key === "MKT" ? "—" : i + 1}</td>
      <td><span class="pill ${pillClass(r.kind)}">${esc(r.label)}</span></td>
      <td class="num">${r.n}</td>
      <td class="num">${f3(r.rps)}</td>
      <td class="num">${skill}</td>
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
    <h1>Leaderboard</h1>${lede}
    ${tableWrap(`<table><thead><tr><th class="num">#</th><th>Series</th><th class="num">n</th><th class="num">RPS</th><th class="num">skill vs MKT</th></tr></thead><tbody>${body}</tbody></table>`)}
    <p class="muted" style="margin-top:10px">M1 blind · M2 web search · M3 ratings→engine · ENS ensemble · B1 Elo · B2 squad value · MKT de-vigged market${mktMean != null ? ` (mean RPS ${f3(mktMean)})` : ""}.</p>
    ${h1Panel}
    <h2>The race so far</h2>
    ${chartBox("rps-over-time", 340)}
    ${SCORES && SCORES.leaderboard && SCORES.leaderboard.length ? `<h2>Skill vs market (official scorer, 95% CI)</h2>${chartBox("skill-bars", 420)}` : ""}
  </section>`);

  node._after = () => {
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

function viewMatches() {
  const cards = DB.fixtures.map(fx => {
    const ens = (DB._predsByMatch[fx.match_id] || []).find(p => p.method === "ENS" && p.p_home != null);
    const bar = ens ? hdaBar(ens.p_home, ens.p_draw, ens.p_away) : "";
    const res = fx.result && fx.result.home_goals != null ? `<span class="result">${fx.result.home_goals}–${fx.result.away_goals}</span>` : `<span class="muted">scheduled</span>`;
    return `<a class="card" href="#/match/${encodeURIComponent(fx.match_id)}">
      <div class="teams">${esc(fx.home)} <span class="muted">v</span> ${esc(fx.away)}</div>
      <div class="meta">${esc(fx.group || fx.stage)} · ${esc((fx.kickoff_utc || "").replace("T", " "))} · ${res}</div>
      ${bar}
    </a>`;
  }).join("");
  return el(`<section><h1>Matches</h1><p class="lede">Pre-committed probability vectors per fixture. Bar shows the ensemble (blue home / grey draw / red away).</p><div class="cards">${cards}</div></section>`);
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
    <h1>${esc(fx.home)} <span class="muted">v</span> ${esc(fx.away)}</h1>
    <p class="lede">${esc(fx.group || fx.stage)} · ${esc((fx.kickoff_utc || "").replace("T", " "))} · Result: ${resultLine}</p>
    ${preds.length ? `<h2>Where every series stands</h2>${probStrip(preds, m)}` : ""}
    <h2>Pre-committed forecasts</h2>
    ${tableWrap(`<table><thead><tr><th>Series</th><th class="num">Home</th><th class="num">Draw</th><th class="num">Away</th><th>shape</th><th class="num">RPS</th><th class="hashcol">hash</th></tr></thead>
      <tbody>${predRows}${mktRow}</tbody></table>`)}
    <h2>Raw market odds</h2>
    ${tableWrap(`<table><thead><tr><th>Book</th><th>snapshot</th><th class="num">Home</th><th class="num">Draw</th><th class="num">Away</th></tr></thead><tbody>${oddsRows || `<tr><td colspan="5" class="muted">none captured yet — captured at T−3h before kickoff</td></tr>`}</tbody></table>`)}
  </section>`);
}

function viewForecast() {
  const fcAll = (DB.tournament_forecast || []).filter(f => f.reach);
  if (!fcAll.length) {
    return el(`<section><h1>Forecast</h1>
      <p class="lede">Tournament forecast from the M3 ratings, via Monte Carlo over all 12 groups + the knockout bracket.</p>
      <div class="note">No tournament forecast in this export yet.</div></section>`);
  }
  const cps = orderCheckpoints([...new Set(fcAll.map(f => f.as_of))]);
  const latest = cps[cps.length - 1];
  const fc = fcAll.filter(f => f.as_of === latest);
  const models = [...new Set(fc.map(f => f.model))];
  const champ = fc.some(f => f.reach.champion != null);
  const key = champ ? "champion" : "reach_r32";

  const consensus = {};
  for (const f of fc) (consensus[f.team] ||= []).push(f.reach[key] || 0);
  const teamsByConsensus = Object.entries(consensus).map(([t, v]) => ({ t, m: mean(v) })).sort((a, b) => b.m - a.m);
  const topTeam = teamsByConsensus[0]?.t;

  const rows = fc.slice().sort((a, b) => b.reach[key] - a.reach[key]).map((f, i) => {
    const r = f.reach;
    const tail = champ
      ? `<td class="num">${pct(r.reach_sf)}</td><td class="num">${pct(r.reach_final)}</td>
         <td class="num">${pct(r.champion)}</td>
         <td class="shapecol"><div class="bar"><span class="h" style="width:${r.champion * 100}%"></span></div></td>`
      : `<td class="shapecol"><div class="bar"><span class="h" style="width:${r.reach_r32 * 100}%"></span></div></td>`;
    return `<tr>
      <td class="num muted">${i + 1}</td>
      <td>${esc(f.team)}${models.length > 1 ? ` <span class="muted mono">${esc(shortModel(f.model))}</span>` : ""}</td>
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
    <h1>Forecast — what ten models believe</h1>
    <p class="lede">A 50,000-run Monte Carlo over each model's M3 ratings: group round-robins (FIFA tiebreakers + 8 best thirds) into the single-elimination bracket. Checkpoint: <code>${esc(latest)}</code>.</p>
    ${champ ? `<h2>The title race</h2>
    <p class="muted">Bars = consensus across models; dots = each model's own P(champion).</p>
    ${chartBox("title-race", 420)}` : ""}
    <h2>Road to the final <span class="muted">·</span> <select id="team-pick" class="picker">${teamOptions}</select></h2>
    ${chartBox("reach-curves", 300)}
    ${cps.length > 1 ? `<h2>Champion-odds trajectory <span class="muted">(checkpoints)</span></h2>${chartBox("trajectory", 300)}` : ""}
    ${ratingsHeatmap()}
    <h2>Full table</h2>
    <div class="note">Champion probability is n=1 and unfalsifiable — a trajectory vs. the market's futures, never scored. Third-placed teams are slotted into the R32 by a valid assignment respecting FIFA's group constraints (the exact combination table is approximated).</div>
    ${tableWrap(`<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`)}
  </section>`);

  node._after = () => {
    const tr = node.querySelector("#title-race");
    if (tr && champ) WCViz.titleRace(tr, fc.map(f => ({ team: f.team, model: f.model, p_champion: f.reach.champion || 0 })), shortModel);
    const rc = node.querySelector("#reach-curves");
    const drawReach = (team) => rc && WCViz.reachCurves(rc, fc.filter(f => f.team === team), shortModel);
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

function viewVerify() {
  const rows = DB.predictions.filter(p => p.input_hash).slice(0, 200).map(p =>
    `<tr><td class="mono">${esc(p.match_id)}</td><td><span class="pill ${pillClass(p.model ? "m" : "base")}">${esc(p.method)}${p.model ? " · " + esc(shortModel(p.model)) : ""}</span></td><td class="mono muted hashfull">${esc(p.input_hash)}</td></tr>`).join("");
  return el(`<section>
    <h1>Verify</h1>
    <p class="lede">Every forecast is committed before kickoff and carries a SHA-256 of its inputs. In the live pipeline each T−3h batch is one append-only git commit, so the public history proves a prediction existed before the match.</p>
    <div class="note">How to check (live repo): <code>git log</code> the capture commit for a matchday, recompute the SHA-256 of a prediction's canonical inputs, and confirm it matches the manifest in the commit message — dated before the match. This page lists the per-prediction hashes from the current export.</div>
    ${tableWrap(`<table><thead><tr><th>match_id</th><th>series</th><th>input_hash (SHA-256)</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="muted">Per-match predictions arrive with the first T−3h capture batch (June 11).</td></tr>`}</tbody></table>`)}
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
      <div>Pre-commitment</div><div>Locked at T−3h, SHA-256 hashed, append-only git history.</div>
      <div>Honesty</div><div>Losses to the market are featured, not hidden — the honesty is the product.</div>
    </div>
    <div class="note" style="margin-top:18px">Forecasts and odds are locked and committed at T−3h before each kickoff; results and scores fill in as matches finish. The site reads only the committed JSON export — no backend.</div>
  </section>`);
}

// --- router ---
function render() {
  const h = location.hash || "#/";
  const m = h.match(/^#\/match\/(.+)$/);
  let node;
  if (m) node = viewMatch(decodeURIComponent(m[1]));
  else if (h.startsWith("#/matches")) node = viewMatches();
  else if (h.startsWith("#/forecast")) node = viewForecast();
  else if (h.startsWith("#/verify")) node = viewVerify();
  else if (h.startsWith("#/about")) node = viewAbout();
  else node = viewLeaderboard();
  app().replaceChildren(node);
  if (node._after) node._after();
  window.scrollTo(0, 0);
}

async function main() {
  try {
    const res = await fetch("./data/export.json");
    if (!res.ok) throw new Error(res.status);
    DB = await res.json();
  } catch (e) {
    app().innerHTML = `<div class="note warn">Could not load <code>./data/export.json</code> (${esc(e.message)}). Serve this folder over HTTP: <code>python -m http.server</code> from <code>site/</code>, then open the printed URL.</div>`;
    return;
  }
  try {
    const res = await fetch("./data/scores.json");
    if (res.ok) SCORES = await res.json();
  } catch { /* optional until the scorer has run */ }
  // Once a (match, method, model) series has T-3h rows (the locked batch, prereg §5),
  // they supersede earlier batches (e.g. pre-tournament) in every view.
  const skey = (p) => `${p.match_id}|${p.method}|${p.model || ""}`;
  const locked = new Set(DB.predictions.filter(p => p.as_of === "T-3h").map(skey));
  DB.predictions = DB.predictions.filter(p => p.as_of === "T-3h" || !locked.has(skey(p)));
  DB._fixById = Object.fromEntries(DB.fixtures.map(f => [f.match_id, f]));
  DB._oddsByMatch = {}; for (const o of DB.market_odds) (DB._oddsByMatch[o.match_id] ||= []).push(o);
  DB._predsByMatch = {}; for (const p of DB.predictions) (DB._predsByMatch[p.match_id] ||= []).push(p);
  document.getElementById("genmeta").textContent = `export ${DB.schema_version} · generated ${DB.generated_at}`;
  window.addEventListener("hashchange", render);
  render();
}
main();
