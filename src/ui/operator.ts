import type { PmdDataLayer } from '../dal';
import type {
  Machine,
  Operator,
  PlanningOrder,
  ProductionRecord,
  RejectCategory,
  ShiftCode,
  StatusCode,
} from '../types';
import {
  SHIFTS,
  SLOTS_PER_SHIFT,
  buildShiftId,
  currentShift,
  currentSlotIndex,
  dateKey,
  msUntilShiftEnd,
  parseShiftId,
  previousShift,
  shiftBounds,
  slotClock,
} from '../core/shifts';
import { STATUSES, STATUS_MAP } from '../core/status';
import { cavityGross } from '../core/metrics';
import { ordersCoRun } from '../core/corun';
// Re-exported so existing importers (Trace view, tests) can keep pulling
// these from ./operator while the canonical definitions live in core.
import { jobLeftPiecesFor, shiftTargetFor } from '../core/targets';
export { jobLeftPiecesFor, shiftTargetFor } from '../core/targets';
import { sumOtherShiftGood, unsignedEarlierTuples } from '../core/jobgood';
import { bdLabelFor } from '../core/breakdown';
import { compareOrdersByStart } from '../core/planning';
import { type Handover, parseHandover as sharedParseHandover } from '../core/handover';
import { openBreakdownCascade } from './breakdown';
import { toast } from './toast';
import { closeModal, escapeHtml, openModal } from './modal';
import { renderOutputRejectChart } from './charts';
import { clearSupervisor, isSupervisor } from './supervisor-auth';
import { isIpadDevice } from '../core/device';
import { confirmTuple, isTupleConfirmed } from '../core/confirm';

/**
 * Device-class write rule (replaces the old per-device OwnerDevice claim
 * arbitration which caused fights between iPads on the floor):
 *   iPad → writable (it's the on-floor data-entry device)
 *   anything else → read-only, unless supervisor mode is signed in
 * Memoised iPad detection + live supervisor session → re-evaluated on
 * every call so a supervisor sign-in flips the UI immediately.
 */
function canWriteThisDevice(): boolean {
  return isIpadDevice() || isSupervisor();
}

/** Presses that can run a multi-cavity die — the only machines that show the
 *  Cavities dropdown on the operator sheet. Everywhere else the count is taken
 *  at face value (1 cavity). Edit this set if a die moves to another press. */
const CAVITY_MACHINES = new Set(['550T', '320T', '150T', '125T']);

/** Selectable cavity counts. A die makes this many identical parts per press
 *  cycle, so Total Good = (Count End − Count Start) × cavities − Reject. */
const CAVITY_OPTIONS = [1, 2, 4, 8];

function machineHasCavityOption(mc: string): boolean {
  return CAVITY_MACHINES.has(mc.trim());
}

// PMD Operator Production Sheet — Excel-style rebuild of modPMDOperator.bas.
// One machine + one shift + one job at a time. 16 half-hour slots horizontally;
// rows are: Machine Status / 10 defect rows (D01-D10).

interface OpState {
  mc: string;
  viewDate: Date;
  shiftCode: ShiftCode;
  selJob: string;
  prod: ProductionRecord[];
  planning: PlanningOrder[];
  machines: Machine[];
  /** Full roster objects (carry .shift) so the dropdowns can narrow to
   *  the selected shift's people — see rosterNames(). */
  operators: Operator[];
  supervisors: Operator[];
  rejCats: RejectCategory[];
  selOperator: string;
  selSupervisor: string;
  /** 1 = single-shift detail (editable); 2 = today's 3 shifts;
   *  3 = past 7 days; 4 = past 30 days. Levels 2-4 are read-only summaries. */
  viewLevel: number;
  /** Sum of Good across all shifts of selJob — drives the cross-shift Job Left. */
  jobTotalGood: number;
  /** "machine|shiftId" keys of EARLIER shifts of selJob that produced
   *  pieces but were never signed off. Job Left arithmetic is signed-only
   *  (see refreshJobTotal), so while this is non-empty the number
   *  OVERSTATES what's still needed — the ⚠ next to Job Left names the
   *  shift(s) that need signing. */
  unsignedEarlier: string[];
  /** Slots currently highlighted for status entry (tap or hold-and-drag). */
  selSet: Set<number>;
  /** Part # → die / paint hex colour + physical die number, read from
   *  PMD_ProductDieColor on boot. Drives the swatch on the Product
   *  Description meta cell + the Die# pill so the operator can see the
   *  colour and which die to fit before starting the job. */
  dieColors: Map<string, { hex: string; name: string; dieNumber: string; coRun: boolean }>;
}

let S: OpState | null = null;
let dalRef: PmdDataLayer;
let nowTimer: ReturnType<typeof setInterval> | undefined;
// Guard against a double Sign Off. On a laggy iPad the supervisor used
// to tap the confirm button repeatedly (no feedback while lockShift's
// slow network round-trip ran) — each tap fired a fresh lockShift, and
// because editCache is cleared only at the END of lockShift the MERGE
// lookup couldn't see the in-flight POSTed row yet, so every tap POSTed
// a NEW PMD_Production row (SFM507208 landed 11× identical). The confirm
// button is also disabled on click; this flag is the belt-and-braces.
let signoffInFlight = false;

// Per-tab persistence of which shift the operator was last looking at.
// Without this, switching to KPIs and back resets viewDate / shiftCode to
// today's live shift — and an iPad operator who'd been reviewing 02/06
// loses their place every time they tap a top-nav link by accident.
const UI_KEY = 'pmd_op_view_v1';
interface PersistedView {
  mc: string;
  viewDateIso: string;
  shiftCode: ShiftCode;
  selJob: string;
  selOperator: string;
  selSupervisor: string;
}
export function loadSavedOperatorView(): PersistedView | null {
  try {
    const raw = sessionStorage.getItem(UI_KEY);
    return raw ? (JSON.parse(raw) as PersistedView) : null;
  } catch {
    return null;
  }
}
function loadView(): PersistedView | null {
  return loadSavedOperatorView();
}
function saveView(): void {
  if (!S) return;
  try {
    sessionStorage.setItem(
      UI_KEY,
      JSON.stringify({
        mc: S.mc,
        viewDateIso: S.viewDate.toISOString(),
        shiftCode: S.shiftCode,
        selJob: S.selJob,
        selOperator: S.selOperator,
        selSupervisor: S.selSupervisor,
      }),
    );
  } catch {
    /* storage blocked — best effort */
  }
}

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
let dispZoom = 1;

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
function applyDispZoom(): void {
  dispZoom = dispZoomPref === 'fit' ? measureFitZoom() : dispZoomPref;
  document.body.style.setProperty('--disp-zoom', String(dispZoom));
  // The grid's pinned header rows park under the sticky top bar; its real
  // height feeds their sticky offsets (see the --topbar-h rules in CSS).
  const topBar = document.querySelector<HTMLElement>('.top');
  if (topBar) document.body.style.setProperty('--topbar-h', `${topBar.offsetHeight}px`);
  const lbl = document.querySelector('.ab-zoom-val');
  if (lbl) lbl.textContent = dispZoomLabel();
}

function dispZoomLabel(): string {
  const pct = `${Math.round(dispZoom * 100)}%`;
  return dispZoomPref === 'fit' ? `⛶ ${pct}` : `🔍 ${pct}`;
}

function stepDispZoom(dir: 1 | -1): void {
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

// ===== Voice dictation for the handover boxes =====
// A 🎤 button on each of the four handover boxes (Machine / Mold /
// Material / Method) live-transcribes speech into the textarea via the
// Web Speech API where the browser exposes it (desktop Edge/Chrome,
// Safari). iPad caveat: Edge on iOS is WebKit inside a WKWebView and
// does NOT expose the API to third-party browsers — there the button
// points the operator at the built-in fallback instead: the 🎤 dictation
// key on the iPad on-screen keyboard, which types into any focused
// text box (works in Edge, needs Settings → General → Keyboard →
// Enable Dictation).
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null;
}

let activeRec: SpeechRecognitionLike | null = null;
let activeMicField = '';

function stopDictation(): void {
  const rec = activeRec;
  activeRec = null; // clear FIRST — rec.stop() fires onend synchronously in some engines
  activeMicField = '';
  if (rec) {
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  }
  document.querySelectorAll('.mic-btn.rec').forEach((b) => b.classList.remove('rec'));
}

function toggleDictation(field: string, btn: HTMLButtonElement): void {
  if (activeMicField === field) {
    // Tapping the flashing mic ends the take; commit via the same save
    // path a keyboard blur uses.
    const ta = document.querySelector<HTMLTextAreaElement>(`textarea[data-meta="${field}"]`);
    stopDictation();
    if (ta) onMetaChange(ta);
    return;
  }
  stopDictation();
  const Ctor = speechCtor();
  if (!Ctor) {
    toast(
      'No voice input in this browser — use the 🎤 key on the iPad keyboard instead',
      'warn',
    );
    return;
  }
  const ta = document.querySelector<HTMLTextAreaElement>(`textarea[data-meta="${field}"]`);
  if (!ta || ta.disabled) return;
  const rec = new Ctor();
  rec.lang = 'en-AU';
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    // Re-query — a poll re-render may have swapped the textarea node out
    // from under a long dictation.
    const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-meta="${field}"]`);
    if (!el) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r.isFinal) continue;
      const text = r[0].transcript.trim();
      if (!text) continue;
      el.value = el.value ? `${el.value.replace(/\s+$/, '')} ${text}` : text;
    }
  };
  rec.onend = () => {
    // Engines auto-end after silence; commit whatever landed.
    if (activeMicField !== field) return;
    const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-meta="${field}"]`);
    stopDictation();
    if (el) onMetaChange(el);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast(
        'Microphone blocked — allow mic access for this site, or use the 🎤 key on the keyboard',
        'warn',
      );
    }
  };
  activeRec = rec;
  activeMicField = field;
  btn.classList.add('rec');
  try {
    rec.start();
  } catch {
    stopDictation();
  }
}

// ===== Defect photos → PMD_Production attachments =====
// 📷 button on the side panel opens the iPad camera (file input with
// capture — native in Edge/Safari on iOS, no getUserMedia needed). The
// shot is downscaled to ≤1600px JPEG and queued in localStorage, keyed
// to the (machine, shift, job) tuple on screen. The queue flushes to
// the tuple's PMD_Production row as list-item attachments — immediately
// when the row already exists (signed-off shift), otherwise right after
// Sign Off creates it. localStorage (not memory) so a tab reload during
// the shift doesn't lose the evidence photos.
const PHOTO_QUEUE_KEY = 'pmd_photo_queue_v1';
/** localStorage is ~5 MB; at ≤ ~400 KB per compressed photo, 8 leaves
 *  headroom for the edit cache that shares the store. */
const PHOTO_QUEUE_MAX = 8;

interface QueuedPhoto {
  mc: string;
  shiftId: string;
  job: string;
  name: string;
  dataUrl: string;
}

function loadPhotoQueue(): QueuedPhoto[] {
  try {
    return JSON.parse(localStorage.getItem(PHOTO_QUEUE_KEY) ?? '[]') as QueuedPhoto[];
  } catch {
    return [];
  }
}

function savePhotoQueue(q: QueuedPhoto[]): boolean {
  try {
    localStorage.setItem(PHOTO_QUEUE_KEY, JSON.stringify(q));
    return true;
  } catch {
    return false; // quota — caller decides how to break the news
  }
}

/** Downscale + re-encode a camera shot: ≤1600px on the long edge, JPEG
 *  q0.72 ≈ 200-400 KB — enough to read a defect, small enough to queue
 *  in localStorage and to keep the SP attachment upload quick on shop
 *  WiFi. imageOrientation:'from-image' bakes the EXIF rotation in; the
 *  catch retries without options for engines that reject the dictionary. */
async function compressPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() =>
    createImageBitmap(file),
  );
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.72);
}

