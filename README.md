# Robot League — WC2026 LLM Forecasting (Public Record)

This repository is the **tamper-evident public record** of a preregistered
experiment measuring whether frontier LLMs produce trustworthy probabilistic
forecasts, scored against the de-vigged betting market, using the 2026 FIFA
World Cup (June 11 – July 19, 2026).

It contains **only the protocol, the data, and a static dashboard** — no
experiment code. The capture/scoring pipeline is maintained privately; it is
not needed to verify the claims here (see *Verify* below). The private
pipeline state at the anchor is bound by the commit hash recorded in the
`prereg-v1` tag message.

**Live dashboard:** https://nikitamed.github.io/Robot-League/ (served from
[`docs/`](docs/), auto-updates with every data push).

## The contest

Ten pinned models from five labs — Claude Fable 5, Claude Opus 4.8, Claude
Haiku 4.5, GPT‑5.5, GPT‑5.4 mini, Gemini 3.1 Pro, Gemini 3.5 Flash, Grok 4.3,
DeepSeek v4 Pro, DeepSeek v4 Flash — each forecast every match three ways
(M1 blind · M2 with web search · M3 ratings→Dixon-Coles engine), against an
ensemble (ENS), an Elo baseline (B1), a squad-value baseline (B2), and the
de-vigged Pinnacle market (MKT). The single confirmatory question (H1): does
web search change forecast skill, paired within model, RPS on the 90-minute
1X2 result over the 72 group matches.

## What's in here

| Path | Contents |
|---|---|
| [`PREREGISTRATION.md`](PREREGISTRATION.md) | The locked protocol — hypotheses, scoring rule, market benchmark, sampling, exclusions. Committed and tagged **before** the first kickoff. |
| [`predictions.json`](predictions.json) | The cumulative export: fixtures, every scored prediction (with SHA-256 `input_hash`), raw captured odds, tournament forecasts, model ratings. **One commit per T−3h capture batch** — the git history is the per-batch record, and each batch commit message embeds the batch `payload_sha256` plus a per-match manifest. |
| [`scores.json`](scores.json) | Official frozen-scorer output (leaderboard, H1 with bootstrap CI), refreshed as results are ingested. |
| [`schema/export.schema.json`](schema/export.schema.json) | JSON Schema for the export format. |
| [`docs/`](docs/) | The static dashboard (viewer only; reads `docs/data/`). |

## The claim, and how to verify it

**Claim:** every prediction was committed before the match it forecasts, and
the analysis plan was fixed before any match was played — so results cannot
have leaked into the predictions or the methodology.

**Verify:**
1. Clone this repo and read the git history: `git log --format='%H %cI %s'`.
2. Each batch commit predates the kickoff of the matches it covers (compare
   the commit timestamp to `kickoff_utc` in the fixtures).
3. Recompute a prediction's `input_hash` from its canonical fields and confirm
   it matches the export and the commit-message manifest.
4. Confirm `PREREGISTRATION.md` was committed (tag `prereg-v1`, whose message
   embeds the document's SHA-256) before the first kickoff, 2026-06-11 19:00 UTC.

Because GitHub records the server-side receive time of each push, the public
push history is an external timestamp that the committer cannot back-date.
Predictions for each fixture are locked at **T−3h before its kickoff**;
matches with a missed or late capture window are logged as such, never
backfilled.
