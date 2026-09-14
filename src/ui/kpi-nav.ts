/**
 * The two KPI departments, drawn as the first two buttons of the KPI toolbar.
 *
 * They used to be their own band above the page — a second row of navigation,
 * in a third style, directly under the top bar's own — so the screen opened
 * with three stacked strips of links before any number appeared. They are the
 * same kind of choice as the period tabs beside them (which slice of the
 * factory am I looking at, over which window), so they are the same control:
 * one row, one style, department first because it decides what the rest of
 * the row even means.
 *
 * Anchors rather than buttons: the hash is the route, and `main.ts` already
 * listens for it, so this needs no wiring and a long-press still offers
 * "open in new tab".
 *
 * Its own module because both KPI pages draw it and they already depend on
 * each other in one direction — `kpi.ts` mounts the Assembly page — so putting
 * it in either one would close the loop.
 */

export type KpiDepartment = 'pmd' | 'assembly';

const TABS: Array<{ key: KpiDepartment; label: string; hash: string }> = [
  { key: 'pmd', label: 'PMD', hash: '#/kpi' },
  { key: 'assembly', label: 'Assembly', hash: '#/kpi/assembly' },
];

export function departmentTabs(active: KpiDepartment): string {
  return TABS.map(
    (t) =>
      `<a class="shift-btn kpi-dept${t.key === active ? ' a' : ''}" href="${t.hash}"${
        t.key === active ? ' aria-current="page"' : ''
      }>${t.label}</a>`,
  ).join('');
}