function dataUrlToBlob(u: string): Blob {
  const [meta, b64] = u.split(',');
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function queuePhoto(file: File): Promise<void> {
  const dataUrl = await compressPhoto(file);
  const q = loadPhotoQueue();
  if (q.filter((p) => p.mc === S!.mc && p.shiftId === sid() && p.job === S!.selJob).length >= PHOTO_QUEUE_MAX) {
    toast(`Max ${PHOTO_QUEUE_MAX} photos per job — sign off to upload them first`, 'warn');
    return;
  }
  // SP attachment filenames can't take #%&*:<>?/\{|} — keep to word chars.
  const name = `PMD_${S!.mc}_${sid()}_${S!.selJob}_${Date.now()}.jpg`.replace(/[^\w.-]+/g, '_');
  q.push({ mc: S!.mc, shiftId: sid(), job: S!.selJob, name, dataUrl });
  if (!savePhotoQueue(q)) {
    toast('Photo storage full — sign off to upload the queued photos first', 'err');
    return;
  }
  renderPhotoStrip();
  if (isJobLocked()) {
    toast('Photo uploading to PMD_Production…', 'ok');
  } else {
    toast('Photo saved — uploads to PMD_Production at Sign off', 'ok');
  }
  void flushPhotoQueue();
}

let photoFlushInFlight = false;
let lastPhotoFlushAt = 0;

/** Try to attach every queued photo to its tuple's PMD_Production row.
 *  attachProductionPhoto returns false while the row doesn't exist yet
 *  (tuple not signed off) — those stay queued for the next pass. */
async function flushPhotoQueue(): Promise<void> {
  if (photoFlushInFlight || !dalRef.attachProductionPhoto) return;
  const q = loadPhotoQueue();
  if (q.length === 0) return;
  photoFlushInFlight = true;
  lastPhotoFlushAt = Date.now();
  try {
    const remain: QueuedPhoto[] = [];
    for (const p of q) {
      let done = false;
      try {
        done = await dalRef.attachProductionPhoto(
          p.mc,
          p.shiftId,
          p.job,
          p.name,
          dataUrlToBlob(p.dataUrl),
        );
      } catch (e) {
        // Transient (network / digest) — keep queued, next flush retries.
        console.warn('[photo] attachment upload failed, keeping queued:', e);
      }
      if (!done) remain.push(p);
    }
    if (remain.length !== q.length) {
      savePhotoQueue(remain);
      renderPhotoStrip();
    }
  } finally {
    photoFlushInFlight = false;
  }
}

/** Rebuild the side panel's photo strip: queued shots (amber, ⏳, ✕ to
 *  discard) then the tuple's already-uploaded attachments (tap to open).
 *  The upload half is async + best-effort — SP only. */
function renderPhotoStrip(): void {
  const strip = document.querySelector<HTMLElement>('[data-photo-strip]');
  if (!strip) return;
  const mc = S!.mc;
  const shiftId = sid();
  const job = S!.selJob;
  const queued = loadPhotoQueue().filter(
    (p) => p.mc === mc && p.shiftId === shiftId && p.job === job,
  );
  strip.innerHTML = queued
    .map(
      (p) =>
        `<span class="photo-thumb pending" title="Uploads to PMD_Production at Sign off"><img src="${p.dataUrl}" alt=""><button type="button" data-photo-del="${escapeHtml(p.name)}" title="Discard this photo">✕</button></span>`,
    )
    .join('');
  strip.querySelectorAll<HTMLButtonElement>('[data-photo-del]').forEach((b) =>
    b.addEventListener('click', () => {
      savePhotoQueue(loadPhotoQueue().filter((p) => p.name !== b.dataset.photoDel));
      renderPhotoStrip();
    }),
  );
  if (!dalRef.listProductionPhotos || !job) return;
  void (async () => {
    try {
      const up = await dalRef.listProductionPhotos!(mc, shiftId, job);
      // The operator may have switched tuple while we awaited.
      if (S!.mc !== mc || sid() !== shiftId || S!.selJob !== job) return;
      const cur = document.querySelector<HTMLElement>('[data-photo-strip]');
      if (!cur || up.length === 0) return;
      cur.insertAdjacentHTML(
        'beforeend',
        up
          .map(
            (a) =>
              `<a class="photo-thumb" href="${escapeHtml(a.url)}" target="_blank" rel="noopener" title="${escapeHtml(a.name)} — attached to PMD_Production"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}"></a>`,
          )
          .join(''),
      );
    } catch {
      /* listing attachments is cosmetic — never block the sheet on it */
    }
  })();
}

const SLOT_PX = 64; // touch target for the half-hour status cell on 10" iPad

const VIEW_LEVELS: Array<{ level: number; label: string }> = [
  { level: 1, label: 'Shift' },
  { level: 2, label: 'Today (3 shifts)' },
  { level: 3, label: 'Past 7 days' },
  { level: 4, label: 'Past 30 days' },
];

function sid(): string {
  return buildShiftId(S!.viewDate, S!.shiftCode);
}

function blankRecord(slot: number): ProductionRecord {
  return blankRecordForJob(slot, S!.selJob);
}

function blankRecordForJob(slot: number, job: string): ProductionRecord {
  const iso = new Date().toISOString();
  // Resolve the order for this job once so the slot carries
  // JobHead_PartNum — PMD_Production / PMD_LiveStatus persist the
  // colour-lookup key per row instead of relying on a planning join.
  // orderForJob() prefers PMD_Production for past shifts, so a
  // supervisor editing history still stamps the recorded Part #
  // rather than a blank (planning has long dropped the order).
  const order = orderForJob(job);
  const rec: ProductionRecord = {
    id: 0,
    machineCode: S!.mc,
    shiftId: sid(),
    jobNumber: job,
    partNumber: order?.partNumber ?? '',
    // Carry cycle time + the ORDER TOTAL so they persist through
    // editCache → live mirror → sign-off even if Epicor drops the order
    // from planning before the shift is signed. jobRequired here is the
    // total (orderQty), matching the PMD_Production.JobRequired column —
    // NOT Epicor's decremented remaining qty.
    cycleTime: order?.qtyPerHr ?? 0,
    jobRequired: order && order.orderQty > 0 ? order.orderQty : undefined,
    slotIndex: slot,
    statusCode: '',
    countStart: null,
    countEnd: null,
    rejectCount: 0,
    rejects: '{}',
    purgeKg: null,
    operator: S!.selOperator,
    supervisor: S!.selSupervisor,
    bdIssue: '',
    mangoTicket: '',
    handoverNote: '',
    qcBy: '',
    locked: false,
    lockedBy: '',
    lockedAt: '',
    createdAt: iso,
    updatedAt: iso,
  };
  // NOTE: Job Left / Shift Target are deliberately NOT stamped on the
  // record any more. The old "freeze at job start" snapshot captured
  // whatever the freezing device could see at that instant — stale live
  // shadows contaminated it, it round-tripped through PMD_LiveStatus to
  // every other device, and it could never self-correct (SFM507147's
  // phantom "200"). Both values are now derived on read from signed
  // PMD_Production rows, and the authoritative per-row columns are
  // recomputed from the same source at sign-off (see lockShift).
  return rec;
}

function isPastShift(): boolean {
  // A shift is "past" if its calendar date is strictly before today, OR
  // if it's today but earlier than the live shift. The Job# dropdown for
  // past shifts is restricted to jobs that were actually worked on, since
  // the planning list only reflects the current Epicor state.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (S!.viewDate < today) return true;
  if (S!.viewDate > today) return false;
  const liveShiftId = currentShift(new Date()).shiftId;
  return sid() !== liveShiftId;
}

/**
 * The selected shift hasn't started yet — its wall-clock start is still in
 * the future. The classic trap is a Night-shift supervisor working past
 * midnight who leaves the date on "today": a Night shift dated today doesn't
 * begin until 23:00 tonight, so production logged against it actually belongs
 * to the Night shift that started 23:00 *yesterday* (the one running now).
 * There is never real production for a shift that hasn't begun, so this is a
 * reliable mis-date signal. One local clock, same basis as currentShift().
 */
function isFutureShift(now: Date = new Date()): boolean {
  const b = shiftBounds(sid());
  return b ? now < b.start : false;
}

/** "29 Jun 23:00 → 30 Jun 07:00" — the physical period a shift covers, so a
 *  night that crosses midnight is unambiguous about which calendar day it is. */
function shiftWindowLabel(shiftId: string): string {
  const b = shiftBounds(shiftId);
  if (!b) return '';
  const day = (x: Date): string =>
    x.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
  const time = (x: Date): string =>
    x.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day(b.start)} ${time(b.start)} → ${day(b.end)} ${time(b.end)}`;
}

function shiftOrders(): PlanningOrder[] {
  // Historical jobs — every JobNum that appears on PMD_Production rows for
  // the currently-viewed shift. Always derived from S!.prod so it works for
  // both signed-off shifts and unsaved edits.
  const historicalIds = Array.from(
    new Set(S!.prod.map((r) => r.jobNumber).filter((j) => !!j)),
  );
  const historicalOrder = (j: string): PlanningOrder => {
    // Pull every denormalised field PMD_Production carries — the
    // canonical (slot 0) row is the truth for past shifts. Other
    // shifts on the same job (different machine / different shift)
    // also contribute partNumber via .find() so the dropdown still
    // names the part even if THIS shift's slot 0 hasn't been
    // canonical-row-ified yet.
    const canon = S!.prod.find((r) => r.jobNumber === j && r.slotIndex === 0);
    const anySlot = canon ?? S!.prod.find((r) => r.jobNumber === j);
    return {
      id: 0,
      jobNumber: j,
      machineCode: '',
      originalMachine: '',
      partNumber: anySlot?.partNumber ?? '',
      partDescription: canon?.partDescription ?? '(historical)',
      plannedStart: '',
      plannedEnd: '',
      // PMD_Production denormalises the order total into its JobRequired
      // column (see ProductionRecord.jobRequired) — surface it as both the
      // Order Qty total and the Job Left basis for orders Epicor has dropped.
      orderQty: canon?.jobRequired ?? 0,
      jobRequired: canon?.jobRequired ?? 0,
      // CycleTime persisted at sign-off → Shift Target recomputes for a
      // historical order even after Epicor drops it from planning.
      qtyPerHr: canon?.cycleTime ?? 0,
      duration: 0,
      released: false,
      isDieChange: false,
      manuallyAdded: true,
      source: 'Manual',
    };
  };

  // Past shifts: only show the jobs actually worked on — the planning list
  // reflects current Epicor state and would otherwise drown the dropdown
  // with unrelated active orders.
  if (isPastShift()) {
    return historicalIds.map(historicalOrder);
  }

  // Active / future shift: keep every planning order scheduled to start
  // by the end of a 2-day horizon (today + tomorrow on a live shift).
  // We only bound the FUTURE — Epicor releases far more upcoming orders
  // than a press will touch in one shift, and operators were scrolling
  // past dozens of not-yet-relevant entries. The PAST is left open: an
  // order that is still in the planning list is, by definition, not yet
  // complete (Epicor drops finished orders), so an overdue / long-running
  // job that started days ago must still appear — the operator is very
  // likely still running it. (Previously a lower `plannedEnd >= today`
  // bound hid exactly those unfinished historical orders.)
  //
  // Orders missing a plannedStart (rare: legacy CSV row) fall
  // through the filter so the operator can still pick them.
  // Sorted plannedStart-ascending so the next-to-run order is at
  // the top of the dropdown.
  const windowStart = new Date(S!.viewDate);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 2);
  windowEnd.setHours(23, 59, 59, 999);
  const we = windowEnd.getTime();
  const planned = S!.planning
    .slice()
    .filter((o) => {
      if (!o.plannedStart) return true;
      const s = Date.parse(o.plannedStart);
      if (!isFinite(s)) return true;
      // Keep it unless it starts beyond the future horizon.
      return s <= we;
    })
    .sort(
      (a, b2) =>
        new Date(a.plannedStart).getTime() - new Date(b2.plannedStart).getTime(),
    );
  const knownIds = new Set(planned.map((o) => o.jobNumber));
  const extras = historicalIds.filter((j) => !knownIds.has(j)).map(historicalOrder);
  return [...planned, ...extras];
}

function selectedOrder(): PlanningOrder | undefined {
  return orderForJob(S!.selJob);
}

/**
 * Resolve the PlanningOrder for an arbitrary job on the current view
 * (not just the selected one) — needed so the co-run mirror / seed can
 * stamp a sibling order's Part# / cycle time / Job-Left freeze. Same
 * precedence as the old selectedOrder: live/future shift prefers the
 * planning CSV (current Epicor state), past shift / dropped order falls
 * back to the denormalised PMD_Production rows in S!.prod.
 */
function orderForJob(job: string): PlanningOrder | undefined {
  if (!job) return undefined;
  // Planning.csv reflects the CURRENT Epicor state — it is only relevant
  // to the live and future shifts. Viewing a PAST shift/date means
  // "review what was actually recorded", so the order must be rebuilt
  // from PMD_Production (the List is the source of truth for history),
  // exactly like Trace's Job Number Search. Consulting planning here
  // would show today's remaining qty / cycle time against a shift that
  // ran days ago, and would disagree with Trace for the same tuple.
  if (!isPastShift()) {
    const jt = job.trim();
    const fromPlanning =
      S!.planning.find((o) => o.jobNumber === job) ??
      S!.planning.find((o) => o.jobNumber.trim() === jt);
    if (fromPlanning) return fromPlanning;
  }
  // Synthetic order rebuilt from the PMD_Production rows already in
  // S!.prod. This is the only path for a past shift, and also the
  // present/future fallback for orders Epicor has dropped from active
  // planning (completed in ERP) but that the operator / supervisor is
  // reviewing or unlocking — the header bar (Order Qty / Part# / Product
  // Description) must still show the real denormalised values, not blanks.
  const canon = S!.prod.find(
    (r) => r.jobNumber === job && r.slotIndex === 0,
  );
  const anySlot = canon ?? S!.prod.find((r) => r.jobNumber === job);
  if (!anySlot) return undefined;
  return {
    id: 0,
    jobNumber: job,
    machineCode: anySlot.machineCode,
    originalMachine: '',
    partNumber: anySlot.partNumber ?? '',
    // partDescription / jobRequired are denormalised on slot 0 of
    // PMD_Production rows. Both default to '' / 0 when the tenant
    // hasn't added the corresponding column yet — the header shows
    // a blank / em-dash in that case, which is the same fallback
    // behaviour an order had pre-redesign.
    partDescription: canon?.partDescription ?? '',
    plannedStart: '',
    plannedEnd: '',
    orderQty: canon?.jobRequired ?? 0,
    jobRequired: canon?.jobRequired ?? 0,
    // CycleTime persisted at sign-off → Shift Target recomputes for a
    // past shift even after Epicor drops the order from planning.
    qtyPerHr: canon?.cycleTime ?? 0,
    duration: 0,
    released: false,
    isDieChange: false,
    manuallyAdded: true,
    source: 'Manual',
  };
}

function slotRec(slot: number): ProductionRecord | undefined {
  return S!.prod.find((r) => r.jobNumber === S!.selJob && r.slotIndex === slot);
}

/**
 * The earliest other-job row on (machine, shift) that already covers
 * this slot with a Machine Status, or null when this slot is free. Used
 * to lock cross-job overlap: once SFM507103 has been signed off with
 * R 15:00-16:00, picking SFM506888 must NOT let the operator overwrite
 * 15:00 with a second R block. Signed-off rows always block;
 * still-being-edited other jobs block too (the press can only be in one
 * state per slot — two operators sharing one press is a data error,
 * not a feature).
 */
function occupyingOtherJob(slot: number): ProductionRecord | null {
  for (const r of S!.prod) {
    if (r.slotIndex !== slot) continue;
    if (r.jobNumber === S!.selJob) continue;
    if (!r.statusCode) continue;
    // Co-running orders share one die on the same press, so they
    // legitimately occupy the SAME half-hour with the SAME machine
    // status — don't treat a co-runner as a blocking occupier. The
    // status is mirrored across the group, so the selected job has its
    // own copy on this slot anyway.
    if (coRunsWith(r.jobNumber, S!.selJob)) continue;
    return r;
  }
  return null;
}

// ---- Co-running orders (one die → 2-3 parts at once) ----------------
// A single die can run multiple parts simultaneously on one press, so
// the same (machine, shift) legitimately has 2-3 orders running at the
// exact same time. They share ONE machine-status timeline (it's the
// press) but keep their own Count Start/End, Rejects, Job Left and
// sign-off. Grouping is automatic by DieNumber (PMD_ProductDieColor) —
// no new UI, no new SP column. The status entered on any one of them is
// mirrored across the group; everything else stays per-order.

/** Part # for any job on the current view — from its PMD_Production
 *  rows first, then the planning CSV. */
/** Whether a Job# appears in the loaded Planning.csv (current Epicor state).
 *  Drives the "not in planning" warning that catches item numbers typed into
 *  the Job# box. */
function jobInPlanning(job: string): boolean {
  const jt = job.trim();
  return !!jt && S!.planning.some((o) => o.jobNumber.trim() === jt);
}

function partNumberForJob(job: string): string {
  if (!job) return '';
  const fromProd = S!.prod.find((r) => r.jobNumber === job && r.partNumber)?.partNumber;
  if (fromProd) return fromProd;
  return S!.planning.find((o) => o.jobNumber === job)?.partNumber ?? '';
}

/** The PMD_ProductDieColor row for a job's part, or undefined. */
function dieRowForJob(job: string): { dieNumber: string; coRun: boolean } | undefined {
  const pn = partNumberForJob(job).trim().toUpperCase();
  if (!pn) return undefined;
  return S!.dieColors.get(pn);
}

/** Order Quantity for a job (Epicor ProdQty), or null when unknown / a die
 *  change. Used to gate co-running: genuinely-simultaneous orders share the
 *  same quantity. */
function orderQtyForJob(job: string): number | null {
  const o = orderForJob(job);
  if (!o || o.isDieChange) return null;
  return o.orderQty > 0 ? o.orderQty : null;
}

/**
 * Two jobs co-run when they share the same non-empty die, both parts are
 * flagged CoRun = Yes in PMD_ProductDieColor, AND the two orders carry the
 * same Order Quantity. The die match alone is not enough: different colours
 * share a die and are often scheduled one-after-another, so the floor marks
 * the genuinely-simultaneous parts with CoRun. The equal-quantity check is
 * the final guard — a multi-cavity die makes one of each part per cycle, so
 * truly co-running orders finish equal quantities; differing quantities mean
 * the colours run separately even when both are flagged. Only when all three
 * hold does the operator sheet mirror their machine status.
 */
function coRunsWith(jobA: string, jobB: string): boolean {
  if (!jobA || !jobB || jobA === jobB) return false;
  return ordersCoRun(
    dieRowForJob(jobA),
    dieRowForJob(jobB),
    orderQtyForJob(jobA),
    orderQtyForJob(jobB),
  );
}

/** Distinct OTHER jobs already recorded on this (machine, shift) that
 *  share the given job's die — the mirror targets. Signed-off siblings
 *  are excluded (we never write into a locked order). */
function coRunSiblings(job: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of S!.prod) {
    const j = r.jobNumber;
    if (!j || j === job || seen.has(j)) continue;
    if (!coRunsWith(j, job)) continue;
    seen.add(j);
    if (S!.prod.some((x) => x.jobNumber === j && x.locked)) continue;
    out.push(j);
  }
  return out;
}

/** Distinct OTHER jobs that co-run with `job` on this (machine, shift),
 *  whether already recorded OR merely planned for the shift. Drives the
 *  ⛓ Co-Run chips next to Job#, so the floor sees the linked order — and
 *  can hop to it — before any counts are entered. Unlike coRunSiblings
 *  (the mirror write target) this keeps signed-off siblings, so the link
 *  stays visible all shift. */
function coRunLinks(job: string): string[] {
  if (!job) return [];
  const out: string[] = [];
  const seen = new Set<string>([job]);
  const consider = (j: string): void => {
    if (!j || seen.has(j) || !coRunsWith(j, job)) return;
    seen.add(j);
    out.push(j);
  };
  for (const o of shiftOrders()) consider(o.jobNumber);
  for (const r of S!.prod) consider(r.jobNumber);
  return out;
}

function canonical(): ProductionRecord | undefined {
  return slotRec(0);
}

/**
 * True when the currently-selected job has meaningful in-progress data
 * that has NOT been signed off yet — i.e. leaving it now would strand
 * the JobLeft snapshot (it only lands in PMD_Production at sign-off).
 * Used to block a Job# / shift / machine switch until the operator
 * signs the current order off (per floor policy: every worked order
 * must be signed off before moving on, so Trace gets accurate Job Left).
 * Never fires on read-only devices (can't sign off anyway), past shifts
 * (history review, not the live production flow), or when a supervisor
 * is signed in — supervisors can unlock the discipline and navigate
 * freely to correct data.
 */
function currentJobNeedsSignoff(): boolean {
  if (!S!.selJob) return false;
  if (isReadOnlyDevice()) return false;
  if (isPastShift()) return false;
  if (isSupervisor()) return false; // supervisor unlocks the discipline
  const c = canonical();
  if (c?.locked) return false; // already signed off — data is safe
  const hasStatus = S!.prod.some((r) => r.jobNumber === S!.selJob && r.statusCode);
  const hasCounts = c?.countStart != null || c?.countEnd != null;
  return hasStatus || hasCounts;
}

/** Minutes before shift end that the sign-off reminder starts nagging. */
const SIGNOFF_REMINDER_MIN = 5;

/**
 * True only in the final SIGNOFF_REMINDER_MIN of the LIVE shift. The floor
 * asked to be reminded to sign off near handover rather than blocked on every
 * navigation, so this is the one window where the reminder banner + one-shot
 * toast appear.
 */
function inSignoffReminderWindow(now: Date = new Date()): boolean {
  if (currentShift(now).shiftId !== sid()) return false; // live shift only
  const ms = msUntilShiftEnd(sid(), now);
  return ms != null && ms > 0 && ms <= SIGNOFF_REMINDER_MIN * 60_000;
}

/**
 * Empty Machine-Status slots that must be filled before the selected
 * job can be signed off (floor policy: no gaps up to the current
 * half-hour for a live shift, or all 16 for a past shift). A slot held
 * by ANOTHER job on the same press counts as satisfied — it's that
 * job's responsibility, not this one's. When a different job takes over
 * the press right after this job's last slot, this job's run is
 * considered finished there and only its own slots are required to be
 * gap-free; otherwise (this is the only / last job) coverage must reach
 * the live cutoff. Assumes the caller already verified the job has at
 * least one filled slot. Returns 0-based slot indices.
 */
function slotGapsForSignoff(): number[] {
  const mineFilled = (i: number): boolean =>
    S!.prod.some((r) => r.jobNumber === S!.selJob && r.slotIndex === i && r.statusCode);
  let lastMine = -1;
  for (let i = 0; i < SLOTS_PER_SHIFT; i++) if (mineFilled(i)) lastMine = i;
  const globalCutoff = isPastShift()
    ? SLOTS_PER_SHIFT - 1
    : currentSlotIndex(sid(), new Date()) ?? SLOTS_PER_SHIFT - 1;
  // Did another job take over the press after this job's last slot?
  let otherTakesOver = false;
  for (let i = lastMine + 1; i < SLOTS_PER_SHIFT; i++) {
    if (occupyingOtherJob(i)) {
      otherTakesOver = true;
      break;
    }
  }
  const cutoff = otherTakesOver ? lastMine : globalCutoff;
  const gaps: number[] = [];
  for (let i = 0; i <= cutoff; i++) {
    if (mineFilled(i)) continue;
    if (occupyingOtherJob(i)) continue;
    gaps.push(i);
  }
  return gaps;
}

function parseRejects(r: ProductionRecord | undefined): Record<string, number> {
  if (!r || !r.rejects) return {};
  try {
    return JSON.parse(r.rejects) as Record<string, number>;
  } catch {
    return {};
  }
}

async function upsertSlot(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  // Defence-in-depth lock guard: a signed-off (machine, shift, job) is
  // immutable until a supervisor reopens it via Unlock. Without this,
  // a stray tap on a slot would put a NEW slot record into editCache,
  // and the next pushLiveSnapshot would re-broadcast the (locked) shift
  // as live — polluting PMD_LiveStatus and resetting the timeline. The
  // UI already disables the inputs, but inputs can still emit events
  // when re-enabled by devtools or a flaky disabled-attribute paint;
  // belt-and-braces stop here.
  if (isJobLocked()) {
    toast('Signed off — sign in as supervisor to edit', 'warn');
    return;
  }
  if (!canWriteThisDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  const existing = S!.prod.find(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  const rec = existing ? { ...existing } : blankRecord(slot);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  // Sync-update local state so concurrent upsertSlot() calls don't race on a
  // stale S!.prod — without this, typing CountStart then immediately tabbing
  // to CountEnd would have CountEnd's upsert clone the pre-CountStart record
  // and overwrite it on flush.
  const idx = S!.prod.findIndex(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  try {
    await dalRef.upsertProductionRecord(rec);
    await reload();
  } catch {
    toast('Cannot save — check network', 'err');
  }
}

/**
 * The job with live activity furthest along this press's shift —
 * PMD_LiveStatus rows surface in S!.prod as unsigned (locked=false) slot
 * records with a non-empty statusCode, so the job whose latest filled slot is
 * greatest is what the press is running right now. '' when nothing is live.
 */
function liveActiveJob(): string {
  const lastSlotByJob = new Map<string, number>();
  for (const r of S!.prod) {
    if (!r.locked && r.statusCode && r.jobNumber) {
      const cur = lastSlotByJob.get(r.jobNumber) ?? -1;
      if (r.slotIndex > cur) lastSlotByJob.set(r.jobNumber, r.slotIndex);
    }
  }
  let bestJob = '';
  let bestSlot = -1;
  for (const [j, s] of lastSlotByJob) {
    if (s > bestSlot) {
      bestSlot = s;
      bestJob = j;
    }
  }
  return bestJob;
}

/**
 * @param preferLiveJob boot-time only: when the restored per-tab job has no
 *   rows on this (machine, shift) but another order is live on the press,
 *   land on the live one — the floor reported iPads opening on a stale saved
 *   order and producing junk entries against it. NOT set on ordinary reloads:
 *   an operator who deliberately picks the (still-empty) next order from the
 *   dropdown must not be yanked back to the previous one by the next poll.
 */
async function reload(preferLiveJob = false): Promise<void> {
  const id = sid();
  S!.prod = await dalRef.listProduction({ machineCode: S!.mc, shiftId: id });
  const orders = shiftOrders();
  if (!S!.selJob) {
    // No selection (fresh view / machine switch): prefer the order the press
    // is running right now; then the previous shift's unfinished order
    // (handover inheritance — still needs this crew's ✅ Confirm); fall
    // back to the earliest-starting planned order.
    const live = liveActiveJob();
    if (live) S!.selJob = live;
    else {
      const inherited = await prevShiftUnfinishedJob();
      if (inherited) S!.selJob = inherited;
      else if (orders.length) {
        S!.selJob = orders.slice().sort(compareOrdersByStart)[0].jobNumber;
      }
    }
  } else if (preferLiveJob && !isPastShift()) {
    const touched = S!.prod.some((r) => r.jobNumber === S!.selJob);
    const live = liveActiveJob();
    if (!touched && live && live !== S!.selJob) S!.selJob = live;
  }
  // Tuples that already carry real data are confirmed by definition —
  // must run before needsConfirm() gates the automation below.
  autoConfirmExistingWork();
  hydrateOperatorSupervisor();
  // Start-of-run automation is deferred until the worker confirms the
  // selection: an unconfirmed browse must leave zero footprint (the
  // auto-carried Count Start was exactly how junk tuples were born).
  if (!needsConfirm()) {
    // Count Start auto-carry: a same-machine/same-job continuation from
    // the previous shift starts where the previous shift's counter ended
    // — Day 14000 → Afternoon 14000 (Count Start) → Afternoon 28000 (End)
    // → Night 28000 (Count Start). Only fires when the operator hasn't
    // typed anything yet (count Start null on the live shift) and we
    // have a non-null Count End from the immediately-preceding shift on
    // the same machine + job.
    await maybeCarryCountStart();
  }
  await refreshJobTotal();
  if (!needsConfirm()) await seedStatusFromCoRunner();
  saveView();
  render();
}

/**
 * When the operator opens an order that shares a die with one already
 * running this shift but has no machine status of its own yet, copy the
 * co-runner's timeline into it — they run together off the same die, so
 * the new order inherits the same status pattern. Only seeds a live,
 * writable, unsigned order that is genuinely empty (so it never
 * overwrites a status the operator has already entered, and never runs
 * on a past-shift review).
 */
async function seedStatusFromCoRunner(): Promise<void> {
  if (!S!.selJob || isPastShift() || isReadOnlyDevice() || isJobLocked()) return;
  const mineHasStatus = S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.statusCode,
  );
  if (mineHasStatus) return;
  // Find a co-running sibling that DOES have a timeline to copy from.
  const sib = coRunSiblings(S!.selJob).find((j) =>
    S!.prod.some((r) => r.jobNumber === j && r.statusCode),
  );
  if (!sib) return;
  const sibSlots = S!.prod.filter((r) => r.jobNumber === sib && r.statusCode);
  for (const sr of sibSlots) {
    await upsertSlotForJob(S!.selJob, sr.slotIndex, (r) => {
      r.statusCode = sr.statusCode;
      r.bdIssue = sr.bdIssue;
      r.mangoTicket = sr.mangoTicket;
    });
  }
}

/** True when THIS browser is forbidden from writing — non-iPad without
 *  supervisor sign-in. Distinct from isJobLocked() (a signed-off row);
 *  this is a device-class lock that applies to every shift/job opened
 *  here, past or live. Replaces the old per-device OwnerDevice claim
 *  arbitration which caused iPad-vs-iPad fights on the floor. */
function isReadOnlyDevice(): boolean {
  return !canWriteThisDevice();
}

// ---------------------------------------------------------------------
// Confirm flow — "this order really runs on this press, by these people".
//
// A live-shift (machine, order) selection starts UNCONFIRMED: the grid is
// locked, nothing is auto-carried or mirrored, and navigating away
// discards whatever the browse left behind. The worker picks Operator +
// Supervisor and taps ✅ Confirm — from then on the tuple is live: grid
// entry opens, Count Start carries over, and the 60 s mirror broadcasts
// it to PMD_LiveStatus (main.ts wires the mirror gate to the same
// registry). An unfinished order inherits onto the next shift's view but
// needs a fresh confirmation there — each shift's crew vouches for its
// own line. This is what keeps machine-hopping browses out of the data.
// ---------------------------------------------------------------------

/** True when the current selection still needs the worker's ✅ Confirm
 *  before data entry / mirroring. Past shifts (history review), locked
 *  orders and read-only devices are exempt — the gate is for creating
 *  NEW live data only. */
function needsConfirm(): boolean {
  if (!S!.selJob || isPastShift() || isReadOnlyDevice() || isJobLocked()) return false;
  return !isTupleConfirmed(S!.mc, sid(), S!.selJob);
}

/** Mirror of the DAL's hasMeaningfulProgress: real production evidence,
 *  not just a picked name. */
function rowHasProgress(r: ProductionRecord): boolean {
  if (r.statusCode) return true;
  if (r.countStart != null || r.countEnd != null || r.purgeKg != null) return true;
  if (r.rejectCount > 0 || (r.rejects && r.rejects !== '{}')) return true;
  const note = (r.handoverNote ?? '').trim();
  return !!note && note !== '{}';
}

/**
 * Grandfather clause, run on every reload: any job on this (machine,
 * shift) that ALREADY carries real production data is treated as
 * confirmed. Covers tuples created before the confirm flow shipped,
 * tuples authored by another device (someone else already vouched), and
 * signed-then-unlocked corrections — without it, deploying the gate
 * would freeze every in-flight shift on the floor.
 */
function autoConfirmExistingWork(): void {
  const byJob = new Map<string, boolean>();
  for (const r of S!.prod) {
    if (!r.jobNumber) continue;
    byJob.set(r.jobNumber, (byJob.get(r.jobNumber) ?? false) || rowHasProgress(r));
  }
  for (const [job, has] of byJob) {
    if (has && !isTupleConfirmed(S!.mc, sid(), job)) confirmTuple(S!.mc, sid(), job);
  }
}

/** Before navigating away from an unconfirmed selection, drop whatever
 *  the browse wrote (staged names, legacy junk) so it can never be
 *  mirrored later. No-op when the tuple is confirmed or has no job. */
function discardIfUnconfirmed(): void {
  if (!needsConfirm()) return;
  void dalRef
    .discardUnconfirmedTuple?.(S!.mc, sid(), S!.selJob)
    .catch((e) => console.warn('[pmd] unconfirmed-tuple discard failed', e));
  // Keep the in-memory rows consistent with the discarded cache.
  S!.prod = S!.prod.filter((r) => r.locked || r.jobNumber !== S!.selJob);
}

/**
 * Shift handover inheritance: when a fresh (unconfirmed, empty) live
 * shift opens with no live job of its own, offer the job the SAME press
 * was running at the end of the PREVIOUS shift — provided it's still
 * selectable (in planning ⇒ not complete). The worker still has to
 * ✅ Confirm it, which is the "inherits but must be re-confirmed" rule.
 */
async function prevShiftUnfinishedJob(): Promise<string> {
  if (isPastShift() || isFutureShift()) return '';
  const prevSid = previousShift(sid());
  if (!prevSid) return '';
  try {
    const rows = await dalRef.listProduction({ machineCode: S!.mc, shiftId: prevSid });
    let best = '';
    let bestSlot = -1;
    for (const r of rows) {
      if (!r.statusCode || !r.jobNumber) continue;
      if (r.slotIndex > bestSlot) {
        bestSlot = r.slotIndex;
        best = r.jobNumber;
      }
    }
    if (!best) return '';
    return shiftOrders().some((o) => o.jobNumber === best) ? best : '';
  } catch (e) {
    console.warn('[pmd] prev-shift job inheritance lookup failed', e);
    return '';
  }
}

/** The ✅ Confirm tap: requires Operator AND Supervisor picked, writes
 *  them onto the canonical slot, marks the tuple confirmed, then lets
 *  the deferred start-of-run automation (Count Start carry, co-run
 *  seed) run via reload. */
async function confirmCurrentTuple(): Promise<void> {
  if (!needsConfirm()) return;
  if (!S!.selOperator || !S!.selSupervisor) {
    toast('Pick Operator AND Supervisor first — the confirmation records who is running this order', 'warn');
    return;
  }
  confirmTuple(S!.mc, sid(), S!.selJob);
  await upsertSlotNoReload(0, (r) => {
    r.operator = S!.selOperator;
    r.supervisor = S!.selSupervisor;
  });
  toast(`Confirmed — ${S!.selJob} on ${S!.mc}, ${S!.selOperator}`, 'ok');
  await reload();
}

/**
 * Operator / Supervisor always mirror the selected (machine, shift, job)
 * tuple's canonical slot-0 record — never a selection left over from a
 * previously-viewed date, machine, or order. Reported bug: switching to a
 * past shift kept the live selection, and switching back to today's order
 * showed an edited name instead of the one already chosen for that order.
 *
 * When the tuple has a canonical row (signed-off, unlocked, or a live shift
 * where someone has been picked), load its names; otherwise blank both —
 * nobody has been assigned to this tuple yet. Picking a name in the dropdown
 * writes slot 0 (onMetaChange), so the choice survives the reload that
 * follows and every subsequent slot edit (upsertSlot preserves slot 0's
 * operator/supervisor), which is why an unconditional load never wipes an
 * active operator's own selection.
 */
function hydrateOperatorSupervisor(): void {
  const c = canonical();
  // Unconfirmed tuple: names are STAGED locally (nothing written yet, so
  // canonical is empty) — keep whatever the worker just picked so the
  // reload between pick and ✅ Confirm doesn't blank the dropdowns.
  if (needsConfirm() && !c?.operator && !c?.supervisor) return;
  S!.selOperator = c?.operator ?? '';
  S!.selSupervisor = c?.supervisor ?? '';
}

/**
 * Most recent canonical Count End for this (machine, job) on a shift
 * strictly before the one currently being viewed, looking back 7 days
 * (an arbitrary but reasonable bound — gaps longer than that are
 * almost certainly a brand-new run, not a continuation).
 *
 * One ranged listProduction instead of up to 21 sequential by-shiftId
 * round-trips — on iPad/SP that turns a 2-3 s "switch to a fresh
 * shift" lag into a single sub-200 ms call.
 */
async function prevShiftCountEnd(): Promise<number | null> {
  if (!S!.selJob) return null;
  const currentSid = buildShiftId(S!.viewDate, S!.shiftCode);
  const sevenDaysAgo = new Date(S!.viewDate);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const rows = await dalRef.listProduction({
    machineCode: S!.mc,
    jobNumber: S!.selJob,
    shiftIdFrom: dateKey(sevenDaysAgo),
    // '-￿' suffix keeps same-day shifts inside the range: shiftIds are
    // 'YYYY-MM-DD-<code>' and a bare 'YYYY-MM-DD' upper bound sorts
    // BEFORE them, which silently dropped the Day shift when carrying
    // Count Start into the same day's Afternoon / Night shift.
    shiftIdTo: `${dateKey(S!.viewDate)}-￿`,
  });
  // Pick the canonical row whose shiftId is the largest one strictly
  // before the current shift. Lex-sort works because shiftIds are
  // `YYYY-MM-DD-<code>` and the codes sort Afternoon < Day < Night —
  // chronologically wrong, so we compute the previous shiftId via
  // previousShift() and walk a tiny in-memory list.
  let sid: string | null = previousShift(currentSid);
  const byShift = new Map<string, ProductionRecord>();
  for (const r of rows) {
    if (r.slotIndex === 0 && r.countEnd != null) byShift.set(r.shiftId, r);
  }
  for (let hops = 0; hops < 21 && sid; hops++) {
    const canon = byShift.get(sid);
    if (canon) return Number(canon.countEnd);
    sid = previousShift(sid);
  }
  return null;
}

async function maybeCarryCountStart(): Promise<void> {
  if (!S!.selJob) return;
  const c = canonical();
  // Don't touch signed-off shifts or shifts where the operator already
  // typed a Count Start (the existing value wins).
  if (c?.locked) return;
  if (c?.countStart != null) return;
  const prev = await prevShiftCountEnd();
  if (prev == null) return;
  console.info(
    `[pmd] auto-carry Count Start ← ${prev} (prev shift's Count End on ${S!.mc}/${S!.selJob})`,
  );
  // Use no-reload upsert so we don't recurse via reload().
  await upsertSlotNoReload(0, (r) => {
    r.countStart = prev;
  });
}

