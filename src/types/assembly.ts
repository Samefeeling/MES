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
}

export interface AssemblyDataLayer {
  results(from: string, to: string): Promise<AssemblyResult[]>;
}
