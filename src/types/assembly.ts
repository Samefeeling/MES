import type { AttendanceEntry } from '../core/attendance';
import type { HistoryRow } from '../core/assembly-history';

/** Assembly uses job/day results; PMD uses machine/shift records. */
export interface AssemblyResult {
  workType?: string;
  laborHours?: number;
  description?: string;
  supportDepartment?: string;
  id: string;
  job: string;
  day: string;
  line: string;
  /**
   * The whole order's standard labour content, from `PlannedHours`. With
   * `orderQty` it turns a day's finished units back into hours, which is what
   * Efficiency is measured on. Absent on a record written before the board
   * started sending it — such a row is left out of Efficiency, not scored zero.
   */
  plannedHours?: number;
  /** Ordered quantity, the denominator of the standard above. */
  orderQty?: number;
  /**
   * Labour hours this day's booking actually consumed, from `BookedHour`:
   * how long the crew were on the order, times how many of them there were.
   * The denominator of Efficiency.
   *
   * `null` on a row written before the board recorded it — that is a day
   * nobody measured, not a day that took no time, so it is left out of
   * Efficiency rather than scored as infinitely efficient.
   */
  bookedHours?: number | null;
  operators: string;
  output: number;
  complete: number;
  reject: number;
  rework: number;
  completed: boolean;
  due: string | null;
  completedAt: string | null;
  /**
   * Epicor's completion of the order that day (`CompletedJobs.csv`), and who
   * the supervisor confirmed finished it — the `ASSY_CompletedJobs` row's own
   * columns, written by the board's completed-orders dialog. `null` on a row
   * without them (one added by hand), which is read from its standard columns.
   */
  epicor?: EpicorCompletion | null;
}

export interface EpicorCompletion {
  qty: number;
  /** Standard hours Epicor values the quantity at (`LaborDtl_LaborHrs`). */
  hours: number;
  partNum: string;
  at: string | null;
  /** The people confirmed as having finished it. */
  people: string[];
  confirmedBy: string;
  confirmedAt: string;
}

/** One person on the Assembly roster (`ASSY_Operator`). */
export interface AssemblyRosterPerson {
  /** The `ASSY_Operator` item id — the key the board files leave under. */
  id: string;
  /** The name the board shows — and so the name completions carry. */
  name: string;
  position: string;
  /**
   * Days the board has them on leave (`YYYY-MM-DD`): booked annual leave
   * (`PlannedAnnualLeave`) and days marked off on the board (the saved plan's
   * `workerOnLeave`).
   */
  leaveDays: string[];
  /** Payroll's Employee Id (`ASSY_Operator.EmployeeId`): the key to their timesheet lines. '' when not filled in. */
  employeeId: string;
  /**
   * The line their hours count towards, as the board names it: where the
   * supervisor has put them (the saved plan's `workerLines`), else the first
   * line their Skills name. '' when neither says.
   */
  line: string;
}

/** Payroll's timesheets as read from the Attendance folder. */
export interface AssemblyAttendance {
  entries: AttendanceEntry[];
  /** Lines or files that could not be read. */
  errors: string[];
  folder: string;
  files: string[];
}

export interface AssemblyDataLayer {
  results(from: string, to: string): Promise<AssemblyResult[]>;
  /**
   * The roster with each person's leave; absent off SharePoint. `warning`
   * says what could not be read (the board's leave), the roster still being
   * usable without it.
   */
  roster?(): Promise<{ people: AssemblyRosterPerson[]; warning: string | null }>;
  /** Every timesheet export in the Attendance folder; absent off SharePoint. */
  attendance?(): Promise<AssemblyAttendance>;
  /** Every entry of `CompletedJobs.csv` (standard hours by day and planner); absent off SharePoint. */
  history?(): Promise<{ rows: HistoryRow[]; errors: string[] }>;
}
