/**
 * Dispatch is a supervisor's page.
 *
 * It holds the whole of the dispatch office's planning — loads booked,
 * dispatched, held, re-dated — and nothing on it is for the floor. So it is
 * drawn only once the supervisor gate is open, the same gate that guards crew
 * allocation (see `store/supervisorStore` for what that gate is and is not).
 * Inside MES the top bar shows the Dispatch link only while signed in; this is
 * what stands behind a bookmarked `#/dispatch` opened by anybody else, or a
 * page left open when the supervisor signs out.
 */

import type { AssemblyGanttView } from '@/engine/assembly/board';
import { signInAt, useSupervisorStore } from '@/store/supervisorStore';
import { DispatchPage } from './DispatchPage';

export function DispatchGate({ assembly }: { assembly: AssemblyGanttView | null }) {
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const hosted = useSupervisorStore((s) => s.hosted);
  if (unlocked) return <DispatchPage assembly={assembly} />;
  return (
    <div className="dispatch-locked" role="status">
      <h2>Dispatch Planner is for supervisors</h2>
      <p>Sign in with {signInAt(hosted)} to open it.</p>
    </div>
  );
}
