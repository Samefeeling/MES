import { useState } from 'react';
import type { AssemblyGanttView } from '@/engine/assembly/board';
import { usePlanStore } from '@/store/planStore';
import { useUiStore } from '@/store/uiStore';
import { useSupervisorStore } from '@/store/supervisorStore';
import { clashesFor } from '@/engine/assembly/crew';
import { JobId } from '@/domain/ids';
import { toDayKey, formatDay } from '@/lib/time';
import { Button } from '@/ui';

function readDay(text: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) throw new Error('Enter the date as dd/mm/yyyy.');
  const day = match[3] + '-' + match[2] + '-' + match[1];
  if (toDayKey(new Date(day + 'T12:00:00')) !== day) throw new Error('Enter a valid date.');
  return day;
}

export function ManualOrderButton({ board }: { board: AssemblyGanttView }) {
  const unlocked = useSupervisorStore(s => s.unlocked);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  return <>
    <Button disabled={!unlocked} onClick={() => setOpen(true)}>New support order</Button>
    {open && <div className="manual-backdrop" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      <form className="manual-dialog" role="dialog" aria-modal="true" aria-label="New support order" onSubmit={e => {
        e.preventDefault();
        try {
          if (!useSupervisorStore.getState().unlocked) throw new Error('Supervisor access required.');
          const data = new FormData(e.currentTarget);
          const description = String(data.get('description') ?? '').trim();
          const supportDepartment = String(data.get('department') ?? '').trim();
          const day = readDay(String(data.get('day')));
          const plannedHours = Number(data.get('hours'));
          if (!description || !supportDepartment || !Number.isFinite(plannedHours) || plannedHours <= 0) throw new Error('Enter the work, department and positive total labour hours.');
          const id = 'FG-' + day.replaceAll('-', '') + '-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
          usePlanStore.getState().addManualOrder({ id, description, supportDepartment, day, plannedHours });
          useUiStore.getState().select(id);
          setOpen(false);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      }}>
        <h2>New support order</h2>
        <label>Supporting department<input name="department" required maxLength={100} autoFocus /></label>
        <label>Work description<textarea name="description" required maxLength={500} /></label>
        <label>Date<input name="day" defaultValue={formatDay(board.today)} placeholder="dd/mm/yyyy" required /></label>
        <label>Total planned labour hours<input name="hours" type="number" min="0.25" step="0.25" required /></label>
        <p>Factory General work is recorded in hours and excluded from production quantities.</p>
        {error && <p role="alert">{error}</p>}
        <div><Button type="button" onClick={() => setOpen(false)}>Cancel</Button> <Button type="submit">Create order</Button></div>
      </form>
    </div>}
  </>;
}

export function ManualOrderInspector({ board, id }: { board: AssemblyGanttView; id: string }) {
  const order = usePlanStore(s => s.manualOrders[id]);
  const entries = usePlanStore(s => s.production);
  const workerLines = usePlanStore(s => s.workerLines);
  const assignments = usePlanStore(s => s.orderCrewAssignments);
  const unlocked = useSupervisorStore(s => s.unlocked);
  const [error, setError] = useState('');
  const today = toDayKey(board.today);
  const existing = entries[id]?.find(entry => entry.date === today);
  const selected = assignments[id]?.map(a => a.workerId) ?? existing?.operatorIds ?? [];
  if (!order) return null;
  return <div className="manual-backdrop" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); useUiStore.getState().select(null); } }}>
    <form key={id} className="manual-dialog" role="dialog" aria-modal="true" aria-label="Support order details" onSubmit={e => {
      e.preventDefault();
      try {
        if (!useSupervisorStore.getState().unlocked) throw new Error('Supervisor access required.');
        const data = new FormData(e.currentTarget);
        const laborHours = Number(data.get('hours'));
        const workerIds = data.getAll('worker').map(String);
        const closed = data.get('closed') === 'on';
        if (!workerIds.length || workerIds.length > 4) throw new Error('Select between one and four operators per support order.');
        if (!Number.isFinite(laborHours) || laborHours < 0 || laborHours > workerIds.length * 24) throw new Error('Enter valid total labour hours for this day.');
        const crew = board.workers.filter(w => workerIds.includes(String(w.id)));
        const row = board.rowsByJob.get(id);
        if (row) {
          for (const workerId of workerIds.filter(workerId => !selected.includes(workerId))) {
            const clashes = clashesFor(board.groups.flatMap(group => group.rows), row, workerId);
            if (clashes.length) throw new Error('Operator already allocated to ' + clashes.map(other => String(other.job.id)).join(', ') + '. Reassign that work first.');
          }
        }
        const names = crew.map(w => w.name);
        const plan = usePlanStore.getState();
        const key = JobId(id);
        const existingCrew = plan.orderCrewAssignments[id] ?? [];
        const completed = (plan.production[id] ?? []).some(entry => entry.jobCompleted);
        if (completed && !existing) throw new Error('This support order is already complete.');
        for (const assignment of existingCrew) {
          if (!workerIds.includes(assignment.workerId)) plan.unassignWorker(key, assignment.workerId);
        }
        for (const workerId of workerIds) plan.assignWorker(key, workerId);
        plan.startOrder(key, { startedAt: new Date().toISOString(), overrideReason: null, operatorIds: workerIds, operatorNames: names });
        plan.saveProductionEntry(key, {
          date: today, laborHours, complete: laborHours, reject: 0, rework: 0, shiftOutput: 0,
          paused: false, pauseReason: null, jobCompleted: closed,
          completedAt: closed ? new Date().toISOString() : null,
          operatorIds: workerIds, operatorNames: names, notes: String(data.get('notes') ?? '').trim(),
        }, { remainingQty: order.plannedHours, completedQty: 0 });
        useUiStore.getState().select(null);
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    }}>
      <h2>Factory General</h2><p>{order.description}</p><p>{order.supportDepartment} · {formatDay(new Date(order.day + 'T12:00:00'))} · {order.plannedHours} planned labour hours</p>
      <p>Drag operators to Factory General before selecting the crew. Hours are the total across the selected crew.</p>
      <fieldset disabled={!unlocked}><legend>Crew</legend>{board.workers.filter(w => selected.includes(String(w.id)) || (w.onShift && !w.plannedLeave?.includes(today) && workerLines[String(w.id)] === 'FACTORY_GENERAL')).map(w =>
        <label key={String(w.id)}><input name="worker" type="checkbox" value={String(w.id)} defaultChecked={selected.includes(String(w.id))} />{w.name}</label>)}</fieldset>
      <label>Total labour hours on {formatDay(board.today)}<input disabled={!unlocked} name="hours" type="number" min="0" step="0.25" defaultValue={existing?.laborHours ?? ''} required /></label>
      <label>Notes<textarea disabled={!unlocked} name="notes" defaultValue={existing?.notes ?? ''} maxLength={2000} /></label>
      <label><input disabled={!unlocked} name="closed" type="checkbox" defaultChecked={existing?.jobCompleted} />Support order complete</label>
      {error && <p role="alert">{error}</p>}
      <div><Button type="button" onClick={() => useUiStore.getState().select(null)}>Close</Button> <Button disabled={!unlocked} type="submit">Save daily hours</Button></div>
    </form>
  </div>;
}
