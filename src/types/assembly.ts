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
