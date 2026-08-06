# Monitoring-tax-appeals workflow

Subagent prompt templates and call governance. Unlike a research skill, most of this pipeline is deterministic scripts — subagents exist only where judgment is required. **The sweep itself is never fanned out**: ASI is a public state service and gets one sequential client.

## Contents
- [Sweep](#sweep) — main agent, sequential, not fanned out
- [Hydration](#hydration) — per-docket detail, capped, sequential
- [Analysis](#analysis) — assessment gap, comps, precedent (fan-out allowed)
- [Routing](#routing) — BOR vs PTAB recommendation (fan-out allowed)
- [Governance](#governance) — caps, pacing, error handling

---

## Sweep

**Not a subagent task.** The main agent runs it directly, sequentially, from `queries.jsonl`.

Rules that do not bend:

- One request at a time. No `parallel_tasks`, no concurrent `agent_spawn`, no browser fan-out against `ptab.illinois.gov`.
- ~2–3 seconds between requests. A sweep is a weekly job; there is no reason to hurry it.
- A plain fetch, not a browser session — ASI is server-rendered HTML.
- Write raw HTML to `snapshots/{date}/raw/{watch_id}_p{N}.html` **before** parsing. The fetch is the expensive, unrepeatable part.
- Stop the sweep on the first 5xx or interstitial. Report a partial sweep with the watches that completed; do not retry into a struggling service.
- Read `Results | 1 to 50 of N Records` before paginating. `N` over `max_pages × 50` means the watch is too broad — record the overflow in the digest rather than silently truncating.

## Hydration

**HARD CAP: 2 fetches per docket** — `property.asp`, then `PropertyDetails.asp` per PIN. Plus at most one decision PDF, once ever.

Hydrate only dockets whose list row changed since the last snapshot, plus every docket with an open deadline. A full re-hydration of a 400-matter book is a thousand requests against a public service to learn nothing.

Sequential, same pacing as the sweep. If the book is large enough that hydration is slow, that is the correct speed.

**Subagent prompt** — used only when parsing volume justifies it; the fetching stays with the main agent:

```
You are a hydration parser for the monitoring-tax-appeals skill. Parse cached PTAB HTML into
canonical matter records. You do NOT fetch anything — every file you need is already on disk.

INPUT FILES (already fetched, one docket per pair):
{FILE_LIST}

OUTPUT: one JSON file per docket at {WORKSPACE}/matters/{docket}.json, written in a SINGLE Bash
call using chained heredocs. Schema in references/example-matter.md — follow it exactly.

RULES:
1. Bash only. No fetching tools of any kind. If a file is missing, record it and move on.
2. Parse the result table BY HEADER, not by column position — the third column is "First Name"
   or "Firm Name" depending on the query that produced it.
3. Store case-history transaction descriptions VERBATIM. Do not paraphrase, normalize casing,
   or summarize. The phrasing is the evidence, and the type mapping happens downstream.
4. Strip thousands separators from values before storing (35,640 → 35640). An unstripped value
   makes every future sweep report a spurious valuation_change.
5. Empty fields (&nbsp;) become null, NEVER 0. A zero assessment and an unreported assessment
   are different facts and the digest treats them differently.
6. Never invent a field. If the page does not show it, the value is null and that is correct.
7. Never construct a decision PDF URL as evidence a decision exists. Only record decision_pdf
   when the file is on disk with a byte count.

Report back ONLY: "Parsed {n}/{total} dockets, {k} missing files ({dockets})".
```

## Analysis

Fan-out is fine here — it touches no external service, only stored values.

**HARD CAP: 0 external fetches.** Analysis reads `matters/`, `decisions/`, and the watchlist. If a number is not derivable from stored data, it is `Unknown` with the missing input named.

```
You are an analysis subagent for the monitoring-tax-appeals skill. For each matter in your batch,
compute the assessment figures and assemble supporting evidence from STORED DATA ONLY.

MATTERS: {MATTER_LIST}
County factors (equalization factor, composite rate): {COUNTY_FACTORS}
Workspace: {WORKSPACE}

COMPUTE per matter:
1. assessment_gap = bor_total − appellant_total; also as a % of bor_total.
2. estimated_tax_exposure = gap × equalization_factor × composite_rate.
   Label it an ESTIMATE and record both factors and their source year in the output.
   If either factor is missing for the county, output null and name what is missing. Do NOT
   substitute a factor from another county or another year.
3. comparable_support: comps supplied in the watchlist, or matters in {WORKSPACE}/matters/ with
   the same township + class + tax year. Cite docket numbers. NEVER invent a comparable sale.
4. prior_precedent: decisions already in {WORKSPACE}/decisions/ for the same township + class.
   Cite docket numbers only. Do NOT characterize a holding from a decision you have not read —
   "3 prior decisions in this township/class" is a fact; "PTAB favors appellants here" is not.

RULES:
- Shell only. Everything this step needs is already on disk.
- Never estimate a missing input. Unknown is an output, and it is the right one.
- Round currency to whole dollars. Show the arithmetic in a `computed_from` field so a human
  can check it without re-deriving it.

Report back ONLY: "Analyzed {n}/{total}, {k} with incomplete factors ({dockets})".
```

## Routing

Also fan-out safe. Reads analysis output plus the deadline engine's output.

```
You are a routing subagent for the monitoring-tax-appeals skill. For each matter, recommend a
lane and justify it. This is an ADVISORY output for an attorney, not a decision.

MATTERS with analysis + deadlines: {MATTER_LIST}
Routing rules: references/deadlines-and-routing.md — follow the ordering rule exactly.

OUTPUT per matter, appended to {WORKSPACE}/routing/{docket}.json:
  recommendation: bor_request | ptab_challenge | both | no_action
  because:   [facts driving it — each quoting a stored value or a case-history phrase]
  against:   [the strongest argument the other way — REQUIRED. If there genuinely isn't one,
              write "No material counter-argument: {reason}". Never omit the field.]
  deadline:  {the computed window and its basis, copied verbatim from the deadline engine}
  unknowns:  [every missing input, named]

THE ORDERING RULE — apply before anything else:
If days_remaining <= 14, the recommendation LEADS with preserving the PTAB filing regardless of
which lane scores better on the merits. A BOR reconsideration does not toll the 30-day window,
and a pending request when the window closes forecloses the appeal entirely.

RULES:
- Never restate a deadline in your own words. Copy the engine's object. Paraphrasing a date is
  how a wrong date enters a calendar.
- Never recommend against a filing on cost grounds without stating the gap number that drove it.
- Never claim what PTAB "usually" does. You have specific decisions or you have nothing.
- No legal conclusions. Recommendations and their evidence.

Report back ONLY: "Routed {n}/{total}: {bor} BOR, {ptab} PTAB, {both} both, {none} no-action,
{critical} inside 14 days".
```

---

## Governance

**Caps**

| Step | Concurrency | Calls | External? |
|---|---|---|---|
| Sweep | 1 | 1 per watch page | Yes — paced |
| Hydration | 1 | 2 per changed docket + 1 PDF once | Yes — paced |
| Parsing | fan-out ok | 0 | No |
| Analysis | fan-out ok | 0 | No |
| Routing | fan-out ok | 0 | No |

The rule is simple: **anything that touches `ptab.illinois.gov` runs single-file; anything that reads disk can fan out.**

**Error handling**

- Partial sweep → publish the digest with an explicit "sweep incomplete" banner listing the watches that did not run. A digest that silently covers 6 of 9 watches is worse than no digest, because it reads as complete.
- Parse failure on one docket → record it in the digest as `parse_failed` with the raw file path. Never drop a docket quietly; a docket that vanishes from the digest reads as "nothing happened."
- Decision PDF 404 → `decision_pdf: null`, retry next sweep. Not an error.
- Chain verification failure → **stop the entire run.** Do not append, do not publish. Report and hand to a human.
- No deadline computable → the matter still appears in the digest under "needs input," naming the missing date. A matter without a deadline is not a matter without urgency.
