# PTAB surfaces

Every endpoint the skill reads, verified against `ptab.illinois.gov` on 2026-08-05. All of it is public: no login, no form driving, every page addressable by URL. Read it through the browser session — see [Acquisition](#acquisition). Re-verify this file when a sweep fails identically across watches; that is cheaper than re-deriving the shapes every run.

## The map

| Surface | URL | Returns |
|---|---|---|
| Advanced search | `/asi/AdvancedSearch.asp` | Paginated docket list — the sweep workhorse |
| Docket lookup | `/asi/property.asp?docketno={YY-NNNNN}` | Parties, county/township, type/class, **case history**, PINs, attorney, intervenors, decision link |
| PIN lookup | `/asi/PropertyPIN.asp?PropPin={PIN}` | Every docket filed against a parcel |
| Property details | `/asi/PropertyDetails.asp?proppin={PIN}&docketno={FULL-DOCKET}` | BOR / appellant / PTAB values, county status, decision type, hearing date and location |
| Signed decision | `/web/Decisions/{YYYY}/{FULL-DOCKET}.pdf` | The signed decision PDF |
| eFiling portal | `/efile/` | **Out of scope. Never touch it.** |

## Advanced search

```
https://ptab.illinois.gov/asi/AdvancedSearch.asp
  ?LName=&FName=&AttyLName=&FirmName=&County=&Township=&TaxYR=&Dockets=A
```

All eight parameters are always present; empty ones are omitted from matching. `Dockets` is `A` (all), `O` (open), `C` (closed).

**Result columns**: `Docket | Last Name | First Name | Attorney | County | Township | Close Date`. When the query includes `AttyLName` or `FirmName`, the third column becomes `Firm Name` instead of `First Name` — **parse by header, not by position.**

**Pagination**: 50 rows per page, with `First Page | Prev Page | Next Page | Last Page` controls and a `Results | 1 to 50 of N Records` line. Read `N` from that line before paginating; it tells you immediately whether the watch is too broad.

**Verified volumes** (2026-08-05): `County=Cook&TaxYR=2021&Dockets=A` → 39,126 records. `AttyLName=Smith&Dockets=A` → 190. An attorney or firm watch is the high-signal one; a bare county+year watch is a firehose.

**Empty result**: the page renders `No records found!` with a Back to Search link. That is a valid response, not an error — the most common causes are an over-narrow township, a tax year before 1999 (ASI's data floor), or a county spelling mismatch.

**Docket number has two forms.** Result links use `property.asp?docketno=04-01668` (two-digit year); the page displays `2004-01668`; `PropertyDetails.asp` wants the full form with a sub-index, `2004-01668-001`. `ptab_urls.mjs` normalizes between them — do not do it by hand.

## Docket lookup

`/asi/property.asp?docketno={YY-NNNNN}` returns, in order:

1. `Information for Docket No: {full docket}`
2. Appellant — first/last name, street, city/state, ZIP
3. County, Township, Type (`R` residential, `C`, `I`, `F`), Class
4. **Case History** — `Transaction Date | Transaction Description | Received/Letter Date`
5. **Property Details** — `PIN | Multiple Year Filings | Close Date | Reason`
6. Appellant attorney — name, firm, address, phone
7. Intervenor(s), or a line stating there are none

On a closed case, the close row carries an inline link to the decision PDF.

### Case history vocabulary

PTAB writes these from a fixed vocabulary. Store the phrase **verbatim** in the matter record and map it to a type for the digest. Observed phrases and their mappings:

| Phrase (substring match) | Change type |
|---|---|
| `new appeal received` | `new_filing` |
| `acknowledgment letter was sent` | `status_change` |
| `evidence received` | `status_change` |
| `filing complete` / `filing is complete` | `status_change` |
| `extension request` / `extension for` | `status_change` |
| `Notes on Appeal form received` | `status_change` |
| `possible stipulation received` | `status_change` — flag it; a stipulation often ends the matter |
| `granted 30 days to respond` | `status_change` — starts a response clock |
| `rebuttal period begins` | `status_change` — starts a rebuttal clock |
| `Hearing Scheduled` | `hearing_scheduled` |
| `Case closed on {date}` | `decision_issued` or `dismissal`, per close reason |

**Anything unmatched becomes `case_history_entry`** and still reaches the ledger and the digest. Silent classification loss is the one failure this vocabulary table must never cause. When you see a new phrase, add it here.

## Property details

`/asi/PropertyDetails.asp?proppin={PIN}&docketno={FULL-DOCKET}` is where the numbers live:

```
Board of Review     Land | Improvements | Farm Land | Farm Building | BOR Total
Appellant           Land | Improvements | Farm Land | Farm Building | Appellant Total
PTAB Assessed Value PTAB Total
PTAB Information    County Status | Decision Type | Close Date | Reason Closed | Hearing Status
Hearing Information Hearing Date/Time | Hearing Site/Location
```

Every one of these is a diff target. `BOR Total`, `Appellant Total`, and `PTAB Total` drive `valuation_change`; `County Status`, `Decision Type`, and `Hearing Status` drive `status_change`; `Hearing Date/Time` drives `hearing_scheduled`.

Values are formatted with thousands separators (`35,640`) — strip them before comparing, or every sweep reports a spurious change. Empty fields render as `&nbsp;` and must normalize to `null`, not `"0"`. A zero assessment and an unreported assessment are different facts.

Verified example: docket `2004-01668`, PIN `10-10-11-108-008` — BOR total 35,640, appellant total 9,670, PTAB total 31,167, hearing 1/30/2007 10:00 AM, closed 12/21/2007 "Decision with Hearing".

## Signed decisions

```
https://ptab.illinois.gov/web/Decisions/{YYYY}/{FULL-DOCKET}.pdf
```

`{YYYY}` is the docket's four-digit year, not the decision year. Verified: `/web/Decisions/2004/2004-01668.pdf` → 200, `application/pdf`, ~59 KB.

**Take the PDF as a download, and prefer the link over the pattern.** On a closed case the close row on `property.asp` carries an inline link to the decision. Click that link, let the download land in the session, then pull the bytes with `get_downloads` and write them to `decisions/{docket}.pdf`. The URL pattern above is the fallback for when the inline link is missing: `navigate` to it and the same download path applies.

The difference matters because a constructed URL that happens to 404 and a decision that genuinely is not posted yet look identical from the outside. The link is the site telling you the decision exists. The pattern is you guessing.

Record byte size and SHA-256 in the matter record, computed from the file on disk after the download completes. Verify the content type is `application/pdf` before hashing — an interstitial or an error page saved under a `.pdf` name hashes perfectly well and is worthless.

Once, ever. A signed decision does not change, so a second download is waste and a hash mismatch on one is worth surfacing rather than overwriting.

A 404 or a missing link on a closed case means the decision is not posted yet. Record `decision_pdf: null` and let the next sweep find it.

## PIN lookup

`/asi/PropertyPIN.asp?PropPin={PIN}` returns `PIN # | Docket No | Last Name` — every filing against that parcel across tax years. This is the watch that catches a matter filed by someone else on a property you track.

## Acquisition

Every page and every PDF comes through the browser session. `browser_manage` is the surface:

| Step | Action |
|---|---|
| Open the sweep | `start` — one session for the whole sweep |
| Load a page | `navigate` to the URL from `ptab_urls.mjs` |
| Take the HTML | `get_content`, written straight to `snapshots/{date}/raw/` |
| Page forward | `click` the `Next Page` control |
| Take a decision | `click` the inline decision link, then `get_downloads` |
| Prove a surface | `screenshot` |
| Close the sweep | end the session, including on the failure path |

Chain `navigate` and `get_content` in one `batch` call per page. One page is one round-trip, and the budget in `workflow.md` counts it that way.

Why the browser rather than a plain GET. The PDFs are the reason: a decision arrives as a download, and the session's download bucket is the surface that hands you the bytes with their real content type. The list pages come along for the ride, and taking them the same way means the sweep holds one session, one cookie jar, and one place to look when a page comes back wrong. The `screenshot` action is also what makes a parse failure diagnosable a week later.

One session, reused across every request, released when the sweep ends. The concurrency here is 1 by design, because the pacing below is the point.

## Rate and access discipline

- Public state service. Sequential requests, ~2–3 seconds apart, one sweep per week.
- Stop on the first 5xx or interstitial rather than retrying into it. End the session and report the partial sweep.
- Cache raw HTML under `snapshots/{date}/raw/` and PDFs under `decisions/`. Re-parse freely; re-fetch never.
- **The eFiling portal is not a surface.** Attorney-represented appeals have gone through it since 2023-07-01, it is credentialed and captcha-protected, and this skill has no business there. A browser session makes that boundary easier to cross by accident, so it is an invariant rather than a preference.

## Related sources

- Rules of practice: **86 Ill. Adm. Code 1910** (JCAR). Blocks automated fetches — read it in a browser, cite it by section.
- Board of Review Notes on Appeal forms: `/PDF/ptab6.pdf` (residential), `/PDF/PTAB6C.pdf` (commercial), `/PDF/PTAB6I.pdf` (industrial).
- eFiling user guide: `/PDF/EfilingGuide.pdf` — reference for the human who files, not for the skill.
