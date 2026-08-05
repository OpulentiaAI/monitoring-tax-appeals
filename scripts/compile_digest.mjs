#!/usr/bin/env node
/**
 * compile_digest.mjs — the Monday digest.
 *
 *   node compile_digest.mjs <WORKSPACE> [--today YYYY-MM-DD] [--open]
 *
 * Reads   {WORKSPACE}/matters/*.json
 *         {WORKSPACE}/alerts.json                    (deadline_engine.mjs)
 *         {WORKSPACE}/snapshots/{today}/events.jsonl (detect_changes.mjs)
 * Writes  {WORKSPACE}/digest.html
 *         {WORKSPACE}/matters.csv
 *         {WORKSPACE}/digest_summary.json
 *
 * Deadlines lead. Everything else is below them.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const WORKSPACE = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
if (!WORKSPACE) {
  console.error("usage: node compile_digest.mjs <WORKSPACE> [--today YYYY-MM-DD] [--open]");
  process.exit(1);
}

const TODAY = flag("--today") || new Date().toISOString().slice(0, 10);
const MATTERS = join(WORKSPACE, "matters");
if (!existsSync(MATTERS)) {
  console.error(`No matters/ under ${WORKSPACE} — run a sweep first.`);
  process.exit(1);
}

const matters = readdirSync(MATTERS)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(MATTERS, f), "utf-8")));

const alertsFile = join(WORKSPACE, "alerts.json");
const alerts = existsSync(alertsFile) ? JSON.parse(readFileSync(alertsFile, "utf-8")).alerts || [] : [];
const alertByDocket = new Map(alerts.map((a) => [a.docket, a]));

const eventsFile = join(WORKSPACE, "snapshots", TODAY, "events.jsonl");
const events = existsSync(eventsFile)
  ? readFileSync(eventsFile, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];
const eventsByDocket = events.reduce((acc, e) => {
  (acc[e.docket] ||= []).push(e);
  return acc;
}, {});

const BAND_ORDER = { expired: 0, critical: 1, warning: 2, watch: 3, needs_input: 4, clear: 5 };
const BAND_LABEL = {
  expired: "Expired", critical: "Critical", warning: "Warning",
  watch: "Watch", needs_input: "Needs input", clear: "Clear",
};
const TYPE_LABEL = {
  new_filing: "New filing", status_change: "Status", hearing_scheduled: "Hearing",
  decision_issued: "Decision", dismissal: "Dismissal", valuation_change: "Valuation",
  case_history_entry: "Case history",
};

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Quote every cell; neutralize spreadsheet formula injection from scraped text. */
function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const money = (n) => (n === null || n === undefined ? "—" : `$${Number(n).toLocaleString("en-US")}`);

function gapFor(matter) {
  const bor = matter.values?.bor?.total;
  const app = matter.values?.appellant?.total;
  if (bor === null || bor === undefined || app === null || app === undefined) return null;
  const gap = Number(bor) - Number(app);
  return { gap, percent: Number(bor) ? Math.round((gap / Number(bor)) * 1000) / 10 : null };
}

const rows = matters
  .map((matter) => {
    const alert = alertByDocket.get(matter.docket) || { band: "needs_input", deadline: null, days_remaining: null, basis: "none", verify: true };
    return {
      matter,
      alert,
      events: eventsByDocket[matter.docket] || [],
      gap: gapFor(matter),
    };
  })
  .sort((a, b) => {
    const band = BAND_ORDER[a.alert.band] - BAND_ORDER[b.alert.band];
    if (band !== 0) return band;
    const days = (a.alert.days_remaining ?? 9e9) - (b.alert.days_remaining ?? 9e9);
    if (days !== 0) return days;
    return b.events.length - a.events.length;
  });

const counts = {
  matters: rows.length,
  changed: rows.filter((r) => r.events.length).length,
  events: events.length,
  by_type: events.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] || 0) + 1 }), {}),
  by_band: rows.reduce((acc, r) => ({ ...acc, [r.alert.band]: (acc[r.alert.band] || 0) + 1 }), {}),
  needs_human: rows.filter((r) => r.alert.verify && ["expired", "critical", "warning"].includes(r.alert.band)).length,
};

