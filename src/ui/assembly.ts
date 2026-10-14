import { isSupervisor } from './supervisor-auth';

let frame: HTMLIFrameElement | null = null;
const entry = import.meta.env.DEV
  ? new URL('/assembly/index.html', window.location.origin)
  : new URL('../assembly/index.html', new URL(import.meta.url));

/** Which page of the planning frame is showing: the board, or Dispatch. */
export type PlanningPage = 'assembly' | 'dispatch';
let page: PlanningPage = 'assembly';

/**
 * Keep the frame mounted across routes so pending saves and inspector edits
 * survive navigation. Assembly and Dispatch are two pages of the one frame:
 * switching between them is a message, not a reload.
 */
export function showAssembly(active: boolean, view: PlanningPage = page): void {
  page = view;
  const app = document.getElementById('app')!;
  app.hidden = active;
  if (!frame && active) {
    frame = document.createElement('iframe');
    frame.id = 'assembly-frame';
    frame.title = 'Assembly planning';
    if (import.meta.env.DEV) frame.src = entry.href;
    else {
      // Fixed SharePoint filenames need fresh URLs on each page open. Use the
      // same token for JS and CSS so a normal reload cannot reuse old styling.
      const revision = Date.now().toString(36);
      const js = new URL('./assets/assembly.js?v=' + revision, entry).href;
      const css = new URL('./assets/assembly.css?v=' + revision, entry).href;
      // SharePoint may download HTML files. srcdoc loads the built module directly.
      frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script type="module" src="${js}"></script></body></html>`;
    }
    // Same ground as the dashboard's own pages (--bg): the frame fills the
    // viewport under the top bar, so a white one flashed a white page on every
    // switch to Assembly and read as a load that had failed.
    frame.style.cssText = 'display:block;width:100%;height:calc(100dvh - var(--topbar-h,52px));margin-top:var(--topbar-h,52px);border:0;background:#f1f5f9;';
    frame.addEventListener('load', () => {
      notifyAssembly();
      if (!frame!.hidden) frame!.contentWindow?.focus();
    });
    app.insertAdjacentElement('afterend', frame);
  }
  if (frame) {
    frame.hidden = !active;
    frame.style.display = active ? 'block' : 'none';
    notifyAssembly();
    if (active) frame.contentWindow?.focus();
  }
}

export function notifyAssembly(): void {
  frame?.contentWindow?.postMessage({ type: 'mes:assembly-state', supervisor: isSupervisor(), active: !frame.hidden, view: page }, entry.origin);
}

window.addEventListener('message', event => {
  if (event.origin === entry.origin && event.source === frame?.contentWindow && event.data?.type === 'assembly:ready') notifyAssembly();
});
