# File formats

Four artifacts have fixed shapes. The scripts parse them, so field names are exact and single-valued.

---

## Matter — `matters/{docket}.json`

The canonical state of one appeal, rewritten each sweep. Rewritable because history lives in the ledger, not here.

```json
{
  "docket": "2004-01668",
  "docket_short": "04-01668",
  "watch_ids": ["atty-smith-r"],
  "appellant": { "first_name": "James", "last_name": "Jennings" },
  "property": {
    "pins": ["10-10-11-108-008"],
    "county": "Tazewell",
    "township": "Cincinnati",
    "type": "R",
    "class": "1"
  },
  "attorney": {
    "first_name": "Robert L.",
    "last_name": "Smith",
    "firm_name": "Moehle, Swearingen & Umholtz, Ltd."
  },
  "values": {
    "bor":       { "land": 9950, "improvements": 25690, "farm_land": 0, "farm_building": 0, "total": 35640 },
    "appellant": { "land": 9670, "improvements": 0,     "farm_land": 0, "farm_building": 0, "total": 9670 },
    "ptab":      { "total": 31167 }
  },
  "status": {
    "county_status": "Ready",
    "decision_type": "Hearing",
    "hearing_status": "Hearing Set",
    "close_date": "2007-12-21",
    "reason_closed": "Decision with Hearing"
  },
  "hearing": { "datetime": "2007-01-30T10:00:00", "location": null },
  "case_history": [
    { "transaction_date": "2005-04-26", "description": "Appellant new appeal received", "letter_date": "2005-04-22" },
    { "transaction_date": "2006-12-13", "description": "Hearing Scheduled (Click on Property PIN number below for details)", "letter_date": "2006-12-14" }
  ],
  "decision_pdf": {
    "url": "https://ptab.illinois.gov/web/Decisions/2004/2004-01668.pdf",
    "path": "decisions/2004-01668.pdf",
    "bytes": 58778,
    "sha256": "…",
    "fetched_at": "2026-08-05T14:02:11Z"
  },
  "bor_decision": {
    "notice_date": null,
    "township_transmit_date": null,
    "source": null
  },
  "source_urls": {
    "docket": "https://ptab.illinois.gov/asi/property.asp?docketno=04-01668",
    "details": "https://ptab.illinois.gov/asi/PropertyDetails.asp?proppin=10-10-11-108-008&docketno=2004-01668-001"
  },
  "observed_at": "2026-08-05T14:02:09Z"
}
```

Non-negotiables:

- **`case_history[].description` is verbatim.** Whatever PTAB wrote, character for character. Type mapping happens at diff time, not at parse time.
- **Values are integers with separators stripped.** `35,640` → `35640`. An unstripped string makes every sweep report a spurious `valuation_change`.
- **Missing is `null`, never `0`.** An unreported improvement value and a zero improvement value are different facts, and the digest treats them differently.
- **`bor_decision` starts null.** Those dates are not on PTAB's site — they come off the notice or from the county, entered by a human. Null here is honest; a guess is not.
- **`decision_pdf` is null until the file is on disk.** A constructed URL is not evidence a decision exists.

---

## Change event — a line in `ledger.jsonl`

Append-only, hash-chained. Written by `detect_changes.mjs`.

```json
{
  "seq": 41,
  "observed_at": "2026-08-05T14:02:12Z",
  "snapshot": "2026-08-05",
  "docket": "2004-01668",
  "type": "valuation_change",
  "field": "values.bor.total",
  "before": 35640,
  "after": 34100,
  "source_url": "https://ptab.illinois.gov/asi/PropertyDetails.asp?proppin=10-10-11-108-008&docketno=2004-01668-001",
  "prev_hash": "9f2c…",
  "hash": "c418…"
}
```

`hash` is SHA-256 over the canonical JSON of the entry with `hash` removed — including `prev_hash`, which is what makes the chain a chain. The first entry uses `prev_hash: "genesis"`.

An entry is never edited. A correction is a **new** entry of type `correction` carrying `corrects_seq`. The wrong entry stays. That is the point of an audit trail: it records what was believed and when, not only what turned out to be true.

---

## Deadline — an entry in `alerts.json`

Written by `deadline_engine.mjs`.

```json
{
  "docket": "2026-01234",
  "county": "Cook",
  "rule": "35 ILCS 200/16-160 (county ≥ 3,000,000)",
  "legs": {
    "notice_date": "2026-07-15",
    "notice_deadline": "2026-08-14",
    "township_transmit_date": null,
    "transmit_deadline": null
  },
  "deadline": "2026-08-14",
  "basis": "partial",
  "missing": ["township_transmit_date"],
  "rolled_from": null,
  "days_remaining": 9,
  "band": "warning",
  "verify": true,
  "note": "Cook matter computed from the notice leg only. The transmittal leg may extend this date — confirm with the county before relying on it."
}
```

- `basis` is `full` (every leg the county's rule requires), `partial` (Cook with one leg), or `none` (no deadline emitted).
- `rolled_from` holds the pre-roll date when day 30 landed on a weekend or holiday, so the roll is auditable.
- `verify: true` is on every single output and only a human clears it.
- `band` drives digest ordering: `expired` and `critical` sort above everything else regardless of gap size.

---

## Watchlist — `watchlists/{firm_slug}.json`

```json
{
  "firm_slug": "example-firm",
  "firm_name": "Example & Associates",
  "watches": [
    { "id": "atty-smith-r", "kind": "attorney", "attorney_last_name": "Smith", "status": "O", "max_pages": 20 },
    { "id": "pin-tazewell-1", "kind": "pin", "pin": "10-10-11-108-008" },
    { "id": "cook-2025-open", "kind": "county_year", "county": "Cook", "tax_year": 2025, "status": "O", "max_pages": 40 }
  ],
  "county_factors": {
    "Cook": { "equalization_factor": 3.0163, "composite_rate": 0.0721, "source_year": 2024, "source": "IDOR final multiplier / county clerk rate" }
  },
  "thresholds": { "min_gap_dollars": 5000, "min_gap_percent": 5 }
}
```

`county_factors` are the user's to maintain and are stamped with `source_year` for a reason — a stale multiplier produces a confidently wrong exposure number, which is worse than a blank one. The analysis step refuses to substitute a factor from another county or year.
