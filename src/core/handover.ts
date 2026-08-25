// Shared parser for the four-field shift handover note (the "4M":
// Machine / Mold / Material / Method). The note is stored on
// PMD_Production.Handover; live edits write JSON, but the SP column
// also accepts the legacy "Machine: …\nMold: …" labelled text shape
// (see formatHandover in dal/sharepoint.ts). Both flavours reduce to
// the same Handover record here so the KPIs cell and the operator
// side-panel render the same four categories.

export interface Handover {
  machine: string;
  mold: string;
  material: string;
  method: string;
}

const BLANK: Handover = { machine: '', mold: '', material: '', method: '' };
const LABELLED_RE =
  /(Machine|Mold|Material|Method)\s*:\s*([\s\S]*?)(?=\r?\n(?:Machine|Mold|Material|Method)\s*:|$)/gi;

export function parseHandover(note: string | undefined | null): Handover {
  if (!note) return { ...BLANK };
  const trimmed = note.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Partial<Handover>;
      // Strip any extraneous keys (e.g. the legacy people/plant fields
      // from rows written by the pre-4M release). Spread-with-default
      // would carry them through if we used the typed cast naively;
      // explicit per-key copy keeps the shape clean.
      return {
        machine: j.machine ?? '',
        mold: j.mold ?? '',
        material: j.material ?? '',
        method: j.method ?? '',
      };
    } catch {
      // fall through to the labelled-text parser
    }
  }
  const out: Handover = { ...BLANK };
  let m: RegExpExecArray | null;
  let matched = false;
  // The regex carries internal state (g flag), but each call here uses
  // a fresh string so the implicit lastIndex reset between calls is
  // fine. Re-creating the RegExp per call would be measurably slower
  // in the KPIs view where parseHandover runs N×.
  LABELLED_RE.lastIndex = 0;
  while ((m = LABELLED_RE.exec(trimmed)) !== null) {
    const key = m[1].toLowerCase() as keyof Handover;
    out[key] = (m[2] ?? '').trim();
    matched = true;
  }
  if (matched) return out;
  // Legacy plain-text: surface under "method" so nothing is lost.
  return { ...BLANK, method: trimmed };
}

/** Append one line to a 4M handover field without overwriting the existing
 * shift note. An exact existing line is not duplicated, which keeps a
 * retried status save idempotent from the operator's point of view. */
export function appendHandoverLine(
  note: string | undefined | null,
  field: keyof Handover,
  line: string,
): string {
  const next = line.trim();
  const handover = parseHandover(note);
  if (!next) return JSON.stringify(handover);
  const lines = handover[field]
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!lines.includes(next)) lines.push(next);
  handover[field] = lines.join('\n');
  return JSON.stringify(handover);
}
