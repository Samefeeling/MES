/**
 * The two-orders-at-once question.
 *
 * Nobody does two jobs at the same time, so putting someone on an order that
 * runs across one they are already on is not written straight to the plan.
 * Until the supervisor answers, nothing has changed — the person is not on the
 * second order.
 *
 * Three answers, and all of them are real:
 *   Queue it        put them on and let the order wait for them, which is what
 *                   the board does with a crew by default: they finish the one
 *                   they are on and pick this up on the next shift
 *   Both at once    they split their day, or hand over part-way; the pair is
 *                   recorded as approved, the bars are left overlapping and
 *                   their day reads as over-booked
 *   Cancel          leave them where they are and put someone else on it
 */

import { JobId } from '@/domain/ids';
import { usePlanStore } from '@/store/planStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { useUiStore } from '@/store/uiStore';
import { Button } from '@/ui';

export function ClashPrompt() {
  const request = useUiStore((s) => s.clashRequest);
  const clear = useUiStore((s) => s.clearClash);
  const assign = usePlanStore((s) => s.assignWorker);
  const assignWindow = usePlanStore((s) => s.assignWorkerWindow);
  const approve = usePlanStore((s) => s.approveDoubleBooking);
  // The same gate as allocating by hand: this *is* an allocation, and a
  // heavier one than most.
  const unlocked = useSupervisorStore((s) => s.unlocked);
  const gated = useSupervisorStore((s) => s.required) && !unlocked;

  if (!request) return null;

  const jobId = JobId(request.jobId);
  /** Put them on. `overlap` also records that the two bars may run together. */
  const put = (overlap: boolean) => {
    if (request.fromDay !== undefined || request.toDayExclusive !== undefined) {
      assignWindow(
        jobId,
        request.workerId,
        request.fromDay ?? null,
        request.toDayExclusive ?? null,
      );
    } else {
      assign(jobId, request.workerId);
    }
    if (overlap) approve(jobId, request.workerId);
    clear();
  };

  return (
    <div
      className="ot-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clash-title"
      onClick={clear}
    >
      <div className="ot-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="clash-title">Already on another order</h2>
        <p>
          <strong>{request.workerName}</strong> would be on{' '}
          <strong>{request.jobId}</strong> while it runs across work they are
          already booked for:
        </p>
        <ul className="clash-list">
          {request.withLabels.map((label, i) => (
            <li key={request.withJobIds[i]}>{label}</li>
          ))}
        </ul>
        <p className="ot-note">
          Queue it and this order waits for them: they finish what they are on
          and pick this up on the next shift, which is how the board plans a
          crew. Both at once plans a full shift on each, so their day reads as
          over-booked — choose it only if they really are splitting the day or
          handing over part-way.
        </p>
        {gated && (
          <p className="ot-gate">
            Unlock Supervisor in the header to allocate.
          </p>
        )}
        <div className="ot-actions">
          <Button
            autoFocus
            variant="primary"
            disabled={gated}
            onClick={() => put(false)}
          >
            Queue it — they start when free
          </Button>
          <Button disabled={gated} onClick={() => put(true)}>
            Both at once
          </Button>
          <Button onClick={clear}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
