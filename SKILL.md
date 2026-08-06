---
name: monitoring-tax-appeals
description: Watch Illinois property-tax appeals on the PTAB Appeal Status Inquiry system and turn them into a Monday digest, deadline alerts, and an append-only audit trail. Sweeps matters by PIN, county, tax year, owner, and attorney; detects new filings, status changes, scheduled hearings, decisions, dismissals, and valuation changes; tracks the 30-day statutory window to appeal a Board of Review decision; and routes matters between a BOR reconsideration request and a PTAB challenge. Use when the user wants to monitor a property-tax appeal docket, track PTAB matters or deadlines, pull signed PTAB decisions, or decide between a Board of Review request and a PTAB appeal. Triggers "check PTAB", "monitor my appeals", "PTAB deadlines", "property tax appeal status", "Monday digest", "pull PTAB decisions", "BOR or PTAB".
license: MIT
---

# Monitoring tax appeals

Sweep the Illinois Property Tax Appeal Board every Monday, diff it against last week, and turn the delta into three things: a digest of what moved, an alert for every deadline inside the window, and a ledger entry no one can quietly rewrite.

Property-tax appeal work is a watching problem before it is a lawyering problem. The docket changes on the state's schedule, not yours; a hearing gets set, a county files a stipulation, a decision drops as a PDF — and none of it emails you. The cost of missing a change is not inconvenience, it is a jurisdictional deadline that does not reopen. This skill does the watching, and hands the judgment back.

**Required**: the PTAB Appeal Status Inquiry system at `ptab.illinois.gov/asi/` (public, no login) and a watchlist in `watchlists/`. No credentials, ever — see the filing boundary below.

## Ownership

This skill owns observation: what the public record says today, what changed since last sweep, which deadlines that implies, and what the numbers look like. It does not own the filing decision, the filing itself, or the date an attorney will rely on. It produces a packet; a person files it.

**Output directory**: `/opulent/workspace/ptab/{firm_slug}/` — persistent across runs, not per-run. Sweeps land in `snapshots/{YYYY-MM-DD}/`, the current state in `matters/{docket}.json`, and the ledger in `ledger.jsonl`. Deliverables are `digest.html`, `alerts.json`, and `matters.csv`.

---

## The filing boundary

**Everything in this skill is read-only against public pages.** The line is absolute and it is drawn at `ptab.illinois.gov/efile/`.

- **Never navigate to, log into, or interact with the eFiling portal.** Not to check status, not to confirm a submission, not "just to look."
- **Never handle a PTAB eFile credential** — not typed, not stored, not passed to a subagent, not read from a vault.
- **Never attempt a captcha.** A captcha is a stop sign, and the correct response is to tell the user which matter needs a human.
- The skill's terminal output for a filing is a **packet**: the computed deadline, the evidence list, the drafted narrative, and a link to the form. A person opens the portal and files it.

Attorney-represented appeals have had to go through the eFiling portal since July 1, 2023. That is precisely the workflow this skill stays out of.

## Dates are computed, not relied on

Every date this skill produces is a **computation from observed inputs**, and it is labeled that way.

- Each deadline carries `verify: true`, the inputs it was computed from, and which input was missing. It clears only when a human confirms it.
- **The statutory trigger is county-dependent.** Outside Cook, it is 30 days from the BOR's written notice. In Cook, it is the later of that or 30 days from the date the BOR transmits its final action on the township to the county assessor. Treating Cook as single-leg reports an expired window on matters that are still live — and the matter gets dropped.
- **The trigger dates are not on PTAB's site.** The notice date comes off the notice; the transmittal date comes from the county. The skill computes from what it has and names what it lacks.
- Cook matter with only the notice leg → `basis: "partial"`, the conservative earlier date, and the missing input named. Never let a partial computation present as a confirmed deadline.
- Nothing here is legal advice. Routing recommendations carry their evidence so an attorney can disagree with them quickly.

