import type { AssemblyResult } from '../types/assembly';

export function assemblyMetrics(rows: readonly AssemblyResult[]): {
  orders: number; output: number; complete: number; reject: number; rework: number; completedOrders: number;
} {
  return {
    orders: new Set(rows.map(row => row.job)).size,
    output: rows.reduce((sum, row) => sum + row.output, 0),
    complete: rows.reduce((sum, row) => sum + row.complete, 0),
    reject: rows.reduce((sum, row) => sum + row.reject, 0),
    rework: rows.reduce((sum, row) => sum + row.rework, 0),
    completedOrders: new Set(rows.filter(row => row.completed).map(row => row.job)).size,
  };
}
