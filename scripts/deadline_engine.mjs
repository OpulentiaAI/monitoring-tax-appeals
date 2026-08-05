#!/usr/bin/env node
/**
 * deadline_engine.mjs — the 30-day window under 35 ILCS 200/16-160.
 *
 *   node deadline_engine.mjs <WORKSPACE> [--today YYYY-MM-DD]
 *   node deadline_engine.mjs --check Cook 2026-07-15 --transmit 2026-07-22
 *
 * Reads   {WORKSPACE}/matters/*.json  (bor_decision.notice_date, .township_transmit_date)
 * Writes  {WORKSPACE}/alerts.json
 *
 * Every output carries verify: true. Nothing here is legal advice — it is a
 * computation with its inputs shown. See references/deadlines-and-routing.md.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WINDOW_DAYS = 30;

/** Counties of 3,000,000+ get the second statutory leg. Cook is the only one. */
const TWO_LEG_COUNTIES = new Set(["cook"]);

/**
 * Illinois holidays used for the weekend/holiday roll under 5 ILCS 70/1.11.
 * Data, not logic — edit this list rather than the function below.
 * General Election Day (even years) is deliberately absent; see flagElectionDay().
 */
const FIXED_HOLIDAYS = [
  [1, 1, "New Year's Day"],
  [2, 12, "Lincoln's Birthday"],
  [6, 19, "Juneteenth"],
  [7, 4, "Independence Day"],
  [11, 11, "Veterans Day"],
  [12, 25, "Christmas Day"],
];
const FLOATING_HOLIDAYS = [
  [1, 1, 3, "Martin Luther King Jr. Day"], // month, weekday(Mon=1), nth
  [2, 1, 3, "Washington's Birthday"],
  [9, 1, 1, "Labor Day"],
  [10, 1, 2, "Columbus Day"],
  [11, 4, 4, "Thanksgiving Day"],
];