// ---------- CSV ----------
const CSV = [
  ["docket", (r) => r.matter.docket],
  ["county", (r) => r.matter.property?.county],
  ["township", (r) => r.matter.property?.township],
  ["pins", (r) => (r.matter.property?.pins || []).join("; ")],
  ["appellant", (r) => [r.matter.appellant?.first_name, r.matter.appellant?.last_name].filter(Boolean).join(" ")],
  ["attorney", (r) => [r.matter.attorney?.first_name, r.matter.attorney?.last_name].filter(Boolean).join(" ")],
  ["firm", (r) => r.matter.attorney?.firm_name],
  ["bor_total", (r) => r.matter.values?.bor?.total],
  ["appellant_total", (r) => r.matter.values?.appellant?.total],
  ["ptab_total", (r) => r.matter.values?.ptab?.total],
  ["assessment_gap", (r) => r.gap?.gap],
  ["gap_percent", (r) => r.gap?.percent],
  ["county_status", (r) => r.matter.status?.county_status],
  ["hearing_status", (r) => r.matter.status?.hearing_status],
  ["hearing_datetime", (r) => r.matter.hearing?.datetime],
  ["close_date", (r) => r.matter.status?.close_date],
  ["reason_closed", (r) => r.matter.status?.reason_closed],
  ["deadline", (r) => r.alert.deadline],
  ["deadline_basis", (r) => r.alert.basis],
  ["days_remaining", (r) => r.alert.days_remaining],
  ["band", (r) => r.alert.band],
  ["verify_required", (r) => r.alert.verify],
  ["changes_this_sweep", (r) => r.events.length],
  ["decision_pdf", (r) => r.matter.decision_pdf?.path],
  ["docket_url", (r) => r.matter.source_urls?.docket],
];
writeFileSync(
  join(WORKSPACE, "matters.csv"),
  [CSV.map(([h]) => csvCell(h)).join(","), ...rows.map((r) => CSV.map(([, get]) => csvCell(get(r))).join(","))].join("\n") + "\n",
);

// ---------- HTML ----------
const eventLine = (e) => `
        <li class="event ev-${esc(e.type)}">
          <span class="etype">${esc(TYPE_LABEL[e.type] || e.type)}</span>
          <span class="ebody">${
            e.before !== null && e.before !== undefined && e.field !== "case_history"
              ? `${esc(e.field)}: <s>${esc(e.before)}</s> → <strong>${esc(e.after)}</strong>`
              : esc(e.after)
          }</span>
        </li>`;

const deadlineBlock = (a) => {
  if (!a.deadline) {
    return `<div class="dl needs_input"><span class="band">Needs input</span>
      <span class="dltext">No deadline computed — ${esc((a.missing || []).join(", ") || "no trigger date on record")}</span></div>`;
  }
  return `<div class="dl ${esc(a.band)}">
      <span class="band">${esc(BAND_LABEL[a.band] || a.band)}</span>
      <span class="dltext"><strong>${esc(a.deadline)}</strong> · ${a.days_remaining} days
      · basis <code>${esc(a.basis)}</code>${a.rolled_from ? ` · rolled from ${esc(a.rolled_from)}` : ""}
      ${a.verify ? '<span class="verify">verify</span>' : ""}</span>
      ${a.note ? `<p class="dlnote">${esc(a.note)}</p>` : ""}
    </div>`;
};

