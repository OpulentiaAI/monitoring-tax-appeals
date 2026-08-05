#!/usr/bin/env node
/**
 * detect_changes.mjs — diff this sweep against the last one, append to the ledger.
 *
 *   node detect_changes.mjs <WORKSPACE> --snapshot YYYY-MM-DD
 *   node detect_changes.mjs <WORKSPACE> --verify
 *
 * Reads   {WORKSPACE}/matters/*.json                 current state
 *         {WORKSPACE}/snapshots/{prev}/matters/*.json baseline
 * Writes  {WORKSPACE}/ledger.jsonl                   append-only, hash-chained
 *         {WORKSPACE}/snapshots/{today}/matters/     baseline for next week
 *         {WORKSPACE}/snapshots/{today}/events.jsonl this sweep's events
 *
 * The ledger is never edited. A correction is a new entry referencing the old
 * one. Re-running a sweep on the same day emits nothing — events are keyed.
 */

import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const GENESIS = "genesis";

/** PTAB writes case-history descriptions from a fixed vocabulary. Substring match, first hit wins. */
const HISTORY_VOCABULARY = [
  [/new appeal received/i, "new_filing"],
  [/hearing scheduled/i, "hearing_scheduled"],
  [/case closed on/i, "decision_issued"],
  [/acknowledgment letter was sent/i, "status_change"],
  [/evidence received/i, "status_change"],
  [/filing (is )?complete/i, "status_change"],
  [/extension (request|for)/i, "status_change"],
  [/notes on appeal form received/i, "status_change"],
  [/possible stipulation received/i, "status_change"],
  [/granted \d+ days to respond/i, "status_change"],
  [/rebuttal period begins/i, "status_change"],
];

/** Anything unmatched still reaches the ledger. Silent classification loss is the one unacceptable failure. */
export function classifyHistory(description) {
  for (const [pattern, type] of HISTORY_VOCABULARY) {
    if (pattern.test(String(description || ""))) return type;
  }
  return "case_history_entry";
}

const DISMISSAL = /dismiss|withdraw|no jurisdiction|lack of jurisdiction/i;