/** Cavities frozen on the selected job's canonical row (1 when unset). */
function cavities(): number {
  const v = canonical()?.cavities;
  return v && v > 0 ? v : 1;
}

/**
 * Shift Target = pieces the operator should aim for this shift, from the
 * job demand AT SHIFT START (signed cross-shift good only — goodThis is
 * deliberately excluded, otherwise the target would shrink as the shift
 * produces). Stable through the shift without any frozen snapshot, and
 * the same formula lockShift persists to the ShiftTarget column.
 */
function shiftTarget(): number | null {
  const o = selectedOrder();
  if (!o) return null;
  const jl = jobLeftPiecesFor(o, S!.jobTotalGood);
  if (jl == null) return null;
  return shiftTargetFor(o, jl);
}

/**
 * Job Left = JobRequired − sum(Good) across all OTHER shifts of this job.
 * The current (S!.mc, sid()) tuple is EXCLUDED here because jobLeftPieces()
 * adds goodThis (this shift's good) on top of S!.jobTotalGood — counting
 * the current shift in both places double-subtracted it from JobRequired
 * and made Job Left collapse to 0 the moment Count End was filled in.
 *
 * SIGNED rows only (PMD_Production), same source the Trace page and the
 * sign-off JobLeft column use, so all three always agree and the number
 * is exactly reproducible from the list (JobRequired − Σ TotalGood).
 * Mixing in live/editCache tuples made this drift on every stale mirror
 * shadow; the price is that an earlier shift's output only counts once
 * that shift is signed off.
 */
