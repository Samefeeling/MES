/**
 * The weekend question.
 *
 * Saturday and Sunday are closed, so a bar dropped on one is not written
 * straight to the plan: paying a crew to come in is the supervisor's call, and
 * this is where they make it. Until they answer, the order stays exactly where
 * it was — the drag has changed nothing.
 *
 * Three answers, and each of them is an answer:
 *   Confirm   run it at the weekend, marked as overtime on the board
 *   Monday    keep the move, land it on the next working day instead
 *   Cancel    leave the order where it was
 */

import { JobId } from '@/domain/ids';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useUiStore } from '@/store/uiStore';
import { Button } from '@/ui';
import { fromDayKey, formatDay } from '@/lib/time';


export function OvertimePrompt() {
  const request = useUiStore((s) => s.overtimeRequest);
  const clear = useUiStore((s) => s.clearOvertime);
  const setOrderStart = usePlanStore((s) => s.setOrderStart);
  const setOvertime = usePlanStore((s) => s.setOvertime);
  // Overtime is a cost the supervisor authorises, so it sits behind the same
  // gate as allocation. With no password configured the gate is open and this
  // is simply a confirmation step.
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gated = useSupervisorStore((s) => s.required) && !unlocked;

  if (!request) return null;

  const jobId = JobId(request.jobId);
  const dropped = fromDayKey(request.isoDay);
  const monday = fromDayKey(request.nextWorkingIsoDay);

  const confirm = () => {
    setOvertime(jobId, true);
    setOrderStart(jobId, dropped.toISOString());
    clear();
  };

  const toMonday = () => {
    setOvertime(jobId, false);
    setOrderStart(jobId, monday.toISOString());
    clear();
  };

  return (
    <div
      className="ot-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ot-title"
      onClick={clear}
    >
      <div className="ot-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="ot-title">Weekend working</h2>
        <p>
          <strong>{request.jobId}</strong> was dropped on{' '}
          <strong>{formatDay(dropped)}</strong>. The factory is closed that
          day, so running it needs overtime.
        </p>
        <p className="ot-note">
          The Due Date does not change either way — only where the order starts.
        </p>
        {gated && (
          <p className="ot-gate">
            Unlock Supervisor in the header to approve overtime.
          </p>
        )}
        <div className="ot-actions">
          <Button
            autoFocus
            variant="primary"
            disabled={gated}
            onClick={confirm}
          >
            Approve overtime
          </Button>
          <Button onClick={toMonday}>
            Move to {formatDay(monday)}
          </Button>
          <Button onClick={clear}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
