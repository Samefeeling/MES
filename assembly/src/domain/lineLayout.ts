/**
 * The board's line layout, as one answer for everything that names a line:
 * the board itself, the completed-orders dialog, and KPIs · Assembly in MES.
 *
 * The layout is the plan's (`ASSY_Plans`): the built-in lines, the ones the
 * supervisor opened (`virtualLines`), what each is called on this floor
 * (`lineNames`), the order they are drawn in (`lineOrder`), and whether
 * upholstery runs by process (`uplByProcess` — then Smart Soft Seating's lane
 * stands down and Upholstery's lane is named for both, "Upholstery + Smart
 * Soft Seating", exactly as `computeAssemblyGantt` names it).
 *
 * `lineOf` reads any name a record may carry — a line key, today's name, a
 * name from before a rename, a bench ("Sewing"), an ERP planner ("UPL",
 * "ASSY") — and answers the top-level line it belongs to *now*. So a record
 * written under an older layout is shown under today's, and when the layout
 * changes every screen moves with it.
 *
 * Free of path aliases on purpose: MES imports it from outside this app.
 */

import {
  LINES,
  STEP_NAME,
  arrangeLines,
  isVirtualLine,
  readLineKey,
  type LineDef,
  type LineKey,
  type VirtualLine,
} from './assembly';

/** What of the plan decides the layout — the fields of `plan.assembly` of the same names. */
export interface LayoutSettings {
  lineNames?: Record<string, string>;
  uplByProcess?: boolean;
  virtualLines?: VirtualLine[];
  lineOrder?: string[];
}

export interface LayoutBench {
  key: string;
  name: string;
}

export interface LayoutLine {
  key: string;
  /** The name the board shows. */
  name: string;
  /** Its benches, in the order they are worked; empty for a line without. */
  benches: LayoutBench[];
}

export interface LineLayout {
  /** Every top-level line, in the board's order. */
  lines: LayoutLine[];
  /** The top-level line a key or a name belongs to now; null when it names none. */
  lineOf(raw: string | null | undefined): LayoutLine | null;
  /** The line's name now, else the text as given (a line the layout does not know). */
  nameOf(raw: string | null | undefined): string;
}

/** By process, Smart Soft Seating's lane and benches are read as Upholstery's. */
const SHARED: Record<string, string> = {
  UPL_SOFTIE: 'UPL_GLUING',
  UPL_SOFTIE_FOAM: 'UPL_GLUING_FOAM',
  UPL_SOFTIE_SEW: 'UPL_GLUING_SEW',
  UPL_SOFTIE_STAPLE: 'UPL_GLUING_STAPLE',
};

const norm = (s: string): string => s.trim().toUpperCase().replace(/[\s/_.+-]+/g, '');

/**
 * Words people and exports use for a line that are neither a key nor a name
 * the board has had — the last thing tried. "Upholstery" is the Gluing lane,
 * as the roster reader reads it.
 */
const LOOSE: Array<[RegExp, LineKey]> = [
  [/^(PMD|MOULD|MOLD)/, 'PMD'],
  [/^TBP/, 'TBP'],
  [/(CUT|SEWCUT)/, 'UPL_CUT_SEW'],
  [/(SOFTIE|SSS|SMARTSOFT)/, 'UPL_SOFTIE'],
  [/(GLU|^UPL|^UPH)/, 'UPL_GLUING'],
  [/^(TABLE|TBL)/, 'TABLE'],
  [/^(ASSY|ASM|ASSEMBL|FINALASSEMBL|SOFA|CHAIR|STOOL|SEAT)/, 'ASSY'],
  [/^(GENERAL|FACTORY)/, 'FACTORY_GENERAL'],
];

export function lineLayout(settings: LayoutSettings = {}): LineLayout {
  const renamed = settings.lineNames ?? {};
  const byProcess = Boolean(settings.uplByProcess);
  const virtual = settings.virtualLines ?? [];
  const builtIn = (key: string): LineDef | undefined => LINES.find((l) => l.key === key);
  const own = (key: string): string =>
    renamed[key]?.trim() || builtIn(key)?.name || virtual.find((v) => v.key === key)?.name || key;
  // The lane over the shared benches is named for both families, as the board names it.
  const shown = (key: string): string =>
    byProcess && key === 'UPL_GLUING' ? `${own('UPL_GLUING')} + ${own('UPL_SOFTIE')}` : own(key);
  const active = (key: string): string => (byProcess && SHARED[key]) || key;
  const root = (key: string): string => builtIn(key)?.parent ?? key;

  const topKeys = arrangeLines(
    [
      ...LINES.filter((l) => !l.parent && !(byProcess && SHARED[l.key])).map((l) => ({ key: String(l.key) })),
      ...virtual.map((v) => ({ key: String(v.key) })),
    ],
    settings.lineOrder ?? [],
  ).map((l) => l.key);
  const lines: LayoutLine[] = topKeys.map((key) => ({
    key,
    name: shown(key),
    benches: LINES.filter((l) => l.parent === key).map((b) => ({ key: String(b.key), name: own(String(b.key)) })),
  }));
  const byKey = new Map(lines.map((l) => [l.key, l]));

  // Every name a line goes by now, and its benches': today's name wins.
  const byName = new Map<string, string>();
  const name = (text: string, key: string): void => {
    const k = norm(text);
    if (k && !byName.has(k)) byName.set(k, key);
  };
  for (const line of lines) {
    name(line.name, line.key);
    name(own(line.key), line.key);
    for (const bench of line.benches) name(bench.name, line.key);
  }
  // The Smart Soft Seating lane's own name, by process: its work is Upholstery's now.
  if (byProcess) {
    name(own('UPL_SOFTIE'), 'UPL_GLUING');
    for (const b of LINES.filter((l) => l.parent === 'UPL_SOFTIE')) name(own(String(b.key)), 'UPL_GLUING');
  }

  const toLine = (key: string | null): LayoutLine | null => (key ? byKey.get(root(active(key))) ?? null : null);

  const lineOf = (raw: string | null | undefined): LayoutLine | null => {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    // A key as stored, or today's name for a line or one of its benches.
    if (byKey.has(text)) return byKey.get(text)!;
    const named = byName.get(norm(text));
    if (named) return byKey.get(named) ?? null;
    // A built-in name or a legacy one ("UPL-Gluing", "ASM", "UPL"), however renamed since.
    const key = readLineKey(text);
    if (key && !isVirtualLine(key)) return toLine(key);
    if (key && byKey.has(key)) return byKey.get(key)!;
    // A bench named without its lane ("Sewing"): Upholstery's, which by
    // process is the only set there is, and otherwise the larger one.
    const step = Object.entries(STEP_NAME).find(([, n]) => norm(n) === norm(text))?.[0];
    if (step) return toLine('UPL_GLUING');
    const loose = LOOSE.find(([re]) => re.test(norm(text)));
    return loose ? toLine(loose[1]) : null;
  };

  return {
    lines,
    lineOf,
    nameOf: (raw) => lineOf(raw)?.name ?? String(raw ?? '').trim(),
  };
}
