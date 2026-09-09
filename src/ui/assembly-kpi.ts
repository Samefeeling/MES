import type { AssemblyDataLayer } from '../types/assembly';
import { assemblyMetrics } from '../core/assembly-metrics';
import { escapeHtml } from './modal';

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const au = (day: string): string => /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10).split('-').reverse().join('/') : '—';
const parse = (text: string): string => {
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!parts) throw new Error('Enter dates as dd/mm/yyyy.');
  const day = `${parts[3]}-${parts[2]}-${parts[1]}`;
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime()) || localDay(d) !== day) throw new Error('Enter a valid calendar date.');
  return day;
};

export async function renderAssemblyKpi(dal: AssemblyDataLayer): Promise<void> {
  const app = document.getElementById('app')!;
  const today = new Date();
  const first = new Date(today); first.setDate(today.getDate() - 6);
  app.innerHTML = `<section class="assembly-kpi"><h2>Assembly results</h2>
    <form><label>From <input name="from" aria-label="From date" value="${au(localDay(first))}" placeholder="dd/mm/yyyy" /></label>
    <label>To <input name="to" aria-label="To date" value="${au(localDay(today))}" placeholder="dd/mm/yyyy" /></label>
    <button type="submit">Refresh</button></form><div data-results aria-live="polite"></div></section>`;
  const host = app.querySelector<HTMLElement>('[data-results]')!;
  const form = app.querySelector('form')!;
  let request = 0;
  async function load(): Promise<void> {
    const current = ++request;
    host.textContent = 'Loading Assembly results…';
    try {
      const data = new FormData(form);
      const from = parse(String(data.get('from'))), to = parse(String(data.get('to')));
      if (from > to) throw new Error('From must be on or before To.');
      const rows = await dal.results(from, to);
      if (current !== request || !host.isConnected) return;
      const metrics = assemblyMetrics(rows);
      host.innerHTML = `<div class="assembly-summary">${Object.entries({ Orders: metrics.orders, 'Support orders': metrics.supportOrders, 'Support hours': metrics.supportHours, 'Shift output': metrics.output,
        Complete: metrics.complete, Reject: metrics.reject, Rework: metrics.rework, 'Completed orders': metrics.completedOrders })
        .map(([label, n]) => `<div><small>${label}</small><strong>${n.toLocaleString('en-AU')}</strong></div>`).join('')}</div>
        <p>Daily booked quantities. Completed orders are counted once within the selected period.</p>
        ${rows.length ? `<div class="assembly-results-scroll"><table><thead><tr><th>Date</th><th>Order</th><th>Line</th><th>Support department</th><th>Work</th><th>Labour hours</th><th>Crew</th><th>Output</th><th>Complete</th><th>Reject</th><th>Rework</th><th>Due</th><th>Completed</th></tr></thead><tbody>${rows.map(row => `<tr>
          <td>${au(row.day)}</td><td>${escapeHtml(row.job)}</td><td>${escapeHtml(row.line)}</td><td>${escapeHtml(row.supportDepartment ?? '')}</td><td>${escapeHtml(row.description ?? '')}</td><td>${row.workType === 'Support' ? row.laborHours ?? 0 : '—'}</td><td>${escapeHtml(row.operators)}</td>
          <td>${row.output}</td><td>${row.complete}</td><td>${row.reject}</td><td>${row.rework}</td><td>${row.due ? au(row.due) : '—'}</td><td>${row.completed ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No Assembly results in this period.</p>'}`;
    } catch (e) {
      if (current === request && host.isConnected) host.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void load(); });
  await load();
}