## Sweep discipline

ASI is a public service run by a state agency, not an API.

- **One sweep per week, sequential.** Batch ordered steps inside a single session; keep one session at a time against `ptab.illinois.gov`.
- **Pace requests** — roughly one every 2–3 seconds, and stop the sweep on the first 5xx or interstitial rather than retrying into it.
- ASI answers plain GETs, so fetch. Escalate to a browser session for pages that need interaction.
- **Never re-fetch what has not changed.** The list query is cheap; the per-docket hydration is not. Hydrate only dockets whose list row changed, plus anything with an open deadline.
- Cache every raw response under `snapshots/{date}/raw/`. The parse can be re-run; the fetch should not be.

## The ledger is append-only

`ledger.jsonl` is the audit trail, and it is the artifact that outlives the matter.

- **Append only.** Never edit, never delete, never re-order. A correction is a new entry that references the one it corrects.
- Every entry is hash-chained to its predecessor (`prev_hash` → `hash`). `detect_changes.mjs` writes the chain; `--verify` re-walks it.
- Every entry records what was observed, the URL it came from, and when. Not conclusions — observations.
- A broken chain is an incident, not a bug to patch. Report it, keep the file, do not rewrite history to make it validate.

---

## Pipeline Overview

Follow these 9 steps in order.

0. **Setup** — resolve the workspace, verify the ledger chain
1. **Load watchlist** — `watchlists/{firm_slug}.json`
2. **Sweep** — one GET per watch → `snapshots/{date}/`
3. **Hydrate** — docket + property details for changed rows only
4. **Diff** — typed change events vs. last snapshot
5. **Deadlines** — the 30-day window, rolled and banded
6. **Analyze** — assessment gap, tax exposure, comparables, precedent
7. **Route** — BOR reconsideration vs. PTAB challenge, with evidence
8. **Publish** — digest, alerts, CSV, ledger append

Invoke with `/monitoring-tax-appeals [--firm <slug>] [--since <YYYY-MM-DD>] [--dry-run]`. Default is a full sweep against the last snapshot. Scheduled weekly runs are the normal mode — see Step 8.

---

## Step 0: Setup

```bash
FIRM_SLUG=${FIRM_SLUG:-default}
WORKSPACE=/opulent/workspace/ptab/${FIRM_SLUG}
TODAY=$(date +%Y-%m-%d)
mkdir -p "$WORKSPACE/snapshots/$TODAY/raw" "$WORKSPACE/matters" "$WORKSPACE/decisions"
node {SKILL_DIR}/scripts/detect_changes.mjs "$WORKSPACE" --verify
```

`--verify` walks the hash chain before anything writes to it. **If it fails, stop.** A broken chain means the ledger was edited out of band, and every downstream artifact is suspect until a human says otherwise.

## Step 1: Load Watchlist

```bash
cat {SKILL_DIR}/watchlists/${FIRM_SLUG}.json
```

Each watch is one query against ASI. Five kinds, mirroring how matters actually get tracked:

| Watch kind | Fields | Becomes |
|---|---|---|
| `pin` | `pin` | Every docket filed against that parcel |
| `docket` | `docket` | One matter, hydrated directly |
| `county_year` | `county`, `tax_year`, `status` | The county's docket for a tax year |
| `owner` | `last_name`, `first_name`, `county?` | Matters by taxpayer name |
| `attorney` | `attorney_last_name` or `firm_name` | The firm's own docket — the highest-value watch |

`status` is `A` (all), `O` (open), or `C` (closed). Open-only is the right default for active monitoring; sweep `A` quarterly to catch matters that closed between sweeps.

**ASI holds data from 1999 forward.** A watch for an earlier tax year returns nothing, and that is not a failure.

## Step 2: Sweep

Build the query URLs deterministically — never hand-assemble them:

```bash
node {SKILL_DIR}/scripts/ptab_urls.mjs {SKILL_DIR}/watchlists/${FIRM_SLUG}.json > "$WORKSPACE/snapshots/$TODAY/queries.jsonl"
```

Fetch each sequentially, pacing between calls, writing raw HTML to `snapshots/{date}/raw/{watch_id}_p{N}.html`.

Result pages paginate at 50 rows with First/Prev/Next/Last links. Follow `Next` until it stops advancing or you hit the watch's `max_pages` (default 20). A watch returning tens of thousands of rows is a watch that is too broad — `references/ptab-surfaces.md` has the narrowing guidance.

Parse each result table into `snapshots/{date}/rows.jsonl`, one record per docket row: `docket`, `last_name`, `first_name` or `firm_name`, `attorney`, `county`, `township`, `close_date`, plus the `watch_id` that found it.

## Step 3: Hydrate

Only for dockets whose list row differs from last snapshot, plus every docket with an open deadline. Two fetches each:

```
/asi/property.asp?docketno={YY-NNNNN}                        → parties, case history, PINs, attorney
/asi/PropertyDetails.asp?proppin={PIN}&docketno={FULL}       → BOR / Appellant / PTAB values, hearing, status
```

The docket page's **Case History** table is the event stream — `Transaction Date | Transaction Description | Received/Letter Date`. PTAB writes those descriptions from a fixed vocabulary; `references/ptab-surfaces.md` maps each phrase to a change type. Do not paraphrase them into the matter record. Store them verbatim; the phrasing is the evidence.

When the case history shows a close, the signed decision is at a deterministic URL:

```
https://ptab.illinois.gov/web/Decisions/{YYYY}/{FULL-DOCKET}.pdf
```

Fetch it once, store it under `decisions/`, record its byte size and SHA-256 in the matter. Never re-fetch a decision you already have — a signed decision does not change.

Write one canonical record per matter to `matters/{docket}.json`. Format in `references/example-matter.md`.

## Step 4: Diff

```bash
node {SKILL_DIR}/scripts/detect_changes.mjs "$WORKSPACE" --snapshot "$TODAY"
```

Compares this snapshot's matters against the previous and emits typed events, each appended to `ledger.jsonl` with its hash link:

| Event | Fired when |
|---|---|
| `new_filing` | A docket appears under a watch that did not have it |
| `status_change` | `county_status`, `hearing_status`, or `decision_type` differs |
| `hearing_scheduled` | A hearing date/time appears or moves |
| `decision_issued` | Case closes with a decision, or the decision PDF first resolves |
| `dismissal` | Close reason indicates dismissal or withdrawal |
| `valuation_change` | Any BOR, appellant, or PTAB total changes |
| `case_history_entry` | A new row in the case history — the catch-all, never dropped |

Every event carries `docket`, `observed_at`, `source_url`, `before`, `after`. `case_history_entry` exists so an unrecognized PTAB phrase still lands in the ledger and the digest rather than being silently classified away.

## Step 5: Deadlines

```bash
node {SKILL_DIR}/scripts/deadline_engine.mjs "$WORKSPACE" --today "$TODAY"
```

Computes the window under 35 ILCS 200/16-160, counts days per 5 ILCS 70/1.11 (exclude the first day, include the last), rolls a weekend or Illinois holiday landing forward, and bands by urgency: `expired`, `critical` (≤ 7 days), `warning` (≤ 14), `watch` (≤ 30), `clear`.

Reads `bor_decision.notice_date` and — **Cook only** — `bor_decision.township_transmit_date` from the matter file. Neither is on PTAB's site; both come off the notice or from the county. Outside Cook the engine uses the notice leg alone. In Cook it takes the **later** of the two legs, and with only one leg marks `basis: "partial"` and reports the conservative earlier date. With no notice date it emits nothing — there is no fallback trigger on the public record, and inventing one is how a matter gets filed late.