async function refreshJobTotal(): Promise<void> {
  if (!S!.selJob) {
    S!.jobTotalGood = 0;
    S!.unsignedEarlier = [];
    return;
  }
  const currentKey = `${S!.mc}|${sid()}`;
  // Blended read (live mirror + cache + signed) feeds ONLY the unsigned-
  // earlier-shift detector; the Job Left ARITHMETIC below stays strictly
  // signed-only — mixing live tuples into the sum is what caused the
  // SFM507147 phantom-shadow drift.
  const blended = await dalRef.listProduction({ jobNumber: S!.selJob });
  const signed = dalRef.listSignedOffProduction
    ? await dalRef.listSignedOffProduction({ jobNumber: S!.selJob })
    : // Memory DAL fallback: signed rows only (reopened rows are signed
      // rows temporarily unlocked for correction — still counted).
      blended.filter((r) => r.locked || r.reopened);
  S!.jobTotalGood = sumOtherShiftGood(signed, currentKey);
  S!.unsignedEarlier = unsignedEarlierTuples(blended, currentKey);
}

/** "125T|2026-07-06-Afternoon" → "06/07 Afternoon" (+ machine when it's
 *  not the press on screen) for the Job Left ⚠ tooltip. */
function fmtTupleKey(key: string): string {
  const cut = key.indexOf('|');
  const mc = key.slice(0, cut);
  const m = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(key.slice(cut + 1));
  if (!m) return key;
  return `${m[3]}/${m[2]} ${m[4]}${mc !== S!.mc ? ` (${mc})` : ''}`;
}

function jobLeftWarnTitle(): string {
  if (!S!.unsignedEarlier.length) return '';
  return `Job Left may be OVERSTATED — earlier shift(s) produced pieces but are NOT signed off yet: ${S!.unsignedEarlier
    .map(fmtTupleKey)
    .join(
      ', ',
    )}. Their output only counts once a supervisor signs them off — then this number (and the shifts after) self-correct.`;
}

/**
 * Live-update the Total Good / Total Reject / Job Left cells without a
 * re-render. Used by the canonical-slot edits (Count Start / End / Purge)
 * that now go through upsertSlotNoReload so the focused input is not
 * destroyed mid-typing.
 */
async function refreshJobTotalAndPaintSide(): Promise<void> {
  await refreshJobTotal();
  const c = canonical();
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, c?.cavities);
  const totalReject = jobTotals();
  const good = Math.max(0, gross - totalReject);
  const o = selectedOrder();
  // Shared core formula (order TOTAL − good) — see jobLeftPiecesFor for
  // why the base must not be Epicor's already-decremented remaining qty.
  const jobLeft = o ? jobLeftPiecesFor(o, S!.jobTotalGood + good) : null;
  // Patch by data-live tag — text-content matching used to live here,
  // but renaming a label silently broke the live update. Tags are set
  // in buildSide() on each <b> so this stays in sync with the layout.
  const set = (tag: string, v: string | null): void => {
    if (v == null) return;
    const el = document.querySelector<HTMLElement>(`.op-side [data-live="${tag}"]`);
    if (el) el.textContent = v;
  };
  set('jobLeft', jobLeft == null ? null : String(jobLeft));
  set('totalGood', String(good));
  set('totalReject', String(totalReject));
  const warnEl = document.querySelector<HTMLElement>('.op-side [data-live="jlWarn"]');
  if (warnEl) {
    warnEl.style.display = S!.unsignedEarlier.length ? '' : 'none';
    warnEl.title = jobLeftWarnTitle();
  }
}

/**
 * Names from a roster that belong to the selected shift, so the
 * Operator / Supervisor dropdowns only list the people actually rostered
 * on (e.g. Day) instead of the whole plant. A roster entry matches when:
 *   - it has no shift tag (untagged data must never hide a needed name), or
 *   - its shift and the selected shift are prefixes of one another
 *     (tolerates "Day" vs "Day Shift" vs a single-letter "D").
 * `alwaysInclude` (the currently-selected name) is appended even when it
 * falls outside the shift, so switching shifts never drops the name a
 * record already holds. De-duplicated, original order preserved.
 */
export function rosterNames(
  roster: Operator[],
  shiftCode: ShiftCode,
  alwaysInclude: string,
): string[] {
  const want = shiftCode.trim().toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const o of roster) {
    const sh = (o.shift ?? '').trim().toLowerCase();
    const match = sh === '' || sh === want || want.startsWith(sh) || sh.startsWith(want);
    if (!match) continue;
    if (seen.has(o.operatorName)) continue;
    seen.add(o.operatorName);
    names.push(o.operatorName);
  }
  if (alwaysInclude && !seen.has(alwaysInclude)) names.push(alwaysInclude);
  return names;
}

function selOpts(values: string[], selected: string, placeholder: string): string {
  return [`<option value="">— ${escapeHtml(placeholder)} —</option>`]
    .concat(
      values.map(
        (v) =>
          `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`,
      ),
    )
    .join('');
}

function buildActionBar(): string {
  const dateIso = dateKey(S!.viewDate);
  const tabs = SHIFTS.map(
    (s) =>
      `<button class="shift-btn${s.code === S!.shiftCode ? ' a' : ''}" data-shift="${s.code}">${escapeHtml(
        s.label,
      )}</button>`,
  ).join('');
  // Action bar trimmed for iPad portrait (≈810px wide): the explicit
  // "Now" button is redundant — tapping today on the date picker drops
  // you on the live shift anyway — and shortening the save label to
  // "Sign off" buys the ~80px needed for the bar to fit on one row.
  return `<div class="op-actionbar">
    <div class="ab-date">
      <input type="date" class="ab-date-input" data-meta="date" value="${dateIso}">
    </div>
    <div class="ab-shifts">${tabs}</div>
    <div class="ab-window" title="The physical clock window this shift covers — a Night shift starts the evening before and ends 07:00 the next morning, so its date is the START day.">🕑 ${escapeHtml(shiftWindowLabel(sid()))}</div>
    <div class="ab-zoom" title="Display size — scales the whole operator page. ⛶ = auto-fit everything on screen; − / + set a fixed size; tap the % to go back to auto-fit. Remembered on this device.">
      <button type="button" class="ab-zoom-btn" data-dispzoom="-" aria-label="Smaller">−</button>
      <button type="button" class="ab-zoom-val" data-dispzoom="fit" aria-label="Auto-fit">${dispZoomLabel()}</button>
      <button type="button" class="ab-zoom-btn" data-dispzoom="+" aria-label="Larger">+</button>
    </div>
    <div class="ab-right">
      <button class="btn-load" data-refresh title="Re-pull planning from SharePoint &amp; recompute Job Left">⟳ Refresh</button>
      <button class="btn-save" data-saveclear>✅ Sign off</button>
    </div>
  </div>`;
}

