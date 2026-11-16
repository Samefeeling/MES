// SharePoint data layer — the Mango maintenance reports (work orders, PM).
import type {
  MaintStatus,
  MaintType,
  MaintPriority,
  DieMaintenanceRequest,
  MachinePmEvent,
} from '../../types';
import { parseCsv, csvDateToIso } from './csv';

// PMD_DieMaintenance stores lifecycle fields as plain text (people also
// edit the list directly in SharePoint), and the Mango mirror feeds the
// same readers its stage/type vocabulary — so normalise whatever's in
// the cell back onto the app's closed unions instead of trusting it.
export function normaliseMaintStatus(raw: string): MaintStatus {
  const s = raw.trim().toLowerCase();
  // Mango: "Stage 4 Closed" → done · "Stage 2 Being Investigated" /
  // "Stage 3 Coordinator Reviewing" → in-progress · "Stage 1
  // Coordinator Assessing" (just raised) → open.
  if (/closed|complete|done/.test(s)) return 'done';
  // Whatever Mango names its middle stages, 2 and 3 are under way.
  if (/^in|investigat|review|started|wip|progress|\bstage\s*[23]\b/.test(s)) return 'in-progress';
  return 'open';
}

export function normaliseMaintType(raw: string): MaintType {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('clean')) return 'cleaning';
  // Mango's "3. Preventive Maintenance" / "1. Calibration" are check-ups.
  if (/inspect|preventive|calibrat/.test(s)) return 'inspection';
  if (/repair|fix|breakdown/.test(s)) return 'repair';
  return s ? 'other' : 'other';
}