Every output carries `verify: true`. Read `references/deadlines-and-routing.md` before touching this step.

## Step 6: Analyze

Per matter with an open decision point, compute from stored values only:

- **Assessment gap** — `bor_total − appellant_total`, and as a percentage of BOR total.
- **Estimated tax exposure** — gap × equalization factor × composite tax rate, from the county's published factors in the watchlist. **An estimate**, labeled as one, with its inputs shown. County rates move; a stale rate produces a confident wrong number.
- **Comparable support** — comparable sales the user supplied, or PTAB matters on the same township/class/tax year found through the county+year watch. Never invent a comparable.
- **Prior PTAB precedent** — decisions already in `decisions/` for the same township and property class. Cite docket numbers; do not characterize a holding you have not read.

Anything not computable from stored values is `Unknown` with the missing input named. A blank is a question for the user, not a gap to fill.

## Step 7: Route

Two lanes, and the choice is mostly about evidence and clock:

| | Board of Review request | PTAB challenge |
|---|---|---|
| Nature | Administrative reconsideration | Formal, evidence-heavy appeal |
| Best when | Factual/clerical error, clear comp support, BOR still in session | Valuation dispute on the merits, BOR exhausted, appraisal available |
| Cost | Low | High — evidence, exhibits, possible hearing |
| Clock | County calendar | 30 days, jurisdictional |

The skill emits a recommendation **with its evidence and its counter-evidence**, never a bare verdict. Where the deadline is inside 14 days, the recommendation says so first — a reconsideration that runs past the PTAB window forecloses the appeal, and that ordering matters more than which lane scores better.

Decision table and the full reasoning in `references/deadlines-and-routing.md`.

## Step 8: Publish

```bash
node {SKILL_DIR}/scripts/compile_digest.mjs "$WORKSPACE" --today "$TODAY"
```

Produces:
- `digest.html` — the Monday digest: alerts first, then changes grouped by matter, then the quiet matters collapsed
- `alerts.json` — machine-readable deadline alerts for downstream notification
- `matters.csv` — the full book of business, one row per matter

Then surface the table as an interactive artifact and post the summary:

```
## PTAB sweep — week of {date}

- **Matters watched**: {n} across {k} watches
- **Changes**: {n} ({new_filing} new · {hearing_scheduled} hearings · {decision_issued} decisions · {valuation_change} valuations)
- **Deadlines**: {critical} critical · {warning} warning · {watch} watch
- **Decisions pulled**: {n}
- **Ledger**: {n} entries appended, chain verified
- **Needs a human**: {n} (deadline verification, eFiling, captcha)
```

Lead with the critical band. If a matter is inside 7 days, it goes at the top of the digest and into the first line of the chat summary — under it, everything else.

Register the recurring Monday run as a scheduled automation rather than a loop: weekly, Monday morning, with the digest delivered on completion. The sweep is idempotent — running it twice in a day produces zero new events and zero new ledger entries.

---

## Failure modes worth naming

| Symptom | Cause | Fix |
|---|---|---|
| Sweep returns "No records found!" for a known-good watch | Over-narrow combination, or tax year before 1999 | Drop `township`, then `tax_year`; confirm the county spelling |
| Tens of thousands of rows for one watch | County+year with `Dockets=A` | Narrow to `O`, add township or attorney |
| Decision PDF 404s on a closed case | Decision not yet posted | Leave `decision_pdf: null`; the next sweep picks it up. Do not synthesize the URL as evidence it exists |
| Deadline shows `basis: "partial"` | Only one statutory leg known | Get the missing date from the notice or the county — do not let the partial date reach a calendar |
| Chain verification fails | Ledger edited out of band | Stop. Report. Do not rewrite to make it pass |
| A case-history phrase lands as `case_history_entry` | New or unmapped PTAB vocabulary | Correct behavior. Add the phrase to `references/ptab-surfaces.md` so it types next week |