function buildMeta(): string {
  const machineOpts = S!.machines
    .map(
      (m) =>
        `<option value="${escapeHtml(m.machineCode)}"${
          m.machineCode === S!.mc ? ' selected' : ''
        }>${escapeHtml(m.machineCode)}</option>`,
    )
    .join('');
  const orders = shiftOrders();
  // Job# is a strict dropdown of the released orders for this press, sorted
  // by planned start (JobHead_StartDate + StartHour), earliest first — the
  // next order to run is the first thing the operator sees. Free typing was
  // removed on request: workers were entering item / part numbers (and other
  // junk) into the Job# box. A just-released order appears after the 15-min
  // Epicor sync; ⟳ Refresh pulls it sooner.
  const sortedOrders = orders.slice().sort(compareOrdersByStart);
  const jobOpts = (): string => {
    const opts = sortedOrders.map((ord) => {
      const d = new Date(ord.plannedStart);
      const when = isFinite(d.getTime())
        ? ` · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '';
      const tag = ord.manuallyAdded ? ' (history)' : '';
      return `<option value="${escapeHtml(ord.jobNumber)}"${
        ord.jobNumber === S!.selJob ? ' selected' : ''
      }>${escapeHtml(`${ord.jobNumber}${when}${tag}`)}</option>`;
    });
    // A selected job missing from the list (legacy manual entry, or planning
    // aged it out mid-shift) must stay selectable — a <select> without its
    // current value would silently jump to the first option.
    if (S!.selJob && !sortedOrders.some((ord) => ord.jobNumber === S!.selJob)) {
      opts.unshift(
        `<option value="${escapeHtml(S!.selJob)}" selected>${escapeHtml(S!.selJob)}</option>`,
      );
    }
    if (!S!.selJob) opts.unshift('<option value="" selected>— pick job —</option>');
    return opts.length ? opts.join('') : '<option value="">— no orders —</option>';
  };
  const o = selectedOrder();
  const pastLocked = isPastShift() && !isSupervisor();
  let jobField: string;
  if (isReadOnlyDevice()) {
    // Non-iPad without supervisor sign-in: the Job# dropdown freezes on
    // whatever's currently selected. The device-class rule replaced the
    // old per-iPad OwnerDevice claim which was causing fights on the
    // floor — iPads write freely now, only PCs are read-only by default.
    jobField = `<input type="text" disabled value="${escapeHtml(S!.selJob)}" title="Read only — sign in as supervisor to edit">`;
  } else if (pastLocked) {
    // Past shift: same dropdown, but shiftOrders() already restricts it to
    // the jobs actually recorded on that shift.
    jobField = `<select data-meta="job" title="Past shift — pick from the jobs recorded on this shift">${jobOpts()}</select>`;
  } else {
    jobField = `<select data-meta="job">${jobOpts()}</select>`;
  }
  // Signed-off shifts: operator & supervisor are frozen to the values that
  // were recorded at sign-off. Without this an iPad tap on the dropdown
  // changes the canonical slot's operator/supervisor, but the rest of the
  // signed-off record stays — you end up looking at "the right numbers
  // signed off by the wrong name". Supervisor mode reveals the select
  // again so a correction can be made and re-signed off.
  const opSupLocked = lockInfo() !== null && !isSupervisor();
  const lockedOrSelect = (meta: 'operator' | 'supervisor', list: string[], value: string): string =>
    isReadOnlyDevice()
      ? `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Read only — sign in as supervisor to edit">`
      : opSupLocked
        ? `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Signed off — sign in as supervisor to change">`
        : `<select data-meta="${meta}">${selOpts(list, value, meta)}</select>`;
  const opField = lockedOrSelect(
    'operator',
    rosterNames(S!.operators, S!.shiftCode, S!.selOperator),
    S!.selOperator,
  );
  const supField = lockedOrSelect(
    'supervisor',
    rosterNames(S!.supervisors, S!.shiftCode, S!.selSupervisor),
    S!.selSupervisor,
  );
  // Order Qty = total order quantity (Epicor JobHead_ProdQty), shown in the
  // meta row next to Job# / Part#. This is the whole-order size and stays
  // fixed; Job Left (side panel) = this total − Σ signed Good.
  const orderQty = o && !o.isDieChange ? o.orderQty : '—';
  // Die / paint colour swatch from PMD_ProductDieColor, looked up by
  // the selected job's Part #. Planning.csv always carries
  // JobHead_PartNum, so the key comes from there directly. Upper-trim
  // both sides so any case / whitespace drift between PMD_ProductDieColor
  // and Planning.csv still resolves.
  const partKey = (o?.partNumber ?? '').trim().toUpperCase();
  const die = partKey ? S!.dieColors.get(partKey) : undefined;
  const swatch = die?.hex
    ? `<span class="m-die-swatch-inline" style="background:${die.hex}" title="${escapeHtml(die.name || die.hex)}"></span>`
    : '';
  // Physical die number from PMD_ProductDieColor.DieNumber, shown inline
  // next to the Product Description title so the floor knows which die
  // to fit before starting. ALWAYS rendered (em-dash when blank) so the
  // operator can tell at a glance whether the list has a value for this
  // part — silently hiding it made an empty cell indistinguishable from
  // a missing column.
  const dieNumber = die?.dieNumber || '';
  const dieNumberLabel = ` <span class="m-die-num" title="Die # for this part (from PMD_ProductDieColor.DieNumber)">Die# ${escapeHtml(dieNumber || '—')}</span>`;
  // ⛓ Co-Run chips: jobs sharing this die that are both flagged CoRun=Yes in
  // PMD_ProductDieColor. They run simultaneously, so the floor needs to enter
  // each one's counts and sees their machine status mirrored. The chip is a
  // one-tap hop to the linked order (switching between co-runners is exempt
  // from the sign-off-before-leaving gate). Admin-set, not worker-picked: the
  // die is shared by colours that often run one-after-another, so only the
  // CoRun flag — not the die alone — marks a genuine simultaneous pair.
  const coRunLinkJobs = coRunLinks(S!.selJob);
  const coRunBadge = coRunLinkJobs.length
    ? `<span class="m-corun" title="Co-running on the same die — enter each order's counts; machine status is mirrored. Tap a linked job to switch.">⛓ Co-Run${coRunLinkJobs
        .map(
          (j) =>
            `<button type="button" class="corun-chip" data-corun-jump="${escapeHtml(j)}" title="Switch to co-running order ${escapeHtml(j)}">${escapeHtml(j)}</button>`,
        )
        .join('')}</span>`
    : '';
  // Job# sanity check: a live-shift Job# that isn't in Planning.csv is almost
  // always an item / part number typed into the wrong box. Warn (don't block —
  // a just-released order can lag the 15-min Epicor sync). Past shifts derive
  // their orders from PMD_Production, not planning, so the check is skipped.
  const jobWarn =
    S!.selJob && !isPastShift() && !jobInPlanning(S!.selJob)
      ? `<span class="m-job-warn" title="This Job# is not in the planning list (Planning.csv). Check you didn't type the item / part number instead of the Job#.">⚠ Not in planning — is this the Job# or an item number?</span>`
      : '';
  return `<div class="op-meta">
    <label class="m-mc">Machine <select data-meta="machine">${machineOpts}</select></label>
    <label class="m-job">Job# ${jobField}${coRunBadge}${jobWarn}</label>
    <label class="m-orderqty">Order Qty <input type="text" disabled value="${escapeHtml(String(orderQty))}"></label>
    <label class="m-part"><span class="m-part-title">Part# ${swatch}</span><input type="text" disabled value="${escapeHtml(o?.partNumber ?? '')}"></label>
    <label class="m-desc"><span class="m-desc-title">Product Description${dieNumberLabel}</span><input type="text" disabled value="${escapeHtml(o?.partDescription ?? '')}"></label>
    <label class="m-op">Operator ${opField}</label>
    <label class="m-sup">Supervisor ${supField}</label>
  </div>`;
}

/** Short two-letter initials for a "First Last" name, used as the
 *  compact label on QC sign-off cells. Falls back to the first two
 *  characters when the name doesn't have two whitespace-separated
 *  words (single-word handles, codes). Exported so the Trace view
 *  labels QC cells with the same initials. */
export function initials(name: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * Slots that require a supervisor QC sign-off rather than an operator
 * one. Production updated the cadence: instead of alternating
 * operator / supervisor every half-hour, supervisors check at three
 * fixed points per shift — start (slot 1 = ~07:30 on Day), middle
 * (slot 7 = ~10:30), and near end (slot 13 = ~13:30). The same indices
 * map onto Afternoon (15:30 / 18:30 / 21:30) and Night (23:30 / 02:30 /
 * 05:30) because every shift counts slots from 0 at its start.
 * Operators still do a QC every other slot.
 */
const SUPERVISOR_QC_SLOTS = new Set([1, 7, 13]);

/** Whose turn is it to QC this slot — supervisor at the 3 cadence slots
 *  per shift, operator on every other slot. */
function qcRoleFor(slot: number): 'operator' | 'supervisor' {
  return SUPERVISOR_QC_SLOTS.has(slot) ? 'supervisor' : 'operator';
}

/**
 * Shared QC-cell presentation — label / class / title — so the editable
 * operator grid and the read-only Trace card render the same content.
 * Both contexts compose this with their own wrapper element (operator: a
 * `<td>` with a tap-to-edit `<button>`; Trace: a `<div>` row above the
 * status timeline).
 */
export function qcCellPresentation(
  slot: number,
  name: string,
): { role: 'operator' | 'supervisor'; signed: boolean; label: string; title: string } {
  const role = qcRoleFor(slot);
  const roleLabel = role === 'operator' ? '👷 Operator' : '👔 Supervisor';
  const signed = !!name;
  const label = signed ? `✓ ${escapeHtml(initials(name))}` : '—';
  const title = signed
    ? `${roleLabel} sign-off · ${escapeHtml(name)} · tap to change`
    : `${roleLabel} sign-off required · tap to confirm`;
  return { role, signed, label, title };
}

function qcCellHtml(slot: number, name: string, isNow: boolean): string {
  const p = qcCellPresentation(slot, name);
  const cls = `qc-cell${isNow ? ' is-now-col' : ''}${p.signed ? ' is-signed' : ''} qc-${p.role}`;
  return `<td class="${cls}"><button type="button" class="qc-btn" data-qc-slot="${slot}" title="${p.title}">${p.label}</button></td>`;
}

function statusCellHtml(
  slot: number,
  code: StatusCode | '',
  bdIssue: string,
  isNow: boolean,
): string {
  // If THIS job hasn't claimed the slot, surface any other job that has
  // — operator-side guard so 15:00 can't end up running for two orders.
  const occ = code ? null : occupyingOtherJob(slot);
  const occDef = occ?.statusCode ? STATUS_MAP[occ.statusCode] : undefined;
  const effectiveDef = code ? STATUS_MAP[code] : occDef;
  const style = effectiveDef
    ? `background:${effectiveDef.color};color:${effectiveDef.text};border-color:${effectiveDef.border}`
    : '';
  let tip = '';
  if (code === 'B' && bdIssue) {
    tip = ` title="${escapeHtml(bdIssue)} — ${escapeHtml(bdLabelFor(bdIssue))}"`;
  } else if (occ) {
    tip = ` title="${escapeHtml(slotClock(sid(), slot))} · already used by ${escapeHtml(occ.jobNumber)} (${escapeHtml(occ.statusCode)})"`;
  }
  const tag =
    code === 'B' && bdIssue
      ? `<span class="bd-tag">${escapeHtml(bdIssue.split('-')[0])}</span>`
      : '';
  let cls = `status-cell${isNow ? ' is-now' : ''}`;
  if (occ) cls += ' is-occupied';
  if (S!.selSet.has(slot)) cls += ' multisel';
  const btnAttrs = occ ? ' disabled aria-disabled="true"' : '';
  // Unified status entry — single-tap selects this slot, hold-and-drag across
  // cells selects a range; the picker opens automatically on finger-up.
  // Occupied cells render the occupier's code but are not selectable.
  const cellChar = code || (occ?.statusCode ?? '·');
  return `<td class="${cls}"${tip}><button type="button" class="slot-cell" style="${style}" data-slot="${slot}" data-row="status"${btnAttrs}>${cellChar}</button>${tag}</td>`;
}

function buildGrid(): string {
  const recs = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => slotRec(i));

  // §2 — highlight the slot that the live wall clock falls in (only when
  // viewing the active shift on today). The whole column (time header +
  // status + every reject row) is tinted so operators see which time to fill.
  const liveShiftId = currentShift(new Date()).shiftId;
  const nowSlot = liveShiftId === sid() ? currentSlotIndex(sid(), new Date()) : null;

  const headers = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    // Just the slot's START time ("07:00-") — the end time was redundant
    // (it's the next slot's start) and forced a tiny font. Keeping only
    // the start lets the label be larger and readable on the iPad.
    const lbl = slotClock(sid(), i).split('–')[0] + '-';
    const now = nowSlot === i ? ' is-now-col' : '';
    return `<th class="slot-head${now}">${escapeHtml(lbl)}</th>`;
  }).join('');

  // Quality Checks row sits between the time-header and Machine Status.
  // Operator checks every half-hour; supervisor signs off at three
  // fixed cadence slots per shift (1 / 7 / 13 → ~07:30, ~10:30, ~13:30
  // for Day; same offsets for Afternoon / Night). Tap a cell to pick
  // the signing name. Signed cells show the initials of the picked
  // user so the supervisor can scan the row at a glance.
  const qcRow =
    `<tr class="row-qc"><th class="rh" title="Operator checks every 30 min; Supervisor checks at slots 1 / 7 / 13 per shift (Day: 07:30, 10:30, 13:30)">Quality Checks</th>` +
    recs
      .map((r, i) => qcCellHtml(i, r?.qcBy ?? '', nowSlot === i))
      .join('') +
    `</tr>`;

  const statusRow =
    `<tr class="row-status"><th class="rh">Machine Status</th>` +
    recs
      .map((r, i) =>
        statusCellHtml(i, r?.statusCode ?? '', r?.bdIssue ?? '', nowSlot === i),
      )
      .join('') +
    `</tr>`;

  const gridRdo = isReadOnlyDevice()
    ? ' disabled title="Read only — sign in as supervisor to edit"'
    : isJobLocked()
      ? ' disabled title="Signed off — sign in as supervisor and Unlock to edit"'
      : needsConfirm()
        ? ' disabled title="Tap ✅ Confirm above to start logging this order on this press"'
        : '';
  // In reopened-for-correction mode, reject inputs are editable only on the
  // already-signed slots — an empty slot can't sprout rejects any more than it
  // can sprout a status letter.
  const reopened = reopenedForCorrection();
  const rejRows = S!.rejCats
    .map((cat) => {
      const cells = recs
        .map((r, i) => {
          const v = parseRejects(r)[cat.code] ?? 0;
          const now = nowSlot === i ? ' is-now-col' : '';
          const cellRdo =
            gridRdo || (reopened && !slotHasOwnStatus(i) ? ' disabled' : '');
          return `<td class="num-cell${now}"><input type="text" inputmode="numeric" pattern="[0-9]*" class="rej-input" data-row="named" data-code="${escapeHtml(
            cat.code,
          )}" data-slot="${i}" value="${v || ''}"${cellRdo}></td>`;
        })
        .join('');
      return `<tr class="row-named"><th class="rh">${escapeHtml(cat.code)} ${escapeHtml(
        cat.label,
      )}</th>${cells}</tr>`;
    })
    .join('');

  return `<div class="op-grid-wrap" style="--slot-w:${SLOT_PX}px">
    <table class="op-grid">
      <thead>
        <tr><th class="rh corner">Timeline</th>${headers}</tr>
      </thead>
      <tbody>
        ${qcRow}
        ${statusRow}
        ${rejRows}
      </tbody>
    </table>
  </div>`;
}

/** One handover box: label + 🎤 dictation toggle + textarea. The mic is
 *  hidden while the box is read-only (locked shift / read-only device). */
function handoverBox(
  label: string,
  field: string,
  placeholder: string,
  value: string,
  rdo: string,
  rdoTitle: string,
): string {
  const mic = rdo
    ? ''
    : `<button type="button" class="mic-btn" data-mic="${field}" title="Dictate — speak and it types here. On iPad you can also use the 🎤 key on the keyboard.">🎤</button>`;
  return `<label><span>${label}${mic}</span><textarea data-meta="${field}" placeholder="${placeholder}" ${rdo}${rdoTitle}>${escapeHtml(value)}</textarea></label>`;
}

function buildSide(): string {
  const c = canonical();
  const cs = c?.countStart ?? '';
  const ce = c?.countEnd ?? '';
  const cav = cavities();
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, cav);
  const totalReject = jobTotals();
  const good = Math.max(0, gross - totalReject);
  const o = selectedOrder();
  // §7 — Job Left = order total − Σ Good across ALL shifts, not just this
  // one. Shared core formula; see jobLeftPiecesFor for the base choice.
  const jobLeft = (o ? jobLeftPiecesFor(o, S!.jobTotalGood + good) : null) ?? '—';
  const purge = c?.purgeKg ?? '';
  const h = parseHandover(c);
  // When the (machine, shift, job) is signed off, every editable field
  // on the side panel is rendered read-only so the operator can't
  // accidentally type into a frozen shift — supervisor mode re-enables
  // them via the Unlock flow. Title tooltips explain what changed.
  const rdo = isJobLocked() || isReadOnlyDevice() || needsConfirm() ? 'disabled' : '';
  const rdoTitle = isReadOnlyDevice()
    ? ' title="Read only — sign in as supervisor to edit"'
    : isJobLocked()
      ? ' title="Signed off — sign in as supervisor and Unlock to edit"'
      : needsConfirm()
        ? ' title="Tap ✅ Confirm above to start logging this order on this press"'
        : '';
  // Shift Target: pieces the operator should aim for this shift. See
  // shiftTarget() for the rule — either a full 8h run at cycle time, or
  // just the remainder of the job if it'll finish in under 8h.
  const tgt = shiftTarget();
  const targetDisplay = tgt == null ? '—' : String(tgt);
  const targetTitle = tgt == null
    ? 'No JobOper_ProdStandard on the planning row — Shift Target cannot be computed.'
    : `Shift Target = if Job Left × ${o!.qtyPerHr} h/piece ≥ 8h then 8 ÷ ${o!.qtyPerHr}, else Job Left.`;
  return `<aside class="op-side">
    <div class="side-title">Shift counters</div>
    <div class="sk"><label>Job left</label><b data-live="jobLeft">${jobLeft}</b><span class="jl-warn" data-live="jlWarn" title="${escapeHtml(jobLeftWarnTitle())}"${S!.unsignedEarlier.length ? '' : ' style="display:none"'}>⚠</span></div>
    <div class="sk"><label title="${escapeHtml(targetTitle)}">Shift Target</label><b title="${escapeHtml(targetTitle)}">${targetDisplay}</b></div>
    <div class="sk"><label>Count Start</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cstart" value="${cs}" ${rdo}${rdoTitle}></div>
    <div class="sk"><label>Count End</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cend" value="${ce}" ${rdo}${rdoTitle}></div>
    ${
      machineHasCavityOption(S!.mc)
        ? `<div class="sk sk-cavity"><label title="Number of identical cavities on the die — pieces produced per press cycle. Total Good = (Count End − Count Start) × cavities − Reject.">Cavities</label><select class="cavity-sel" data-meta="cavity" ${rdo}${rdoTitle}>${CAVITY_OPTIONS.map(
            (n) => `<option value="${n}"${cav === n ? ' selected' : ''}>×${n}</option>`,
          ).join('')}</select></div>`
        : ''
    }
    <div class="sk"><label>Total Reject</label><b class="r" data-live="totalReject">${totalReject}</b></div>
    <div class="sk"><label${cav > 1 ? ` title="(Count End − Count Start) × ${cav} cavities − Reject"` : ''}>Total Good${cav > 1 ? ` <span class="cavity-tag">×${cav}</span>` : ''}</label><b class="g" data-live="totalGood">${good}</b></div>
    <div class="sk"><label>Purge (kg)</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="purge" value="${purge}" ${rdo}${rdoTitle}></div>
    <div class="photos">
      <div class="photos-title">📷 Photos</div>
      <div class="photo-strip" data-photo-strip></div>
      <button type="button" class="photo-take" data-photo-take ${
        isReadOnlyDevice()
          ? 'disabled title="Read only — sign in as supervisor to add photos"'
          : needsConfirm()
            ? 'disabled title="Tap ✅ Confirm above to start logging this order on this press"'
            : ''
      }>📷 Take photo</button>
      <input type="file" accept="image/*" capture="environment" data-photo-file hidden>
    </div>
    <div class="handover">
      <div class="handover-title">Handover</div>
      <div class="handover-grid">
        ${handoverBox('🛠 Machine', 'hand-machine', 'Press state, robot, hot runner, breakdown follow-ups…', h.machine, rdo, rdoTitle)}
        ${handoverBox('🧩 Mold', 'hand-mold', 'Mould condition, slides, ejector, water lines, maintenance due…', h.mold, rdo, rdoTitle)}
        ${handoverBox('📦 Material', 'hand-material', 'Material lot, dryer, regrind, masterbatch…', h.material, rdo, rdoTitle)}
        ${handoverBox('📋 Method', 'hand-method', 'Cycle, settings, process changes, work instructions…', h.method, rdo, rdoTitle)}
      </div>
    </div>
  </aside>`;
}

interface SummaryBucket {
  label: string;
  shiftId: string;
  goCs: number;
  goCe: number;
  /** Gross PIECES = Σ (Count End − Count Start) × cavities, so the
   *  "Output (gross)" column matches Good once a 2-cavity die is in play
   *  (goCe − goCs alone would under-count by half). */
  grossPieces: number;
  good: number;
  rej: number;
  downHrs: number; // B + M slots × 0.5
  setupHrs: number; // C + D + I + P + S slots × 0.5
}

async function loadProdRange(from: Date, to: Date): Promise<ProductionRecord[]> {
  // Lex-from prefix is enough for date-only filtering (IDs start with YYYY-MM-DD).
  const fromKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const toKey = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}￿`;
  return dalRef.listProduction({
    machineCode: S!.mc,
    shiftIdFrom: fromKey,
    shiftIdTo: toKey,
  });
}

function rollup(label: string, shiftId: string, rows: ProductionRecord[]): SummaryBucket {
  let good = 0;
  let rej = 0;
  let goCs = 0;
  let goCe = 0;
  let grossPieces = 0;
  let down = 0;
  let setup = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    // Down / setup slot counts ignore SlotIndex grouping — each filled slot
    // contributes 30 min.
    if (r.statusCode === 'B' || r.statusCode === 'M') down++;
    else if (
      r.statusCode === 'C' ||
      r.statusCode === 'D' ||
      r.statusCode === 'I' ||
      r.statusCode === 'P' ||
      r.statusCode === 'S'
    )
      setup++;
    if (r.slotIndex !== 0) continue;
    const key = `${r.jobNumber}|${r.shiftId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = Number(r.countStart ?? 0);
    const ce = Number(r.countEnd ?? 0);
    const gross = cavityGross(r.countStart, r.countEnd, r.cavities);
    let jobRej = 0;
    try {
      const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
      jobRej = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    } catch {
      jobRej = Number(r.rejectCount) || 0;
    }
    goCs += cs;
    goCe += ce;
    grossPieces += gross;
    rej += jobRej;
    good += Math.max(0, gross - jobRej);
  }
  return {
    label,
    shiftId,
    goCs,
    goCe,
    grossPieces,
    good,
    rej,
    downHrs: down * 0.5,
    setupHrs: setup * 0.5,
  };
}

let summaryCache: { level: number; buckets: SummaryBucket[] } | null = null;

function buildSummary(): string {
  const lvl = S!.viewLevel;
  // Kick off async fetch; render placeholder, then replace on resolve.
  if (!summaryCache || summaryCache.level !== lvl) {
    void rebuildSummary();
    return `<div class="summary-loading">Loading ${escapeHtml(
      VIEW_LEVELS[lvl - 1]?.label ?? '',
    )} summary…</div>`;
  }
  const rows = summaryCache.buckets
    .map(
      (b) =>
        `<tr data-jump-shift="${escapeHtml(b.shiftId)}">
          <th>${escapeHtml(b.label)}</th>
          <td class="num">${b.good}</td>
          <td class="num r">${b.rej}</td>
          <td class="num">${b.grossPieces}</td>
          <td class="num">${b.downHrs.toFixed(1)}h</td>
          <td class="num">${b.setupHrs.toFixed(1)}h</td>
        </tr>`,
    )
    .join('');
  const title = VIEW_LEVELS[lvl - 1]?.label ?? '';
  const chart = renderOutputRejectChart(
    summaryCache.buckets.map((b) => ({
      label: b.label.split(' — ')[0],
      good: b.good,
      reject: b.rej,
    })),
  );
  return `<div class="summary-wrap">
    <h3 class="summary-title">${escapeHtml(title)} — ${escapeHtml(S!.mc)}</h3>
    <p class="bd-sub">Read-only roll-up · tap a row to drill into that shift.</p>
    <div class="summary-chart">${chart}</div>
    <table class="summary-table">
      <thead><tr>
        <th>Bucket</th><th>Good</th><th>Reject</th><th>Output (gross)</th><th>Down</th><th>Setup</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No data</td></tr>'}</tbody>
    </table>
  </div>`;
}

async function rebuildSummary(): Promise<void> {
  const lvl = S!.viewLevel;
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const buckets: SummaryBucket[] = [];
  if (lvl === 2) {
    // Today × 3 shifts. Night actually starts at 23:00 today (its shiftId
    // date is today), so we pull a 24h window starting at today 00:00.
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const rows = await loadProdRange(today, tomorrow);
    for (const code of ['Day', 'Afternoon', 'Night'] as const) {
      const sid = buildShiftId(today, code);
      buckets.push(
        rollup(`${code} — ${sid.slice(0, 10)}`, sid, rows.filter((r) => r.shiftId === sid)),
      );
    }
  } else {
    const days = lvl === 3 ? 7 : 30;
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    const rows = await loadProdRange(from, today);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const datePart = dateKey(d);
      const dayRows = rows.filter((r) => r.shiftId.startsWith(`${datePart}-`));
      const label = d.toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      // shiftId target for click-through: jump to Day shift of that date.
      buckets.push(rollup(label, `${datePart}-Day`, dayRows));
    }
  }
  summaryCache = { level: lvl, buckets };
  render();
}

function buildLegend(): string {
  return `<div class="op-legend">${STATUSES.map(
    (s) =>
      `<span><i style="background:${s.color};border-color:${s.border}"></i>${s.code}: ${escapeHtml(s.label)}</span>`,
  ).join('')}</div>`;
}

function applyShiftTheme(): void {
  // Day → blue (102,204,255); Afternoon → green (131,226,142); Night → yellow (255,255,0).
  // Drives CSS variables in styles.css, including the top bar.
  const cls = `shift-${S!.shiftCode.toLowerCase()}`;
  if (document.body.className !== cls) document.body.className = cls;
}

/**
 * True when the currently-viewed (machine, shift, job) is signed off
 * and the operator therefore can't edit it without a supervisor
 * Unlock. Supervisor sign-in transparently lifts the read-only state
 * so the supervisor can re-open the order via the lock banner's Unlock
 * button. Used to gate every input on the page (status picker, reject
 * cells, Count Start / End, Purge, handover textareas).
 */
