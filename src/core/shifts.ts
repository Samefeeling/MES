import type { ShiftCode } from '../types';

export const SLOTS_PER_SHIFT = 16; // §5.1 — 8h × 2
export const SLOT_MINUTES = 30; // §5.1 — every slot is exactly 30 min

export interface ShiftDef {
  code: ShiftCode;
  label: string;
  startHour: number; // local hour the shift starts
  spanHours: number; // always 8
}

// §2.3 Shift Definitions. Night spans midnight; its ShiftId date is the
// START date (night beginning 23:00 on 15 May = 2026-05-15-Night, §2.3).
export const SHIFTS: ShiftDef[] = [
  { code: 'Day', label: 'Day 07:00–15:00', startHour: 7, spanHours: 8 },
  { code: 'Afternoon', label: 'Afternoon 15:00–23:00', startHour: 15, spanHours: 8 },
  { code: 'Night', label: 'Night 23:00–07:00', startHour: 23, spanHours: 8 },
];

export const SHIFT_MAP: Record<ShiftCode, ShiftDef> = Object.fromEntries(
  SHIFTS.map((s) => [s.code, s]),
) as Record<ShiftCode, ShiftDef>;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-date YYYY-MM-DD (not UTC — TZ is pinned to site-local, §13 Q4). */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function buildShiftId(d: Date, code: ShiftCode): string {
  return `${dateKey(d)}-${code}`;
}

export function parseShiftId(
  shiftId: string,
): { year: number; month: number; day: number; code: ShiftCode } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(Day|Afternoon|Night)$/.exec(shiftId);
  if (!m) return null;
  return {
    year: +m[1],
    month: +m[2],
    day: +m[3],
    code: m[4] as ShiftCode,
  };
}

/** {start,end} wall-clock bounds of a shift. Night end is next calendar day. */
export function shiftBounds(shiftId: string): { start: Date; end: Date } | null {
  const p = parseShiftId(shiftId);
  if (!p) return null;
  const def = SHIFT_MAP[p.code];
  const start = new Date(p.year, p.month - 1, p.day, def.startHour, 0, 0, 0);
  const end = new Date(start.getTime() + def.spanHours * 3600_000);
  return { start, end };
}

/** {start,end} of a single 30-min slot within a shift. */
export function slotTimeRange(
  shiftId: string,
  slotIndex: number,
): { start: Date; end: Date } | null {
  const b = shiftBounds(shiftId);
  if (!b || slotIndex < 0 || slotIndex >= SLOTS_PER_SHIFT) return null;
  const start = new Date(b.start.getTime() + slotIndex * SLOT_MINUTES * 60_000);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
  return { start, end };
}

function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "09:00–09:30" for a slot. */
export function slotClock(shiftId: string, slotIndex: number): string {
  const r = slotTimeRange(shiftId, slotIndex);
  if (!r) return '';
  return `${hhmm(r.start)}–${hhmm(r.end)}`;
}

/** "Slot 6/16 · 09:00–09:30" — modal header (§8.2). */
export function slotLabel(shiftId: string, slotIndex: number): string {
  return `Slot ${slotIndex + 1}/${SLOTS_PER_SHIFT} · ${slotClock(shiftId, slotIndex)}`;
}

/**
 * The shift active at `now`, accounting for Night belonging to the previous
 * calendar day when the clock is past midnight (§2.3).
 */
export function currentShift(now: Date = new Date()): {
  code: ShiftCode;
  shiftId: string;
} {
  const h = now.getHours();
  if (h >= 7 && h < 15) return { code: 'Day', shiftId: buildShiftId(now, 'Day') };
  if (h >= 15 && h < 23) return { code: 'Afternoon', shiftId: buildShiftId(now, 'Afternoon') };
  // 23:00–06:59 — Night. If we're past midnight the shift started yesterday.
  const anchor = new Date(now);
  if (h < 7) anchor.setDate(anchor.getDate() - 1);
  return { code: 'Night', shiftId: buildShiftId(anchor, 'Night') };
}

/** Which slot index `now` falls in for the given shift, or null if outside. */
export function currentSlotIndex(shiftId: string, now: Date = new Date()): number | null {
  const b = shiftBounds(shiftId);
  if (!b) return null;
  if (now < b.start || now >= b.end) return null;
  const idx = Math.floor((now.getTime() - b.start.getTime()) / (SLOT_MINUTES * 60_000));
  return idx >= 0 && idx < SLOTS_PER_SHIFT ? idx : null;
}
