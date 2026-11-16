// Operator sheet — photos taken during the shift, queued until the row exists.
import { compressPhoto, dataUrlToBlob } from '../photo';
import { S, dalRef } from './state';
import { sid } from './sheet';
import { toast } from '../toast';
import { isJobLocked } from './lock';
import { escapeHtml } from '../modal';

/** Mango's home page — the button beside Photos opens it in a new tab, so a
 *  breakdown can be raised there without leaving the sheet. */
export const MANGO_HOME_URL = 'https://my.mangolive.com/';

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

export async function queuePhoto(file: File): Promise<void> {
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

export let lastPhotoFlushAt = 0;

/** Try to attach every queued photo to its tuple's PMD_Production row.
 *  attachProductionPhoto returns false while the row doesn't exist yet
 *  (tuple not signed off) — those stay queued for the next pass. */
export async function flushPhotoQueue(): Promise<void> {
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
export function renderPhotoStrip(): void {
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