export function normaliseMaintPriority(raw: string): MaintPriority {
  const s = raw.trim().toLowerCase();
  if (s === 'low') return 'low';
  if (s === 'high') return 'high';
  if (s === 'urgent' || s === 'critical') return 'urgent';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Mango plant-equipment work-order report (CSV) → DieMaintenanceRequest[].
// Downloaded by scripts/sync-mango-csv.mjs into the OneDrive-synced folder
// (same pipeline as Planning.csv). Mango has no API for this module, so the
// CSV report is the only machine-readable surface we get.
// ---------------------------------------------------------------------------

/** Direct field → EXACT column-name map for the Mango "AU - Minto
 *  Maintenance Request" export. The report header is fixed and published,
 *  so each field maps to the one column it comes from — no fuzzy guessing.
 *  Names are matched after normalising (lowercase, non-alphanumerics
 *  stripped), so a trailing space in "Type of Maintenance " or the
 *  punctuation in "Cost (parts, labour)" doesn't matter. If Mango ever
 *  renames a column the console warning names it and prints the header row.
 *
 *  User-confirmed mapping (2026-07):
 *   Die number  ← Plant/Equipment        Issue       ← Brief Description
 *   Raised by   ← Employee               Full issue  ← Describe the issue
 *   Due date    ← To be completed by     Maint type  ← Type of Maintenance
 *   Assignee    ← Assign to Action       Outcome     ← Summary of work
 *   completed + Corrective action taken + Preventative action taken +
 *   Summary     Cost/effort ← Cost (parts, labour) + Downtime + Labour Hours */
const MANGO_HEADERS: Record<string, string> = {
  ticket: 'Number',
  downtime: 'Downtime',
  labourHours: 'Labour Hours',
  status: 'Current Stage',
  asset: 'Plant/Equipment',
  description: 'Brief Description',
  requestedBy: 'Employee',
  createdAt: 'Created Date',
  dueDate: 'To be completed by',
  type: 'Type of Maintenance',
  issueDetail: 'Describe the issue',
  actionsTaken: 'Actions taken',
  contact: 'Assign to Action',
  workSummary: 'Summary of work completed',
  cost: 'Cost (parts, labour)',
  correctiveAction: 'Corrective action taken',
  preventativeAction: 'Preventative action taken',
  summary: 'Summary',
  branch: 'Branch',
};

/** Columns whose absence is a real problem (everything else is optional
 *  detail). Without Plant/Equipment there are no die numbers; without
 *  Current Stage the lifecycle can't be resolved. */
const MANGO_REQUIRED = new Set(['asset', 'status']);

/**
 * Parse Mango's work-order CSV report into the app's work-order shape.
 *
 * The report covers the WHOLE plant (forklifts, presses, dock levelers…).
 * Rows whose Plant/Equipment names a DIE belong to Die Management: the die
 * assets follow the site convention "AU - Die 280 Postura Max 430 & 460" —
 * the number after the word "Die" IS the PMD_ProductDieColor DieNumber, so
 * it's extracted directly (word-boundary match: "Diesel" never qualifies).
 * A die row whose number can't be extracted keeps the asset name so it
 * stays visible. Every other row is a machine/plant work order, surfaced
 * separately by parseMangoMachineWorkOrdersCsv for the Die board's Machine
 * column (matched to a press by code — see assetNamesMachine).
 *
 * Status maps the Mango stages (Stage 1 Assessing → open · Stage 2/3 →
 * in-progress · Stage 4 Closed → done); cancelled/declined orders are
 * skipped. The Minto export carries no completion-date column, so for
 * closed orders the date is recovered from the "Actions taken" log — the
 * newest "… to Stage 4 Closed" line, else its latest dated entry. Ids are
 * synthetic (the UI is read-only against this source).
 */
export function parseMangoWorkOrdersCsv(text: string): DieMaintenanceRequest[] {
  return parseMangoReport(text, 'die');
}

/** The machine/plant half of the same Mango report: every work order whose
 *  Plant/Equipment does NOT name a die. The raw asset is preserved on
 *  `asset` so the Die board can match a row to a press by its code; the
 *  synthetic-die `dieNumber` is left empty. Same header detection, cell
 *  mapping, status/closure logic as the die parser. */
export function parseMangoMachineWorkOrdersCsv(text: string): DieMaintenanceRequest[] {
  return parseMangoReport(text, 'machine');
}

function parseMangoReport(text: string, mode: 'die' | 'machine'): DieMaintenanceRequest[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) throw new Error('Mango CSV is empty');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(Object.values(MANGO_HEADERS).map(norm));
  // Mango prefixes the export with a report-TITLE line ("AU - Minto
  // Maintenance Request 1783728039982" — the number is the export
  // timestamp, different every time), sometimes followed by blanks. The
  // real header is the first row carrying the known column names.
  let headerAt = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const score = rows[i].reduce((n, c) => n + (c && wanted.has(norm(c)) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      headerAt = i;
    }
  }
  if (headerAt < 0 || bestScore < 3) {
    throw new Error(
      `Mango CSV schema invalid: could not locate the report header (best score ${bestScore}; first lines: ${rows
        .slice(0, 3)
        .map((r) => r.join(',').slice(0, 120))
        .join(' / ')})`,
    );
  }
  // Direct map: each field takes the column whose header matches its exact
  // name. The layout is fixed, so no prefix/contains guessing.
  const header = rows[headerAt].map(norm);
  const idx: Record<string, number> = {};
  for (const [field, name] of Object.entries(MANGO_HEADERS)) {
    idx[field] = header.indexOf(norm(name));
  }
  const missing = [...MANGO_REQUIRED].filter((f) => idx[f] < 0).map((f) => MANGO_HEADERS[f]);
  if (missing.length > 0) {
    throw new Error(
      `Mango CSV schema invalid: required column(s) missing: ${missing.join(', ')}; header: ${rows[
        headerAt
      ].join(' | ')}`,
    );
  }
  // The due-date column drives the Maint traffic light and is the one
  // people most often forget to fill. Make its resolution explicit.
  if (idx['dueDate'] < 0) {
    console.warn(
      "[pmd] Mango CSV: no '" + MANGO_HEADERS.dueDate + "' column in the export.",
      'Header row was:', rows[headerAt].join(' | '),
    );
  } else {
    console.info(
      "[pmd] Mango CSV: due-date column = '" + rows[headerAt][idx['dueDate']] + "' (index " + idx['dueDate'] + ')',
    );
  }
  const cell = (row: string[], field: string): string =>
    idx[field] >= 0 ? (row[idx[field]] ?? '').trim() : '';
  // "…Die 280…" as a WORD then the number — "Diesel" has no boundary
  // after "die" so it never matches.
  const dieRe = /\bdie\b[^0-9a-z]*(\d+)/i;
  const out: DieMaintenanceRequest[] = [];
  // Per die-row raw "To be completed by" cell — so when a date fails to
  // surface we can show exactly what the parsed bytes held at that column
  // (empty file vs. a value the app parsed differently than Excel shows).
  const dueDiag: { ticket: string; raw: string }[] = [];
  for (let r = headerAt + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;
    const asset = cell(row, 'asset');
    // Split the plant into dies vs everything else. Die mode keeps the die
    // assets ("AU - Die 171 …"); machine mode keeps the rest (presses,
    // forklifts, …) so the Die board's Machine column can match a press to
    // its work orders by code (assetNamesMachine).
    const dieMatch = dieRe.exec(asset);
    const isDieAsset = !!dieMatch || /\bdies?\b/i.test(asset);
    if (mode === 'die' ? !isDieAsset : isDieAsset) continue;
    const ticket = cell(row, 'ticket');
    const description = cell(row, 'description');
    if (!asset && !description && !ticket) continue;
    if (mode === 'machine' && !asset) continue; // machine WOs match on the asset
    const rawStatus = cell(row, 'status');
    if (/cancel|declin|reject|void/i.test(rawStatus)) continue;
    const status = normaliseMaintStatus(rawStatus);
    // Closure date: a real completed column when the layout has one,
    // else the newest "to Stage 4 Closed" line of the actions log, else
    // the latest entry of the log, else the log's last date of any kind.
    // Each entry opens "Fri, 02/10/2026, Chris Buckley (Stage 1 …): …";
    // a date typed inside a note ("parts due 15/10/2026") opens none.
    let closedAt = csvDateToIso(cell(row, 'closedAt'));
    if (!closedAt && status === 'done') {
      const log = cell(row, 'actionsTaken');
      const toClosed = Array.from(
        log.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})[^\n]*to\s+stage\s*4\s*closed/gi),
      ).pop();
      const latestEntry = Array.from(
        log.matchAll(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*(\d{1,2}\/\d{1,2}\/\d{4})/gi),
        (m) => csvDateToIso(m[1]),
      )
        .filter(Boolean)
        .sort()
        .pop();
      const anyDates = log.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
      if (toClosed) closedAt = csvDateToIso(toClosed[1]);
      else if (latestEntry) closedAt = latestEntry;
      else if (anyDates) closedAt = csvDateToIso(anyDates[anyDates.length - 1]);
    }
    out.push({
      id: 1_000_000 + r, // synthetic — this source is read-only in the UI
      dieNumber: mode === 'machine' ? '' : dieMatch ? dieMatch[1] : asset,
      asset,
      status,
      maintType: normaliseMaintType(cell(row, 'type')),
      priority: normaliseMaintPriority(cell(row, 'priority')),
      description: description || asset,
      contact: cell(row, 'contact'),
      requestedBy: cell(row, 'requestedBy'),
      machineCode: '',
      jobNumber: '',
      mangoTicket: ticket,
      createdAt: csvDateToIso(cell(row, 'createdAt')),
      closedAt,
      downtime: cell(row, 'downtime') || undefined,
      labourHours: cell(row, 'labourHours') || undefined,
      issueDetail: cell(row, 'issueDetail') || undefined,
      actionsTaken: cell(row, 'actionsTaken') || undefined,
      workSummary: cell(row, 'workSummary') || undefined,
      correctiveAction: cell(row, 'correctiveAction') || undefined,
      preventativeAction: cell(row, 'preventativeAction') || undefined,
      summary: cell(row, 'summary') || undefined,
      cost: cell(row, 'cost') || undefined,
      dueDate: csvDateToIso(cell(row, 'dueDate')) || undefined,
      maintTypeRaw: cell(row, 'type') || undefined,
      branch: cell(row, 'branch') || undefined,
    });
    dueDiag.push({ ticket, raw: idx['dueDate'] >= 0 ? (row[idx['dueDate']] ?? '') : '' });
  }
  // Diagnostics for the due date that drives the Maint traffic light: for
  // any rows whose date didn't surface, print the ticket + the RAW cell
  // the app parsed at the due-date column. If the raw cell is '' the file
  // the app loaded has no date there (empty export / stale-or-wrong file —
  // the value in Excel is from a different copy); if it holds text the app
  // parsed it wrong and the sample shows exactly what to teach excelDate.
  const missingDue = out
    .map((o, i) => ({ o, d: dueDiag[i] }))
    .filter((x) => !x.o.dueDate);
  if (mode === 'die' && idx['dueDate'] >= 0 && missingDue.length > 0) {
    console.warn(
      `[pmd] Mango CSV: ${missingDue.length}/${out.length} die rows have no parsed`,
      `'${rows[headerAt][idx['dueDate']]}' (col ${idx['dueDate']}). Raw cells:`,
      missingDue.slice(0, 8).map((x) => `${x.d.ticket || '?'}=${JSON.stringify(x.d.raw)}`).join(' · '),
    );
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ---------------------------------------------------------------------------
// MachinePM.csv — Mango's plant-equipment register with its PM events. One
// row per (equipment, event); Name, the first column, is the same string as
// the work-order report's Plant/Equipment. Columns are found by name, so the
// export's other forty-odd columns can come and go.
// ---------------------------------------------------------------------------

const MACHINE_PM_HEADERS = {
  asset: 'Name',
  assetNumber: 'Asset Number',
  description: 'Description',
  department: 'Department',
  branch: 'Branch',
  eventType: 'Event Type',
  owner: 'Owner of work',
  frequency: 'Event Frequency',
  frequencyNumber: 'Event Frequency Number',
  startDate: 'Event Start Date',
  dueDate: 'Event Due Date',
  detail: 'Event Detail',
  superseded: 'Superseded',
} as const;

export function parseMachinePmCsv(text: string): MachinePmEvent[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) throw new Error('MachinePM CSV is empty');
  const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(Object.values(MACHINE_PM_HEADERS).map(norm));
  // Like the work-order report, an export may open with a title line.
  let headerAt = 0;
  let best = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const score = rows[i].reduce((n, c) => n + (c && wanted.has(norm(c)) ? 1 : 0), 0);
    if (score > best) {
      best = score;
      headerAt = i;
    }
  }
  const header = rows[headerAt].map(norm);
  const at = (name: string): number => header.indexOf(norm(name));
  const idx = Object.fromEntries(
    Object.entries(MACHINE_PM_HEADERS).map(([k, name]) => [k, at(name)]),
  ) as Record<keyof typeof MACHINE_PM_HEADERS, number>;
  // Name is the first column whatever it is called.
  if (idx.asset < 0) idx.asset = 0;
  if (idx.dueDate < 0 && idx.detail < 0) {
    throw new Error(
      `MachinePM CSV schema invalid: no 'Event Due Date' or 'Event Detail' column; header: ${rows[headerAt].join(' | ')}`,
    );
  }
  const cell = (row: string[], k: keyof typeof MACHINE_PM_HEADERS): string =>
    idx[k] >= 0 ? (row[idx[k]] ?? '').replace(/\u00a0/g, ' ').trim() : '';
  const day = (v: string): string => csvDateToIso(v).slice(0, 10);
  const out: MachinePmEvent[] = [];
  for (let r = headerAt + 1; r < rows.length; r++) {
    const row = rows[r];
    const asset = cell(row, 'asset');
    if (!asset) continue;
    const unit = cell(row, 'frequency');
    const n = cell(row, 'frequencyNumber');
    // "3" + "months", or a number column that already says "3 months".
    const frequency = n && unit && !/[a-z]/i.test(n) ? `${n} ${unit}` : n || unit;
    out.push({
      asset,
      assetNumber: cell(row, 'assetNumber'),
      description: cell(row, 'description'),
      department: cell(row, 'department'),
      branch: cell(row, 'branch'),
      eventType: cell(row, 'eventType'),
      owner: cell(row, 'owner'),
      frequency,
      startDate: day(cell(row, 'startDate')),
      dueDate: day(cell(row, 'dueDate')),
      detail: cell(row, 'detail'),
      superseded: /^(true|yes|1)$/i.test(cell(row, 'superseded')),
    });
  }
  return out;
}
