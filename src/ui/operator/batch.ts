// Operator sheet — hot stamp batches: orders run together and signed off as
// one list. The rule that shares the press time out is core/hs-batch.
//
// While a batch runs, the sheet keeps ONE timeline: the first order's. Its
// canonical slot 0 carries the other orders (`batchJobs`), which is how every
// device that opens HS knows about them. The other orders have no records of
// their own until sign-off, when each gets its block of the timeline, its
// Good and Reject, and is signed like any order.
import { S, dalRef } from './state';
import { canonical, orderForJob, parseRejects, shiftOrders, sid, isPastShift, isFutureShift } from './sheet';
import {
  isReadOnlyDevice,
  needsConfirm,
  reload,
  upsertSlotForJob,
  upsertSlotNoReload,
} from './data';
import { isJobLocked } from './lock';
import { render } from './render';
import { toast } from '../toast';
import { closeModal, escapeHtml, openModal } from '../modal';
import { isSupervisor, clearSupervisor } from '../supervisor-auth';
import { SLOT_MINUTES } from '../../core/shifts';
import {
  canBatch,
  formatBatchJobs,
  parseBatchJobs,
  splitBatchSlots,
  type BatchOrder,
} from '../../core/hs-batch';
import type { PlanningOrder, ProductionRecord } from '../../types';

const canonOf = (job: string): ProductionRecord | undefined =>
  S!.prod.find((r) => r.jobNumber === job && r.slotIndex === 0);

const lockedJob = (job: string): boolean => S!.prod.some((r) => r.jobNumber === job && r.locked);

/** The job has half-hours of its own this shift — it ran as an order of its own. */
const hasOwnTimeline = (job: string): boolean => S!.prod.some((r) => r.jobNumber === job && r.statusCode);

/**
 * The orders running with `job` in its batch, still waiting to be shared out:
 * named on its canonical slot, and neither signed nor holding half-hours of
 * their own (once they do, the batch has been taken apart into ordinary
 * orders, as a sign-off that stopped half-way leaves it).
 */
export function batchCompanions(job: string = S!.selJob): string[] {
  if (!job || !canBatch(S!.mc)) return [];
  return parseBatchJobs(canonOf(job)?.batchJobs).filter((j) => j !== job && !lockedJob(j) && !hasOwnTimeline(j));
}

/** The first order of the open batch `job` runs in, or null. */
export function batchPrimaryFor(job: string): string | null {
  if (!job || !canBatch(S!.mc)) return null;
  for (const r of S!.prod) {
    if (r.slotIndex !== 0 || r.jobNumber === job || lockedJob(r.jobNumber)) continue;
    if (batchCompanions(r.jobNumber).includes(job)) return r.jobNumber;
  }
  return null;
}

/** Orders that may join the selected one: HS's own list, not running elsewhere. */
function eligibleOrders(): PlanningOrder[] {
  const taken = new Set<string>();
  for (const r of S!.prod) {
    if (r.slotIndex === 0 && r.jobNumber !== S!.selJob) {
      for (const j of batchCompanions(r.jobNumber)) taken.add(j);
    }
  }
  return shiftOrders().filter(
    (o) =>
      o.jobNumber !== S!.selJob &&
      !o.isDieChange &&
      !lockedJob(o.jobNumber) &&
      !hasOwnTimeline(o.jobNumber) &&
      !taken.has(o.jobNumber),
  );
}

/** Why the batch cannot be changed right now, or '' when it can. */
function batchEditBlocked(): string {
  if (!S!.selJob) return 'Pick a Job# first';
  if (isReadOnlyDevice()) return 'Read only — sign in as supervisor to edit';
  if (isPastShift() && !isSupervisor()) return 'Past shift — sign in as supervisor to edit';
  if (isFutureShift()) return "This shift hasn't started yet";
  if (isJobLocked()) return 'Order signed off — Unlock as supervisor to edit';
  if (needsConfirm()) return 'Tap ✅ Confirm first — order, press, operator & supervisor';
  return '';
}

