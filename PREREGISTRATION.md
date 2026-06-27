# WC2026 LLM Forecasting League — Pre-Registration (v1.0, LOCKED 2026-06-10)

> **Status: LOCKED.** This document is an irreversible gate item (§7.6): it is
> finalized, committed, and SHA-256-anchored on the public repo (annotated tag
> `prereg-v1`) **before the first kickoff (2026-06-11)**. Every former [LOCK]
> decision below is resolved and marked. This protocol is fixed; any later
> analysis not specified here is explicitly exploratory. The scoring code
> (`src/wc2026/score/`) implementing §3/§9 is frozen in the same commit, so no
> analysis decision post-dates the data.

## 1. Purpose & hypotheses

This experiment measures whether frontier LLMs produce trustworthy probabilistic
forecasts, scored against a near-efficient betting market, using the 2026 FIFA
World Cup. Predictions are pre-committed at T−3h, SHA-256 hashed with git
provenance, so leakage cannot be claimed retroactively.

**Primary confirmatory hypothesis (H1) — the M2−M1 contrast.**
Within-model, web search (M2) changes group-stage forecast skill relative to the
blind prior (M1).
- **Unit:** the 72 group-stage matches.
- **Metric:** Ranked Probability Score (RPS) on the 90-minute 1X2 result.
- **Design:** paired, within-model (each model is its own control); the paired
  difference is RPS(M2) − RPS(M1) per match.
- **Inference:** clustered bootstrap resampling **on matches** (not on
  model×match cells), two-sided, α = 0.05.
- **Direction:** non-directional. We report the signed effect and CI; "search
  doesn't help" (or hurts) is a publishable result, not a failure.

**Lead secondary hypothesis (H2) — update quality.**
After each round, do M3 re-ratings over/under-react relative to a Bayesian
benchmark? Read out from the rating `delta` distribution vs. the benchmark's
implied update. Reported with bootstrap CIs; **not** part of the confirmatory
family.

**Capability-ladder sub-study (H3) — separate pre-registered paired family.**
Flagship vs. cheaper within-lab sibling (see roster.yaml `tier`). Paired by
lab: Anthropic (`claude-fable-5` ↔ `claude-haiku-4-5`), OpenAI, Google,
DeepSeek — four pairs. `claude-opus-4-8` is an additional Anthropic mid rung,
fully scored everywhere but outside the H3 pair family. RPS skill and the
cost-vs-skill frontier. **Multiplicity correction applied within this family**
(Holm–Bonferroni across the lab pairs).

All other comparisons (per-method leaderboard, ENS, baselines, per-stage
breakdowns) are **descriptive with bootstrap CIs clustered on matches** — not
confirmatory. ~104 matches is a real power constraint, which is *why* the
confirmatory surface is a single question (H1).

## 2. Pooling vs. a single named primary model — LOCKED: (b)

H1 could be tested either:
- **(a) Pooled** across all roster models with native search (random-effect on
  model), reporting the pooled M2−M1 effect; **or**
- **(b) One named primary model** (pre-specified here), with the rest as
  pre-registered secondary replications.

**LOCKED: (b), primary model = `claude-fable-5`** (Anthropic's newest flagship,
released days before the tournament — the most informative single test of a
current frontier model). One named primary gives the cleanest confirmatory
claim and sidesteps the model-as-random-effect power cost at n≈72. The other
seven search-capable roster entries are pre-registered secondary replications
of the same paired contrast; DeepSeek entries run M1/M3 only (no native search)
and cannot enter H1. All ten roster strings are pinned in `roster.yaml`
(verified against each provider's live model-list endpoint, 2026-06-09;
`claude-haiku-4-5` reinstated 2026-06-10 as the Anthropic H3 sibling, before
any public anchor existed).

## 3. Scoring spine

