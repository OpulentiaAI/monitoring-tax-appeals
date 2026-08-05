# Deadlines and routing

The one part of this skill where being confidently wrong is worse than being silent. Read it before touching `deadline_engine.mjs`.

**Nothing here is legal advice.** It is a computation with its inputs shown, and every output carries `verify: true` until a human confirms it.

---

## The 30-day rule has two forms

Under **35 ILCS 200/16-160**, the window to appeal a Board of Review decision to PTAB depends on county population, and the difference is not cosmetic.

### Counties under 3,000,000 — every county except Cook

> within 30 days after the date of written notice of the decision of the board of review

One leg. One input: the **written-notice date on the notice itself**.

### Counties of 3,000,000 or more — Cook County

> within 30 days after the date of the board of review notice **or** within 30 days after the date that the board of review transmits to the county assessor … its final action on the township in which the property is located, **whichever is later**

Two legs, and the later one governs. A Cook matter computed from the notice date alone can produce a deadline **earlier than the law allows** — which is survivable — but treating the notice leg as the only leg also means you will report an expired window on a matter that is still live. That is a real harm: the matter gets dropped.

**The engine encodes this as a county rule, not a global one.** `county: "Cook"` enables the second leg; everything else uses the single leg. Do not "simplify" this.

## Counting the days

**5 ILCS 70/1.11** governs the arithmetic:

> The time within which any act provided by law is to be done shall be computed by excluding the first day and including the last, unless the last day is Saturday or Sunday or is a holiday … and then it shall also be excluded.

Three consequences the engine implements:

1. **Day 1 is the day after the trigger date.** A notice dated the 1st runs to the 31st, not the 30th.
2. **Calendar days, not business days.** Weekends inside the window count.
3. **The landing rolls.** If day 30 falls on a Saturday, Sunday, or holiday, the deadline moves to the next day that is none of those — and rolls again if that day is also excluded (a Friday holiday before a weekend rolls to Monday).

### Illinois holidays used for the roll

New Year's Day · Martin Luther King Jr. Day (3rd Mon Jan) · Lincoln's Birthday (Feb 12) · Washington's Birthday (3rd Mon Feb) · Memorial Day (last Mon May) · Juneteenth (Jun 19) · Independence Day (Jul 4) · Labor Day (1st Mon Sep) · Columbus Day (2nd Mon Oct) · Veterans Day (Nov 11) · Thanksgiving (4th Thu Nov) · Christmas (Dec 25)

A fixed-date holiday falling on Sunday is observed the following Monday; the engine rolls past both. General Election Day in even-numbered years is a state holiday and is **not** in the table — if a deadline lands in early November of an even year, the engine flags it for manual check rather than guessing.

The holiday set is data, not logic — it lives at the top of `deadline_engine.mjs` and is meant to be edited.

## What the engine will not do

- **No deadline from zero inputs.** No notice date, no output. It does not fall back to the PTAB filing date, the case-history date, or anything else on the public record. None of those are the statutory trigger.
- **No confident partial.** Cook matter with only the notice leg → `basis: "partial"`, the conservative earlier date, and `missing: ["township_transmit_date"]`. It never presents as confirmed.
- **No silent expiry.** A window that has closed emits `band: "expired"` and stays in the digest. A matter does not disappear because its deadline passed — that is precisely when someone needs to see it.
- **No postmark assumptions.** Whether a filing is timely on deposit or on receipt is a rule question this skill does not resolve. The engine reports the date; the filer manages the margin.

## Urgency bands

| Band | Days remaining | Digest treatment |
|---|---|---|
| `expired` | < 0 | Top of digest, flagged, never dropped |
| `critical` | 0–7 | Top of digest and first line of the chat summary |
| `warning` | 8–14 | Second block |
| `watch` | 15–30 | Listed, not alerted |
| `clear` | > 30 | Table only |

Inside 7 days, deadline ordering beats every other consideration — including a routing recommendation that scores better on the merits.

---

## Routing: Board of Review request or PTAB challenge

Two lanes with different clocks, evidence bars, and costs.

| | **Board of Review request** | **PTAB challenge** |
|---|---|---|
| Nature | Administrative reconsideration by the body that decided | Formal appeal to a separate state board |
| Evidence | Light — the error, the correction, supporting comps | Heavy — appraisal, comparable grids, exhibits, possible hearing |
| Cost / effort | Low | High |
| Clock | County BOR calendar, session-dependent | 30 days, jurisdictional, does not reopen |
| Best for | Factual or clerical error; characteristics wrong on the card; strong comps; BOR still in session | Genuine valuation dispute; BOR reconsideration exhausted or unavailable; appraisal in hand |
| Risk | Time spent while the PTAB clock runs | Cost and effort on a matter a phone call could have fixed |

### The ordering rule

**Deadline first, merits second.** A reconsideration request does not toll the 30-day PTAB window. If a BOR request is still pending when the window closes, the appeal is foreclosed — and the client's remedy is gone regardless of how good the case was.

So:

1. **Deadline inside 14 days** → the recommendation leads with preserving the PTAB filing, whatever the merits say. Pursuing both in parallel is a legitimate choice; letting the clock run on a reconsideration is not.
2. **Deadline beyond 14 days and the defect is factual** → BOR request first. It is cheaper, faster, and a correction there ends the matter.
3. **Deadline beyond 14 days and the dispute is valuation on the merits** → PTAB, and start assembling evidence now. The evidence phase is what the 30 days are actually for.
4. **Assessment gap below the county's practical threshold** → recommend neither, and say why with the number. Not every gap is worth a filing, and saying so is more useful than a ranked list of marginal matters.

### What a recommendation must contain

Never a bare verdict. Every routing output carries:

- `recommendation` — `bor_request` | `ptab_challenge` | `both` | `no_action`
- `because` — the specific facts driving it, each quoting a stored value or a case-history phrase
- `against` — the strongest argument the other way. If there isn't one, say so explicitly rather than omitting the field
- `deadline` — the computed window and its `basis`
- `unknowns` — every input that was missing, named

The `against` field is not decoration. An attorney reads it first to decide whether to trust the rest, and a recommendation that never argues against itself is a recommendation nobody checks.

---

## Sources

- **35 ILCS 200/16-160** — [Illinois General Assembly](https://www.ilga.gov/documents/legislation/ilcs/documents/003502000K16-160.htm) · [FindLaw](https://codes.findlaw.com/il/chapter-35-revenue/il-st-sect-35-200-16-160.html)
- **5 ILCS 70/1.11** — Statute on Statutes, computation of time
- **86 Ill. Adm. Code 1910** — PTAB rules of practice and procedure (JCAR; blocks automated fetches, read in a browser)
- **Board of Review Notes on Appeal** — [PTAB6 residential](https://www.ptab.illinois.gov/PDF/ptab6.pdf) · [PTAB6C commercial](https://www.ptab.illinois.gov/PDF/PTAB6C.pdf) · [PTAB6I industrial](https://www.ptab.illinois.gov/PDF/PTAB6I.pdf)

Statutes change. Re-verify the citations at the start of each tax year, and treat this file as the place that record lives.
