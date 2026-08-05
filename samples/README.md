# Sample inputs — two-week PTAB sweep

An offline fixture that runs the whole pipeline with no network, plus the live queries to point a real sweep at.

## What's real and what isn't

**Real**: every URL shape in [`../references/ptab-surfaces.md`](../references/ptab-surfaces.md), verified against `ptab.illinois.gov` on 2026-08-05 — the search parameters, the result columns, the case-history vocabulary, the `PropertyDetails.asp` value blocks, and the `/web/Decisions/{YYYY}/{DOCKET}.pdf` pattern. The statutory rule and its Cook-County second leg are cited to source.

**Synthetic**: every matter under `fixture/` is invented. The docket numbers do not exist, the parties are fictional, and the PINs are made up except one shape borrowed from a real closed 2004 case. Nothing here is a real person's tax matter.

---

## Offline: the full pipeline in three commands

```bash
cp -R samples/fixture /tmp/ptab-ws && node scripts/detect_changes.mjs /tmp/ptab-ws --snapshot 2026-08-03 && node scripts/deadline_engine.mjs /tmp/ptab-ws --today 2026-08-03 && node scripts/compile_digest.mjs /tmp/ptab-ws --today 2026-08-03 --open
```

The fixture is a workspace with last week's baseline at `snapshots/2026-07-27/matters/` and this week's state at `matters/`. Expected:

```
events:     13     (decision_issued 3 · status_change 4 · hearing_scheduled 2
                    valuation_change 2 · new_filing 1 · case_history_entry 1)
deadlines:  2 expired · 0 critical · 1 warning · 1 watch · 1 needs input
matters:    5      4 changed
```

### What each matter proves

| Docket | County | Proves |
|---|---|---|
| `2026-01234` | Cook | BOR total drops 412,000 → 398,000 (`valuation_change`), hearing gets set (`hearing_scheduled`), a county stipulation lands. Notice date only, no transmittal date → **`basis: "partial"`**, the conservative earlier date, `township_transmit_date` named as missing |
| `2026-02001` | Tazewell | Case closes, PTAB total appears, decision PDF resolves → three `decision_issued` observations from three distinct sources, all kept. Notice 2026-06-04 → day 30 is Sat **July 4** → **rolls to Mon 2026-07-06** |
| `2026-03050` | DuPage | Absent last week → `new_filing`. Notice 2026-07-24 → day 30 is Sun 2026-08-23 → **rolls to Mon 2026-08-24** |
| `2025-04120` | Cook | Both legs known. Notice 2026-04-30 + 30 = May 30; transmittal 2026-05-02 + 30 = June 1 → **the later leg governs**, then rolls off Sat 2026-05-30 to Mon 2026-06-01. Expired, and still in the digest — a matter does not vanish because its window closed |
| `2026-05099` | Lake | No trigger date at all → **no deadline emitted**, `band: needs_input`. Its case history carries a phrase outside PTAB's known vocabulary, which lands as `case_history_entry` rather than being dropped |

### The ledger

```bash
node scripts/detect_changes.mjs /tmp/ptab-ws --verify
```

Then try to break it:

```bash
node -e 'const f="/tmp/ptab-ws/ledger.jsonl",fs=require("fs");const L=fs.readFileSync(f,"utf8").trim().split("\n");const e=JSON.parse(L[3]);e.after=999999;L[3]=JSON.stringify(e);fs.writeFileSync(f,L.join("\n")+"\n")'
```

Verification now fails on **line 4** specifically, and `detect_changes.mjs` refuses to append to a broken chain (exit 2). Re-running an unmodified sweep on the same day appends **zero** entries — the sweep is idempotent, so a retry after a network failure is safe.

---

## Live: what to point a real sweep at

Every query below is a plain GET. Build them with `ptab_urls.mjs` rather than by hand — it normalizes the three docket-number forms.

```bash
node scripts/ptab_urls.mjs --docket 04-01668     # → all three forms + the decision PDF URL
```

| Watch | Query | Verified volume (2026-08-05) |
|---|---|---|
| Attorney | `AdvancedSearch.asp?AttyLName=Smith&Dockets=A` | 190 records — the high-signal watch |
| County + year | `AdvancedSearch.asp?County=Cook&TaxYR=2021&Dockets=A` | 39,126 records — a firehose; narrow it |
| Docket | `property.asp?docketno=04-01668` | Parties, case history, PINs, attorney |
| Property | `PropertyDetails.asp?proppin=10-10-11-108-008&docketno=2004-01668-001` | BOR 35,640 · appellant 9,670 · PTAB 31,167 · hearing 1/30/2007 |
| Decision | `/web/Decisions/2004/2004-01668.pdf` | 200, `application/pdf`, ~59 KB |

Copy `watchlists/example.json` to `watchlists/<firm>.json` and fill it in. Running `ptab_urls.mjs` against the unedited template rejects all five watches by design — an empty watch matches the whole database, and a skipped watch is a blind spot rather than a silent no-op.

The eFiling portal is not on this list and never will be. Monitoring is read-only; filing is a person.
