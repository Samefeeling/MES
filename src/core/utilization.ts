// Machine Utilization by month — the supervisor's KPI chart.
//
//   Utilization = Actual running hours ÷ Available working hours
//
// Actual running hours: the half-hours the press was marked R (Running),
// on any day. Available working hours: every weekday of the month the
// FactoryCalendar list does not shut (holidays and RDOs alike), × 24 h,
// plus 8 h for each shift the press worked on a day the factory is shut —
// a weekend, a holiday or an RDO — so the R hours of a weekend shift are
// counted against that shift, not against nothing.
// The month so far, for the month under way.
//
// The year runs from April (the New Zealand practice): the months are
// charted April → March, and YTD is the financial year to date. Both start
// at the first month MES recorded in full — it went live over June–August
// 2026, so the months before September have no or partial records: they
// show no bar and are not in YTD, where they would only drag it down.

import { machineKey } from './maint';
import { SLOT_MINUTES } from './shifts';

/** Hours a weekday makes available: three shifts, round the clock. */
export const UTILIZATION_HOURS_PER_WEEKDAY = 24;

/** Hours a shift worked on a closed day adds. */
export const UTILIZATION_HOURS_PER_SHIFT = 8;

/** The presses charted, in the order they are laid out. */
export const UTILIZATION_PRESSES = ['1600T', '1300T', 'Batt1', 'Batt2', '850T', '550T', '320T', '150T', '125T'];

/** The month the financial year starts (1 = January): April. */
export const UTILIZATION_FY_START_MONTH = 4;

/**
 * The first month (`YYYY-MM`) MES recorded in full. Months before it (MES
 * went live over June–August 2026) show no bar and are not in YTD.
 */
export const UTILIZATION_FIRST_FULL_MONTH = '2026-09';

/** The chart that adds every press up. */
export const UTILIZATION_TOTAL = 'Total';

/** A row of the FactoryCalendar list: a day the factory is shut. */
export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  day: string;
  /** "RDO", or the holiday's name. */
  name: string;
}

/** A shift's status timeline for one order (16 half-hours). */
export interface ShiftTimeline {
  machineCode: string;
  shiftId: string;
  timeline?: string;
}

export interface UtilizationMonth {
  /** `YYYY-MM`, or 'YTD' for the year to date. */
  month: string;
  runHours: number;
  /** weekdayHours + closedShiftHours. */
  availableHours: number;
  /** Open weekdays × 24 h. */
  weekdayHours: number;
  /** Shifts worked on closed days × 8 h. */
  closedShiftHours: number;
  /** runHours ÷ availableHours × 100; null with no available hours. */
  pct: number | null;
  /** A month before MES recorded in full: no figure, not in YTD. */
  beforeMes?: boolean;
  /** YTD only: the first and last month it covers (null: none yet). */
  fromMonth?: string | null;
  toMonth?: string | null;
}

