/**
 * Production orders from `Planning1.csv` — the Epicor BAQ export that feeds
 * both the PMD row and the assembly lines.
 *
 * Sample (headers abbreviated):
 *   JobNum      PartNum   PartDescription  Line  ProdQty  RemainingQty  ...
 *   SFM507615   7911FR    Encore           PMD   34       34
 *   018140-1-1  CSSL0143  Cosmic Stool     ASSY  30       30
 *
 * Columns are matched **by header name**, not position: the BAQ is edited from
 * time to time and column order is not something we control. `mapHeaders`
 * ignores the `JobHead_` / `JobOper_` / `Calculated_` prefixes, so both the raw
 * export and a hand-tidied file parse the same way.
 *
 * Derivations the export leaves implicit:
 *   completedQty = ProdQty - RemainingQty
 *   hoursPerUnit = RemainingLaborHrs / RemainingQty, else ProdStandard
 *   laborHrs     = hoursPerUnit x (RemainingQty + completedQty)
 *   qtyPerHr     = 1 / hoursPerUnit
 *   startDate    = StartDate + StartHour
 */

import { JobId, MachineId, PartId, WorkCenterId } from '@/domain/ids';
import type { Department, Job } from '@/domain/types';
import {
  LINE_BY_ID,
  readLineKey,
  type MaterialPrepStatus,
  type OrderType,
} from '@/domain/assembly';
import { NULL_LINE_ROUTER, type LineRouter } from '@/engine/assembly/lineRouter';
import { isVisibleMachine } from '@/domain/constants';
import { mapHeaders, normalizeHeader, parseCsv, type CsvRow } from '@/lib/csv';
import type { ParseOutcome } from '@/data/excel/parsers/types';

type Field =
  | 'jobNum'
  | 'partNum'
  | 'description'
  | 'line'
  | 'prodQty'
  | 'remainingQty'
  | 'startDate'
  | 'startHour'
  | 'dueDate'
  | 'laborHrs'
  | 'remainingLaborHrs'
  | 'prodStandard'
  | 'orderType'
  | 'completedQty'
  | 'predecessor'
  | 'materialPrep'
  | 'released'
  | 'priority';

/**
 * Accepted header spellings per field, most-specific first. Prefixes are
 * stripped before matching, so `JobHead_ReqDueDate` matches `ReqDueDate`.
 */
const ALIASES: Record<Field, readonly string[]> = {
  jobNum: ['JobNum', 'Job'],
  partNum: ['PartNum', 'Part'],
  description: ['PartDescription', 'Description', 'PartDesc'],
  // The PMD / ASSY column. Which table it comes from varies by BAQ, so several
  // spellings are accepted — and if none matches, `findLineColumn` finds it by
  // looking at the values.
  line: [
    'Line',
    'PersonID',
    'Department',
    'Dept',
    'ResourceGrpID',
    'ResourceGroup',
    'ProdTeamID',
    'WorkCenter',
    'Area',
    'Plant',
  ],
  prodQty: ['ProdQty', 'Qty', 'OrderQty'],
  remainingQty: ['RemainingQty', 'QtyRemaining'],
  startDate: ['StartDate', 'SchedStartDate'],
  // Decimal hour of the day the order starts, e.g. 23.67 for 23:40.
  startHour: ['StartHour', 'SchedStartHour'],
  dueDate: ['ReqDueDate', 'DueDate'],
  // Both are *remaining* work; `RemainingLaborHrs` is the one Resero plans on.
  // The BAQ spells it `Calculated_RemaingLaborHrs` — "Remaing" — and that
  // typo is in the live export, so it is a real spelling, not a guess.
  // `findLaborColumn` catches anything else shaped like it.
  remainingLaborHrs: [
    'RemainingLaborHrs',
    'RemaingLaborHrs',
    'RemainingLabourHrs',
    'RemaingLabourHrs',
    'RemLaborHrs',
  ],
  laborHrs: ['LaborHrs', 'ProdHours', 'TotalHours'],
  prodStandard: ['ProdStandard', 'EstProdHours', 'HoursPerPiece'],
  // Not in today's export — read if they get added (see README).
  orderType: ['OrderType', 'WorkOrderType', 'OpCode'],
  completedQty: ['QtyCompleted', 'CompletedQty'],
  predecessor: ['Predecessor', 'PredecessorJob', 'ParentJobNum'],
  materialPrep: ['MaterialPrep', 'MaterialStatus', 'KitStatus'],
  released: ['JobReleased', 'Released'],
  priority: ['Priority'],
};