const iso = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** Memorial Day = last Monday in May. */
function lastMondayOfMay(year) {
  const d = new Date(Date.UTC(year, 4, 31));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

/** nth given weekday of a month, e.g. 3rd Monday of January. */
function nthWeekday(year, month, weekday, nth) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday % 7) {
      count += 1;
      if (count === nth) return iso(d);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export function holidaysFor(year) {
  const map = new Map();
  for (const [month, day, name] of FIXED_HOLIDAYS) {
    const d = new Date(Date.UTC(year, month - 1, day));
    map.set(iso(d), name);
    // A fixed-date holiday on Sunday is observed the following Monday.
    if (d.getUTCDay() === 0) map.set(iso(addDays(d, 1)), `${name} (observed)`);
  }
  for (const [month, weekday, nth, name] of FLOATING_HOLIDAYS) {
    map.set(nthWeekday(year, month, weekday, nth), name);
  }
  map.set(lastMondayOfMay(year), "Memorial Day");
  return map;
}

const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** Roll forward past weekends and holidays; rolls repeatedly (Fri holiday → Monday). */
export function rollForward(date) {
  let d = date;
  let guard = 0;
  while (guard++ < 14) {
    const holidays = holidaysFor(d.getUTCFullYear());
    if (!isWeekend(d) && !holidays.has(iso(d))) return d;
    d = addDays(d, 1);
  }
  return d;
}

/** Early November of an even year may hit General Election Day, which isn't in the table. */
function flagElectionDay(date) {
  const year = date.getUTCFullYear();
  if (year % 2 !== 0 || date.getUTCMonth() !== 10) return null;
  if (date.getUTCDate() > 8) return null;
  return "Lands in early November of an even year — General Election Day is an Illinois holiday and is not in the roll table. Check the date manually.";
}

/**
 * One leg: 30 days from a trigger, counted per 5 ILCS 70/1.11 — exclude the
 * first day, include the last — then rolled off weekends and holidays.
 */
export function computeLeg(triggerDate) {
  const trigger = parseDate(triggerDate);
  if (!trigger) return null;
  const raw = addDays(trigger, WINDOW_DAYS);
  const rolled = rollForward(raw);
  return {
    trigger: iso(trigger),
    raw_deadline: iso(raw),
    deadline: iso(rolled),
    rolled_from: iso(rolled) === iso(raw) ? null : iso(raw),
  };
}

export function computeDeadline({ county, notice_date, township_transmit_date, today }) {
  const twoLeg = TWO_LEG_COUNTIES.has(String(county || "").trim().toLowerCase());
  const rule = twoLeg
    ? "35 ILCS 200/16-160 (county ≥ 3,000,000 — later of notice or township transmittal)"
    : "35 ILCS 200/16-160 (county < 3,000,000 — 30 days from written notice)";

  const noticeLeg = computeLeg(notice_date);
  const transmitLeg = twoLeg ? computeLeg(township_transmit_date) : null;

  if (!noticeLeg && !transmitLeg) {
    return {
      rule,
      legs: { notice_date: notice_date ?? null, notice_deadline: null, township_transmit_date: township_transmit_date ?? null, transmit_deadline: null },
      deadline: null,
      basis: "none",
      missing: twoLeg ? ["notice_date", "township_transmit_date"] : ["notice_date"],
      band: "needs_input",
      verify: true,
      note: "No statutory trigger date on record. PTAB's public pages do not carry it — it comes off the Board of Review notice. No deadline computed, and no fallback exists.",
    };
  }

  const missing = [];
  if (!noticeLeg) missing.push("notice_date");
  if (twoLeg && !transmitLeg) missing.push("township_transmit_date");

  // Both legs → the later governs. One leg → that one, conservatively.
  let chosen = noticeLeg;
  if (transmitLeg && (!noticeLeg || transmitLeg.deadline > noticeLeg.deadline)) chosen = transmitLeg;

  const basis = missing.length === 0 ? "full" : "partial";
  const todayDate = parseDate(today) || new Date();
  const daysRemaining = Math.round((parseDate(chosen.deadline) - todayDate) / 86400000);

  const notes = [];
  if (basis === "partial" && twoLeg) {
    notes.push("Cook matter computed from one leg only. The other leg may extend this date — confirm with the county before relying on it.");
  }
  const election = flagElectionDay(parseDate(chosen.deadline));
  if (election) notes.push(election);

  return {
    rule,
    legs: {
      notice_date: noticeLeg?.trigger ?? null,
      notice_deadline: noticeLeg?.deadline ?? null,
      township_transmit_date: transmitLeg?.trigger ?? null,
      transmit_deadline: transmitLeg?.deadline ?? null,
    },
    deadline: chosen.deadline,
    basis,
    missing,
    rolled_from: chosen.rolled_from,
    days_remaining: daysRemaining,
    band: band(daysRemaining),
    verify: true,
    note: notes.join(" ") || null,
  };
}

export function band(days) {
  if (days === null || days === undefined) return "needs_input";
  if (days < 0) return "expired";
  if (days <= 7) return "critical";
  if (days <= 14) return "warning";
  if (days <= 30) return "watch";
  return "clear";
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

if (argv[0] === "--check") {
  // node deadline_engine.mjs --check <County> <notice-date> [--transmit <date>] [--today <date>]
  const result = computeDeadline({
    county: argv[1],
    notice_date: argv[2],
    township_transmit_date: flag("--transmit"),
    today: flag("--today"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const WORKSPACE = argv[0];
if (!WORKSPACE) {
  console.error("usage: node deadline_engine.mjs <WORKSPACE> [--today YYYY-MM-DD]");
  console.error("       node deadline_engine.mjs --check <County> <notice-date> [--transmit <date>]");
  process.exit(1);
}

const MATTERS = join(WORKSPACE, "matters");
if (!existsSync(MATTERS)) {
  console.error(`No matters/ directory under ${WORKSPACE} — run a sweep first.`);
  process.exit(1);
}

const today = flag("--today") || iso(new Date());
const alerts = [];
for (const file of readdirSync(MATTERS).filter((f) => f.endsWith(".json")).sort()) {
  const matter = JSON.parse(readFileSync(join(MATTERS, file), "utf-8"));
  const bor = matter.bor_decision || {};
  const computed = computeDeadline({
    county: matter.property?.county,
    notice_date: bor.notice_date,
    township_transmit_date: bor.township_transmit_date,
    today,
  });
  alerts.push({ docket: matter.docket, county: matter.property?.county ?? null, ...computed });
}

const ORDER = { expired: 0, critical: 1, warning: 2, watch: 3, needs_input: 4, clear: 5 };
alerts.sort((a, b) => (ORDER[a.band] - ORDER[b.band]) || (a.days_remaining ?? 9e9) - (b.days_remaining ?? 9e9));

writeFileSync(join(WORKSPACE, "alerts.json"), JSON.stringify({ computed_at: today, alerts }, null, 2) + "\n");

const counts = alerts.reduce((acc, a) => ({ ...acc, [a.band]: (acc[a.band] || 0) + 1 }), {});
console.log(
  [
    `matters:     ${alerts.length}`,
    `expired:     ${counts.expired || 0}`,
    `critical:    ${counts.critical || 0}`,
    `warning:     ${counts.warning || 0}`,
    `watch:       ${counts.watch || 0}`,
    `needs input: ${counts.needs_input || 0}`,
    ``,
    `${join(WORKSPACE, "alerts.json")}`,
    `All deadlines carry verify: true — a human confirms before any of them reaches a calendar.`,
  ].join("\n"),
);
