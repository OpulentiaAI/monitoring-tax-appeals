# Budgets and pacing

Request budgets, pacing, and how a sweep is sized and checked. Open this when planning a sweep or diagnosing one that went wrong.

## Hard caps

| Stage | Requests | What the request is |
| --- | --- | --- |
| Sweep | 1 per watch, plus 1 per additional page | A result-page fetch, 50 rows each |
| Hydration | 2 per changed docket | The docket page, then the property page |
| Decisions | 1 per closed docket, once ever | The signed PDF |
| Diff, deadlines, digest | 0 | Everything they need is on disk |

`max_pages` defaults to 20, so one watch costs at most 20 requests. A watch that keeps paginating past that is too broad, and the fix is a narrower query rather than a higher cap.

Hydrate only dockets whose list row changed since last sweep, plus any docket carrying an open deadline. Hydrating everything is the most common way a sweep costs ten times what it needs to.

A signed decision never changes. Fetch it once, store it with its byte size and hash, and treat a later hash mismatch as something to surface rather than overwrite.

## Pacing

One sweep per week. Requests sequential, roughly two to three seconds apart. This is a public service run by a state agency, and the pacing is what keeps it available.

Stop the sweep on the first 5xx or interstitial and report a partial. Retrying into a block is how a partial sweep becomes a blocked one.

## Cache and re-reads

Raw HTML for every request lands in `snapshots/{date}/raw/`. Re-parse it freely. Re-fetch it never.

When a parse fails, the answer is in the cached HTML, so fix the parser against that file rather than sweeping again.

## Checks after each sweep

- **Coverage.** Every watch produced rows, or reported `No records found!` as a valid outcome.
- **Chain.** `--verify` passes before anything appends and after the run completes.
- **Idempotency.** Re-running the same sweep emits zero events and appends zero ledger entries.
- **Vocabulary.** Any case-history phrase that fell through to `case_history_entry` is added to `ptab-surfaces.md`.

## When a sweep fails

| Signal | Meaning | Response |
| --- | --- | --- |
| One watch returns nothing | Over-narrow, or a tax year before 1999 | Drop township, then tax year |
| Tens of thousands of rows | County plus year with status All | Narrow to Open, add township or attorney |
| Every watch fails identically | The site changed | Stop, re-derive shapes, update `ptab-surfaces.md` |
| Chain verification fails | The ledger was edited out of band | Stop and report. Repairing it to validate destroys the thing it is for |
| A parse breaks mid-sweep | Column order shifted | Parse by header name against the cached HTML |

## Cost shape

The sweep scales with watches and pages, and it is cheap. Hydration scales with *change*, which is what makes the changed-row filter the main cost lever. A quiet week costs almost nothing, and that is the correct behaviour rather than a sign the sweep failed.

## Layers on top of

`SKILL.md` owns the invariants, including the filing boundary and the ledger rule. `deadlines-and-routing.md` owns every date question. `ptab-surfaces.md` owns endpoint shapes and the case-history vocabulary. This file adds only the budgets and the pacing.