- **Primary metric:** RPS on the 90-minute 1X2 result across all 104 matches —
  regulation only, so extra time and penalties never touch the scored outcome
  (a knockout drawn in 90' is scored as a draw on the 1X2 spine).
- **Conventions (pinned, implemented verbatim in `src/wc2026/score/rps.py`):**
  outcome order (home, draw, away); RPS = ½·Σᵢ₌₁²(cumPᵢ − cumOᵢ)²; Brier =
  multiclass Σₖ(pₖ − oₖ)²; log-loss = −ln(p_outcome), natural log, p clipped at
  1e-15. The 90-minute score is read from the result feed's regulation (`ft`)
  field only.
- **Companion metrics:** Brier and log-loss (reported, not confirmatory).
- **Knockout 1X2 elicitation (decision deadline 2026-06-24, before the R32):**
  whether M1/M2 knockout prompts emit the 90-minute {H/D/A} vector alongside
  advancement, or knockouts are scored on Brier(advancement) only. The decision
  is logged as a dated amendment before any knockout fixture is captured; it
  cannot affect the group-stage record, which is complete by then.
- **Knockout advancement:** Brier on advancement for the 32 knockout matches, a
  companion to the 1X2 spine.
- **Skill:** RPS relative to the de-vigged market (MKT) per match. MKT is the
  benchmark, not a competitor to beat for the result to be interesting.
- **MKT definition (LOCKED).** Odds come from a single feed (TheStatsAPI). Each
  book is captured raw at T−3h under its own `source` and de-vigged later. The
  **scored** MKT benchmark is **de-vigged Pinnacle 1X2 from the T−3h capture** (the
  sharpest book, the standard efficient-market benchmark), with the **Betfair
  Exchange** no-vig line as a reported cross-check. Bet365 and Kambi are also
  captured (reported, not scored). *Verified live (2026-06): for 2026 fixtures
  TheStatsAPI returns Bet365, Betfair Exchange, Kambi, and Pinnacle on the current
  key; the per-book raw price stored is the feed's `last_seen` at the capture
  instant.* "Closing" here means the scored **T−3h** capture (§5); the true-closing
  snapshot remains diagnostic-only. If Pinnacle is ever absent for a given fixture,
  that match's MKT falls back to Betfair Exchange and the substitution is logged.
- **Champion probability:** n=1, unfalsifiable — tracked as a trajectory vs.
  market futures, **never scored** for calibration.
- **M2 and market content (ruling).** At T−3h, web search can surface bookmaker
  prices. That is a **feature of the M2 arm, not leakage**: H1 asks what search
  does to forecast skill, and the information environment search exposes —
  including market prices — is part of the treatment. No filtering or exclusion
  is applied on this basis; M2 rationales are stored, so market-parroting is
  analyzable descriptively.

## 4. Methods, baselines, market

Per spec §2 / roster.yaml: M1 (blind), M2 (search), M3 (ratings→engine), ENS,
baselines B1 (Elo) and B2 (squad value), and MKT (de-vigged closing odds).
**ENS definition (pinned, as implemented):** the equal-weight mean of the
scored M1/M2 vectors across roster models for that fixture (M3/baselines are
not ensemble members). **Baseline inputs (frozen pre-tournament):**
`data/elo_snapshot.yaml` (eloratings.net, retrieved 2026-06-09) and
`data/values_snapshot.yaml` (Transfermarkt squad totals, retrieved 2026-06-09).
M1c/M2c (state-aware) are built during the tournament and are a **separate**
pre-registered question, not part of H1. M4 (player bottom-up) is deferred to v2.

**Provider-withdrawal rule.** Pinned strings include preview-channel models
(e.g. `gemini-3.1-pro-preview`). If a provider withdraws or breaks a pinned
model mid-tournament, its remaining fixtures are recorded as
missing-by-provider, the model is reported on its covered matches only, and it
is excluded from any full-coverage comparison. The pinned string is never
silently substituted.

## 5. Capture & pre-commitment protocol

- Predictions for every fixture locked at **T−3h**; raw market odds captured at
  the same instant (de-vig computed later from the raw capture).
- Each T−3h batch = **one git commit** embedding the SHA-256 of the payload, with
  a manifest mapping match → hash. Tagged per matchday (`md1`, `r16`, …).
- The pre-commitment branch is **append-only** — never rebased, amended, or
  force-pushed. Public repo from the start.
- Exploratory snapshots at T−1h and true closing are diagnostic only.

## 6. Sampling & exclusions (locked, spec §6)

- **M3 ratings:** 5 samples; scored rating = per-team mean **over the valid
  samples** (an invalid sample drops per the rule below and is counted in the
  §7.4 drop rate; the model drops entirely only if all samples fail). The
  elicitation prompt
  **injects the exact canonical qualified-team roster** (the model cannot otherwise
  know the 2026 set, which excludes e.g. Italy). A sample is validated against that
  roster: returned names are **canonicalized** (so an alias like "USA" matches
  "United States") and any team **outside the qualified set is ignored** (models
  reliably over-include from prior knowledge); the sample is valid iff every
  qualified team is present. *Observed (2026-06): `claude-opus-4-8` produces
  complete ratings; `claude-haiku-4-5` intermittently omits a team and drops — its
  M3 drop rate is reported per §7.4.*
- **M1/M2 per match:** 1 scored low-temperature draw (sample_idx 0) + 2 diagnostic
  samples (stored, unscored). Where a model rejects `temperature`, the scored
  sample is sample_idx 0 at the provider default (documented per model). A model
  may emit the vector under a one-level wrapper key (e.g. Haiku's `{"group": …}`);
  parsing tolerates this, the locked prompt is unchanged.
- **Invalid or incomplete output:** unparseable JSON *or* output that fails
  validation (missing probability keys, a missing qualified team) is retried to
  budget, then the (match, model, sample) is dropped and logged.
- **Drop-rate threshold (§7.4) — LOCKED at 5%:** a per-model scored-sample drop
  rate above **5%** is flagged in the results and the model's affected matches
  are reported separately.

## 7. Two constants (§7.4) — LOCKED

- **Elo K = 20** for the H2 update benchmark (the standard base K for senior
  international friendlies on the eloratings.net scale; chosen a priori, not
  fit to any tournament data).
- **Retry budget = 2** before dropping a sample (config.yaml), i.e. one attempt
  plus two retries.

## 8. Engine & β (§7.2)

Form locked (Dixon-Coles; constants in config.yaml: base 1.35, ρ −0.08, scale 100,
β 1.41). β gets one final market sanity-check against the **captured T−3h** market
on a handful of marquee fixtures once real M3 ratings land; if the live rating
spread differs materially from the elite≈90/weak≈40 assumption, β is re-fit
**before** M3 predictions are committed. This re-fit, if it happens, is logged
with its justification — it is not a free parameter to tune against outcomes.

## 9. Analysis plan summary

| Family | Hypothesis | Metric | Inference | Multiplicity |
|---|---|---|---|---|
| Confirmatory | H1: M2−M1 | RPS (group, paired) | clustered bootstrap on matches, α=0.05, two-sided | single test |
| Secondary | H2: update quality | rating delta vs Bayesian | bootstrap CIs | reported, not confirmatory |
| Sub-study | H3: capability ladder | RPS skill, cost-vs-skill | paired bootstrap | Holm–Bonferroni within family |
| Descriptive | leaderboard, ENS, baselines, per-stage | RPS/Brier/log-loss vs MKT | bootstrap CIs clustered on matches | — |

## Amendments (dated; the locked text above is never rewritten)

- **2026-06-27. Knockout scoring & M3 re-rating cadence (§3, §6) — logged before any knockout fixture is captured.**
  - **§3 knockout-1X2 decision (deadline 2026-06-24):** knockouts are scored on
    **Brier(advancement) only**. The M1/M2 knockout prompts emit advancement
    {`p_advance_home`, `p_advance_away`} only — no 90′ {H/D/A} vector — matching the
    locked knockout prompt; M3/baselines convert ratings to advancement via the
    engine. Advancement Brier is reported as a **companion** to the group-stage 1X2
    RPS spine, never blended into it. **No advancement market** is captured: knockout
    advancement is scored as raw Brier, with no MKT skill companion (the §3 MKT line
    is 1X2-only and stays group-stage).
  - **§6 M3 re-rating cadence:** M3 ratings are re-elicited at round checkpoints —
    **`group-end`** (after MD3), then **`r16` / `qf` / `sf`** — using the locked
    re-rating prompt (results-since context) and the §7.4 drop-and-flag rules,
    stored at those `as_of` labels. The post-MD1/MD2 re-ratings were **not** captured
    in real time and are **not** reconstructed, so the H2 `delta` readout begins at
    `group-end` (flagged; the early group rounds are not covered). At each checkpoint
    the forecast Monte Carlo is re-run **conditioned on actual results** (eliminated
    teams → 0; played knockout winners fixed); champion/reach remain an **unscored
    trajectory** per §3.

- **2026-06-27. Primary model withdrawn by the provider — §4 rule invoked.**
  Anthropic withdrew `claude-fable-5` mid-tournament (live calls return
  `404: "Claude Fable 5 is not available. Please use Opus 4.8."`; first observed
  to fail ~2026-06-13, after the model had captured **4** group matches). Per the
  §4 **provider-withdrawal rule**, the pinned string is **not substituted**:
  - `claude-fable-5` **remains the named §2 H1 primary**. H1 is therefore reported
    on its **covered matches only (n=4 paired M1/M2)** — underpowered and flagged
    as such; it cannot carry the confirmatory claim. The **pre-registered secondary
    replications (§2)** — the other seven search-capable models, each at full
    coverage (n≈66) — carry the M2−M1 contrast; this is the substantive H1 result,
    reported per §9 at harvest.
  - **H3 capability ladder:** the Anthropic pair (Fable 5 ↔ Haiku 4.5) is broken on
    the Fable side (M1/M2 n=4 vs n=66); it is reported on covered matches only and
    excluded from the full-coverage frontier. The OpenAI, Google, and DeepSeek pairs
    are unaffected.
  - **M3 for Fable 5 is unaffected** (70 matches): it runs from the frozen
    pre-tournament ratings (`--m3-from-stored`, no live call), so it carries the
    pre-withdrawal ratings forward legitimately; no re-ratings are possible.
  - Captured M1/M2 (4 matches) and all other models are untouched. ENS self-adjusts
    to whichever models are present per match.
  - **Operational, no protocol effect:** `roster.yaml` sets Fable 5 to **M3-only**
    to stop the doomed M1/M2 calls each lock; a **per-model coverage alarm** was
    added to the scheduler so a future silent withdrawal/outage surfaces in real
    time (it went unnoticed for ~2 weeks because per-model drops did not reach the
    monitor). The site hides Fable 5 from per-model displays; this record retains it.

- **2026-06-18.** §3 MKT odds-source redundancy. TheStatsAPI (the locked odds
  feed) abruptly dropped sharp-book coverage for 2026 fixtures on **2026-06-17**:
  from that matchday it served only Bet365 — or nothing — for new fixtures, where
  June 11–16 had carried Pinnacle/Betfair/Bet365/Kambi in full. Pinnacle is the
  *scored* benchmark, so this erodes the entire model-vs-market comparison going
  forward. Amendment: when TheStatsAPI yields no sharp book (Pinnacle / Betfair
  Exchange) for a fixture, the **Pinnacle** 1X2 line is sourced from
  **API-Football** (`/odds`, "Match Winner" market) at the same T−3h capture
  instant, joined to fixtures by canonical team pair. The benchmark is unchanged —
  de-vigged **Pinnacle**, the same book; only the aggregator reporting the price
  differs, and only when the primary feed lacks it. June 11–16 fixtures keep their
  TheStatsAPI Pinnacle capture untouched. Code: `feeds/odds.py`
  (`af_fixture_index` / `fetch_af_odds` / `parse_af_odds`), wired into
  `capture_odds`.
  - **Three already-locked fixtures** (GK-portugal-dr_congo, GL-england-croatia,
    GL-ghana-panama; all kicked off 2026-06-17) had their T−3h odds window lost to
    the outage — no sharp line was captured at their T−3h instant and that moment
    cannot be recreated. Their MKT is backfilled from the **API-Football Pinnacle
    line available post-outage** (a near-closing line, not a true T−3h capture),
    flagged here so the substitution is on record. Predictions for these fixtures
    locked normally and their model scores are unaffected; only the market
    comparison for these three uses a later-than-T−3h Pinnacle price.

- **2026-06-13.** §3 MKT fallback extended. The locked chain is Pinnacle →
  Betfair Exchange → (a fixture with neither sharp book is excluded). Observed on
  matchday 2: TheStatsAPI carried only Bet365 and Kambi for Canada–Bosnia &
  Herzegovina (`GB-canada-bosnia_&_herzegovina`), with no Pinnacle or Betfair
  line at any snapshot, which would drop that fixture from the model-vs-market
  comparison. Amendment: when neither sharp book is present, MKT for that fixture
  is the **de-vigged consensus** — the per-leg mean of the individually de-vigged
  1X2 vectors of the remaining captured books — and the substitution is logged
  (`consensus_matches`). Only a fixture with no usable book at all is excluded.
  This is strictly a fallback: Pinnacle and Betfair Exchange keep their existing
  precedence and are unaffected wherever present. Rationale: a soft-book consensus
  is a weaker efficient-market proxy than a sharp book, but a materially better
  benchmark than discarding the fixture; the substitution is per-match auditable.
  Absolute model scores (RPS/Brier/log-loss) never depended on MKT and are
  unchanged. Scoring code: `src/wc2026/score/mkt.py`.

- **2026-06-11 (evening).** Results sourcing redundancy: when the openfootball
  feed lags a finished match (observed: opener score absent ~2.5h after full
  time), the same regulation 90-minute score may be ingested from API-Football
  (`score.fulltime`, statuses FT/AET/PEN), joined to fixtures by canonical team
  pair. Identical ground truth, identical spine — no scoring rule changes.

- **2026-06-11, before the first T−3h capture.** §6 M1/M2 sampling: the two
  **diagnostic** samples (sample_idx 1–2, stored-but-unscored) are dropped for
  cost; each (model, method, match) captures the scored sample only
  (sample_idx 0, unchanged settings). Diagnostics were exploratory material
  outside every registered analysis — the scored record, H1, and all §9
  analyses are unaffected. config.yaml `n_diagnostic` 2 → 0. The 2,232-forecast
  pre-tournament batch (captured 2026-06-10 with diagnostics) is unaffected.

## 10. Lock checklist — ALL RESOLVED (2026-06-10)

- [x] Pooling vs. named primary model (§2) — **(b)**, primary `claude-fable-5`;
      six search-capable secondaries; DeepSeek M1/M3-only.
- [x] MKT source (§3) — Pinnacle confirmed available on TheStatsAPI for 2026; scored
      book locked to de-vigged Pinnacle (T−3h), Betfair Exchange cross-check.
- [x] M3 elicitation/validation (§6) — roster injected; validation canonicalizes
      names and ignores non-qualifiers, requiring all qualified present.
- [x] Drop-rate threshold (§6) confirmed at 5%.
- [x] Elo K = 20 and retry budget = 2 (§7).
- [x] roster.yaml: every `PIN-EXACT` replaced with a pinned version string —
      10 entries across 5 labs, each verified against the provider's live
      model-list endpoint on 2026-06-09 (latest-model audit repeated
      2026-06-10) and smoke-tested end-to-end (M1/M2/M3, dry run) before this
      anchor. `claude-haiku-4-5` reinstated 2026-06-10 pre-anchor; its known
      M3 omission behavior is governed by the §6/§7.4 drop-and-flag rules.
- [x] data/venues.yaml: `fifa_name`s confirmed against the official fixture feed —
      all 16 grounds in the live openfootball feed resolve via fifa_name/city/
      aliases (compound "City (Borough)" labels added as aliases, 2026-06-09).
- [x] Baseline inputs frozen (§4): elo_snapshot + values_snapshot rebuilt from
      live sources 2026-06-09 (48/48 teams each).
- [x] Scoring code frozen pre-kickoff: `src/wc2026/score/` (RPS/Brier/log-loss,
      MKT construction with logged Pinnacle→Betfair fallback, H1 clustered
      bootstrap n_boot=10000 seed=20260611) + synthetic-data tests.
- [x] T−3h capture automation: `src/wc2026/capture/scheduler.py` (idempotent
      from the DB state, late-capture/missed-window logging, in-window odds
      retry until kickoff−30min, per-batch commit+push).
- [x] This document committed and SHA-256-anchored (tag `prereg-v1`) before
      2026-06-11 kickoff.
