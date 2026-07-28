export type ToastKind = 'ok' | 'err' | 'warn' | '';

let timer: ReturnType<typeof setTimeout> | undefined;

/** §8.5 — top-right, auto-dismiss 3s.
 *
 *  `sticky` keeps it up until it's tapped: 3 seconds is not enough to read
 *  a server error message on an iPad held at arm's length, and the one that
 *  matters most (a failed email notice) used to flash past unread. */
export function toast(
  message: string,
  kind: ToastKind = '',
  opts: { sticky?: boolean } = {},
): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}${opts.sticky ? ' sticky' : ''}`.trim();
  if (timer) clearTimeout(timer);
  timer = undefined;
  el.onclick = null;
  if (opts.sticky) {
    el.onclick = () => {
      el.className = 'toast';
      el.onclick = null;
    };
    return;
  }
  timer = setTimeout(() => {
    el.className = 'toast';
  }, 3000);
}
