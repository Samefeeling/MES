// Device-class detection. The PMD floor app's write rule is now:
//   iPad → writable (it's the on-floor data-entry device)
//   anything else → read-only, unless supervisor mode is signed in
// This module owns the iPad detection only — supervisor state lives in
// ui/supervisor-auth, and the composite "can write" check is assembled
// in the UI (operator.ts) so the DAL stays UI-decoupled.
//
// Detection uses the user-agent first, then iPadOS's desktop-mode
// disguise (Safari on iPadOS ≥ 13 reports itself as Macintosh, but the
// touch-points count gives it away — a real Mac has 0 or 1).

let cached: boolean | null = null;

export function isIpadDevice(): boolean {
  if (cached !== null) return cached;
  try {
    const nav = globalThis.navigator;
    if (!nav) {
      cached = false;
      return cached;
    }
    const ua = nav.userAgent || '';
    // Direct hit: classic iPad / iPhone / iPod UA. iPhones are included
    // because the iPad split-screen build can run on iPhone too; the floor
    // doesn't have iPhones in practice, but the rule is "iOS device".
    if (/\b(iPad|iPhone|iPod)\b/.test(ua)) {
      cached = true;
      return cached;
    }
    // iPadOS desktop-mode disguise: Safari reports "Macintosh" with no
    // distinguishing UA bit, but exposes touch via maxTouchPoints > 1
    // (Macs report 0 or 1).
    const mtp =
      typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
    if (/Macintosh/.test(ua) && mtp > 1) {
      cached = true;
      return cached;
    }
    cached = false;
    return cached;
  } catch {
    cached = false;
    return cached;
  }
}

/** Test-only: clear the memoised result so a UA stub in a unit test
 *  takes effect on the next call. Never invoke from production code. */
export function _resetIpadDetectionForTests(): void {
  cached = null;
}
