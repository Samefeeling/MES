/**
 * Assembly's efficiency by week from the two records that go back: Epicor's
 * `CompletedJobs.csv` (what was finished, in standard hours) and payroll's
 * timesheets (who was at work, and for how long).
 *
 *   Efficiency = Σ standard hours finished ÷ Σ direct hours attended
 *
 * — earned hours over attended direct hours. Unlike the person-day measure
 * on the rest of the page it needs no supervisor to have confirmed who
 * finished what, so it reaches back as far as the files do; and its
 * denominator is the hours actually worked, overtime and short days included.
 *
 * ## Lines
 *
 * The export's planner is the line it can name: TBP, UPL, ASSY, TABLE,
 * GENERAL (PMD is moulding's and left out, and TBP is not measured). The board's upholstery benches
 * (UPL-CUT, UPL-Gluing, UPL-SSS) are one UPL here, because the export does
 * not tell them apart. A person's hours go to their line on the board
 * (`workerLines`), else to the first line their Skills name; hours of
 * somebody with no line count towards the whole floor only.
 */


/** The lines the history can tell apart and measures, in the board's order. */
export const HISTORY_GROUPS = ['UPL', 'Assembly', 'Table', 'General'] as const;
export type HistoryGroup = (typeof HISTORY_GROUPS)[number] | 'TBP' | 'PMD';

/**
 * Lines the page does not measure: PMD is moulding's, and TBP is not assessed
 * while its equipment waits to be replaced. Their standard hours, their
 * people's hours and their completions are all left out.
 */
export const NOT_ASSESSED = new Set<HistoryGroup>(['PMD', 'TBP']);

/** Is this line (a planner, a board line name or key) one the page measures? Unknown lines are. */
export const isAssessedGroup = (g: HistoryGroup | null): boolean => !g || !NOT_ASSESSED.has(g);

/** A planner, a board line key or name, or a Skills entry → the history line it belongs to; null when none. */
export function historyGroup(raw: string): HistoryGroup | null {
  const s = raw.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  if (!s) return null;
  if (/^(pmd|mould|mold)/.test(s)) return 'PMD';
  if (/^tbp/.test(s)) return 'TBP';
  if (/^(upl|uph|cut|sew|glu|soft|smartsoft|sss)/.test(s)) return 'UPL';
  if (/^(table|tbl)/.test(s)) return 'Table';
  if (/^(assy|asm|assembl|finalassembl|sofa|chair|stool|seat)/.test(s)) return 'Assembly';
  if (/^(general|factory)/.test(s)) return 'General';
  return null;
}

/**
 * A roster line (a board line key such as `UPL_GLUING`, or what Skills says)
 * → the board's line name, as the KPI table names its rows; '' when none.
 * Read the way the board's roster reader reads Skills: plain "UPL" is Gluing.
 */
export function boardLineName(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  if (!s) return '';
  if (/^(pmd|mould|mold)/.test(s)) return 'PMD';
  if (/^tbp/.test(s)) return 'TBP';
  if (/(cut|sew)/.test(s)) return 'UPL-CUT';
  if (/(softie|sss|smartsoft)/.test(s)) return 'UPL-SSS';
  if (/(glu|^upl|^uph)/.test(s)) return 'UPL-Gluing';
  if (/^(table|tbl)/.test(s)) return 'Table';
  if (/^(assy|asm|assembl|finalassembl|sofa|chair|stool|seat)/.test(s)) return 'Assembly';
  if (/^(general|factory)/.test(s)) return 'General';
  return '';
}

/** One labour entry of `CompletedJobs.csv`, as far as the history needs it. */
export interface HistoryRow {
  day: string;
  stdHours: number;
  group: HistoryGroup | null;
  planner: string;
  jobNum?: string;
  /** The part's description, first line only. */
  description?: string;
}

const ALIASES = {
  createDate: ['LaborDtl_CreateDate', 'CreateDate'],
  createDateTime: ['Calculated_CreateDateTime', 'CreateDateTime'],
  hours: ['LaborDtl_LaborHrs', 'LaborHrs'],
  planner: ['Calculated_PlannerID', 'PlannerID', 'PersonID'],
  jobNum: ['LaborDtl_JobNum', 'JobNum'],
  description: ['JobAsmbl_Description', 'Description'],
} as const;

/** The first `n` words of a description — what the KPI table's Material column shows. */
export const firstWords = (text: string, n = 6): string => text.trim().split(/\s+/).filter(Boolean).slice(0, n).join(' ');

const norm = (s: string): string => s.replace(/[\s_.-]+/g, '').toLowerCase();
const pad = (n: number): string => String(n).padStart(2, '0');

/** The day of an entry, as the board reads it: ISO `LaborDtl_CreateDate`, else Australian D/M/Y. */
function entryDay(iso: string, dmy: string): string | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (a) return `${a[1]}-${a[2]}-${a[3]}`;
  const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dmy.trim() || iso.trim());
  return b ? `${b[3]}-${pad(+b[2])}-${pad(+b[1])}` : null;
}

/** `CompletedJobs.csv`, already split into cells, → its entries with a day and standard hours. */
export function parseHistoryTable(table: readonly (readonly string[])[]): { rows: HistoryRow[]; errors: string[] } {
  if (!table.length) return { rows: [], errors: ['CompletedJobs.csv is empty.'] };
  const head = new Map(table[0].map((h, i) => [norm(String(h ?? '')), i] as const));
  const col = (names: readonly string[]): number | undefined => names.map((n) => head.get(norm(n))).find((i) => i !== undefined);
  const at = {
    createDate: col(ALIASES.createDate),
    createDateTime: col(ALIASES.createDateTime),
    hours: col(ALIASES.hours),
    planner: col(ALIASES.planner),
    jobNum: col(ALIASES.jobNum),
    description: col(ALIASES.description),
  };
  if (at.hours === undefined || (at.createDate === undefined && at.createDateTime === undefined)) {
    return { rows: [], errors: ['CompletedJobs.csv has no LaborDtl_CreateDate or LaborDtl_LaborHrs column.'] };
  }
  const cell = (row: readonly string[], i: number | undefined): string => (i === undefined ? '' : String(row[i] ?? '').trim());
  const rows: HistoryRow[] = [];
  let unreadable = 0;
  for (const row of table.slice(1)) {
    if (row.every((c) => String(c ?? '').trim() === '')) continue;
    const day = entryDay(cell(row, at.createDate), cell(row, at.createDateTime));
    const stdHours = Number(cell(row, at.hours).replace(/,/g, '') || '0');
    if (!day || !Number.isFinite(stdHours)) {
      unreadable++;
      continue;
    }
    const planner = cell(row, at.planner).toUpperCase();
    rows.push({
      day,
      stdHours,
      planner,
      group: historyGroup(planner),
      jobNum: cell(row, at.jobNum),
      description: cell(row, at.description).split(/\r?\n/)[0].trim(),
    });
  }
  return { rows, errors: unreadable ? [`CompletedJobs.csv: ${unreadable} rows with no readable day or hours were skipped.`] : [] };
}
