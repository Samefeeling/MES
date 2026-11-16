// Operator sheet — the display zoom: fit to the screen, or a size picked by hand.
import { renderNowLine } from './render';

// ===== Display zoom — scales the WHOLE operator page =====
// The − / % / + control in the action bar sets CSS `zoom` on .op-sheet
// via the --disp-zoom var (see styles.css), so the action bar, meta,
// grid, side panel and legend all scale together. DEFAULT is auto-fit:
// pick the zoom (≤100%) that puts the whole sheet — every D01–D10
// defect row included — on screen with no vertical scroll, sized for
// the 10" iPad 9 the floor runs. − / + switch to a fixed manual zoom;
// tapping the % readout goes back to auto-fit. The choice is persisted
// per DEVICE in localStorage (not per tab) so a floor iPad keeps its
// size across reloads and asset redeploys. Distinct from the retired
// +/− viewLevel zoom, which switched detail↔summary views.
const DISP_ZOOM_KEY = 'pmd_disp_zoom_v1';

const DISP_ZOOM_MIN = 0.6;

const DISP_ZOOM_MAX = 1.5;

const DISP_ZOOM_STEP = 0.1;

/** Clamp + snap a display-zoom factor to the 0.6–1.5 range in 0.1 steps.
 *  Pure — exported for tests. Non-finite input falls back to 1. */
export function clampDispZoom(v: number): number {
  if (!isFinite(v)) return 1;
  const snapped = Math.round(v * 10) / 10;
  return Math.min(DISP_ZOOM_MAX, Math.max(DISP_ZOOM_MIN, snapped));
}

/** Auto-fit zoom: what factor puts a sheet of natural height `sheetH`
 *  inside `availH` of viewport? Never enlarges past 100%; floor 0.6
 *  (below that text is unreadable — past the floor the PAGE scrolls
 *  instead). NOT snapped to
 *  0.1 steps: snapping up would overflow, snapping down wastes space.
 *  Pure — exported for tests. */
export function fitDispZoom(availH: number, sheetH: number): number {
  if (!isFinite(availH) || !isFinite(sheetH) || sheetH <= 0 || availH <= 0) return 1;
  return Math.min(1, Math.max(DISP_ZOOM_MIN, availH / sheetH));
}

/** 'fit' = auto-fit (default); a number = operator-chosen fixed zoom. */
type DispZoomPref = number | 'fit';

let dispZoomPref: DispZoomPref = ((): DispZoomPref => {
  try {
    const raw = localStorage.getItem(DISP_ZOOM_KEY);
    if (raw != null && raw !== 'fit') return clampDispZoom(Number(raw));
  } catch {
    /* storage blocked — best effort */
  }
  return 'fit';
})();

/** Effective factor currently painted — what renderNowLine divides by. */
export let dispZoom = 1;

function saveDispZoomPref(): void {
  try {
    localStorage.setItem(DISP_ZOOM_KEY, String(dispZoomPref));
  } catch {
    /* storage blocked — zoom still applies for this page load */
  }
}

/** Natural (zoom:1) height of the sheet — the grid is uncapped, so every
 *  D-row already counts toward it; the .measuring class just pins the
 *  zoom to 1 so the reading is scale-free. */
function measureFitZoom(): number {
  const sheet = document.querySelector<HTMLElement>('.op-sheet');
  if (!sheet) return 1;
  sheet.classList.add('measuring');
  const sheetH = sheet.getBoundingClientRect().height;
  sheet.classList.remove('measuring');
  // Chrome above + .vw padding below never scale — subtract at face value.
  // The top bar is position:sticky, so its offsetHeight is scroll-stable.
  const topBar = document.querySelector<HTMLElement>('.top');
  const availH = window.innerHeight - (topBar?.offsetHeight ?? 56) - 28;
  return fitDispZoom(availH, sheetH);
}

/** Resolve the pref to an effective factor, paint it, sync the % label.
 *  Call AFTER the sheet is in the DOM — auto-fit measures the real thing. */
export function applyDispZoom(): void {
  dispZoom = dispZoomPref === 'fit' ? measureFitZoom() : dispZoomPref;
  document.body.style.setProperty('--disp-zoom', String(dispZoom));
  // The grid's pinned header rows park under the sticky top bar; its real
  // height feeds their sticky offsets (see the --topbar-h rules in CSS).
  const topBar = document.querySelector<HTMLElement>('.top');
  if (topBar) document.body.style.setProperty('--topbar-h', `${topBar.offsetHeight}px`);
  const lbl = document.querySelector('.ab-zoom-val');
  if (lbl) lbl.textContent = dispZoomLabel();
}

export function dispZoomLabel(): string {
  const pct = `${Math.round(dispZoom * 100)}%`;
  return dispZoomPref === 'fit' ? `⛶ ${pct}` : `🔍 ${pct}`;
}

/** Back to auto-fit: the sheet sized to the screen it is on. */
export function fitDispZoomToScreen(): void {
  dispZoomPref = 'fit';
  saveDispZoomPref();
  applyDispZoom();
}

export function stepDispZoom(dir: 1 | -1): void {
  // Stepping leaves auto-fit: the operator is taking manual control,
  // starting from whatever factor is currently on screen.
  dispZoomPref = clampDispZoom(dispZoom + dir * DISP_ZOOM_STEP);
  saveDispZoomPref();
  applyDispZoom();
}

// Auto-fit tracks the viewport: re-measure on rotate / split-view resize.
// Manual zoom is a fixed choice — resize leaves it alone. (typeof guard:
// this module is imported by node-environment unit tests.)
let dispZoomResizeTimer: ReturnType<typeof setTimeout> | undefined;

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (dispZoomPref !== 'fit' || !document.querySelector('.op-sheet')) return;
    clearTimeout(dispZoomResizeTimer);
    dispZoomResizeTimer = setTimeout(() => {
      applyDispZoom();
      renderNowLine();
    }, 150);
  });
}