function isJobLocked(): boolean {
  return lockInfo() !== null && !isSupervisor();
}

/** The selected order has been signed off and re-opened for correction
 *  (PMD_Production.Reopened = Yes). In this mode the floor may fix the
 *  already-signed slots and the counts, but NOT add status to new (empty)
 *  time periods — that keeps a re-opened order from sprouting fresh
 *  production across devices. Read off the canonical slot, so every device
 *  that sees the server flag agrees. */
function reopenedForCorrection(): boolean {
  return canonical()?.reopened === true;
}

/** Whether the selected job already has a machine-status letter on this slot
 *  — i.e. it was part of the signed timeline. Editable slots in reopened mode. */
function slotHasOwnStatus(slot: number): boolean {
  return S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot && !!r.statusCode,
  );
}

function lockInfo(): { lockedBy: string; lockedAt: string } | null {
  // Lock is scoped to (machine, shift, **job**). A signed-off SFM507017
  // does not lock SFM507018 — the press still has half a shift of run
  // time available and the operator needs to start the next order on
  // the remaining slots. Without the selJob filter the lock banner +
  // every gated edit (Operator/Supervisor fields, status grid via
  // pastLocked) would freeze the whole UI as soon as one job on this
  // shift got signed off.
  if (!S!.selJob) return null;
  for (const r of S!.prod) {
    if (r.jobNumber !== S!.selJob) continue;
    if (r.locked) return { lockedBy: r.lockedBy, lockedAt: r.lockedAt };
  }
  return null;
}

/** Notice shown while a signed order is re-opened for correction, so the floor
 *  understands why only the signed slots/counts are editable. */
function buildReopenedBanner(): string {
  if (!reopenedForCorrection()) return '';
  return `<div class="reopened-banner">
    <b>🔓 Re-opened for correction</b>
    <span>Fix the already-signed slots and the counts, then sign off again. New time periods can't be added.</span>
  </div>`;
}

function buildLockBanner(): string {
  const info = lockInfo();
  if (!info) return '';
  const when = info.lockedAt
    ? new Date(info.lockedAt).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';
  // The Unlock button only shows in supervisor mode — operators see an
  // explanatory note instead so they know who can re-open the shift and
  // why nothing happens when they tap.
  const action = isSupervisor()
    ? `<button type="button" class="lock-unlock-btn" data-unlock>🔓 Unlock</button>`
    : `<span class="lock-no-perm" title="Sign in via 🔓 Supervisor in the top nav to enable Unlock">Supervisor sign-in required</span>`;
  return `<div class="lock-banner">
    <div class="lock-text">
      <b>🔒 Signed off</b>
      <span>by ${escapeHtml(info.lockedBy || '—')}${when ? ' · ' + escapeHtml(when) : ''}</span>
    </div>
    ${action}
  </div>`;
}

/**
 * Loud warning when the selected shift hasn't started yet — almost always a
 * night supervisor who left the date on "today" after midnight. Names the
 * running shift and offers a one-tap jump to it, so this morning's work lands
 * on yesterday's Night (the shift that actually ran) instead of tonight's.
 */
/**
 * The ✅ Confirm banner — shown while the live selection is unconfirmed.
 * Names what's being vouched for (order + press + shift + people) and
 * carries the single Confirm button; it disappears once confirmed. The
 * button stays disabled until BOTH Operator and Supervisor are picked in
 * the meta row above, so a confirmation always records who ran the line.
 */
function buildConfirmBar(): string {
  if (!needsConfirm()) return '';
  const o = selectedOrder();
  const ready = !!S!.selOperator && !!S!.selSupervisor;
  const people = `${S!.selOperator ? escapeHtml(S!.selOperator) : '<i>pick operator</i>'} · ${
    S!.selSupervisor ? escapeHtml(S!.selSupervisor) : '<i>pick supervisor</i>'
  }`;
  return `<div class="confirm-bar">
    <div class="confirm-text">
      <b>Confirm to start logging</b>
      <span><b>${escapeHtml(S!.selJob)}</b>${
        o?.partDescription ? ' — ' + escapeHtml(o.partDescription) : ''
      } on <b>${escapeHtml(S!.mc)}</b> · ${escapeHtml(S!.shiftCode)} · ${people}</span>
    </div>
    <button type="button" class="confirm-btn" data-confirm-tuple${
      ready
        ? ''
        : ' disabled title="Pick Operator and Supervisor in the row above first"'
    }>✅ Confirm &amp; start</button>
  </div>`;
}

function buildFutureShiftBanner(): string {
  if (!isFutureShift()) return '';
  const running = currentShift(new Date());
  return `<div class="future-banner">
    <div class="future-text">
      <b>⚠ This shift hasn't started yet</b>
      <span>${escapeHtml(S!.shiftCode)} · ${escapeHtml(shiftWindowLabel(sid()))} is in the future. The shift running now is <b>${escapeHtml(running.code)} · ${escapeHtml(shiftWindowLabel(running.shiftId))}</b> — log this work there.</span>
    </div>
    <button type="button" class="future-fix-btn" data-jump-live>Switch to the running shift →</button>
  </div>`;
}

/**
 * Soft sign-off reminder shown only in the last few minutes of the live
 * shift, when the selected order still has unsigned in-progress data. Replaces
 * the old block-on-every-navigation prompt — the floor wanted a nudge near
 * handover, not a gate each time they switch job / machine / shift.
 */
function buildSignoffReminderBanner(): string {
  if (!inSignoffReminderWindow() || !currentJobNeedsSignoff()) return '';
  return `<div class="signoff-reminder">
    <div class="signoff-reminder-text">
      <b>⏰ Shift ends soon</b>
      <span>Sign off <b>${escapeHtml(S!.selJob)}</b> before the shift ends so its Job Left is recorded.</span>
    </div>
    <button type="button" class="signoff-now-btn" data-signoff-now>✅ Sign off now</button>
  </div>`;
}

function render(): void {
  applyShiftTheme();
  // Preserve the scroll position across a re-render — without this,
  // filling slot 12 via the status picker snapped the view back to the
  // top-left, forcing the operator to scroll again every time on the
  // 10" iPad. The grid pans with the PAGE now (overflow:visible for
  // page-scrollport sticky), so it's the window scroll that matters.
  const prevScrollX = window.scrollX;
  const prevScrollY = window.scrollY;

  const app = document.getElementById('app')!;
  const detail =
    S!.viewLevel === 1
      ? `<div class="op-grid-row">${buildGrid()}${buildSide()}</div>${buildLegend()}`
      : buildSummary();
  app.innerHTML = `<div class="op-sheet">
    ${buildActionBar()}
    ${buildFutureShiftBanner()}
    ${buildSignoffReminderBanner()}
    ${buildReopenedBanner()}
    ${buildLockBanner()}
    ${buildMeta()}
    ${buildConfirmBar()}
    ${detail}
  </div>`;
  // After the sheet exists in the DOM: auto-fit needs to measure the real
  // banners / rows of THIS render (a lock banner appearing changes the fit).
  applyDispZoom();
  wire();
  window.scrollTo(prevScrollX, prevScrollY);
  if (S!.viewLevel === 1) {
    renderNowLine();
  }
}

