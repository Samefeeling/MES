export type ToastKind = 'ok' | 'err' | 'warn' | '';

let timer: ReturnType<typeof setTimeout> | undefined;

// §8.5 — top-right, auto-dismiss 3s.
export function toast(message: string, kind: ToastKind = ''): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}`.trim();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    el.className = 'toast';
  }, 3000);
}
