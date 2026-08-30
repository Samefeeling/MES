// Minimal modal host. `openModal` injects HTML into #mc and wires a close
// handler; the caller attaches listeners to the rendered content.
export function openModal(html: string): HTMLElement {
  const bg = document.getElementById('modal')!;
  const mc = document.getElementById('mc')!;
  mc.innerHTML = html;
  bg.classList.add('open');
  bg.onclick = (e) => {
    if (e.target === bg) closeModal();
  };
  return mc;
}

export function closeModal(): void {
  const bg = document.getElementById('modal');
  if (bg) bg.classList.remove('open');
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
