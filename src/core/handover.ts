// Shared parser for the four-field shift handover note. The note is
// stored on PMD_Production.Handover; live edits write JSON, but the
// SP column also accepts the legacy "People: …\nPlant: …" labelled
// text shape (see formatHandover in dal/sharepoint.ts). Both flavours
// reduce to the same Handover record here so the KPIs cell and the
// operator side-panel render the same four categories.

export interface Handover {
  people: string;
  plant: string;
  machine: string;
  material: string;
}

const BLANK: Handover = { people: '', plant: '', machine: '', material: '' };
const LABELLED_RE = /(People|Plant|Machine|Material)\s*:\s*([^\n\r]*)/gi;

export function parseHandover(note: string | undefined | null): Handover {
  if (!note) return { ...BLANK };
  const trimmed = note.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Partial<Handover>;
      return { ...BLANK, ...j };
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
  // Legacy plain-text: surface under "people" so nothing is lost.
  return { ...BLANK, people: trimmed };
}