/** Canonical JSON so the same object always hashes the same. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export const hashEntry = (entry) => {
  const { hash, ...rest } = entry;
  return createHash("sha256").update(canonical(rest)).digest("hex");
};

function readLedger(workspace) {
  const path = join(workspace, "ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`ledger.jsonl line ${i + 1} is not valid JSON — the chain cannot be verified. Do not repair it in place; escalate.`);
      }
    });
}

export function verifyChain(entries) {
  const problems = [];
  let prev = GENESIS;
  entries.forEach((entry, i) => {
    const line = i + 1;
    if (entry.seq !== i + 1) problems.push(`line ${line}: seq is ${entry.seq}, expected ${i + 1}`);
    if (entry.prev_hash !== prev) problems.push(`line ${line}: prev_hash does not match the previous entry's hash`);
    const expected = hashEntry(entry);
    if (entry.hash !== expected) problems.push(`line ${line}: hash mismatch — entry content changed after it was written`);
    prev = entry.hash;
  });
  return problems;
}

// ---------- diffing ----------

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const VALUE_FIELDS = ["values.bor.total", "values.appellant.total", "values.ptab.total"];
const STATUS_FIELDS = ["status.county_status", "status.decision_type", "status.hearing_status"];

function historyKey(row) {
  return `${row.transaction_date}|${row.description}`;
}

export function diffMatter(before, after) {
  const events = [];
  const source = after.source_urls?.details || after.source_urls?.docket || null;

  if (!before) {
    events.push({ type: "new_filing", field: null, before: null, after: after.docket, source_url: after.source_urls?.docket ?? null });
    // A brand-new matter's history is context, not a week's worth of change events.
    return events;
  }

  for (const field of VALUE_FIELDS) {
    const b = num(get(before, field));
    const a = num(get(after, field));
    if (b !== a) events.push({ type: "valuation_change", field, before: b, after: a, source_url: source });
  }

  for (const field of STATUS_FIELDS) {
    const b = get(before, field) ?? null;
    const a = get(after, field) ?? null;
    if (b !== a) events.push({ type: "status_change", field, before: b, after: a, source_url: source });
  }

  const hearingBefore = get(before, "hearing.datetime") ?? null;
  const hearingAfter = get(after, "hearing.datetime") ?? null;
  if (hearingBefore !== hearingAfter && hearingAfter !== null) {
    events.push({ type: "hearing_scheduled", field: "hearing.datetime", before: hearingBefore, after: hearingAfter, source_url: source });
  }

  const closeBefore = get(before, "status.close_date") ?? null;
  const closeAfter = get(after, "status.close_date") ?? null;
  if (closeBefore !== closeAfter && closeAfter !== null) {
    const reason = String(get(after, "status.reason_closed") || "");
    events.push({
      type: DISMISSAL.test(reason) ? "dismissal" : "decision_issued",
      field: "status.close_date",
      before: closeBefore,
      after: `${closeAfter} — ${reason || "reason not stated"}`,
      source_url: source,
    });
  }

  const pdfBefore = get(before, "decision_pdf.path") ?? null;
  const pdfAfter = get(after, "decision_pdf.path") ?? null;
  if (!pdfBefore && pdfAfter) {
    events.push({ type: "decision_issued", field: "decision_pdf", before: null, after: pdfAfter, source_url: get(after, "decision_pdf.url") ?? null });
  }

  const seen = new Set((before.case_history || []).map(historyKey));
  for (const row of after.case_history || []) {
    if (seen.has(historyKey(row))) continue;
    events.push({
      type: classifyHistory(row.description),
      field: "case_history",
      before: null,
      after: `${row.transaction_date}: ${row.description}`,
      source_url: after.source_urls?.docket ?? null,
    });
  }

  return events;
}

// ---------- CLI ----------

const argv = process.argv.slice(2);
const WORKSPACE = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

if (!WORKSPACE) {
  console.error("usage: node detect_changes.mjs <WORKSPACE> [--snapshot YYYY-MM-DD | --verify]");
  process.exit(1);
}

if (argv.includes("--verify")) {
  let entries;
  try {
    entries = readLedger(WORKSPACE);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (entries.length === 0) {
    console.log("ledger: empty (no entries yet) — chain OK");
    process.exit(0);
  }
  const problems = verifyChain(entries);
  if (problems.length) {
    console.error(`CHAIN VERIFICATION FAILED — ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    console.error("\nStop the run. Do not append, do not publish, do not rewrite the ledger to make it validate.");
    process.exit(2);
  }
  console.log(`ledger: ${entries.length} entries, chain verified (head ${entries.at(-1).hash.slice(0, 12)}…)`);
  process.exit(0);
}

const SNAPSHOT = flag("--snapshot") || new Date().toISOString().slice(0, 10);
const MATTERS = join(WORKSPACE, "matters");
if (!existsSync(MATTERS)) {
  console.error(`No matters/ under ${WORKSPACE} — run a sweep first.`);
  process.exit(1);
}

// Verify before appending. A broken chain stops everything.
const existing = readLedger(WORKSPACE);
const chainProblems = verifyChain(existing);
if (chainProblems.length) {
  console.error(`CHAIN VERIFICATION FAILED (${chainProblems.length} problem(s)) — refusing to append.`);
  for (const p of chainProblems.slice(0, 10)) console.error(`  ${p}`);
  process.exit(2);
}

const SNAPSHOT_DIR = join(WORKSPACE, "snapshots");
const previous = !existsSync(SNAPSHOT_DIR)
  ? null
  : readdirSync(SNAPSHOT_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < SNAPSHOT)
      .filter((d) => existsSync(join(SNAPSHOT_DIR, d, "matters")) && statSync(join(SNAPSHOT_DIR, d, "matters")).isDirectory())
      .sort()
      .at(-1) || null;

const loadDir = (dir) => {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    out.set(file.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, file), "utf-8")));
  }
  return out;
};

const current = loadDir(MATTERS);
const baseline = previous ? loadDir(join(SNAPSHOT_DIR, previous, "matters")) : new Map();

// Re-running the same sweep must be a no-op.
const alreadyLogged = new Set(
  existing.filter((e) => e.snapshot === SNAPSHOT).map((e) => `${e.docket}|${e.type}|${e.field}|${canonical(e.before)}|${canonical(e.after)}`),
);

const observedAt = new Date(`${SNAPSHOT}T00:00:00Z`).toISOString();
let seq = existing.length;
let prevHash = existing.length ? existing.at(-1).hash : GENESIS;
const appended = [];

for (const [docket, matter] of [...current.entries()].sort()) {
  for (const event of diffMatter(baseline.get(docket) || null, matter)) {
    const key = `${docket}|${event.type}|${event.field}|${canonical(event.before)}|${canonical(event.after)}`;
    if (alreadyLogged.has(key)) continue;
    alreadyLogged.add(key);
    seq += 1;
    const entry = {
      seq,
      observed_at: matter.observed_at || observedAt,
      snapshot: SNAPSHOT,
      docket,
      type: event.type,
      field: event.field,
      before: event.before,
      after: event.after,
      source_url: event.source_url,
      prev_hash: prevHash,
    };
    entry.hash = hashEntry(entry);
    prevHash = entry.hash;
    appended.push(entry);
  }
}

if (appended.length) {
  appendFileSync(join(WORKSPACE, "ledger.jsonl"), appended.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// Snapshot current state as next week's baseline, and record this sweep's events.
const snapshotMatters = join(SNAPSHOT_DIR, SNAPSHOT, "matters");
mkdirSync(snapshotMatters, { recursive: true });
for (const [docket, matter] of current) {
  writeFileSync(join(snapshotMatters, `${docket}.json`), JSON.stringify(matter, null, 2) + "\n");
}
writeFileSync(
  join(SNAPSHOT_DIR, SNAPSHOT, "events.jsonl"),
  appended.map((e) => JSON.stringify(e)).join("\n") + (appended.length ? "\n" : ""),
);

const byType = appended.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] || 0) + 1 }), {});
console.log(
  [
    `baseline:   ${previous || "(none — first sweep, everything is new_filing)"}`,
    `matters:    ${current.size}`,
    `events:     ${appended.length}`,
    ...Object.entries(byType).sort().map(([t, n]) => `  ${t.padEnd(20)} ${n}`),
    `ledger:     ${seq} entries, head ${prevHash === GENESIS ? "genesis" : prevHash.slice(0, 12) + "…"}`,
  ].join("\n"),
);