/**
 * The batch row beside Job#, on HS only: the orders running with this one,
 * each removable, and ＋ Run together to add more. Nothing on other presses,
 * or with no order picked.
 */
export function batchBadge(): string {
  if (!canBatch(S!.mc) || !S!.selJob || lockedJob(S!.selJob)) return '';
  const companions = batchCompanions();
  const blocked = batchEditBlocked();
  const chips = companions
    .map(
      (j) =>
        `<span class="batch-chip">${escapeHtml(j)}${
          blocked
            ? ''
            : `<button type="button" data-batch-remove="${escapeHtml(j)}" aria-label="Take ${escapeHtml(j)} out of the batch" title="Take ${escapeHtml(j)} out of the batch">×</button>`
        }</span>`,
    )
    .join('');
  const add = blocked
    ? ''
    : `<button type="button" class="batch-add" data-batch-pick title="Run other HS orders together with ${escapeHtml(
        S!.selJob,
      )} and sign them off as one list">＋ Run together</button>`;
  if (!chips && !add) return '';
  return `<span class="m-batch" title="Hot stamp batch: these orders run together on this order's timeline. Sign off enters each order's Good and Reject; the running time is shared by Good + Reject, in plan order.">${
    chips ? '⛓ Batch' : ''
  }${chips}${add}</span>`;
}

async function saveBatch(jobs: string[]): Promise<void> {
  const blocked = batchEditBlocked();
  if (blocked) {
    toast(blocked, 'warn');
    return;
  }
  // Written in plan order, so the list reads the way the blocks will fall.
  const rank = new Map(shiftOrders().map((o, i) => [o.jobNumber, i]));
  const sorted = [...jobs].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  const had = canonical()?.batchJobs;
  await upsertSlotNoReload(0, (r) => {
    // '' once it has been set: the column is cleared rather than left behind.
    r.batchJobs = sorted.length ? formatBatchJobs(sorted) : had !== undefined ? '' : undefined;
  });
  render();
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
}

