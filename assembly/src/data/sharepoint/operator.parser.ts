/**
 * The shift roster from the SharePoint list `ASSY_Operator`.
 *
 * Columns: Operator | Position | Skills | Supervisor.
 *
 * `Skills` decides who may be allocated to an order, so it is normalised onto
 * the four line keys. It is written by hand, and a multi-choice column comes
 * back from Graph as an array while a text column comes back as one delimited
 * string — both are accepted, as are the long names people actually type
 * ("Upholstery", "Final Assembly") alongside the short codes.
 *
 * Attendance is *not* in the list — the supervisor confirms who is in each
 * morning — so everyone is on shift unless the list grows an `OnShift` column.
 */

import { WorkerId } from '@/domain/ids';
import type { LineKey, Worker, WorkKind } from '@/domain/assembly';
import type { ListItemFields } from './lists.client';
import type { ParseOutcome } from '@/data/excel/parsers/types';

/** Column aliases, most-specific first; matched case/separator-insensitively. */
const COLUMNS = {
  operator: ['Operator', 'OperatorName', 'FullName', 'Name', 'Title'],
  position: ['Position', 'Role', 'JobTitle'],
  skills: ['Skills', 'Skill', 'SkillSet', 'Lines'],
  supervisor: ['Supervisor', 'Manager', 'TeamLeader'],
  onShift: ['OnShift', 'Active', 'Present'],
  plannedLeave: ['PlannedAnnualLeave', 'AnnualLeave', 'PlannedLeave', 'LeaveDates'],
} as const;

type Column = keyof typeof COLUMNS;

const norm = (s: string): string => s.replace(/[\s_.-]+/g, '').toLowerCase();

/** What people write in the Skills column → the line it qualifies them for. */
const SKILL_TO_LINE: [RegExp, LineKey][] = [
  [/^(upl|uph|upholster|cutting|sewing|cutsew|cut&sew)/, 'UPL'],
  [/^(table|tbl)/, 'TABLE'],
  [/^(assy|assembl|finalassembl|sofa|chair)/, 'ASSY'],
  [/^(pmd|mould|mold|press)/, 'PMD'],
];

/**
 * Trades within a line, written in the same column as the lines. A roster that
 * names none behaves exactly as it did before trades existed.
 */
const SKILL_TO_KIND: [RegExp, WorkKind][] = [
  [/^(smartsoftie|softie|ottoman)/, 'smart-softie'],
  [/^(cut|cutsew|cutandsew|sew|sewing)/, 'cut-sew'],
  [/^(upholster)/, 'upholstery'],
];

const skillParts = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[,;/|+]+/);

function readSkills(raw: unknown): LineKey[] {
  const out: LineKey[] = [];
  for (const part of skillParts(raw)) {
    const key = norm(part);
    if (!key) continue;
    const hit = SKILL_TO_LINE.find(([re]) => re.test(key));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out;
}

/**
 * The trades named in `Skills`, if any. `UPL` alone says which line; `UPL,
 * Cut & Sew` says which bench on it.
 *
 * Read after the lines, so a word that is both — "Upholstery" names the UPL
 * line *and* the upholstering trade — only becomes a trade when the column
 * says something narrower elsewhere; otherwise a roster written the old way
 * would suddenly restrict everyone to one bench.
 */
function readTrades(raw: unknown): WorkKind[] {
  const out: WorkKind[] = [];
  for (const part of skillParts(raw)) {
    const key = norm(part);
    if (!key) continue;
    const hit = SKILL_TO_KIND.find(([re]) => re.test(key));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  // "Upholstery" on its own is how people have always written the UPL line.
  return out.length === 1 && out[0] === 'upholstery' ? [] : out;
}

/** Pick a field by any of its accepted names. */
function field(row: ListItemFields, column: Column): unknown {
  const byName = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    const key = norm(k);
    if (!byName.has(key)) byName.set(key, v);
  }
  for (const name of COLUMNS[column]) {
    const v = byName.get(norm(name));
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const text = (v: unknown): string => (v === undefined ? '' : String(v).trim());

function readLeaveDays(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[,;|]+/);
  return parts
    .map((part) => part.trim().slice(0, 10))
    .filter((part) => /^\d{4}-\d{2}-\d{2}$/.test(part));
}

export function parseOperators(rows: ListItemFields[]): ParseOutcome<Worker> {
  const values: Worker[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row, i) => {
    const name = text(field(row, 'operator'));
    if (!name) return; // blank row

    // The list item id is the durable key — a rename must not orphan the
    // allocations already saved against this person.
    const id = text(row.id) || name;
    if (seen.has(id)) return;
    seen.add(id);

    const skills = readSkills(field(row, 'skills'));
    const trades = readTrades(field(row, 'skills'));
    if (skills.length === 0) {
      errors.push(
        `ASSY_Operator row ${i + 1} (${name}): no recognised skill — ` +
          `cannot be allocated to any line`,
      );
    }

    const onShiftRaw = field(row, 'onShift');
    const position = text(field(row, 'position'));
    const supervisor = text(field(row, 'supervisor'));
    const plannedLeave = readLeaveDays(field(row, 'plannedLeave'));

    values.push({
      id: WorkerId(id),
      name,
      skills,
      ...(trades.length > 0 ? { trades } : {}),
      onShift:
        onShiftRaw === undefined
          ? true
          : !['false', 'no', 'n', '0'].includes(text(onShiftRaw).toLowerCase()),
      ...(position ? { position } : {}),
      ...(supervisor ? { supervisor } : {}),
      ...(plannedLeave.length > 0 ? { plannedLeave } : {}),
    });
  });

  return { values, errors };
}
