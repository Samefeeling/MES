import type { AssemblyResult } from '../types/assembly';

export function assemblyMetrics(rows: readonly AssemblyResult[]): {
  supportHours: number; supportOrders: number; orders: number; output: number; complete: number; reject: number; rework: number; completedOrders: number;
} {
  const support = rows.filter(row => row.workType === 'Support');
  rows = rows.filter(row => row.workType !== 'Support');
  return {
    supportHours: support.reduce((sum, row) => sum + (row.laborHours ?? 0), 0),
    supportOrders: new Set(support.map(row => row.job)).size,
    orders: new Set(rows.map(row => row.job)).size,
    output: rows.reduce((sum, row) => sum + row.output, 0),
    complete: rows.reduce((sum, row) => sum + row.complete, 0),
    reject: rows.reduce((sum, row) => sum + row.reject, 0),
    rework: rows.reduce((sum, row) => sum + row.rework, 0),
    completedOrders: new Set(rows.filter(row => row.completed).map(row => row.job)).size,
  };
}