/** A press's months, and its year to date. */
export interface UtilizationSeries {
  machineCode: string;
  ytd: UtilizationMonth;
  months: UtilizationMonth[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;

/**
 * The days the FactoryCalendar list shuts — its holidays and its RDOs — with
 * the factory's one rule on top, as the Assembly board keeps it
 * (engine/assembly/factoryCalendar.ts): an Anzac Day on a weekend shuts the
 * Monday after too (the next weekday still open, when that Monday is
 * already shut).
 */
export function factoryClosedDays(rows: ReadonlyArray<CalendarDay>): Set<string> {
  const listed = new Set(rows.map((r) => r.day));
  const out = new Set<string>(listed);
  for (const r of rows) {
    if (!/anzac/i.test(r.name)) continue;
    const [y, m, d] = r.day.split('-').map(Number);
    const day = new Date(y, m - 1, d);
    if (!isWeekend(day)) continue;
    const monday = new Date(day);
    monday.setDate(monday.getDate() + (day.getDay() === 6 ? 2 : 1));
    // The list already names that Monday for Anzac Day: nothing to add.
    if (rows.some((x) => x.day === dayKey(monday) && /anzac/i.test(x.name))) continue;
    while (listed.has(dayKey(monday)) || isWeekend(monday)) monday.setDate(monday.getDate() + 1);
    out.add(dayKey(monday));
  }
  return out;
}

/**
 * Available working hours in `month`: its weekdays the factory is open ×
 * `hoursPerWeekday`, counted up to and including `asOf`'s day (the month so
 * far; a month to come has none).
 */
export function availableHours(
  month: string,
  closed: ReadonlySet<string>,
  asOf: Date,
  hoursPerWeekday = UTILIZATION_HOURS_PER_WEEKDAY,
): number {
  const [y, m] = month.split('-').map(Number);
  const last = dayKey(asOf);
  let days = 0;
  for (const d = new Date(y, m - 1, 1); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    if (key > last) break;
    if (!isWeekend(d) && !closed.has(key)) days++;
  }
  return days * hoursPerWeekday;
}

/**
 * Hours each press was marked R, by month (of the shift's date): machine
 * key (`machineKey`) → month → hours. A half-hour two orders share on one
 * press (a co-run) is one half-hour of the press.
 */
export function runHoursByMonth(timelines: ReadonlyArray<ShiftTimeline>): Map<string, Map<string, number>> {
  const slots = new Map<string, Set<number>>();
  for (const t of timelines) {
    const tl = t.timeline ?? '';
    const key = `${machineKey(t.machineCode)}|${t.shiftId}`;
    for (let i = 0; i < tl.length && i < 16; i++) {
      if (tl[i] !== 'R') continue;
      const held = slots.get(key) ?? new Set<number>();
      held.add(i);
      slots.set(key, held);
    }
  }
  const out = new Map<string, Map<string, number>>();
  for (const [key, held] of slots) {
    const [machine, shiftId] = key.split('|');
    const month = shiftId.slice(0, 7);
    const byMonth = out.get(machine) ?? new Map<string, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + (held.size * SLOT_MINUTES) / 60);
    out.set(machine, byMonth);
  }
  return out;
}

/**
 * Shifts each press worked on a day the factory is shut (a weekend, or a
 * day in `closed`), by month: machine key → month → shifts. A shift is
 * worked when the press has any status in it but O (No Plan) — set up,
 * started or broken down counts as well as running, since the crew was
 * there to run it.
 */
export function closedDayShiftsByMonth(
  timelines: ReadonlyArray<ShiftTimeline>,
  closed: ReadonlySet<string>,
): Map<string, Map<string, number>> {
  const worked = new Set<string>();
  for (const t of timelines) {
    const day = t.shiftId.slice(0, 10);
    const [y, m, d] = day.split('-').map(Number);
    if (!isWeekend(new Date(y, m - 1, d)) && !closed.has(day)) continue;
    if ([...(t.timeline ?? '').slice(0, 16)].some((c) => c !== '·' && c !== 'O' && c.trim() !== '')) {
      worked.add(`${machineKey(t.machineCode)}|${t.shiftId}`);
    }
  }
  const out = new Map<string, Map<string, number>>();
  for (const key of worked) {
    const [machine, shiftId] = key.split('|');
    const byMonth = out.get(machine) ?? new Map<string, number>();
    byMonth.set(shiftId.slice(0, 7), (byMonth.get(shiftId.slice(0, 7)) ?? 0) + 1);
    out.set(machine, byMonth);
  }
  return out;
}

/** The `n` months up to and including `asOf`'s, oldest first. */
export function lastMonths(asOf: Date, n = 12): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
}

/** The first month (`YYYY-MM`) of the financial year `asOf` falls in. */
export function financialYearStart(asOf: Date, startMonth = UTILIZATION_FY_START_MONTH): string {
  const y = asOf.getMonth() + 1 >= startMonth ? asOf.getFullYear() : asOf.getFullYear() - 1;
  return `${y}-${pad(startMonth)}`;
}

