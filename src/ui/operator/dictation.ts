// Operator sheet — speaking a handover note or a comment instead of typing it.
import { onMetaChange } from './events';
import { toast } from '../toast';

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

export function toggleDictation(field: string, btn: HTMLButtonElement): void {
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
