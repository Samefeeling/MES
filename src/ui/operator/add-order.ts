// Operator sheet — adding an order the planning extract does not carry.
import { isSupervisor } from '../supervisor-auth';
import { dalRef, S, saveView } from './state';
import { openModal, closeModal } from '../modal';
import { toast } from '../toast';
import { reload } from './data';

// ---------------------------------------------------------------------
// Manual order entry (PMD_ManualOrders) — supervisor-only escape hatch
// for a job the Epicor planning extract doesn't carry yet (rush order,
// extract lag). The order persists to SharePoint so every press's Job#
// dropdown sees it for up to 48 hours; once Epicor picks the job up, the
// ERP row wins sooner.

export function openAddOrderModal(): void {
  if (!isSupervisor() || !dalRef.createManualOrder) return;
  const mc = openModal(`<div class="bd-modal add-ord-modal">
    <h2 class="bd-title">➕ Add order manually</h2>
    <p class="bd-sub">For a job that's missing from the Epicor planning extract. It appears in every press's Job# list for up to 48 hours, or until Epicor catches up and its ERP row takes over.</p>
    <div class="dcl-row">
      <label>Job # *<input type="text" data-ao="job" placeholder="e.g. SFM507147" autocomplete="off"></label>
      <label>Part #<input type="text" data-ao="part" placeholder="e.g. 400.410.70" autocomplete="off"></label>
    </div>
    <div class="dcl-row">
      <label>Product description<input type="text" data-ao="desc" autocomplete="off"></label>
      <label>Order Qty *<input type="number" data-ao="qty" min="1" step="1" inputmode="numeric"></label>
    </div>
    <div class="bd-actions">
      <button class="btn-primary-big" data-ao-save>Add order</button>
      <button class="btn-ghost-big" data-ao-cancel>Cancel</button>
    </div>
  </div>`);
  mc.querySelector('[data-ao-cancel]')?.addEventListener('click', () => closeModal());
  mc.querySelector<HTMLButtonElement>('[data-ao-save]')?.addEventListener('click', () => {
    void (async () => {
      const v = (k: string): string =>
        (mc.querySelector<HTMLInputElement>(`[data-ao="${k}"]`)?.value ?? '').trim();
      const job = v('job');
      const qty = Math.floor(Number(v('qty')) || 0);
      if (!job) {
        toast('Job # is required', 'warn');
        return;
      }
      if (S!.planning.some((o) => o.jobNumber.trim().toUpperCase() === job.toUpperCase())) {
        toast(`${job} is already in the order list — pick it from the Job# dropdown`, 'warn');
        return;
      }
      if (qty <= 0) {
        toast('Order Qty must be a positive number', 'warn');
        return;
      }
      const btn = mc.querySelector<HTMLButtonElement>('[data-ao-save]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Adding…';
      }
      try {
        const created = await dalRef.createManualOrder!({
          jobNumber: job,
          partNumber: v('part'),
          partDescription: v('desc'),
          orderQty: qty,
        });
        S!.planning.push(created);
        S!.selJob = created.jobNumber;
        saveView();
        closeModal();
        toast(`Order ${created.jobNumber} added — selectable on every press for 48 hours`, 'ok');
        void reload();
      } catch (e) {
        console.error('[pmd] manual order add failed:', e);
        toast(`Could not add: ${e instanceof Error ? e.message : e}`, 'err');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Add order';
        }
      }
    })();
  });
}