function renderNowLine(): void {
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;
  const old = wrap.querySelector('.now-line');
  if (old) old.remove();
  const cs = currentShift(new Date());
  if (cs.shiftId !== sid()) return;
  const idx = currentSlotIndex(sid(), new Date());
  if (idx == null) return;
  const b = shiftBounds(sid())!;
  const frac = (Date.now() - b.start.getTime()) / (b.end.getTime() - b.start.getTime());
  const headFirst = wrap.querySelector<HTMLElement>('.op-grid thead th.slot-head:first-of-type');
  const headLast = wrap.querySelector<HTMLElement>('.op-grid thead th.slot-head:last-of-type');
  if (!headFirst || !headLast) return;
  const wRect = wrap.getBoundingClientRect();
  const startX = headFirst.getBoundingClientRect().left - wRect.left;
  const endX = headLast.getBoundingClientRect().right - wRect.left;
  const x = startX + Math.max(0, Math.min(1, frac)) * (endX - startX);
  const line = document.createElement('div');
  line.className = 'now-line';
  // getBoundingClientRect returns VISUAL (post-zoom) pixels, but style.left
  // on a child of the zoomed .op-sheet subtree is re-multiplied by the zoom
  // factor at paint time — divide it back out or the line drifts right as
  // the operator zooms in.
  line.style.left = `${x / dispZoom}px`;
  line.title = `Now: ${new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
  wrap.appendChild(line);
}

function wire(): void {
  const app = document.getElementById('app')!;

  // Shift tabs — keep selJob across shift moves: operators commonly
  // carry the same job from Day → Afternoon → Night and shouldn't have to
  // re-pick it. If the new shift has no rows for that job, the grid will
  // just show empty cells. (Day arrows are gone — the date input shows
  // today by default; past days are still reachable via the picker for
  // supervisors reviewing history.)
  app.querySelectorAll<HTMLButtonElement>('[data-shift]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = b.dataset.shift as ShiftCode;
      if (next === S!.shiftCode) return;
      // Switching shift is free — the floor asked NOT to be blocked on every
      // navigation. Sign-off discipline is now a soft reminder in the last
      // 5 min of the shift (see buildSignoffReminderBanner) rather than a
      // gate on leaving. Unconfirmed browses are dropped on the way out.
      discardIfUnconfirmed();
      S!.shiftCode = next;
      void reload();
    }),
  );

  // Drill from a summary row back into single-shift detail.
  app.querySelectorAll<HTMLElement>('[data-jump-shift]').forEach((row) =>
    row.addEventListener('click', () => {
      const sid = row.dataset.jumpShift!;
      const m = /^(\d{4})-(\d{2})-(\d{2})-(Day|Afternoon|Night)$/.exec(sid);
      if (!m) return;
      discardIfUnconfirmed();
      S!.viewDate = new Date(+m[1], +m[2] - 1, +m[3]);
      S!.shiftCode = m[4] as ShiftCode;
      S!.viewLevel = 1;
      summaryCache = null;
      void reload();
    }),
  );

  // Meta fields
  app.querySelectorAll<HTMLElement>('[data-meta]').forEach((el) => {
    el.addEventListener('change', () => onMetaChange(el));
  });
  // ⛓ Co-Run chips — one-tap hop to a co-running order. Switching between
  // co-runners is exempt from the sign-off-before-leaving gate, so this skips
  // straight to the reload that swaps the per-job view.
  app.querySelectorAll<HTMLButtonElement>('[data-corun-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const j = btn.dataset.corunJump;
      if (!j || j === S!.selJob) return;
      discardIfUnconfirmed();
      S!.selJob = j;
      saveView();
      void reload();
    });
  });
  app
    .querySelector<HTMLTextAreaElement>('textarea[data-meta="comments"]')
    ?.addEventListener('blur', (e) => onMetaChange(e.target as HTMLElement));

  // Status cells are picked via the unified hold-and-drag picker — see
  // wireStatusPicker() at the bottom of wire().

  // Named reject inputs — use the no-reload upsert so tabbing from one
  // cell to the next doesn't trigger a full reload() → render() cycle
  // that destroys the input the operator just moved focus into. The
  // refreshJobTotalAndPaintSide call keeps the side-panel totals fresh
  // without rebuilding the grid.
  app.querySelectorAll<HTMLInputElement>('input[data-row="named"]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const slot = Number(inp.dataset.slot);
      const code = inp.dataset.code!;
      const qty = Math.max(0, Math.floor(Number(inp.value) || 0));
      void upsertSlotNoReload(slot, (r) => {
        const obj = parseRejects(r);
        if (qty > 0) obj[code] = qty;
        else delete obj[code];
        r.rejects = JSON.stringify(obj);
      }).then(() => void refreshJobTotalAndPaintSide());
    }),
  );

  // Digits-only sanitiser for every numeric input on the page (D01-D10
  // reject cells, Count Start / End, Purge). `inputmode="numeric"`
  // only hints the on-screen keyboard — an iPad with an attached
  // hardware keyboard, paste, or autofill can still inject '.' / ','
  // / letters, which would land in upsertSlot as NaN. Strip on the
  // `input` event so the value the operator sees and the value we
  // persist always match. Caret position is restored so editing in
  // the middle of a multi-digit count doesn't jump to the end.
  app
    .querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')
    .forEach((inp) =>
      inp.addEventListener('input', () => {
        const cleaned = inp.value.replace(/[^0-9]/g, '');
        if (cleaned === inp.value) return;
        const caret = (inp.selectionStart ?? cleaned.length) - (inp.value.length - cleaned.length);
        inp.value = cleaned;
        try {
          inp.setSelectionRange(caret, caret);
        } catch {
          /* type=number / browser rejection — caret restore is best-effort */
        }
      }),
    );

  // Quality Check picker: alternating operator / supervisor cadence —
  // even slot pops the operators list, odd slot the supervisors list.
  // Tap-then-pick lands the chosen name on the slot record's qcBy field
  // (no full reload — refreshes just the QC cell so a supervisor walking
  // the floor and signing one cell after another doesn't lose focus or
  // their place in the grid).
  app.querySelectorAll<HTMLButtonElement>('[data-qc-slot]').forEach((b) =>
    b.addEventListener('click', () => {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        return;
      }
      const slot = Number(b.dataset.qcSlot);
      if (Number.isFinite(slot)) openQcPicker(slot);
    }),
  );

  // Buttons
  // ⚠ Future-shift fix — jump straight to the shift running now (the night
  // that's actually in progress). No sign-off gate: the whole point is to get
  // out of the mis-dated shift, where nothing legitimate should be entered.
  app
    .querySelector<HTMLButtonElement>('[data-confirm-tuple]')
    ?.addEventListener('click', () => void confirmCurrentTuple());
  app.querySelector('[data-jump-live]')?.addEventListener('click', () => {
    const cs = currentShift(new Date());
    const p = parseShiftId(cs.shiftId);
    if (!p) return;
    discardIfUnconfirmed();
    S!.viewDate = new Date(p.year, p.month - 1, p.day);
    S!.shiftCode = p.code;
    summaryCache = null;
    void reload();
  });
  // Display-size − / + steppers + tap-the-% for auto-fit. No full
  // re-render: just re-apply the CSS var (which syncs the % label) and
  // reposition the NOW line (its pixel maths divides by the zoom factor
  // — see renderNowLine).
  app.querySelectorAll<HTMLButtonElement>('[data-dispzoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.dispzoom;
      if (mode === 'fit') {
        dispZoomPref = 'fit';
        saveDispZoomPref();
        applyDispZoom();
      } else {
        stepDispZoom(mode === '+' ? 1 : -1);
      }
      renderNowLine();
    }),
  );
  // 🎤 dictation toggles on the handover boxes.
  app.querySelectorAll<HTMLButtonElement>('[data-mic]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      toggleDictation(b.dataset.mic!, b);
    }),
  );
  // 📷 defect photos → PMD_Production attachments.
  const photoInput = app.querySelector<HTMLInputElement>('[data-photo-file]');
  app.querySelector<HTMLButtonElement>('[data-photo-take]')?.addEventListener('click', () => {
    if (!S!.selJob) {
      toast('Pick a Job# first — photos attach to the job being run', 'warn');
      return;
    }
    photoInput?.click();
  });
  photoInput?.addEventListener('change', () => {
    const f = photoInput.files?.[0];
    photoInput.value = ''; // same photo re-takeable
    if (!f) return;
    void queuePhoto(f).catch((e) => {
      console.error('[photo] processing failed:', e);
      toast('Could not process that photo — try again', 'err');
    });
  });
  renderPhotoStrip();
  // Retry stranded queued photos (e.g. the tuple was signed off on
  // another device, or the last upload died mid-flight) — throttled so
  // per-keystroke re-renders don't hammer SP with row lookups.
  if (Date.now() - lastPhotoFlushAt > 60_000) void flushPhotoQueue();
  app.querySelector('[data-signoff-now]')?.addEventListener('click', () => openSaveSignoffModal());
  app.querySelector('[data-refresh]')?.addEventListener('click', () => void refreshAll());
  app.querySelector('[data-saveclear]')?.addEventListener('click', () => openSaveSignoffModal());
  app.querySelector('[data-unlock]')?.addEventListener('click', () => openUnlockModal());
  wireStatusPicker();
}

function onMetaChange(el: HTMLElement): void {
  const key = el.dataset.meta;
  const isCheckbox =
    el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox';
  const target = el as HTMLInputElement; // also works for select/textarea (.value)
  const val = isCheckbox ? String(target.checked) : target.value;
  switch (key) {
    case 'date': {
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        discardIfUnconfirmed();
        d.setHours(0, 0, 0, 0);
        S!.viewDate = d;
        void reload();
      }
      break;
    }
    case 'machine':
      // Free to switch presses — no sign-off gate on navigation (the floor
      // found it too aggressive). The shift-end reminder covers discipline.
      // An unconfirmed selection is discarded on the way out: that browse
      // never happened as far as the data is concerned.
      discardIfUnconfirmed();
      S!.mc = val;
      // Machine change does clear selJob: a different press generally runs
      // a different order, and carrying the previous job number across
      // machines tends to mask the empty grid rather than help.
      S!.selJob = '';
      summaryCache = null; // cache is per-machine
      void reload();
      break;
    case 'job':
      // Switching orders is free — the floor asked not to be blocked when
      // moving between jobs. Job Left discipline is handled by the shift-end
      // sign-off reminder instead of a gate here.
      discardIfUnconfirmed();
      S!.selJob = val;
      saveView();
      // Full reload, not just render(): Job Left / Total Good and the
      // Count Start auto-carry are per-job, so switching orders with a
      // bare re-render showed the PREVIOUS job's cross-shift total and
      // skipped the carry for the new one.
      void reload();
      break;
    case 'operator':
      S!.selOperator = val;
      saveView();
      // Pre-confirm the name is only STAGED — the confirm tap writes it.
      // Writing here would recreate the junk the confirm flow prevents.
      if (needsConfirm()) {
        render();
        break;
      }
      void upsertSlot(0, (r) => {
        r.operator = val;
      });
      break;
    case 'supervisor':
      S!.selSupervisor = val;
      saveView();
      if (needsConfirm()) {
        render();
        break;
      }
      void upsertSlot(0, (r) => {
        r.supervisor = val;
      });
      break;
    case 'purge':
    case 'cstart':
    case 'cend': {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        render();
        break;
      }
      // Same race-protection as the handover textareas — a full reload
      // after each blur destroys the focused input the operator is
      // typing into next, e.g. tabbing from Count Start straight into
      // Count End would lose the second number when the first reload
      // re-rendered. upsertSlotNoReload keeps S!.prod in sync without
      // triggering render().
      const field = key as 'purge' | 'cstart' | 'cend';
      void upsertSlotNoReload(0, (r) => {
        // Force integer storage to match the digits-only keyboard /
        // sanitiser — Purge had been accepting decimals; the rest were
        // already conceptually whole counts.
        const v = val === '' ? null : Math.max(0, Math.floor(Number(val) || 0));
        if (field === 'purge') r.purgeKg = v;
        else if (field === 'cstart') r.countStart = v;
        else r.countEnd = v;
      });
      // Job Left / Total Good in the side panel depend on these numbers
      // but won't refresh without a render. Recompute the job total and
      // touch the visible cells directly so the operator still sees a
      // live total without losing focus.
      void refreshJobTotalAndPaintSide();
      break;
    }
    case 'cavity': {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        render();
        break;
      }
      // Cavities dropdown: parts produced per press cycle. Validate against the
      // allowed set, falling back to 1. Persist on the canonical slot, then
      // re-render so Total Good / Job Left / Shift Target and the ×N tag all
      // recompute. A select has no text focus to preserve, so a full render is fine.
      const n = CAVITY_OPTIONS.includes(Number(val)) ? Number(val) : 1;
      void upsertSlotNoReload(0, (r) => {
        r.cavities = n;
      }).then(() => render());
      break;
    }
    case 'hand-machine':
    case 'hand-mold':
    case 'hand-material':
    case 'hand-method': {
      if (needsConfirm()) {
        toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
        break;
      }
      const field = key.slice('hand-'.length) as 'machine' | 'mold' | 'material' | 'method';
      // Skip reload: a full re-render would destroy the textarea the operator
      // just tabbed into, losing whatever they're typing there.
      void upsertSlotNoReload(0, (r) => {
        const obj = parseHandover(r);
        obj[field] = val;
        r.handoverNote = JSON.stringify(obj);
      });
      break;
    }
  }
}

function parseHandover(r: ProductionRecord | undefined): Handover {
  return sharedParseHandover(r?.handoverNote);
}

/**
 * Refresh (§7): re-read PMD_Planning from SharePoint and recompute the
 * cross-shift Good total. The Excel→Planning sync itself is handled by
 * a Power Automate flow on the server (see docs/DEPLOYMENT.md § C) —
 * the in-browser Graph path can't reliably read PMD_Schedule_master
 * (10MB+ workbook with VLOOKUPs/macros times out at 504), so we don't
 * even try.
 */
async function refreshAll(): Promise<void> {
  S!.planning = await dalRef.listPlanning({});
  summaryCache = null;
  await reload();
  toast(`Refreshed · ${shiftOrders().length} job(s) for this shift`, 'ok');
}

/**
 * Sign-off + Save in one modal (§5). Replaces the separate checkbox.
 * Pre-flight = same gates as the .bas btnSaveAndClear_Click:
 *   - Supervisor selected
 *   - Machine Status has at least one filled slot (a shift with no
 *     status timeline records nothing useful and writes an empty
 *     header that later reads back as a blank, confusing record)
 *   - Count Start AND Count End are both entered — explicitly. Zero
 *     is valid data ("counter reset / no parts"); a blank field is
 *     not, because we can't tell "no parts" from "forgot to fill in".
 *   - countEnd >= countStart
 * Confirming locks the shift records and clears the in-form selection.
 */
function openSaveSignoffModal(): void {
  // A shift that hasn't started can't have real production — block sign-off
  // outright (supervisor included) so this morning's Night work never gets
  // locked onto tonight's not-yet-started shift. The banner above offers the
  // one-tap jump to the running shift.
  if (isFutureShift()) {
    toast(
      "This shift hasn't started yet — switch to the running shift before signing off",
      'err',
    );
    return;
  }
  if (!S!.selSupervisor) {
    toast('Pick a Supervisor before signing off', 'err');
    return;
  }
  const hasStatus = S!.prod.some(
    (r) => r.jobNumber === S!.selJob && r.statusCode,
  );
  if (!hasStatus) {
    toast('Machine Status is empty — fill in at least one time slot before signing off', 'err');
    return;
  }
  // No-gaps gate: every Machine-Status slot up to now (live) / all 16
  // (past) must be filled before sign-off, so a half-recorded shift
  // can't be locked in (the reported "worker skips slots, Job Left
  // data is wrong" problem). Slots held by another job on this press
  // are that job's responsibility and don't count as gaps here.
  // A signed-in supervisor bypasses the gate — they can sign off an
  // exceptional / partially-recorded shift when correcting data.
  const gaps = isSupervisor() ? [] : slotGapsForSignoff();
  if (gaps.length) {
    const list = gaps.map((i) => i + 1).join(', ');
    toast(
      `Fill every time slot up to now before signing off — missing slot ${list}`,
      'err',
    );
    return;
  }
  const c = canonical();
  if (c?.countStart == null || c?.countEnd == null) {
    toast('Count Start and Count End are required — enter 0 if no parts were counted', 'err');
    return;
  }
  const cs = Number(c.countStart);
  const ce = Number(c.countEnd);
  if (ce < cs) {
    toast('Count End must be ≥ Count Start', 'err');
    return;
  }
  const cav = cavities();
  const totalRej = jobTotals();
  const good = Math.max(0, (ce - cs) * cav - totalRej);
  const o = selectedOrder();

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">✅ Sign off &amp; Save</h2>
    <p class="bd-sub">${escapeHtml(sid())} · ${escapeHtml(S!.mc)} · job ${escapeHtml(S!.selJob || '—')}</p>
    <div class="signoff-summary">
      <div><span>Operator</span><b>${escapeHtml(S!.selOperator || '—')}</b></div>
      <div><span>Supervisor</span><b>${escapeHtml(S!.selSupervisor)}</b></div>
      <div><span>Part</span><b>${escapeHtml(o?.partNumber ?? '—')}</b></div>
      <div><span>Order Qty</span><b>${o && !o.isDieChange ? o.orderQty : '—'}</b></div>
      <div><span>Count Start → End</span><b>${cs} → ${ce}${cav > 1 ? ` <span class="cavity-tag">×${cav}</span>` : ''}</b></div>
      <div><span>Good (this shift)</span><b class="g">${good}</b></div>
      <div><span>Total Reject</span><b class="r">${totalRej}</b></div>
    </div>
    <p class="bd-sub">By signing off you confirm the above figures are correct and lock the shift records.</p>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-cancel>Cancel</button>
      <button class="btn-primary-big" data-confirm-save>Sign off as ${escapeHtml(S!.selSupervisor)}</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  const confirmBtn = mc.querySelector<HTMLButtonElement>('[data-confirm-save]');
  confirmBtn?.addEventListener('click', () => {
    // Disable immediately so a second tap on a laggy iPad can't fire a
    // second lockShift (the duplicate-row cause). doSignoffSave keeps the
    // modal open until the network round-trip resolves; on failure it
    // re-enables so the supervisor can retry.
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Saving…';
    void doSignoffSave(confirmBtn);
  });
}

// ---------- Unified status picker (tap or hold-and-drag) ----------

function wireStatusPicker(): void {
  const wrap = document.querySelector<HTMLElement>('.op-grid-wrap');
  if (!wrap) return;

  // iPad Safari does not always report e.pressure > 0 during a finger
  // drag — guarding pointermove on pressure caused multi-select to fail
  // silently on the very devices we ship to. Use an explicit isDown flag
  // (set on pointerdown, cleared on pointerup / cancel / lostcapture)
  // and rely on the browser's pointer-capture to keep the events arriving
  // even when the finger drifts outside the original cell.
  let anchor: number | null = null;
  let isDown = false;
  let dragged = false;

  const slotAt = (clientX: number, clientY: number): number | null => {
    const el = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-slot][data-row="status"]');
    if (!el) return null;
    const slot = Number(el.dataset.slot);
    // Slots already held by another job on this (machine, shift) are
    // not selectable — neither single-tap nor drag-range can pick them
    // up. Prevents the duplicate-15:00 case where two orders both
    // claim the same half-hour as Run time.
    if (occupyingOtherJob(slot)) return null;
    return slot;
  };

  const setRange = (a: number, b: number): void => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    S!.selSet = new Set<number>();
    // Skip slots already held by another job — drag-range across a
    // signed-off run mustn't sweep its slots into the selection. In
    // reopened-for-correction mode also skip empty slots (only the signed
    // slots may be edited).
    for (let i = lo; i <= hi; i++) {
      if (occupyingOtherJob(i)) continue;
      if (reopenedForCorrection() && !slotHasOwnStatus(i)) continue;
      S!.selSet.add(i);
    }
    paintSelection();
  };

  const release = (e?: PointerEvent): void => {
    if (e) {
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        /* not captured by this target — fine */
      }
    }
    isDown = false;
  };

  wrap.addEventListener('pointerdown', (e) => {
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null) return;
    // Signed-off shifts: no slot picker, no drag-range, nothing —
    // operator gets a one-shot toast explaining how to re-open it.
    if (isJobLocked()) {
      toast('Signed off — sign in as supervisor and Unlock to edit', 'warn');
      return;
    }
    if (isReadOnlyDevice()) {
      toast('Read only — sign in as supervisor to edit', 'warn');
      return;
    }
    if (needsConfirm()) {
      toast('Tap ✅ Confirm first — confirm the order, press, operator & supervisor to start logging', 'warn');
      return;
    }
    // Reopened-for-correction: only the already-signed slots are editable.
    // Tapping an empty slot to add a new time period is blocked.
    if (reopenedForCorrection() && !slotHasOwnStatus(slot)) {
      toast('Reopened for correction — fix the signed slots & counts; new time periods can\'t be added', 'warn');
      return;
    }
    anchor = slot;
    isDown = true;
    dragged = false;
    S!.selSet = new Set<number>([slot]);
    paintSelection();
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture optional */
    }
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!isDown || anchor == null) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (slot == null || slot === anchor) return;
    dragged = true;
    setRange(anchor, slot);
  });

  const finish = (e: PointerEvent): void => {
    if (anchor == null) {
      release(e);
      return;
    }
    release(e);
    anchor = null;
    // Open picker for both single-tap (selSet.size==1) and drag-range cases —
    // single tap is the most common path so it shouldn't need an extra click.
    if (S!.selSet.size > 0) openStatusPicker(dragged);
  };
  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointercancel', (e) => {
    release(e);
    anchor = null;
    S!.selSet.clear();
    paintSelection();
  });
  wrap.addEventListener('lostpointercapture', () => {
    isDown = false;
  });

  paintSelection();
}

function paintSelection(): void {
  document.querySelectorAll<HTMLElement>('[data-slot][data-row="status"]').forEach((el) => {
    const slot = Number(el.dataset.slot);
    const td = el.closest<HTMLElement>('.status-cell');
    if (!td) return;
    if (S!.selSet.has(slot)) td.classList.add('multisel');
    else td.classList.remove('multisel');
  });
}

/** Find the most recent filled slot with index < min(selSet). */
function previousFilled(beforeSlot: number): ProductionRecord | undefined {
  for (let i = beforeSlot - 1; i >= 0; i--) {
    const r = slotRec(i);
    if (r && r.statusCode) return r;
  }
  return undefined;
}

function openStatusPicker(isRange: boolean): void {
  if (S!.selSet.size === 0) return;
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    S!.selSet.clear();
    paintSelection();
    return;
  }
  const slots = [...S!.selSet].sort((a, b) => a - b);
  const prev = previousFilled(slots[0]);
  const sameAsPrev = prev
    ? `<button class="bd-cause" data-pick-same>
        <span class="bd-code">↪ ${escapeHtml(prev.statusCode)}</span>
        <span class="bd-cause-text">Same as previous (${escapeHtml(prev.statusCode)} ${escapeHtml(STATUS_MAP[prev.statusCode as StatusCode]?.label ?? '')})</span>
      </button>`
    : '';
  const codes: StatusCode[] = ['R', 'B', 'C', 'D', 'I', 'M', 'O', 'P', 'S'];
  const pills = codes
    .map((c) => {
      const d = STATUS_MAP[c];
      return `<button class="ab-pill" style="background:${d.color};border-color:${d.border};color:${d.text}" data-pick="${c}">
        <span class="ab-cd">${c}</span><span class="ab-lb">${escapeHtml(d.label)}</span>
      </button>`;
    })
    .join('');
  const title = isRange || slots.length > 1
    ? `🖌 Set status — ${slots.length} slots`
    : `Set status — slot ${slots[0] + 1}/${SLOTS_PER_SHIFT} (${slotClock(sid(), slots[0])})`;
  const slotsLine = slots.length > 1
    ? `<p class="bd-sub">Slots: ${slots.map((s) => `${s + 1}`).join(', ')}</p>`
    : '';

  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">${title}</h2>
    ${slotsLine}
    ${sameAsPrev ? `<div class="bd-cause-list">${sameAsPrev}</div>` : ''}
    <div class="ab-grid">${pills}</div>
    <div class="bd-actions">
      <button class="btn-ghost-big" data-end-order title="Order or shift finished: fill any empty slots up to now with R (Running), then go straight to Sign off.">🏁 End order / shift</button>
      <button class="btn-ghost-big" data-comments>💬 Comments</button>
      <button class="btn-ghost-big" data-clear>↺ Clear (back to blank)</button>
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  const cancel = (): void => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
  };
  mc.querySelector('[data-cancel]')?.addEventListener('click', cancel);
  mc.querySelector('[data-clear]')?.addEventListener('click', () => {
    closeModal();
    void multiFillApply(slots, '' as StatusCode, '', '');
  });
  mc.querySelector('[data-comments]')?.addEventListener('click', () => {
    // Use cancel(), not closeModal(), so the slot selection clears —
    // the comments path doesn't apply a status, and a leftover
    // selection would confuse the next tap.
    closeModal();
    if (isJobLocked()) {
      toast('Order signed off — Unlock as supervisor to add comments', 'warn');
      S!.selSet.clear();
      paintSelection();
      return;
    }
    openCommentsModal();
  });
  // 🏁 End order / shift: fill any empty slots up to now with R, then route
  // straight to Sign off. The selected slots in the picker are irrelevant to
  // this action (it works off the whole timeline), so clear them first.
  mc.querySelector('[data-end-order]')?.addEventListener('click', () => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
    void endOrderAndSignoff();
  });
  mc.querySelector('[data-pick-same]')?.addEventListener('click', () => {
    closeModal();
    void multiFillApply(slots, prev!.statusCode as StatusCode, prev!.bdIssue, prev!.mangoTicket);
  });
  mc.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const code = b.dataset.pick as StatusCode;
      if (code === 'B') {
        openBreakdownCascade(`${slots.length} slot${slots.length === 1 ? '' : 's'}`, '', (pick) => {
          void multiFillApply(slots, 'B', pick.code, pick.note);
        });
        return;
      }
      closeModal();
      void multiFillApply(slots, code, '', '');
    }),
  );
}

/**
 * Free-text comment popped from the Machine Status modal. The line is
 * appended to the canonical slot's Handover Material field with a
 * `[HH:MM]` wall-clock prefix so it shows up alongside the existing
 * material-side handover notes the next shift reads.
 *
 * Material was the field the production line asked for explicitly —
 * the comment-during-status flow is most often a quick "saw a streak
 * in mix #4", which is material-side observation. If they want to
 * route to a different 4M slot later it's a one-line change here.
 *
 * The on-screen Handover Material textarea is patched directly so the
 * operator sees the line land without a full re-render (which would
 * destroy any in-flight focus in the side panel).
 */
function openCommentsModal(): void {
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">💬 Add comment</h2>
    <p class="bd-sub">Appended to Handover · 📦 Material with the current time.</p>
    <textarea class="comments-input" rows="4" placeholder="Type your note…" style="width:100%;font-family:inherit;font-size:15px;padding:8px;border:2px solid var(--bd);border-radius:8px;background:#fef9c3;resize:vertical"></textarea>
    <div class="bd-actions">
      <button class="btn-primary-big" data-save>Save</button>
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  const ta = mc.querySelector<HTMLTextAreaElement>('.comments-input');
  ta?.focus();
  const close = (): void => {
    closeModal();
    S!.selSet.clear();
    paintSelection();
  };
  mc.querySelector('[data-cancel]')?.addEventListener('click', close);
  mc.querySelector('[data-save]')?.addEventListener('click', () => {
    const txt = (ta?.value ?? '').trim();
    if (!txt) {
      close();
      return;
    }
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const line = `[${hh}:${mm}] ${txt}`;
    let nextMaterial = '';
    void upsertSlotNoReload(0, (r) => {
      const obj = parseHandover(r);
      obj.material = obj.material ? `${obj.material}\n${line}` : line;
      nextMaterial = obj.material;
      r.handoverNote = JSON.stringify(obj);
    });
    // Patch the visible textarea so the operator sees the line land.
    const live = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-meta="hand-material"]',
    );
    if (live) live.value = nextMaterial;
    toast('Comment added to Handover · Material', 'ok');
    close();
  });
}

async function multiFillApply(
  slots: number[],
  code: StatusCode,
  bdIssue: string,
  mangoNote: string,
): Promise<void> {
  const apply = (r: ProductionRecord): void => {
    r.statusCode = code;
    r.bdIssue = code === 'B' ? bdIssue : '';
    if (code === 'B' && mangoNote) r.mangoTicket = mangoNote;
    else if (code !== 'B') r.mangoTicket = '';
  };
  // Mirror the machine status across every co-running order on this die
  // (they share the press, so they share the timeline). Counts / rejects
  // / sign-off stay per-order — only the status row is mirrored.
  const siblings = coRunSiblings(S!.selJob);
  // Sequential upserts — keep simple; could batch later if needed.
  for (const slot of slots) {
    await upsertSlotNoReload(slot, apply);
    for (const sib of siblings) await upsertSlotForJob(sib, slot, apply);
  }
  S!.selSet.clear();
  const mirroredNote = siblings.length ? ` (+${siblings.length} co-run)` : '';
  toast(
    `Filled ${slots.length} slot${slots.length === 1 ? '' : 's'} with ${code}${mirroredNote}`,
    'ok',
  );
  // Skip reload() here. upsertSlotNoReload already mutated S!.prod in
  // memory, and a status edit cannot change anything reload() would
  // re-fetch — Job Left / Total Good are driven by Count Start/End and
  // Rejects, not by status; maybeCarryCountStart is a no-op once it's
  // already been carried; refreshJobTotal sums canonical countEnd
  // across shifts which a status edit doesn't touch. Skipping the SP
  // round-trip turns the iPad lag on "fill a status cell" from
  // 600-800 ms (REST + render) down to a single render.
  render();
  // Kick a live snapshot push so other iPads see the new status pattern
  // without waiting up to 60 s for the next poll tick. Fire-and-forget.
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
}

/**
 * "🏁 End order / shift" shortcut from the Set Status popup. Fills every empty
 * slot up to the current half-hour with R (Running) for the selected job —
 * exactly the gaps the sign-off gate would block on — then opens Sign off. Use
 * when the order or shift is finished and the operator just wants to close it
 * out without painting each remaining cell by hand.
 */
async function endOrderAndSignoff(): Promise<void> {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  if (isReadOnlyDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  if (isJobLocked()) {
    toast('Order signed off — Unlock as supervisor to edit', 'warn');
    return;
  }
  if (needsConfirm()) {
    toast('Tap ✅ Confirm first — order, press, operator & supervisor', 'warn');
    return;
  }
  // In reopened-for-correction mode the order already ran and was signed —
  // don't paint R onto empty slots (that would add new production). Just route
  // to sign-off so the corrected counts/slots can be re-locked.
  const gaps = reopenedForCorrection() ? [] : slotGapsForSignoff();
  if (gaps.length) await multiFillApply(gaps, 'R' as StatusCode, '', '');
  openSaveSignoffModal();
}

/** Like upsertSlot but doesn't call reload — caller batches the final render. */
async function upsertSlotNoReload(
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!S!.selJob) return;
  // Same guard as upsertSlot — the side panel inputs are wired to
  // upsertSlotNoReload (Count Start / End / Purge / handover) and
  // must not write when the order is signed off and the user isn't
  // a supervisor, or when this is a read-only (non-iPad) device.
  if (isJobLocked() || isReadOnlyDevice()) return;
  const existing = S!.prod.find(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  const rec = existing ? { ...existing } : blankRecord(slot);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  // Same sync-update as upsertSlot — keeps S!.prod consistent for the next
  // hand-* event without triggering a render() that would destroy the
  // textarea the operator is currently typing into.
  const idx = S!.prod.findIndex(
    (r) => r.jobNumber === S!.selJob && r.slotIndex === slot,
  );
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  await dalRef.upsertProductionRecord(rec);
}

/**
 * Write one slot of an ARBITRARY job (not the selected one) — used by
 * the co-run status mirror / seed to copy the machine status onto each
 * sibling order sharing the die. Skips a sibling that's signed off
 * (never modify a locked order) and respects the read-only device rule.
 */
async function upsertSlotForJob(
  job: string,
  slot: number,
  mut: (r: ProductionRecord) => void,
): Promise<void> {
  if (!job || isReadOnlyDevice()) return;
  if (S!.prod.some((r) => r.jobNumber === job && r.locked)) return;
  const existing = S!.prod.find((r) => r.jobNumber === job && r.slotIndex === slot);
  const rec = existing ? { ...existing } : blankRecordForJob(slot, job);
  mut(rec);
  let total = 0;
  try {
    const obj = JSON.parse(rec.rejects || '{}') as Record<string, number>;
    total = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  } catch {
    /* keep 0 */
  }
  rec.rejectCount = total;
  const idx = S!.prod.findIndex((r) => r.jobNumber === job && r.slotIndex === slot);
  if (idx >= 0) S!.prod[idx] = rec;
  else S!.prod.push(rec);
  await dalRef.upsertProductionRecord(rec);
}

async function doSignoffSave(confirmBtn?: HTMLButtonElement): Promise<void> {
  if (isReadOnlyDevice()) {
    toast('Read only — sign in as supervisor to sign off here', 'warn');
    return;
  }
  // Reentrancy guard — a second concurrent sign-off would POST a
  // duplicate PMD_Production row (see signoffInFlight comment).
  if (signoffInFlight) return;
  signoffInFlight = true;
  try {
    // Scope sign-off to the order being reviewed: another job already
    // running on this press's remaining timeline slots (operator
    // started the next order mid-shift) must stay live and editable.
    // The JobLeft column is recomputed inside lockShift from signed
    // rows; the canonical row's value (legacy frozen data, if any) rides
    // along only as a deep fallback for when that read fails.
    await dalRef.lockShift(
      S!.mc,
      sid(),
      S!.selSupervisor,
      S!.selOperator,
      S!.selJob || undefined,
      canonical()?.jobLeft ?? null,
    );
    closeModal();
    toast(`Signed off · ${S!.selJob || 'shift'} saved to Master`, 'ok');
    // Keep selJob: the next shift on the same job continues seamlessly
    // (operator keeps clicking ▶ to advance). Matches how Machine sticks
    // across shift navigation.
    // Supervisor sign-in is intentionally per-action: once a shift is
    // signed off and saved, the supervisor's elevated permission ends
    // automatically. They need to sign in again from the top nav for
    // the next unlock.
    if (isSupervisor()) clearSupervisor();
    await reload();
    // The PMD_Production row exists now — ship any photos the operator
    // queued during the shift onto it as attachments.
    void flushPhotoQueue();
  } catch (e) {
    // Surface the actual SP/Graph failure so we don't blindly blame "network".
    // The full stack is in console; toast shows the first line for triage.
    console.error('[signoff] lockShift failed:', e);
    const msg = (e as Error)?.message ?? String(e);
    toast(`Save failed: ${msg.slice(0, 140)}`, 'err');
    // Re-enable the confirm button so the supervisor can retry after a
    // transient failure (the modal is still open on this path).
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Sign off as ${S!.selSupervisor}`;
    }
  } finally {
    signoffInFlight = false;
  }
}

