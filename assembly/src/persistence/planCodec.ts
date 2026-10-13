/**
 * How a plan is laid out in list rows.
 *
 * One list row's text column holds 60,000 characters here, and a plan of a
 * busy few weeks — every order's crew, pins and daily bookings — outgrows
 * that. It used to stop there: the write was refused, the board went into
 * its "not loaded" state, and nothing was saved again until the plan shrank,
 * which it never did by itself.
 *
 * So a plan has three shapes, smallest first:
 *
 *  1. **Plain** — the plan's JSON, as every build has written it. Used while
 *     it fits, so a screen still on an older build reads it unchanged.
 *  2. **Packed** — the JSON deflated and base64'd (typically a fifth of the
 *     size), carried inside an envelope in the same one row.
 *  3. **Split** — the packed text cut into part rows, the envelope in the
 *     plan's own row naming them by generation, count, length and checksum.
 *
 * The plan's own row stays the one row whose version guards every write;
 * the parts are only ever read through it. See `SharePointPlanRepository`.
 */

/** The most a single row's PlanJson may hold, in characters. */
export const MAX_ROW_CHARS = 60000;

export const ENVELOPE_FORMAT = 'assy-plan/2';

export interface PlanEnvelope {
  format: typeof ENVELOPE_FORMAT;
  /** `deflate` is deflated and base64'd; `json` is the JSON as it stands
   *  (a browser that cannot compress still splits). */
  encoding: 'deflate' | 'json';
  /** Names this write's part rows, so an older write's parts are never read. */
  generation: string;
  /** Part rows to read, in order; 0 when the text is inline in `data`. */
  parts: number;
  /** Length of the encoded text, all parts joined. */
  length: number;
  /** FNV-1a of the encoded text, so a missing or stale part is caught. */
  checksum: string;
  data?: string;
}

export const isEnvelope = (value: unknown): value is PlanEnvelope =>
  !!value && typeof value === 'object' && (value as { format?: unknown }).format === ENVELOPE_FORMAT;

/** The title a part row is filed under. */
export const partTitle = (planId: string, generation: string, index: number): string =>
  `${planId}#${generation}#${index}`;

/** Every part row of a plan starts with this, whatever its generation. */
export const partPrefix = (planId: string): string => `${planId}#`;

/** The generation a part row belongs to, or null if the title is not one. */
export function generationOfPart(planId: string, title: string): string | null {
  const prefix = partPrefix(planId);
  if (!title.startsWith(prefix)) return null;
  const rest = title.slice(prefix.length);
  const cut = rest.lastIndexOf('#');
  return cut > 0 ? rest.slice(0, cut) : null;
}

/** A new generation: when it was made (base 36 ms), and a little noise. */
export const newGeneration = (now = Date.now()): string =>
  `${now.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;

/** When a generation was made, or NaN if it is not one `newGeneration` made. */
export function generationTime(generation: string): number {
  const made = /^([0-9a-z]+)-[0-9a-z]{4}$/.exec(generation);
  return made ? parseInt(made[1], 36) : NaN;
}

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits. */
export function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const canDeflate = (): boolean =>
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In slices: one String.fromCharCode over a whole plan overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encodeText(json: string): Promise<{ encoding: PlanEnvelope['encoding']; text: string }> {
  if (!canDeflate()) return { encoding: 'json', text: json };
  const packed = await pipe(new TextEncoder().encode(json), new CompressionStream('deflate'));
  return { encoding: 'deflate', text: toBase64(packed) };
}

export async function decodeText(encoding: PlanEnvelope['encoding'], text: string): Promise<string> {
  if (encoding === 'json') return text;
  if (encoding !== 'deflate') throw new Error(`Saved plan uses an encoding this board cannot read (${String(encoding)}).`);
  if (!canDeflate()) throw new Error('This browser cannot read a compressed saved plan. Open the board in Edge, Chrome or Safari 16.4+.');
  return new TextDecoder().decode(await pipe(fromBase64(text), new DecompressionStream('deflate')));
}

export interface PlanLayout {
  /** What goes in the plan's own row. */
  head: string;
  /** Part rows to write before the head, in order; empty when it fits in one. */
  parts: { title: string; text: string }[];
  /** Null for a plain plan, which has no parts to name. */
  generation: string | null;
}

/** The rows one plan is written as. */
export async function layoutPlan(planId: string, json: string, generation = newGeneration()): Promise<PlanLayout> {
  if (json.length <= MAX_ROW_CHARS) return { head: json, parts: [], generation: null };
  const { encoding, text } = await encodeText(json);
  const envelope: PlanEnvelope = {
    format: ENVELOPE_FORMAT,
    encoding,
    generation,
    parts: 0,
    length: text.length,
    checksum: checksum(text),
  };
  const inline = JSON.stringify({ ...envelope, data: text });
  if (inline.length <= MAX_ROW_CHARS) return { head: inline, parts: [], generation };
  const parts: PlanLayout['parts'] = [];
  for (let at = 0, i = 0; at < text.length; at += MAX_ROW_CHARS, i++) {
    parts.push({ title: partTitle(planId, generation, i), text: text.slice(at, at + MAX_ROW_CHARS) });
  }
  return { head: JSON.stringify({ ...envelope, parts: parts.length }), parts, generation };
}

/**
 * The plan's JSON back out of its own row, reading the parts it names.
 *
 * `readPart` answers the text of one part row by title, or null when there is
 * no such row. Anything missing, extra or altered is refused rather than
 * patched: a plan read wrong is a plan that would be written back wrong.
 */
export async function readPlanText(
  head: string,
  readPart: (title: string) => Promise<string | null>,
  planId: string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch {
    throw new Error('Saved plan is unreadable; editing is disabled.');
  }
  if (!isEnvelope(parsed)) return head;
  const envelope = parsed;
  let text: string;
  if (envelope.parts > 0) {
    const texts = await Promise.all(
      Array.from({ length: envelope.parts }, (_, i) => readPart(partTitle(planId, envelope.generation, i))),
    );
    if (texts.some((t) => t == null)) throw new IncompletePlanError('Saved plan is missing a part; editing is disabled.');
    text = texts.join('');
  } else {
    text = envelope.data ?? '';
  }
  if (text.length !== envelope.length || checksum(text) !== envelope.checksum) {
    throw new IncompletePlanError('Saved plan does not match its checksum; editing is disabled.');
  }
  return decodeText(envelope.encoding, text);
}

/** A split plan read while another board was replacing it. Worth one more read. */
export class IncompletePlanError extends Error {}
