/**
 * The moulding plan from `Planning.csv` — the export the PMD dashboard runs
 * on, one row per press order:
 *
 *   JobHead_JobNum  JobHead_PartNum  Machine  JobHead_PartDescription
 *   JobHead_ProdQty  Calculated_RemainingQty  JobHead_StartDate
 *   JobHead_StartHour  JobHead_ReqDueDate  JobOper_ProdStandard  No of shift
 *
 * It is the one export that says which press an order runs on and how many
 * shifts that press is crewed for, so the PMD lane is built from it: one
 * sub-line per press. `Planning1.csv` carries the same press orders without a
 * machine, and the source lets this file's rows stand in for those.
 *
 * As on the PMD dashboard, the run is JobHead_StartDate + StartHour to
 * JobHead_ReqDueDate — the due date is when Epicor has the press finishing —
 * and `JobOper_ProdStandard` is pieces per hour.
 */

import { JobId, MachineId, PartId } from '@/domain/ids';
import type { Job } from '@/domain/types';
import { mapHeaders, parseCsv, type CsvRow } from '@/lib/csv';
import type { ParseOutcome } from '@/data/parsers/types';

type Field =
  | 'jobNum'
  | 'partNum'
  | 'machine'
  | 'description'
  | 'prodQty'
  | 'remainingQty'
  | 'startDate'
  | 'startHour'
  | 'dueDate'
  | 'rate'
  | 'shifts'
  | 'die'
  | 'color';

const ALIASES: Record<Field, readonly string[]> = {
  jobNum: ['JobNum', 'Job'],
  partNum: ['PartNum', 'Part'],
  machine: ['Machine', 'Press', 'ResourceID'],
  description: ['PartDescription', 'Description'],
  prodQty: ['ProdQty', 'OrderQty'],
  remainingQty: ['RemainingQty', 'QtyRemaining'],
  startDate: ['StartDate'],
  startHour: ['StartHour', 'StartTime', 'Start_Time'],
  dueDate: ['ReqDueDate', 'DueDate'],
  rate: ['ProdStandard'],
  shifts: ['NoofShift', 'NoofShifts', 'Shifts', 'ShiftPattern'],
  // Not in today's export; read if they are ever added beside the machine.
  die: ['DieNumber', 'Die', 'Tool'],
  color: ['Colour', 'Color', 'ActualColor'],
};

const cell = (row: CsvRow, at: number | undefined): string =>
  at === undefined ? '' : (row[at] ?? '').replace(/ /g, ' ').trim();

const num = (v: string): number | null => {
  if (v === '') return null;
  const n = Number(v.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Epicor's `2026-09-10T00:00:00` is local; a bare date is pinned to local midnight. */
const date = (v: string): Date | null => {
  if (v === '') return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(v);
  const d = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : au
      ? new Date(Number(au[3]), Number(au[2]) - 1, Number(au[1]), Number(au[4] ?? 0), Number(au[5] ?? 0))
      : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** StartDate is the day, StartHour the decimal hour within it (18.68 → 18:40). */
function startInstant(day: string, hour: string): Date | null {
  const midnight = date(day);
  if (!midnight) return null;
  const h = num(hour);
  if (h === null || h <= 0 || h >= 24) return midnight;
  return new Date(midnight.getTime() + h * 3_600_000);
}

export function parsePressPlanningCsv(text: string): ParseOutcome<Job> {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) return { values: [], errors: ['Planning.csv is empty'] };
  const header = rows[0];
  const col = mapHeaders<Field>(header, ALIASES);
  const missing = (['jobNum', 'partNum', 'machine'] as const).filter((f) => col[f] === undefined);
  if (missing.length > 0) {
    return {
      values: [],
      errors: [
        `Planning.csv: no column for ${missing.join(', ')} — the PMD lane falls back to ` +
          `Planning1.csv. Headers found: ${header.join(', ')}`,
      ],
    };
  }

  const values: Job[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const jobNum = cell(row, col.jobNum);
    const partNum = cell(row, col.partNum);
    const machine = cell(row, col.machine);
    if (!jobNum || !partNum || !machine || seen.has(jobNum)) continue;
    seen.add(jobNum);

    const start = startInstant(cell(row, col.startDate), cell(row, col.startHour));
    const due = date(cell(row, col.dueDate));
    const prodQty = num(cell(row, col.prodQty));
    const remainingQty = num(cell(row, col.remainingQty)) ?? prodQty ?? 0;
    const piecesPerHour = num(cell(row, col.rate));
    // The window is the run; with no due date the run is the work at rate.
    const windowHours =
      start && due && due.getTime() > start.getTime()
        ? (due.getTime() - start.getTime()) / 3_600_000
        : null;
    const rateHours = piecesPerHour && piecesPerHour > 0 ? remainingQty / piecesPerHour : 0;
    const die = cell(row, col.die) || null;
    const shifts = cell(row, col.shifts) || null;

    values.push({
      id: JobId(jobNum),
      department: 'moulding',
      partNum: PartId(partNum),
      description: cell(row, col.description),
      remainingQty,
      qtyPerHr: piecesPerHour && piecesPerHour > 0 ? piecesPerHour : null,
      laborHrs: windowHours ?? rateHours,
      dueDate: due,
      startDate: start,
      reqBy: start,
      released: true,
      priority: 3,
      materialPrep: 'unknown',
      tool: null,
      preferredMachine: MachineId(machine),
      orderType: null,
      line: null,
      completedQty: prodQty !== null ? Math.max(0, prodQty - remainingQty) : 0,
      predecessors: [],
      assignedWorkers: [],
      press: {
        machine,
        shifts,
        end: due && start && due.getTime() > start.getTime() ? due : null,
        die,
        dieName: null,
        color: cell(row, col.color) || null,
        insert: null,
      },
    });
  }
  return { values, errors: [] };
}