function openQcPicker(slot: number): void {
  if (!S!.selJob) {
    toast('Pick a Job# first', 'warn');
    return;
  }
  if (isJobLocked()) {
    toast('Signed off — sign in as supervisor and Unlock to edit', 'warn');
    return;
  }
  if (!canWriteThisDevice()) {
    toast('Read only — sign in as supervisor to edit', 'warn');
    return;
  }
  const role = qcRoleFor(slot);
  const current = slotRec(slot)?.qcBy ?? '';
  // QC sign-off names are also narrowed to the shift's roster (current
  // sign-off always kept, even if from another shift).
  const roster = rosterNames(
    role === 'operator' ? S!.operators : S!.supervisors,
    S!.shiftCode,
    current,
  );
  const roleLabel = role === 'operator' ? '👷 Operator' : '👔 Supervisor';
  const buttons = roster
    .map(
      (n) =>
        `<button class="bd-cause${n === current ? ' is-current' : ''}" data-qc-pick="${escapeHtml(n)}">
          <span class="bd-code">${escapeHtml(initials(n))}</span>
          <span class="bd-cause-text">${escapeHtml(n)}</span>
        </button>`,
    )
    .join('');
  const clearBtn = current
    ? `<button class="btn-ghost-big" data-qc-clear>↺ Clear sign-off</button>`
    : '';
  const mc = openModal(`<div class="bd-modal">
    <h2 class="bd-title">🔍 Quality Check — slot ${slot + 1}/${SLOTS_PER_SHIFT} (${escapeHtml(
      slotClock(sid(), slot),
    )})</h2>
    <p class="bd-sub">${roleLabel} sign-off · ${escapeHtml(S!.mc)} · ${escapeHtml(S!.selJob)}${
      current ? ` · currently signed by <b>${escapeHtml(current)}</b>` : ''
    }</p>
    <div class="bd-cause-list">${buttons || '<p class="bd-sub">No names available — add them on the People list.</p>'}</div>
    <div class="bd-actions">
      ${clearBtn}
      <button class="btn-ghost-big" data-cancel>Cancel</button>
    </div>
  </div>`);
  mc.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
  mc.querySelector('[data-qc-clear]')?.addEventListener('click', () => {
    closeModal();
    void applyQc(slot, '');
  });
  mc.querySelectorAll<HTMLButtonElement>('[data-qc-pick]').forEach((btn) =>
    btn.addEventListener('click', () => {
      closeModal();
      void applyQc(slot, btn.dataset.qcPick ?? '');
    }),
  );
}

async function applyQc(slot: number, name: string): Promise<void> {
  await upsertSlotNoReload(slot, (r) => {
    r.qcBy = name;
  });
  // Live snapshot push so the floor view picks up the QC sign-off
  // without waiting for the operator poll tick.
  if (dalRef.pushLiveSnapshot) void dalRef.pushLiveSnapshot();
  // Repaint just the QC row so the grid scroll position + every input
  // currently focused stays untouched.
  repaintQcRow();
}

function repaintQcRow(): void {
  const row = document.querySelector<HTMLElement>('.op-grid tr.row-qc');
  if (!row) return;
  const cells = row.querySelectorAll<HTMLElement>('td');
  for (let i = 0; i < cells.length; i++) {
    const rec = slotRec(i);
    const name = rec?.qcBy ?? '';
    const role = qcRoleFor(i);
    const btn = cells[i].querySelector<HTMLButtonElement>('.qc-btn');
    if (!btn) continue;
    btn.textContent = name ? `✓ ${initials(name)}` : '—';
    cells[i].classList.toggle('is-signed', !!name);
    cells[i].title = name
      ? `${role === 'operator' ? '👷 Operator' : '👔 Supervisor'} sign-off · ${name} · tap to change`
      : `${role === 'operator' ? '👷 Operator' : '👔 Supervisor'} sign-off required · tap to confirm`;
  }
}

function openUnlockModal(): void {
  const info = lockInfo();
  if (!info) return;
  const when = info.lockedAt
    ? new Date(info.lockedAt).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';
  openModal(`<div class="bd-modal">
    <h3 class="bd-title">🔓 Unlock this shift?</h3>
    <p class="bd-sub">
      Signed off by <b>${escapeHtml(info.lockedBy || '—')}</b>${when ? ' at ' + escapeHtml(when) : ''}.
      Unlocking lets operators edit the shift again. Someone must sign it off
      a second time once the changes are done — otherwise the master roll-up
      won't include the new numbers.
    </p>
    <div class="bd-actions">
      <button type="button" class="btn-ghost-big" data-mod="cancel">Cancel</button>
      <button type="button" class="btn-primary-big" data-mod="confirm">🔓 Unlock</button>
    </div>
  </div>`);
  document.querySelector('[data-mod="cancel"]')?.addEventListener('click', () => closeModal());
  document.querySelector('[data-mod="confirm"]')?.addEventListener('click', () => void doUnlock());
}

async function doUnlock(): Promise<void> {
  try {
    // Scope the unlock to the currently-viewed job so other signed-off
    // orders on the same shift stay locked — supervisor is unlocking
    // the order they're looking at, not the whole press.
    await dalRef.unlockShift(S!.mc, sid(), S!.selJob || undefined);
    closeModal();
    toast(
      S!.selJob
        ? `Unlocked ${S!.selJob}. Make your fixes, then sign off again.`
        : 'Shift unlocked. Make your fixes, then sign off again.',
      'ok',
    );
    await reload();
  } catch (e) {
    console.error('[unlock] failed', e);
    const msg = (e as Error)?.message ?? String(e);
    toast(`Unlock failed: ${msg.slice(0, 140)}`, 'err');
  }
}

function jobTotals(): number {
  let rej = 0;
  for (const r of S!.prod.filter((x) => x.jobNumber === S!.selJob)) {
    const obj = parseRejects(r);
    rej += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  }
  return rej;
}

export async function renderOperator(
  dal: PmdDataLayer,
  machineCode: string,
  now: Date = new Date(),
): Promise<void> {
  dalRef = dal;
  const [machines, planning, operators, supervisors, rcats, dieColorList] = await Promise.all([
    dal.listMachines(),
    dal.listPlanning({}),
    dal.listOperators(),
    dal.listSupervisors(),
    dal.listRejectCategories(),
    dal.listProductDieColors ? dal.listProductDieColors() : Promise.resolve([]),
  ]);
  // Key by upper-trimmed Part # so the swatch lookup is tolerant of
  // case / whitespace drift between PMD_ProductDieColor and
  // Planning.csv's JobHead_PartNum.
  const dieColors = new Map(
    dieColorList.map((c) => [
      c.partNumber.trim().toUpperCase(),
      { hex: c.hex, name: c.name, dieNumber: c.dieNumber, coRun: c.coRun },
    ]),
  );
  const cs = currentShift(now);
  const vd = new Date(now);
  vd.setHours(0, 0, 0, 0);

  // Resume the last per-tab view if the URL machine matches it. The route's
  // machineCode wins (operator deep-linked to a specific press), but date
  // / shift / selJob / selected operator+supervisor come back from
  // sessionStorage so an inadvertent tap on KPIs and back doesn't reset
  // their context.
  const saved = loadView();
  const startMc = machineCode || saved?.mc || machines[0]?.machineCode || '';
  let viewDate = vd;
  let shiftCode = cs.code;
  let selJob = '';
  let selOperator = '';
  let selSupervisor = '';
  if (saved && saved.mc === startMc) {
    const d = new Date(saved.viewDateIso);
    if (!isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      viewDate = d;
    }
    if (saved.shiftCode) shiftCode = saved.shiftCode;
    if (saved.selJob) selJob = saved.selJob;
    if (saved.selOperator) selOperator = saved.selOperator;
    if (saved.selSupervisor) selSupervisor = saved.selSupervisor;
  }

  S = {
    mc: startMc,
    viewDate,
    shiftCode,
    selJob,
    prod: [],
    planning,
    machines,
    operators,
    supervisors,
    rejCats: rcats,
    selOperator,
    selSupervisor,
    viewLevel: 1,
    jobTotalGood: 0,
    unsignedEarlier: [],
    selSet: new Set<number>(),
    dieColors,
  };
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(nowTick, 30_000);
  // Boot: let the live press activity override a stale restored job (see
  // reload's preferLiveJob doc).
  await reload(true);
}

/** Shift id the sign-off reminder toast has already fired for, so the
 *  one-shot nag doesn't repeat every 30 s while in the window. */
let signoffReminderShownFor: string | null = null;

/** Half-minute heartbeat: redraw the now-line and, once per shift, fire the
 *  shift-ending sign-off reminder (toast + a single render so the banner
 *  appears without waiting for the next edit). */
function nowTick(): void {
  renderNowLine();
  if (!inSignoffReminderWindow() || !currentJobNeedsSignoff()) return;
  if (signoffReminderShownFor === sid()) return;
  signoffReminderShownFor = sid();
  toast(`Shift ends soon — sign off ${S!.selJob} before you leave`, 'warn');
  render();
}

export function operatorPollTick(): void {
  if (!S) return;
  renderNowLine();
  // The PMD_LiveStatus mirror is NOT pushed from here any more: it runs
  // app-lifetime from main.ts (60 s tick + on-wake push), so leaving the
  // operator page — or the route timer being cleared — can no longer
  // silence this device's mirror. The DAL's own stuck-guard watchdog
  // handles reentrancy.
}
