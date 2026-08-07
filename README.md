# monitoring-tax-appeals

An Opulent skill for Illinois property-tax appeal practice: sweep the Property Tax Appeal Board every Monday, diff it against last week, and turn the delta into a digest, deadline alerts, and an append-only audit trail.

## What it does

Property-tax appeal work is a watching problem before it is a lawyering problem. The docket moves on the state's schedule, not yours — a hearing gets set, a county files a stipulation, a decision drops as a PDF — and none of it emails you. This skill does the watching. Once a week it runs your watchlist against the PTAB Appeal Status Inquiry system: matters by PIN, by county and tax year, by owner, by attorney or firm. It pulls each changed docket's case history and assessed values, compares them to last week's snapshot, and writes typed events for what moved — new filings, status changes, scheduled hearings, decisions, dismissals, valuation changes. It computes the 30-day window to appeal a Board of Review decision from the dates you give it, counting the way the statute counts and rolling off weekends and Illinois holidays, and it labels every one of those dates as a computation to be verified rather than a deadline to be trusted. It works out the assessment gap and the estimated tax exposure, and where there's a decision to make it recommends a Board of Review reconsideration or a PTAB challenge — with the argument against its own recommendation attached, because a recommendation that never argues with itself is one nobody checks. Everything it observes goes into a hash-chained ledger that can be verified but not quietly rewritten. What it does not do is file: the eFiling portal is credentialed and captcha-protected, and this skill has no business there. It produces the packet, and a person files it.

## Required inputs

| Input | Where | Required | Notes |
|---|---|---|---|
| Watchlist | `watchlists/{firm_slug}.json` | **Yes** | Copy `example.json`. Five watch kinds — PIN, docket, county+year, owner, attorney/firm. An empty watch is rejected, not run. |
| → `attorney_last_name` / `firm_name` | watchlist | Recommended | The highest-signal watch. Verified: `AttyLName=Smith` → 190 records, vs 39,126 for one Cook tax year. |
| → `county`, `tax_year`, `status` | watchlist | No | `status` is `A`/`O`/`C`. Open-only for active monitoring; sweep all quarterly. |
| → `max_pages` | watchlist | No | Default 20 (1,000 rows). Guards against a runaway watch. |
| `bor_decision.notice_date` | `matters/{docket}.json` | **For any deadline** | The written-notice date off the BOR notice. **Not on PTAB's site** — a person enters it. No notice date, no deadline. |
| `bor_decision.township_transmit_date` | `matters/{docket}.json` | **Cook matters** | The date the BOR transmitted final township action to the assessor. Cook takes the later leg; without it the deadline is `partial`. |
| Equalization factor + composite rate | watchlist `counties` block | For exposure math | County-published. A stale rate produces a confident wrong number, so it's an input, not a constant. |
| Comparable sales | user-supplied | For comp support | Never invented. Absent comps produce `Unknown`, not an estimate. |
| Nothing else | — | — | ASI is public. No login, no API key, no credential anywhere in this skill. |

## Expected outputs

Everything persists under `/opulent/workspace/ptab/{firm_slug}/` — the workspace is durable across runs, not per-run.

| Output | What it is |
|---|---|
| `digest.html` | The Monday digest. Deadlines lead — expired and critical at the top — then changes grouped by matter, quiet matters last. Filterable by band and by changed. Light and dark, no external assets. |
| `alerts.json` | Deadline alerts, sorted by urgency, each with `deadline`, `days_remaining`, `band`, `basis` (`full`/`partial`/`none`), `missing[]`, `rolled_from`, and `verify: true`. |
| `matters.csv` | 25 columns, one row per matter — the full book of business, formula-injection safe. |
| `ledger.jsonl` | The audit trail. Append-only, hash-chained, one entry per observation with its source URL and timestamp. `--verify` re-walks the chain and names the exact line if it breaks. |
| `matters/{docket}.json` | Canonical state per matter — parties, property, values, status, hearing, verbatim case history, decision hash. |
| `snapshots/{date}/` | That sweep's raw HTML, parsed rows, events, and a copy of matters as next week's baseline. Re-parse freely; re-fetch never. |
| `decisions/{docket}.pdf` | Signed decisions, downloaded once through the browser session, stored with byte size and SHA-256. |
| `digest_summary.json` | Counts and the leading matters, for the chat summary. |
| Chat summary | Matters watched, events by type, deadline bands, decisions pulled, ledger status, and how many items need a human. |

A quiet week is a real result: zero events and zero ledger entries. Re-running the same sweep produces zero of both.

## Boundaries

Three of them are load-bearing, and all three are in the skill rather than in this README as advice:

- **No filing, no credentials, no captchas.** The skill never navigates to `ptab.illinois.gov/efile/`. Attorney-represented appeals have had to file through that portal since 2023-07-01; this skill stays out of it and hands over a packet instead.
- **Dates are computed, not relied on.** Every deadline carries `verify: true`, the inputs behind it, and what was missing. Nothing here is legal advice.
- **The ledger is append-only.** A correction is a new entry referencing the old one. A broken chain stops the run — it is not repaired to make it validate.

## Layout

```
monitoring-tax-appeals/
├── SKILL.md                            the pipeline — 9 steps, sweep discipline, the three boundaries
├── watchlists/example.json             watch template + county rate block
├── references/
│   ├── ptab-surfaces.md                every endpoint, verified, with parsing traps and the case-history vocabulary
│   ├── deadlines-and-routing.md        35 ILCS 200/16-160 both forms, day counting, holidays, BOR-vs-PTAB routing
│   ├── workflow.md                     request budgets, pacing, sweep checks
│   └── example-matter.md               matter, event, and alert record formats
├── samples/                            two-week fixture — runs the whole pipeline offline
└── scripts/
    ├── ptab_urls.mjs                   query builder + docket-number normalizer + watch validator
    ├── detect_changes.mjs              snapshot diff → typed events → hash-chained ledger (--verify)
    ├── deadline_engine.mjs             the 30-day window, county-aware, rolled and banded
    └── compile_digest.mjs              digest.html + matters.csv + summary
```

## Try it

```bash
cp -R samples/fixture /tmp/ptab-ws && node scripts/detect_changes.mjs /tmp/ptab-ws --snapshot 2026-08-03 && node scripts/deadline_engine.mjs /tmp/ptab-ws --today 2026-08-03 && node scripts/compile_digest.mjs /tmp/ptab-ws --today 2026-08-03 --open
```

Dependency-free, Node 18+. [`samples/README.md`](samples/README.md) explains what each of the 13 events and 5 deadline outcomes proves, and how to break the ledger on purpose to watch verification catch it.

## Status

**Isolated by design.** This package sits outside `.agents/skills/` in the Opulent monorepo — not in the skill catalog, not in the template SSOT, not in the preloaded seed — so nothing here can affect the snapshot-skill contract tests. The slug follows catalog convention (unprefixed, gerund) and the frontmatter is `name` + `description` + `license` only, so promoting it is a move plus the index regeneration chain.

## Provenance

Structure and voice modeled on [browserbase/skills](https://github.com/browserbase/skills) — the step-numbered pipeline, hard tool-call caps, verbatim-evidence rules, and heredoc-batched subagent writes come from `event-prospecting` and `company-research`. Steps name the capability required rather than a specific tool. PTAB endpoint shapes were verified live on 2026-08-05; statutory citations are in [`references/deadlines-and-routing.md`](references/deadlines-and-routing.md).