/** The financial year's 12 months, April → March, that `asOf` falls in. */
export function financialYearMonths(asOf: Date, startMonth = UTILIZATION_FY_START_MONTH): string[] {
  const [y, m] = financialYearStart(asOf, startMonth).split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y, m - 1 + i, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  });
}

const utilizationOf = (month: string, runHours: number, weekdayHours: number, closedShiftHours: number): UtilizationMonth => {
  const available = weekdayHours + closedShiftHours;
  return {
    month,
    runHours,
    availableHours: available,
    weekdayHours,
    closedShiftHours,
    pct: available > 0 ? Math.round((runHours / available) * 1000) / 10 : null,
  };
};

/**
 * Each press's Utilization in each of `months`, and over the financial year
 * to date (from April, or from `firstFull` when MES recorded in full only
 * later: Σ R hours ÷ Σ available hours of those months, which `months` must
 * include — the financial year's always do). A month before `firstFull`
 * has no figure.
 */
export function machineUtilization(
  presses: ReadonlyArray<string>,
  months: ReadonlyArray<string>,
  timelines: ReadonlyArray<ShiftTimeline>,
  calendar: ReadonlyArray<CalendarDay>,
  asOf: Date,
  firstFull = UTILIZATION_FIRST_FULL_MONTH,
): UtilizationSeries[] {
  const run = runHoursByMonth(timelines);
  const closed = factoryClosedDays(calendar);
  const extra = closedDayShiftsByMonth(timelines, closed);
  const fyStart = financialYearStart(asOf);
  const from = fyStart > firstFull ? fyStart : firstFull;
  const thisMonth = lastMonths(asOf, 1)[0];
  const inYtd = (month: string): boolean => month >= from && month <= thisMonth;
  const covered = months.filter(inYtd);
  return presses.map((machineCode) => {
    const key = machineKey(machineCode);
    const monthly = months.map((month) =>
      month < firstFull
        ? { ...utilizationOf(month, 0, 0, 0), beforeMes: true }
        : utilizationOf(
            month,
            run.get(key)?.get(month) ?? 0,
            availableHours(month, closed, asOf),
            (extra.get(key)?.get(month) ?? 0) * UTILIZATION_HOURS_PER_SHIFT,
          ),
    );
    return { machineCode, ytd: ytdOf(monthly.filter((m) => inYtd(m.month)), covered), months: monthly };
  });
}

function ytdOf(months: ReadonlyArray<UtilizationMonth>, covered: ReadonlyArray<string>): UtilizationMonth {
  const sum = (f: (m: UtilizationMonth) => number): number => months.reduce((n, m) => n + f(m), 0);
  return {
    ...utilizationOf('YTD', sum((m) => m.runHours), sum((m) => m.weekdayHours), sum((m) => m.closedShiftHours)),
    fromMonth: covered[0] ?? null,
    toMonth: covered[covered.length - 1] ?? null,
  };
}

/**
 * Every press added up, month by month and over the year to date: Σ R hours
 * of the presses ÷ Σ their available hours (each press's own — a weekend
 * shift adds its 8 h only to the press that worked it).
 */
export function totalUtilization(series: ReadonlyArray<UtilizationSeries>): UtilizationSeries {
  const add = (ms: ReadonlyArray<UtilizationMonth>, month: string): UtilizationMonth => {
    const sum = (f: (m: UtilizationMonth) => number): number => ms.reduce((n, m) => n + f(m), 0);
    const out = utilizationOf(month, sum((m) => m.runHours), sum((m) => m.weekdayHours), sum((m) => m.closedShiftHours));
    return ms[0]?.beforeMes ? { ...out, beforeMes: true } : out;
  };
  const months = series[0]?.months.map((m, i) => add(series.map((s) => s.months[i]), m.month)) ?? [];
  const ytd = add(series.map((s) => s.ytd), 'YTD');
  return {
    machineCode: UTILIZATION_TOTAL,
    ytd: { ...ytd, fromMonth: series[0]?.ytd.fromMonth ?? null, toMonth: series[0]?.ytd.toMonth ?? null },
    months,
  };
}