const card = (r) => {
  const m = r.matter;
  const name = [m.appellant?.first_name, m.appellant?.last_name].filter(Boolean).join(" ") || "—";
  return `
      <article class="card" data-band="${esc(r.alert.band)}" data-changed="${r.events.length ? "yes" : "no"}">
        <header>
          <div>
            <h2>${m.source_urls?.docket ? `<a href="${esc(m.source_urls.docket)}" target="_blank" rel="noopener">${esc(m.docket)}</a>` : esc(m.docket)}</h2>
            <p class="meta">${esc(name)} · ${esc(m.property?.county || "—")}${m.property?.township ? ` / ${esc(m.property.township)}` : ""}
            ${(m.property?.pins || []).length ? ` · PIN ${esc(m.property.pins[0])}` : ""}</p>
          </div>
          ${r.gap ? `<div class="gap"><span>${money(r.gap.gap)}</span><small>gap${r.gap.percent !== null ? ` · ${r.gap.percent}%` : ""}</small></div>` : ""}
        </header>
        ${deadlineBlock(r.alert)}
        <div class="vals">
          <span><b>BOR</b> ${money(m.values?.bor?.total)}</span>
          <span><b>Appellant</b> ${money(m.values?.appellant?.total)}</span>
          <span><b>PTAB</b> ${money(m.values?.ptab?.total)}</span>
          ${m.hearing?.datetime ? `<span><b>Hearing</b> ${esc(m.hearing.datetime.replace("T", " "))}</span>` : ""}
          ${m.status?.county_status ? `<span><b>Status</b> ${esc(m.status.county_status)}</span>` : ""}
        </div>
        ${r.events.length ? `<ul class="events">${r.events.map(eventLine).join("")}</ul>` : `<p class="quiet">No change this sweep.</p>`}
      </article>`;
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PTAB digest — week of ${esc(TODAY)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fbfbfa; --panel:#fff; --ink:#16161a; --muted:#6b6b76; --line:#e6e6e3; --sunk:#f4f4f1;
    --expired:#b3261e; --critical:#c2410c; --warning:#9a6b12; --watch:#3f6ea8; --ok:#1a7f5a;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#131315; --panel:#1a1a1d; --ink:#ececef; --muted:#9a9aa4; --line:#2a2a2f; --sunk:#202024;
            --expired:#f2857c; --critical:#f0985e; --warning:#d9a648; --watch:#7fb0e6; --ok:#4ec99a; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:24px; letter-spacing:-0.02em; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 8px; }
  .disclaimer { background:var(--sunk); border:1px solid var(--line); border-radius:8px;
                padding:10px 14px; color:var(--muted); font-size:13px; margin:16px 0 24px; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:24px; }
  .filters button { font:inherit; font-size:13px; padding:6px 12px; border-radius:999px;
    border:1px solid var(--line); background:var(--panel); color:var(--muted); cursor:pointer; }
  .filters button[aria-pressed="true"] { color:var(--ink); border-color:var(--ink); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:14px; }
  .card header { display:flex; gap:16px; justify-content:space-between; align-items:flex-start; }
  .card h2 { font-size:16px; margin:0 0 2px; font-variant-numeric:tabular-nums; }
  .card h2 a { color:inherit; text-decoration:none; border-bottom:1px solid var(--line); }
  .meta { margin:0; color:var(--muted); font-size:13px; }
  .gap { text-align:right; line-height:1.2; }
  .gap span { font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; }
  .gap small { display:block; font-size:11px; color:var(--muted); }
  .dl { display:flex; flex-wrap:wrap; align-items:baseline; gap:10px; margin:12px 0 0;
        padding:9px 12px; border-radius:8px; background:var(--sunk); border-left:3px solid var(--line); }
  .dl.expired { border-left-color:var(--expired); } .dl.critical { border-left-color:var(--critical); }
  .dl.warning { border-left-color:var(--warning); } .dl.watch { border-left-color:var(--watch); }
  .band { font-size:11px; text-transform:uppercase; letter-spacing:0.07em; font-weight:600; }
  .dl.expired .band { color:var(--expired); } .dl.critical .band { color:var(--critical); }
  .dl.warning .band { color:var(--warning); } .dl.watch .band { color:var(--watch); }
  .dl.needs_input .band { color:var(--muted); }
  .dltext { font-size:13px; color:var(--muted); }
  .dltext strong { color:var(--ink); font-variant-numeric:tabular-nums; }
  .verify { margin-left:6px; font-size:10px; text-transform:uppercase; letter-spacing:0.06em;
            border:1px solid var(--line); border-radius:999px; padding:1px 6px; }
  .dlnote { flex-basis:100%; margin:6px 0 0; font-size:12px; color:var(--muted); }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .vals { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; font-size:13px; color:var(--muted);
          font-variant-numeric:tabular-nums; }
  .vals b { color:var(--ink); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; }
  .events { list-style:none; margin:12px 0 0; padding:12px 0 0; border-top:1px solid var(--line); }
  .event { display:flex; gap:10px; align-items:baseline; padding:3px 0; font-size:13px; }
  .etype { flex:0 0 96px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); }
  .ev-decision_issued .etype, .ev-dismissal .etype { color:var(--critical); }
  .ev-hearing_scheduled .etype { color:var(--watch); }
  .ev-new_filing .etype { color:var(--ok); }
  .ebody s { color:var(--muted); }
  .quiet { margin:12px 0 0; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
  .empty { color:var(--muted); padding:40px 0; text-align:center; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>PTAB digest — week of ${esc(TODAY)}</h1>
    <p class="sub">${counts.matters} matters · ${counts.changed} changed · ${counts.events} events ·
      ${counts.by_band.expired || 0} expired · ${counts.by_band.critical || 0} critical · ${counts.by_band.warning || 0} warning</p>
    <p class="disclaimer"><strong>Every deadline below is a computation, not a confirmed date.</strong>
      Entries marked <em>verify</em> were derived from the dates on record under 35 ILCS 200/16-160 and must be
      confirmed against the Board of Review notice before anyone relies on them. Filing happens in the PTAB
      eFiling portal, by a person — nothing here files anything.</p>
    <div class="filters">
      <button data-filter="all" aria-pressed="true">All ${counts.matters}</button>
      <button data-filter="changed" aria-pressed="false">Changed ${counts.changed}</button>
      <button data-filter="expired" aria-pressed="false">Expired ${counts.by_band.expired || 0}</button>
      <button data-filter="critical" aria-pressed="false">Critical ${counts.by_band.critical || 0}</button>
      <button data-filter="warning" aria-pressed="false">Warning ${counts.by_band.warning || 0}</button>
      <button data-filter="needs_input" aria-pressed="false">Needs input ${counts.by_band.needs_input || 0}</button>
    </div>
    <main id="cards">${rows.map(card).join("")}
    </main>
    <p class="empty" id="empty" hidden>Nothing in this view.</p>
  </div>
<script>
  const buttons = [...document.querySelectorAll(".filters button")];
  const cards = [...document.querySelectorAll(".card")];
  const empty = document.getElementById("empty");
  buttons.forEach((btn) => btn.addEventListener("click", () => {
    const f = btn.dataset.filter;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    let shown = 0;
    cards.forEach((card) => {
      const match = f === "all" || (f === "changed" ? card.dataset.changed === "yes" : card.dataset.band === f);
      card.hidden = !match;
      if (match) shown += 1;
    });
    empty.hidden = shown > 0;
  }));
</script>
</body>
</html>
`;

writeFileSync(join(WORKSPACE, "digest.html"), html);
writeFileSync(
  join(WORKSPACE, "digest_summary.json"),
  JSON.stringify(
    {
      week_of: TODAY,
      counts,
      leading: rows
        .filter((r) => ["expired", "critical", "warning"].includes(r.alert.band))
        .slice(0, 10)
        .map((r) => ({
          docket: r.matter.docket,
          county: r.matter.property?.county ?? null,
          band: r.alert.band,
          deadline: r.alert.deadline,
          days_remaining: r.alert.days_remaining,
          basis: r.alert.basis,
          changes: r.events.length,
        })),
    },
    null,
    2,
  ) + "\n",
);

console.log(
  [
    `matters:   ${counts.matters}`,
    `changed:   ${counts.changed}`,
    `events:    ${counts.events}`,
    ...Object.entries(counts.by_type).sort().map(([t, n]) => `  ${t.padEnd(20)} ${n}`),
    `deadlines: ${counts.by_band.expired || 0} expired · ${counts.by_band.critical || 0} critical · ${counts.by_band.warning || 0} warning · ${counts.by_band.needs_input || 0} needs input`,
    ``,
    `${join(WORKSPACE, "digest.html")}`,
    `${join(WORKSPACE, "matters.csv")}`,
    `${join(WORKSPACE, "digest_summary.json")}`,
  ].join("\n"),
);

if (argv.includes("--open")) {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [join(WORKSPACE, "digest.html")], () => {});
}
