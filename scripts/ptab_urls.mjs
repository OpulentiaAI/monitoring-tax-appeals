#!/usr/bin/env node
/**
 * ptab_urls.mjs — turn a watchlist into the exact PTAB query URLs to fetch.
 *
 *   node ptab_urls.mjs <watchlist.json>            → queries.jsonl on stdout
 *   node ptab_urls.mjs --docket 2004-01668         → the three URLs for one matter
 *
 * Exists so nobody hand-assembles an ASI URL. Docket numbers appear in three
 * different forms across PTAB's own pages and getting one wrong returns an
 * empty page that looks exactly like "no activity."
 */

import { readFileSync } from "node:fs";

const BASE = "https://ptab.illinois.gov/asi";
const DECISIONS = "https://ptab.illinois.gov/web/Decisions";

/** ASI's advanced search always sends all eight params; empty ones don't filter. */
const SEARCH_PARAMS = ["LName", "FName", "AttyLName", "FirmName", "County", "Township", "TaxYR", "Dockets"];

/**
 * Docket numbers have three forms and each page wants a different one:
 *   short  04-01668        → property.asp?docketno=
 *   full   2004-01668      → displayed, and the decision PDF filename
 *   sub    2004-01668-001  → PropertyDetails.asp?docketno=
 */
export function normalizeDocket(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(\d{2}|\d{4})-(\d{4,6})(?:-(\d{1,3}))?$/);
  if (!m) return null;
  const [, year, seq, sub] = m;
  const yearFull = year.length === 4 ? year : Number(year) >= 50 ? `19${year}` : `20${year}`;
  const yearShort = yearFull.slice(2);
  return {
    short: `${yearShort}-${seq}`,
    full: `${yearFull}-${seq}`,
    sub: `${yearFull}-${seq}-${(sub || "001").padStart(3, "0")}`,
    year: yearFull,
  };
}

const enc = (v) => encodeURIComponent(v === null || v === undefined ? "" : String(v).trim());

export function searchUrl(fields = {}) {
  const query = SEARCH_PARAMS.map((p) => `${p}=${enc(fields[p])}`).join("&");
  return `${BASE}/AdvancedSearch.asp?${query}`;
}

export const pinUrl = (pin) => `${BASE}/PropertyPIN.asp?PropPin=${enc(pin)}`;
export const docketUrl = (d) => `${BASE}/property.asp?docketno=${enc(normalizeDocket(d)?.short ?? d)}`;
export const detailsUrl = (pin, d) =>
  `${BASE}/PropertyDetails.asp?proppin=${enc(pin)}&docketno=${enc(normalizeDocket(d)?.sub ?? d)}`;
export function decisionUrl(d) {
  const n = normalizeDocket(d);
  return n ? `${DECISIONS}/${n.year}/${n.full}.pdf` : null;
}

/** One watch → one query descriptor. Unknown kinds are an error, not a skip. */
export function watchToQuery(watch) {
  const status = watch.status || "A";
  switch (watch.kind) {
    case "attorney":
      return {
        watch_id: watch.id,
        kind: watch.kind,
        url: searchUrl({
          AttyLName: watch.attorney_last_name,
          FirmName: watch.firm_name,
          County: watch.county,
          TaxYR: watch.tax_year,
          Dockets: status,
        }),
        paginate: true,
        max_pages: watch.max_pages ?? 20,
      };
    case "owner":
      return {
        watch_id: watch.id,
        kind: watch.kind,
        url: searchUrl({
          LName: watch.last_name,
          FName: watch.first_name,
          County: watch.county,
          TaxYR: watch.tax_year,
          Dockets: status,
        }),
        paginate: true,
        max_pages: watch.max_pages ?? 20,
      };
    case "county_year":
      return {
        watch_id: watch.id,
        kind: watch.kind,
        url: searchUrl({
          County: watch.county,
          Township: watch.township,
          TaxYR: watch.tax_year,
          Dockets: status,
        }),
        paginate: true,
        max_pages: watch.max_pages ?? 40,
      };
    case "pin":
      return { watch_id: watch.id, kind: watch.kind, url: pinUrl(watch.pin), paginate: false };
    case "docket":
      return { watch_id: watch.id, kind: watch.kind, url: docketUrl(watch.docket), paginate: false };
    default:
      throw new Error(`Unknown watch kind "${watch.kind}" on watch "${watch.id}"`);
  }
}

/** Required fields per kind — an empty watch silently matches everything, which is worse than an error. */
const REQUIRED = {
  attorney: ["attorney_last_name", "firm_name"], // either one
  owner: ["last_name"],
  county_year: ["county"],
  pin: ["pin"],
  docket: ["docket"],
};

export function validateWatch(watch) {
  const problems = [];
  if (!watch.id) problems.push("missing id");
  const required = REQUIRED[watch.kind];
  if (!required) return [`unknown kind "${watch.kind}"`];
  const filled = required.filter((f) => String(watch[f] ?? "").trim() !== "");
  if (filled.length === 0) {
    problems.push(`needs one of: ${required.join(", ")} — an empty watch matches the whole database`);
  }
  if (watch.kind === "docket" && !normalizeDocket(watch.docket)) {
    problems.push(`docket "${watch.docket}" is not YY-NNNNN or YYYY-NNNNN`);
  }
  if (watch.tax_year && Number(watch.tax_year) < 1999) {
    problems.push(`tax_year ${watch.tax_year} predates ASI's 1999 data floor — this watch returns nothing`);
  }
  return problems;
}

// ---------- CLI ----------
const args = process.argv.slice(2);
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain && args.length) {
  const docketFlag = args.indexOf("--docket");
  if (docketFlag !== -1) {
    const raw = args[docketFlag + 1];
    const n = normalizeDocket(raw);
    if (!n) {
      console.error(`Not a docket number: ${raw}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ...n, docket: docketUrl(raw), decision: decisionUrl(raw) }, null, 2));
    process.exit(0);
  }

  const watchlist = JSON.parse(readFileSync(args[0], "utf-8"));
  let failed = 0;
  for (const watch of watchlist.watches || []) {
    const problems = validateWatch(watch);
    if (problems.length) {
      console.error(`SKIP ${watch.id || "(no id)"}: ${problems.join("; ")}`);
      failed += 1;
      continue;
    }
    console.log(JSON.stringify(watchToQuery(watch)));
  }
  if (failed) console.error(`\n${failed} watch(es) skipped. Fix them before sweeping — a skipped watch is a blind spot.`);
}
