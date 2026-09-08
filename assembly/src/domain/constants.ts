/**
 * Shop-floor constants for the moulding data that still feeds this board.
 *
 * The assembly department's own rules live in `domain/assembly.ts`.
 */

import type { ShiftPattern } from './types';

/** Shift patterns referenced by the workbook's `no of shift` column. */
export const SHIFT_PATTERNS: Record<string, ShiftPattern> = {
  '1shift': { id: '1shift', hoursPerDay: 8 },
  '2shift': { id: '2shift', hoursPerDay: 16 },
  '3shift': { id: '3shift', hoursPerDay: 24 },
};

/**
 * The moulding lines whose jobs are loaded. Kept in floor order. Assembly no
 * longer schedules moulding, but the PMD row on the board mirrors its plan, so
 * this still gates which lines' jobs come through.
 */
export const MACHINE_ORDER: string[] = [
  '1600T',
  '1300T',
  'BATT1',
  'BATT2',
  '850T',
  '550T',
  '320T',
  '150T',
  '125T',
  'HS',
];

const VISIBLE_MACHINES = new Set(MACHINE_ORDER);

/** Whether a machine id should appear on the board. */
export const isVisibleMachine = (id: string): boolean =>
  VISIBLE_MACHINES.has(id);