const ORDER_TYPES: Record<string, OrderType> = {
  'cutting/sewing': 'cutting-sewing',
  'cutting-sewing': 'cutting-sewing',
  cuttingsewing: 'cutting-sewing',
  'cut & sew': 'cutting-sewing',
  upholstery: 'upholstery',
  uph: 'upholstery',
  'final assembly': 'final-assembly',
  'final-assembly': 'final-assembly',
  finalassembly: 'final-assembly',
};

const PREP_VALUES = new Set<MaterialPrepStatus>([
  'unknown',
  'not-prepared',
  'preparing',
  'ready',
  'shortage',
]);

const cell = (row: CsvRow, at: number | undefined): string =>
  at === undefined ? '' : (row[at] ?? '').trim();

const num = (v: string): number | null => {
  if (v === '') return null;
  const n = Number(v.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Epicor writes `2026-09-10T00:00:00` with no zone, which JS reads as local time
 * — what a shop-floor date should be. A bare `2026-09-10` it reads as *UTC*
 * midnight instead, which lands on the previous day west of Greenwich, so that
 * form is pinned to local midnight by hand.
 */
const date = (v: string): Date | null => {
  if (v === '') return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The scheduled start, which Epicor splits across two columns:
 * `JobHead_StartDate` is midnight of the day (`2026-09-10T00:00:00`) and
 * `JobHead_StartHour` the decimal hour within it (`23.67` → 23:40). Neither
 * says when the order runs on its own, so they are folded into one instant.
 */
function startInstant(day: string, hour: string): Date | null {
  const midnight = date(day);
  if (!midnight) return null;
  const h = num(hour);
  if (h === null || h <= 0) return midnight;
  return new Date(midnight.getTime() + h * 3_600_000);
}

/**
 * Which line/department a row belongs to. `PMD` and the moulding press names
 * are moulding; everything else that names a line is assembly.
 *
 * Read through `readLineKey`, so a value ERP still exports under a retired
 * name (`UPL`, `ASSY_STOOL`) lands on the line that took that work over
 * rather than falling off the board.
 */
function readPlacement(raw: string): {
  department: Department;
  line: Job['line'];
  preferredMachine: Job['preferredMachine'];
} | null {
  if (raw === '') return null;
  const key = readLineKey(raw);
  const known = key ? LINE_BY_ID.get(key) : undefined;

  if (known) {
    return known.key === 'PMD'
      ? { department: 'moulding', line: null, preferredMachine: MachineId(raw) }
      : { department: 'assembly', line: known.id, preferredMachine: null };
  }
  const id = WorkCenterId(raw);
  // A named press (1300T, BATT1, …) — still a moulding row.
  if (isVisibleMachine(String(id))) {
    return { department: 'moulding', line: null, preferredMachine: id };
  }
  return null;
}

/**
 * Fallback when no header matches: the line column is the one whose values are
 * (almost) all recognisable lines. Leftmost wins.
 */
function findLineColumn(rows: CsvRow[], width: number): number | undefined {
  const sample = rows.slice(0, 200);
  for (let col = 0; col < width; col++) {
    let filled = 0;
    let hits = 0;
    for (const row of sample) {
      const v = (row[col] ?? '').trim();
      if (v === '') continue;
      filled++;
      if (readPlacement(v)) hits++;
    }
    if (filled >= 1 && hits / filled >= 0.8) return col;
  }
  return undefined;
}

/**
 * The labour-hours column, when the header is spelled a way the aliases missed.
 *
 * Every hour the board plans with comes from this one column, and a typo in it
 * is invisible: the parser quietly falls back to `ProdStandard` and the whole
 * schedule is built on the wrong number. So anything that reads as labour
 * hours is taken — remaining first, since that is what Resero plans on.
 */
const REMAINING_LABOR = /^rem[a-z]*lab[a-z]*(hrs|hours)$/;
const ANY_LABOR = /^lab[a-z]*(hrs|hours)$/;

function findLaborColumn(
  header: CsvRow,
  pattern: RegExp,
): number | undefined {
  const at = header.findIndex((h) => pattern.test(normalizeHeader(h)));
  return at === -1 ? undefined : at;
}

/**
 * The work-order type. The export does not carry one yet, so it is inferred
 * from the line where that is unambiguous: ASSY and TABLE only ever run final
 * assembly. UPL runs both cutting/sewing and upholstery, so it stays blank
 * until the column exists.
 */
function readOrderType(raw: string, line: Job['line']): OrderType | null {
  const explicit = ORDER_TYPES[raw.trim().toLowerCase()];
  if (explicit) return explicit;
  const def = line ? LINE_BY_ID.get(String(line)) : undefined;
  return def && def.types.length === 1 ? def.types[0] : null;
}

function readPrep(raw: string): MaterialPrepStatus {
  const p = raw.trim().toLowerCase().replace(/\s+/g, '-') as MaterialPrepStatus;
  return PREP_VALUES.has(p) ? p : 'unknown';
}

/**
 * Parse the text of `Planning1.csv` into production orders.
 *
 * `router` decides which line an order goes to when ERP only named a
 * department — see `engine/assembly/lineRouter`. Without one (the mock
 * source, and every test that does not care) placement falls back to the ERP
 * column alone, exactly as it behaved before the BOM rules existed.
 */
export function parsePlanningCsv(
  text: string,
  router: LineRouter = NULL_LINE_ROUTER,
): ParseOutcome<Job> {
  const rows = parseCsv(text);
  if (rows.length === 0) return { values: [], errors: ['Planning1.csv is empty'] };

  const header = rows[0];
  const body = rows.slice(1);
  const col = mapHeaders<Field>(header, ALIASES);
  col.line ??= findLineColumn(body, header.length);
  col.remainingLaborHrs ??= findLaborColumn(header, REMAINING_LABOR);
  col.laborHrs ??= findLaborColumn(header, ANY_LABOR);

  const errors: string[] = [];
  const missing = (['jobNum', 'partNum'] as const).filter(
    (f) => col[f] === undefined,
  );
  if (missing.length > 0) {
    return {
      values: [],
      errors: [
        `Planning1.csv: no column for ${missing.join(', ')}. ` +
          `Headers found: ${header.join(', ')}`,
      ],
    };
  }
  if (col.line === undefined) {
    errors.push(
      'Planning1.csv: no PMD/ASSY column recognised — every order lands in ' +
        'the pool. Add a Department column or tell the parser its name.',
    );
  }
  // Said once, with the headers, rather than once per row: a missing hours
  // column is one problem with the export, not eighty problems with the data.
  if (
    col.remainingLaborHrs === undefined &&
    col.laborHrs === undefined &&
    col.prodStandard === undefined
  ) {
    errors.push(
      'Planning1.csv: no labour-hours column (Calculated_RemaingLaborHrs) — ' +
        `no order can be scheduled. Headers found: ${header.join(', ')}`,
    );
  }

  const values: Job[] = [];
  const seen = new Set<string>();
  /**
   * Line values the parser did not recognise, and how many rows carried each.
   *
   * An order whose line is not read lands on no line at all, which on the
   * board is indistinguishable from one that was never exported: it simply is
   * not there. Said once at the end with the values themselves, because the
   * fix is either a new alias here or a corrected cell in the BAQ.
   */
  const unknownLines = new Map<string, number>();

  body.forEach((row) => {
    const jobNum = cell(row, col.jobNum);
    const partNum = cell(row, col.partNum);
    if (!jobNum || !partNum) return; // spacer / totals row
    if (seen.has(jobNum)) return; // first occurrence wins
    seen.add(jobNum);

    const lineCell = cell(row, col.line);
    const description = cell(row, col.description);
    // The BOM decides the line wherever ERP only named a department. Where it
    // cannot (no routing-table row and no material export for this part) the
    // ERP column still places the order — an order on a roughly-right line is
    // worth more to the floor than one in the unplaced pool.
    const placed = router.place(partNum, lineCell, description);
    const placement = readPlacement(placed.line ?? '') ?? readPlacement(lineCell);
    if (!placement && lineCell) {
      unknownLines.set(lineCell, (unknownLines.get(lineCell) ?? 0) + 1);
    }
    const prodQty = num(cell(row, col.prodQty));
    const remainingQty = num(cell(row, col.remainingQty)) ?? prodQty ?? 0;
    const explicitDone = num(cell(row, col.completedQty));
    const completedQty =
      explicitDone ?? (prodQty !== null ? Math.max(0, prodQty - remainingQty) : 0);
    const totalQty = remainingQty + completedQty;

    // Epicor's hours columns hold the work *remaining*, not the order total —
    // `RemainingLaborHrs` says so, and in the sample `LaborHrs` equals
    // RemainingQty x ProdStandard exactly. The board needs a total, because
    // booking output during the shift has to shrink the bar, so reduce the
    // export to hours-per-unit and gross it back up. Taking the remaining
    // figure as the total instead would discount it twice on a part-run order.
    const prodStandard = num(cell(row, col.prodStandard));
    const remainingLaborHrs =
      num(cell(row, col.remainingLaborHrs)) ?? num(cell(row, col.laborHrs));
    const hoursPerUnit =
      remainingLaborHrs !== null && remainingQty > 0
        ? remainingLaborHrs / remainingQty
        : prodStandard;
    const laborHrs =
      hoursPerUnit !== null && totalQty > 0
        ? hoursPerUnit * totalQty
        : (remainingLaborHrs ?? 0);

    // An order whose hours cells are blank gets no bar, and says so where it
    // matters — on the board, as an order with nothing to run. It is not
    // reported here: the banner is for problems with the *export*, and one
    // blank cell per order filled it with a line the supervisor can do nothing
    // about from this screen. The header check above still catches the case
    // that is an export problem — the hours column missing altogether.

    const line = placement?.line ?? null;
    const predecessor = cell(row, col.predecessor);
    const releasedRaw = cell(row, col.released).toLowerCase();

    values.push({
      id: JobId(jobNum),
      department: placement?.department ?? 'assembly',
      partNum: PartId(partNum),
      description,
      remainingQty,
      qtyPerHr: hoursPerUnit && hoursPerUnit > 0 ? 1 / hoursPerUnit : null,
      laborHrs,
      dueDate: date(cell(row, col.dueDate)),
      startDate: startInstant(
        cell(row, col.startDate),
        cell(row, col.startHour),
      ),
      // Material has to be at the line when the order starts.
      reqBy: date(cell(row, col.startDate)),
      released:
        releasedRaw === ''
          ? null
          : ['true', 'yes', 'y', '1'].includes(releasedRaw)
            ? true
            : ['false', 'no', 'n', '0'].includes(releasedRaw)
              ? false
              : null,
      priority: num(cell(row, col.priority)) ?? 3,
      materialPrep: readPrep(cell(row, col.materialPrep)),
      tool: null,
      preferredMachine: placement?.preferredMachine ?? null,
      orderType: readOrderType(cell(row, col.orderType), line),
      line,
      completedQty,
      // The order export rarely names one; the material file is where the
      // dependency chain really comes from (`engine/assembly/dependencies`).
      predecessors: predecessor ? [JobId(predecessor)] : [],
      assignedWorkers: [],
    });
  });

  if (unknownLines.size > 0) {
    const rows = [...unknownLines.values()].reduce((a, b) => a + b, 0);
    const shown = [...unknownLines.keys()].sort().slice(0, 4).join(', ');
    errors.push(
      `Planning1.csv: ${rows} order${rows === 1 ? '' : 's'} name a line this ` +
        `board does not know (${shown}${unknownLines.size > 4 ? ', …' : ''}) — ` +
        'they are on no line and are not scheduled.',
    );
  }

  return { values, errors };
}
