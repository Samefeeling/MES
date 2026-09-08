/** Browser-local, reversible exclusions from crew suggestions and the unplaced queue. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AssemblyGanttView } from '@/engine/assembly/board';

export const useIgnoredOrders = create<{
  ids: string[];
  ignore: (id: string) => void;
  restore: (id: string) => void;
}>()(persist((set) => ({
  ids: [],
  ignore: (id) => set((state) => ({ ids: [...new Set([...state.ids, id])] })),
  restore: (id) => set((state) => ({ ids: state.ids.filter((value) => value !== id) })),
}), { name: 'planning-ignored-orders-v1' }));

/** Preserve dependency indexes; only remove excluded rows from crew candidates. */
export function withoutIgnoredOrders(
  board: AssemblyGanttView,
  ids: readonly string[],
): AssemblyGanttView {
  const ignored = new Set(ids);
  return {
    ...board,
    groups: board.groups.map((group) => ({
      ...group,
      rows: group.rows.filter((row) => !ignored.has(String(row.job.id))),
    })),
  };
}
