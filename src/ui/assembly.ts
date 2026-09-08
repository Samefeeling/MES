import { isSupervisor } from './supervisor-auth';

let frame: HTMLIFrameElement | null = null;
const entry = import.meta.env.DEV
  ? new URL('/assembly/index.html', window.location.origin)
  : new URL('../assembly/index.html', new URL(import.meta.url));

/** Keep the frame mounted across routes so pending saves and inspector edits survive navigation. */
export function showAssembly(active: boolean): void {
  const app = document.getElementById('app')!;
  app.hidden = active;
  if (!frame && active) {
    frame = document.createElement('iframe');
    frame.id = 'assembly-frame';
    frame.title = 'Assembly planning';
    if (import.meta.env.DEV) frame.src = entry.href;
    else {
      const js = new URL('./assets/assembly.js', entry).href;
      const css = new URL('./assets/assembly.css', entry).href;
      // SharePoint may download HTML files. srcdoc loads the built module directly.
      frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script type="module" src="${js}"></script></body></html>`;
    }
    frame.style.cssText = 'display:block;width:100%;height:calc(100dvh - var(--topbar-h,52px));margin-top:var(--topbar-h,52px);border:0;background:white;';
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
  frame?.contentWindow?.postMessage({ type: 'mes:assembly-state', supervisor: isSupervisor(), active: !frame.hidden }, entry.origin);
}

window.addEventListener('message', event => {
  if (event.origin === entry.origin && event.source === frame?.contentWindow && event.data?.type === 'assembly:ready') notifyAssembly();
});
