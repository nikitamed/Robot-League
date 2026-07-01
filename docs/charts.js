"use strict";
// Chart helpers for the zero-build site. Chart.js is vendored (site/vendor/,
// pinned v4.5.1) so the public record stays self-contained — no CDN at runtime.
// Everything renders from whatever the committed export contains and degrades
// to honest empty states; app.js decides what data exists.

(() => {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Stable per-model palette (lab-family hues, distinct on the dark theme).
  const MODEL_COLORS = {
    "claude-fable-5": "#7aa2ff",
    "claude-opus-4-8": "#4d7dde",
    "claude-haiku-4-5": "#31539b",
    "gpt-5.5-2026-04-23": "#36c98b",
    "gpt-5.4-mini-2026-03-17": "#1f8f64",
    "gemini-3.1-pro-preview": "#f2b134",
    "gemini-3.5-flash": "#c98e1f",
    "grok-4.3": "#e36464",
    "deepseek-v4-pro": "#b07ce8",
    "deepseek-v4-flash": "#7e57b5",
    "B1": "#c79a3a",   // Elo baseline (pseudo-model key)
    "B2": "#8f7427",   // squad-value baseline
  };
  const FALLBACKS = ["#5b8cff", "#36c98b", "#f2b134", "#e36464", "#b07ce8", "#8b94a7"];
  let fallbackIdx = 0;
  const modelColor = (m) => MODEL_COLORS[m] || (MODEL_COLORS[m] = FALLBACKS[fallbackIdx++ % FALLBACKS.length]);

  // Method-class colors (per-match strip, RPS lines for non-model series).
  const SERIES_COLORS = { M1: "#5b8cff", M2: "#36c98b", M3: "#b07ce8", ENS: "#e7ebf3", B1: "#c79a3a", B2: "#9a7b2e", MKT: "#ffffff" };

  function baseDefaults() {
    if (!window.Chart) return false;
    Chart.defaults.color = css("--muted") || "#8b94a7";
    Chart.defaults.borderColor = css("--line") || "#2a3040";
    Chart.defaults.font.family = "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    return true;
  }

  const charts = new Map(); // canvas -> Chart, so re-renders don't leak
  function mount(canvas, config) {
    if (!baseDefaults()) return null;
    if (charts.has(canvas)) charts.get(canvas).destroy();
    const c = new Chart(canvas, config);
    charts.set(canvas, c);
    return c;
  }

  const pctTick = (v) => (100 * v).toFixed(0) + "%";
  const pct1 = (v) => (100 * v).toFixed(1) + "%";

  // --- Title race: consensus P(champion) bars + per-model dots --------------
  // rows: [{team, model, p_champion}] for ONE checkpoint; labels: model->label.
  function titleRace(canvas, rows, labels, topN = 12) {
    const byTeam = {};
    for (const r of rows) (byTeam[r.team] ||= []).push(r);
    const teams = Object.entries(byTeam)
      .map(([team, rs]) => ({ team, mean: rs.reduce((s, r) => s + (r.p_champion || 0), 0) / rs.length, rs }))
      .sort((a, b) => b.mean - a.mean)
      .slice(0, topN);
    const models = [...new Set(rows.map(r => r.model))];
    const datasets = [{
      type: "bar", label: "consensus (mean of models)",
      data: teams.map(t => t.mean), backgroundColor: "rgba(91,140,255,.25)",
      borderColor: "#5b8cff", borderWidth: 1, order: 2,
    }];
    for (const m of models) {
      datasets.push({
        type: "scatter", label: labels(m),
        data: teams.map((t, i) => {
          const r = t.rs.find(x => x.model === m);
          return r ? { x: r.p_champion, y: i } : null;
        }).filter(Boolean),
        backgroundColor: modelColor(m), pointRadius: 3.5, pointHoverRadius: 5, order: 1,
      });
    }
    return mount(canvas, {
      data: { labels: teams.map(t => t.team), datasets },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { callback: pctTick }, beginAtZero: true },
          y: { ticks: { autoSkip: false } },
        },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct1(c.parsed.x)}` } },
          legend: { position: "bottom" },
        },
      },
    });
  }

  // --- Road to the final: per-model reach curves for one team ---------------
  const STAGES = [
    ["reach_r32", "R32"], ["reach_r16", "R16"], ["reach_qf", "QF"],
    ["reach_sf", "SF"], ["reach_final", "Final"], ["champion", "Champion"],
  ];
  function reachCurves(canvas, rowsForTeam, labels) {
    const present = STAGES.filter(([k]) => rowsForTeam.some(r => r.reach && r.reach[k] != null));
    const datasets = rowsForTeam.map(r => ({
      label: labels(r.model),
      data: present.map(([k]) => r.reach[k]),
      borderColor: modelColor(r.model), backgroundColor: modelColor(r.model),
      tension: 0.25, pointRadius: 3, borderWidth: 2, fill: false,
    }));
    return mount(canvas, {
      type: "line",
      data: { labels: present.map(([, l]) => l), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { ticks: { callback: pctTick }, beginAtZero: true } },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct1(c.parsed.y)}` } },
          legend: { position: "bottom" },
        },
      },
    });
  }

  // --- Champion-odds trajectory across checkpoints for one team -------------
  function trajectory(canvas, checkpoints, rowsByCheckpoint, team, labels) {
    const models = [...new Set(Object.values(rowsByCheckpoint).flat().map(r => r.model))];
    const datasets = models.map(m => ({
      label: labels(m),
      data: checkpoints.map(cp => {
        const r = (rowsByCheckpoint[cp] || []).find(x => x.model === m && x.team === team);
        return r ? r.p_champion : null;
      }),
      borderColor: modelColor(m), backgroundColor: modelColor(m),
      tension: 0.2, pointRadius: 3.5, borderWidth: 2, spanGaps: true,
    }));
    return mount(canvas, {
      type: "line",
      data: { labels: checkpoints, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { ticks: { callback: pctTick }, beginAtZero: true } },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct1(c.parsed.y)}` } },
          legend: { position: "bottom" },
        },
      },
    });
  }

  // --- Cumulative mean RPS over matches (lower = better) --------------------
  // series: [{key, color, points: [{x: matchNo, y: cumMeanRps}]}]
  function rpsOverTime(canvas, series, opts = {}) {
    const xLabel = opts.xLabel || "matches played";
    const yLabel = opts.yLabel || "average forecast error — lower is better";
    return mount(canvas, {
      type: "line",
      data: {
        datasets: series.map(s => ({
          label: s.key, data: s.points,
          borderColor: s.color, backgroundColor: s.color,
          borderWidth: s.width != null ? s.width : (s.key === "MKT" ? 2.5 : 1.8),
          borderDash: s.dash != null ? s.dash : (s.key === "MKT" ? [6, 4] : []),
          pointRadius: 0, tension: 0.15,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, parsing: false,
        scales: {
          x: { type: "linear", title: { display: true, text: xLabel }, ticks: { precision: 0 } },
          y: { title: { display: true, text: yLabel } },
        },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(4)}` } },
          legend: { position: "bottom" },
        },
      },
    });
  }

  // --- Skill vs market: bars + CI whiskers (floating bars) ------------------
  // rows: scores.json leaderboard entries (skill_vs_mkt + skill_ci), labels resolved.
  function skillBars(canvas, rows) {
    // Rows arrive pre-filtered and already ordered by the caller to mirror the
    // leaderboard table's visible rows; render them as given (no re-sort).
    const named = rows.filter(r => r.skill_vs_mkt != null);
    return mount(canvas, {
      data: {
        labels: named.map(r => r.label),
        datasets: [
          {
            type: "bar", label: "RPS skill vs MKT (+ = beats market)",
            data: named.map(r => r.skill_vs_mkt),
            backgroundColor: named.map(r => r.skill_vs_mkt >= 0 ? "rgba(54,201,139,.45)" : "rgba(240,103,107,.45)"),
            borderColor: named.map(r => r.skill_vs_mkt >= 0 ? "#36c98b" : "#f0676b"),
            borderWidth: 1, order: 2,
          },
          {
            type: "bar", label: "95% CI",
            data: named.map(r => r.skill_ci ? [r.skill_ci[0], r.skill_ci[1]] : null),
            backgroundColor: "rgba(231,235,243,.55)", barPercentage: 0.12, order: 1,
          },
        ],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { color: css("--line") } },
          y: { ticks: { autoSkip: false } },  // height is sized per-bar; show every label
        },
        plugins: {
          tooltip: { callbacks: { label: (c) => Array.isArray(c.raw)
            ? `CI [${c.raw[0].toFixed(4)}, ${c.raw[1].toFixed(4)}]`
            : `skill ${c.parsed.x >= 0 ? "+" : ""}${c.parsed.x.toFixed(4)}` } },
          legend: { position: "bottom" },
        },
      },
    });
  }

  // --- per-team ratings by model (team page) ---------------------------------
  // entries: [{model, label, rating}]
  function ratingBars(canvas, entries) {
    const rows = entries.slice().sort((a, b) => b.rating - a.rating);
    return mount(canvas, {
      type: "bar",
      data: {
        labels: rows.map(r => r.label),
        datasets: [{
          data: rows.map(r => r.rating),
          backgroundColor: rows.map(r => modelColor(r.model) + "55"),
          borderColor: rows.map(r => modelColor(r.model)),
          borderWidth: 1.5,
        }],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        scales: { x: { min: 0, max: 100, title: { display: true, text: "strength rating (0–100)" } } },
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.parsed.x.toFixed(1)} / 100` } } },
      },
    });
  }

  // --- Betting returns over time (illustrative) -----------------------------
  // series: [{ key, color, points:[{x,y}] }]; baseline = 0 (flat P/L) or 100 (Kelly).
  function returnsChart(canvas, series, yLabel, baseline) {
    return mount(canvas, {
      type: "line",
      data: {
        datasets: series.map(s => ({
          label: s.key, data: s.points, borderColor: s.color, backgroundColor: s.color,
          borderWidth: s.key === "Betting market" ? 2.5 : 1.8,
          borderDash: s.key === "Betting market" ? [6, 4] : [],
          pointRadius: 0, tension: 0.1,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, parsing: false,
        scales: {
          x: { type: "linear", title: { display: true, text: "matches played" }, ticks: { precision: 0 } },
          y: { title: { display: true, text: yLabel }, grid: { color: (c) => c.tick.value === baseline ? css("--muted") : css("--line") } },
        },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y >= 0 ? "+" : ""}${c.parsed.y.toFixed(2)}` } },
          legend: { position: "bottom" },
        },
      },
    });
  }

  window.WCViz = { modelColor, SERIES_COLORS, titleRace, reachCurves, trajectory, rpsOverTime, skillBars, ratingBars, returnsChart };
})();
