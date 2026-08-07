---
name: monitoring-tax-appeals
description: Sweep the Illinois Property Tax Appeal Board weekly, diff against last week, and produce a digest, deadline alerts, and an append-only audit trail. Detects new filings, status changes, hearings, decisions, dismissals and valuation changes, and computes the statutory window to appeal a Board of Review decision. Use for monitoring a property-tax appeal docket, tracking PTAB deadlines, or pulling signed decisions.
license: MIT
---

# Monitoring tax appeals

A watchlist in, a Monday digest out, with every deadline shown as a computation and every observation hash-chained.

**Offline demo, no network:**

```bash
npm run demo && npm run open
```

**Live run:** stages 1 to 9 below.

## Invariants

- **Never touch `ptab.illinois.gov/efile/`.** No credential, no captcha. This skill produces a filing packet; a person files it.
- Every deadline carries `verify: true` and the inputs it came from. Nothing here is legal advice.
- The deadline rule is county-dependent. Outside Cook it runs 30 days from the BOR written notice. In Cook it is the later of that or 30 days from township transmittal.
- No notice date means no deadline. There is no fallback trigger on the public record.
- The ledger is append-only. A correction is a new entry. A broken chain stops the run.
- One sweep per week, sequential, paced. Stop on the first 5xx or interstitial.
- Read the summary and the digest, not the raw snapshots.

## Stages

### 1 · Setup and chain check
```bash
node scripts/detect_changes.mjs {WORKSPACE} --verify
```
Walks the hash chain before anything writes to it. **A failure stops the run.** Do not repair the ledger to make it validate.

*Done: chain verified or the run halted with the failing line named.*

### 2 · Load the watchlist
`watchlists/{firm_slug}.json`. Five watch kinds: PIN, docket, county+year, owner, attorney or firm. An attorney watch is the high-signal one. ASI holds data from 1999 forward.

*Done: watches loaded, each with a kind and a status filter.*

### 3 · Build queries
```bash
node scripts/ptab_urls.mjs {WATCHLIST} > {WORKSPACE}/snapshots/{date}/queries.jsonl
```
Never hand-assemble a PTAB URL. The docket number has three forms and the builder normalizes between them.

*Done: one query per watch, empty watches rejected with reasons.*

### 4 · Sweep
Fetch each query sequentially, two to three seconds apart, writing raw HTML to `snapshots/{date}/raw/`. Follow `Next` until it stops advancing or `max_pages`. Parse result tables into `rows.jsonl`.

Parse by column header, not position: the third column changes name when the query includes an attorney.

*Done: `rows.jsonl` written, record counts recorded, nothing retried through a block.*

### 5 · Hydrate
Only dockets whose row changed, plus anything with an open deadline. Two reads each: the docket page for parties and case history, the property page for values, hearing and status.

Store case-history phrases **verbatim**. The phrasing is the evidence.

Signed decisions live at a deterministic path by docket year. Fetch once, store with byte size and SHA-256, never re-fetch.

*Done: one `matters/{docket}.json` per changed docket.*

### 6 · Diff
```bash
node scripts/detect_changes.mjs {WORKSPACE} --snapshot {date}
```
Emits typed events and appends each to the hash-chained ledger. Re-running the same sweep emits zero events.

*Done: event counts by type reported, ledger head printed.*

### 7 · Deadlines
```bash
node scripts/deadline_engine.mjs {WORKSPACE} --today {date}
```
Counts by excluding the first day and including the last, rolls off weekends and Illinois holidays, and bands by urgency. Cook takes the later leg. One leg only means `basis: partial` and the conservative date.

Open `references/deadlines-and-routing.md` before changing anything here.

*Done: `alerts.json` written, every entry carrying `verify: true`.*

### 8 · Analyze and route
Assessment gap is BOR total minus appellant total. Tax exposure is an estimate with its inputs shown. Comparables are supplied or found, never invented.

Routing recommends a BOR reconsideration or a PTAB challenge and carries the argument against itself. Inside 14 days, preserving the PTAB filing leads regardless of merits: a reconsideration does not toll the window.

*Done: each open matter has a recommendation, its evidence, and its counter-evidence.*

### 9 · Publish
```bash
node scripts/compile_digest.mjs {WORKSPACE} --today {date}
```
Deadlines lead. Expired and critical at the top, then changes by matter, then quiet matters. Report counts, bands, decisions pulled, ledger status, and how many items need a human.

*Done: `digest.html`, `matters.csv`, `digest_summary.json` written.*

## References

Open on trigger.

| Trigger | File |
| --- | --- |
| A parse fails or a phrase is unmapped | `references/ptab-surfaces.md` |
| Any deadline or routing question | `references/deadlines-and-routing.md` |
| Sizing or pacing a sweep | `references/workflow.md` |
| A record's shape is unclear | `references/example-matter.md` |

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| "No records found" on a known-good watch | Over-narrow combination, or year before 1999 | Drop township, then tax year |
| Tens of thousands of rows | County plus year with status All | Narrow to Open, add township or attorney |
| Decision PDF 404s on a closed case | Not posted yet | Leave null; next sweep finds it |
| Deadline shows `basis: partial` | One statutory leg known | Get the missing date; do not calendar a partial |
| Chain verification fails | Ledger edited out of band | Stop and report. Do not rewrite it |
| A phrase lands as `case_history_entry` | New PTAB vocabulary | Correct behaviour. Add it to `ptab-surfaces.md` |