/** The ＋ Run together picker: tick the HS orders to run with this one. */
export function openBatchPicker(): void {
  const blocked = batchEditBlocked();
  if (blocked) {
    toast(blocked, 'warn');
    return;
  }
  const current = new Set(batchCompanions());
  const options = [...eligibleOrders()];
  const when = (o: PlanningOrder): string => {
    const d = new Date(o.plannedStart);
    return Number.isFinite(d.getTime())
      ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(
          d.getHours(),
        ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : '—';
  };
  const mc = openModal(`<div class="bd-modal batch-modal">
    <h2 class="bd-title">⛓ Run together with ${escapeHtml(S!.selJob)}</h2>
    <p class="bd-sub">Tick the HS orders running on this set-up. They share this order's timeline; at sign-off you enter each one's Good and Reject, and the running time is shared out by Good + Reject, in plan order.</p>
    ${
      options.length
        ? `<div class="batch-pick-list">${options
            .map(
              (o) => `<label class="batch-pick">
                <input type="checkbox" value="${escapeHtml(o.jobNumber)}"${current.has(o.jobNumber) ? ' checked' : ''}>
                <b>${escapeHtml(o.jobNumber)}</b>
                <span>${escapeHtml(o.partNumber || '—')}</span>
                <span class="batch-pick-desc">${escapeHtml(o.partDescription || '')}</span>
                <span>Qty ${o.orderQty || '—'}</span>
                <span>${when(o)}</span>
              </label>`,
            )
            .join('')}</div>`
        : '<p class="bd-sub"><b>No other HS order can join</b> — every order in the Job# list is already running, signed off or in another batch.</p>'
    }
    <div class="bd-actions">
      <button class="btn-ghost-big" data-cancel>Cancel</button>
      <button class="btn-primary-big" data-batch-save${options.length ? '' : ' disabled'}>Save</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-batch-save]')?.addEventListener('click', () => {
    const jobs = [...mc.querySelectorAll<HTMLInputElement>('.batch-pick input:checked')].map((i) => i.value);
    closeModal();
    void saveBatch(jobs).then(() =>
      toast(jobs.length ? `Running together: ${S!.selJob}, ${jobs.join(', ')}` : 'Batch cleared', 'ok'),
    );
  });
}

/** Take one order out of the batch. */
export function removeFromBatch(job: string): void {
  void saveBatch(batchCompanions().filter((j) => j !== job));
}

// ---- Sign-off --------------------------------------------------------

const fmtHours = (slots: number): string => {
  const mins = slots * SLOT_MINUTES;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;
};

/** A planned start as a sortable instant; '' when it has none. */
const planKey = (o: PlanningOrder | undefined): string => {
  const t = Date.parse(o?.plannedStart ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};

/** The reject code entered most on the first order's rows, for its default reason. */
function topRejectCode(job: string): string {
  const by = new Map<string, number>();
  for (const r of S!.prod.filter((x) => x.jobNumber === job)) {
    for (const [code, n] of Object.entries(parseRejects(r))) by.set(code, (by.get(code) ?? 0) + (Number(n) || 0));
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

let batchInFlight = false;

/**
 * Sign off a batch: one list, one confirm. The gates every sign-off passes
 * (supervisor picked, timeline filled, die change logged) have run already;
 * Count Start / End are not asked for — the list is the record.
 */
export function openBatchSignoffModal(): void {
  const primary = S!.selJob;
  const jobs = [primary, ...batchCompanions(primary)];
  // Listed in plan order — the order the blocks of time will fall in.
  const rows = jobs
    .map((job, i) => ({ job, order: orderForJob(job), i }))
    .sort((a, b) => {
      const pa = planKey(a.order);
      const pb = planKey(b.order);
      if (pa && pb && pa !== pb) return pa < pb ? -1 : 1;
      if (!pa !== !pb) return pa ? -1 : 1;
      return a.i - b.i;
    });
  const totalRej = S!.prod
    .filter((r) => r.jobNumber === primary)
    .reduce((a, r) => a + Object.values(parseRejects(r)).reduce((x, v) => x + (Number(v) || 0), 0), 0);
  const topCode = topRejectCode(primary);
  const codes = S!.rejCats;
  const reasonOpts = (selected: string): string =>
    `<option value="">—</option>` +
    codes
      .map(
        (c) =>
          `<option value="${escapeHtml(c.code)}"${c.code === selected ? ' selected' : ''}>${escapeHtml(
            `${c.code} ${c.label}`,
          )}</option>`,
      )
      .join('');
  const mc = openModal(`<div class="bd-modal batch-modal">
    <h2 class="bd-title">✅ Sign off batch</h2>
    <p class="bd-sub">${escapeHtml(sid())} · ${escapeHtml(S!.mc)} · ${jobs.length} orders · Supervisor <b>${escapeHtml(
      S!.selSupervisor,
    )}</b></p>
    <p class="bd-sub">Enter each order's <b>Good</b> and <b>Reject</b> (0 if none). The running time is shared by Good + Reject, in plan order, in half-hours; an order with nothing entered is left out and stays open.</p>
    <div class="batch-table-wrap">
      <table class="batch-table">
        <thead><tr><th>Order</th><th>Part</th><th class="num">Order Qty</th><th class="num">Good</th><th class="num">Reject</th><th>Reason</th><th class="num" title="Running time this order is given">Run time</th></tr></thead>
        <tbody>${rows
          .map(
            ({ job, order }) => `<tr data-batch-row="${escapeHtml(job)}">
              <td><b>${escapeHtml(job)}</b>${job === primary ? ' <span class="batch-first" title="The order the batch ran on">first</span>' : ''}</td>
              <td class="batch-part" title="${escapeHtml(order?.partDescription ?? '')}">${escapeHtml(order?.partNumber || '—')}</td>
              <td class="num">${order && order.orderQty ? order.orderQty : '—'}</td>
              <td class="num"><input type="number" inputmode="numeric" min="0" step="1" data-good placeholder="Good"></td>
              <td class="num"><input type="number" inputmode="numeric" min="0" step="1" data-reject value="${
                job === primary && totalRej ? totalRej : ''
              }" placeholder="0"></td>
              <td><select data-reason>${reasonOpts(job === primary ? topCode : '')}</select></td>
              <td class="num" data-share>—</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>
    <p class="batch-error" role="alert" data-batch-error></p>
    <p class="bd-sub">By signing off you confirm these figures and lock every order's record.</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-cancel>Cancel</button>
      <button class="btn-primary-big" data-batch-confirm>Sign off ${jobs.length} orders as ${escapeHtml(S!.selSupervisor)}</button>
    </div>
  </div>`);

  const timeline = S!.prod
    .filter((r) => r.jobNumber === primary)
    .map((r) => ({ slotIndex: r.slotIndex, statusCode: r.statusCode }));
  const read = (): { orders: (BatchOrder & { reason: string })[]; missing: string[] } => {
    const orders: (BatchOrder & { reason: string })[] = [];
    const missing: string[] = [];
    for (const { job, order } of rows) {
      const tr = mc.querySelector<HTMLTableRowElement>(`[data-batch-row="${CSS.escape(job)}"]`)!;
      const goodRaw = tr.querySelector<HTMLInputElement>('[data-good]')!.value.trim();
      const rejRaw = tr.querySelector<HTMLInputElement>('[data-reject]')!.value.trim();
      if (goodRaw === '') missing.push(job);
      orders.push({
        job,
        plannedStart: planKey(order),
        good: Math.max(0, Math.floor(Number(goodRaw) || 0)),
        reject: Math.max(0, Math.floor(Number(rejRaw) || 0)),
        reason: tr.querySelector<HTMLSelectElement>('[data-reason]')!.value,
      });
    }
    return { orders, missing };
  };
  const errorEl = mc.querySelector<HTMLElement>('[data-batch-error]')!;
  const preview = (): void => {
    const { orders } = read();
    const res = splitBatchSlots(timeline, orders);
    for (const o of orders) {
      const cell = mc.querySelector<HTMLElement>(`[data-batch-row="${CSS.escape(o.job)}"] [data-share]`)!;
      cell.textContent = res.ok
        ? res.split.runSlots[o.job]
          ? fmtHours(res.split.runSlots[o.job])
          : 'left out'
        : '—';
    }
  };
  mc.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', preview));
  preview();
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  const confirmBtn = mc.querySelector<HTMLButtonElement>('[data-batch-confirm]')!;
  confirmBtn.addEventListener('click', () => {
    if (confirmBtn.disabled) return;
    const { orders, missing } = read();
    const fail = (msg: string): void => {
      errorEl.textContent = msg;
    };
    if (missing.length) return fail(`Enter Good for ${missing.join(', ')} — 0 if it made none.`);
    const noReason = orders.filter((o) => o.reject > 0 && !o.reason).map((o) => o.job);
    if (noReason.length) return fail(`Pick a reject reason for ${noReason.join(', ')}.`);
    const first = orders.find((o) => o.job === primary)!;
    if (first.good + first.reject === 0) {
      return fail(`${primary} is the order the batch ran on — it needs its Good or Reject. Take it out by starting the batch from an order that ran.`);
    }
    const res = splitBatchSlots(timeline, orders);
    if (!res.ok) return fail(res.error);
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Saving…';
    void applyBatchSignoff(primary, orders, res.split.owner, res.split.jobs).then((ok) => {
      if (!ok) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = `Sign off ${jobs.length} orders as ${S!.selSupervisor}`;
      }
    });
  });
}

/**
 * Write the shares and sign each order. Every record is written before any
 * order is signed, and each order's records are a whole ordinary order by
 * then — so if SharePoint fails half-way, what is left unsigned is a set of
 * ordinary orders that sign off one by one from the Job# list.
 */
async function applyBatchSignoff(
  primary: string,
  orders: (BatchOrder & { reason: string })[],
  owner: Map<number, string>,
  recorded: string[],
): Promise<boolean> {
  if (batchInFlight) return false;
  batchInFlight = true;
  const signed: string[] = [];
  // Set once the first half-hour moves: from then on the batch is being
  // taken apart, and a retry from this dialog would share out a timeline
  // that is no longer the batch's.
  let split = false;
  try {
    const byJob = new Map(orders.map((o) => [o.job, o]));
    const batch = formatBatchJobs(recorded);
    const write = (job: string, slot: number, mut: (r: ProductionRecord) => void): Promise<void> =>
      job === primary ? upsertSlotNoReload(slot, mut) : upsertSlotForJob(job, slot, mut);
    const people = (r: ProductionRecord): void => {
      r.operator = S!.selOperator;
      r.supervisor = S!.selSupervisor;
    };
    // 1. Each half-hour onto its order; off the first order where it moved.
    //    The sheet's reject entries were the batch's, not one order's: they
    //    are replaced by the list below.
    split = true;
    for (const rec of S!.prod.filter((r) => r.jobNumber === primary).map((r) => ({ ...r }))) {
      const to = owner.get(rec.slotIndex) ?? primary;
      if (to !== primary) {
        await write(to, rec.slotIndex, (r) => {
          r.statusCode = rec.statusCode;
          r.bdIssue = rec.bdIssue;
          r.bdCause = rec.bdCause;
          r.mangoTicket = rec.mangoTicket;
          r.qcBy = rec.qcBy;
          r.rejects = '{}';
          people(r);
        });
      }
      await write(primary, rec.slotIndex, (r) => {
        if (to !== primary) {
          r.statusCode = '';
          r.bdIssue = '';
          r.bdCause = '';
          r.mangoTicket = '';
          r.qcBy = '';
        }
        r.rejects = '{}';
      });
    }
    // 2. Each order's figures: Good + Reject as the count (one piece a
    //    count), its reject on the last half-hour of its block, and the
    //    batch it ran in.
    for (const job of recorded) {
      const o = byJob.get(job)!;
      const slots = [...owner.entries()].filter(([, j]) => j === job).map(([s]) => s);
      const last = Math.max(...slots);
      if (o.reject > 0) {
        await write(job, last, (r) => {
          r.rejects = JSON.stringify({ [o.reason]: o.reject });
        });
      }
      await write(job, 0, (r) => {
        r.countStart = 0;
        r.countEnd = o.good + o.reject;
        r.cavities = 1;
        r.batchJobs = batch;
        people(r);
      });
    }
    // 3. Sign each, in plan order.
    for (const job of recorded) {
      await dalRef.lockShift(
        S!.mc,
        sid(),
        S!.selSupervisor,
        S!.selOperator,
        job,
        job === primary ? (canonical()?.jobLeft ?? null) : null,
      );
      signed.push(job);
    }
    closeModal();
    const left = orders.filter((o) => !recorded.includes(o.job)).map((o) => o.job);
    toast(
      `Signed off batch: ${recorded.join(', ')}${left.length ? ` · ${left.join(', ')} left open (nothing entered)` : ''}`,
      'ok',
    );
    if (isSupervisor()) clearSupervisor();
    await reload();
    return true;
  } catch (e) {
    console.error('[batch signoff] failed:', e);
    const msg = (e as Error)?.message ?? String(e);
    const rest = recorded.filter((j) => !signed.includes(j));
    toast(
      split
        ? `Save failed: ${msg.slice(0, 120)}${signed.length ? ` · signed: ${signed.join(', ')}` : ''} · sign the rest one by one from the Job# list: ${rest.join(', ')}`
        : `Save failed: ${msg.slice(0, 140)}`,
      'err',
    );
    if (split) {
      // The records are split already: the rest are ordinary orders now,
      // each with its own half-hours and counts.
      closeModal();
      await reload();
      return true;
    }
    return false;
  } finally {
    batchInFlight = false;
  }
}
