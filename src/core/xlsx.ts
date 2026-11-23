/**
 * One sheet of an `.xlsx` workbook as rows of text — enough to read the
 * payroll system's timesheet export without a spreadsheet library.
 *
 * An `.xlsx` is a zip of XML parts. This reads the zip's central directory,
 * inflates the parts it needs with the platform's own `DecompressionStream`
 * (every browser MES runs in, and Node 18+), and walks the XML with plain
 * string scanning, so it runs the same in the page and in the tests.
 *
 * Cells come back as text. A number stored under a date or time format is
 * written the way the export shows it: a date as `YYYY-MM-DD` (with
 * ` HH:MM:SS` when it carries a time), a time or duration as `H:MM:SS` —
 * Excel keeps `7:36:00` as 0.31667 of a day, which read as a number would be
 * a third of an hour.
 */

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** The zip's entries by name, from its central directory. */
function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not an .xlsx file (no zip directory)');
  const count = u16(b, eocd + 10);
  let at = u32(b, eocd + 16);
  const out = new Map<string, ZipEntry>();
  const utf8 = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (u32(b, at) !== 0x02014b50) throw new Error('not an .xlsx file (bad zip directory)');
    const nameLen = u16(b, at + 28);
    const extraLen = u16(b, at + 30);
    const commentLen = u16(b, at + 32);
    const name = utf8.decode(b.subarray(at + 46, at + 46 + nameLen));
    out.set(name, { method: u16(b, at + 10), compressedSize: u32(b, at + 20), localOffset: u32(b, at + 42) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One part of the zip as text, or null when the zip has no such part. */
async function zipText(b: Uint8Array, entries: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const e = entries.get(name);
  if (!e) return null;
  const at = e.localOffset;
  if (u32(b, at) !== 0x04034b50) throw new Error(`.xlsx part ${name} is damaged`);
  const start = at + 30 + u16(b, at + 26) + u16(b, at + 28);
  const raw = b.subarray(start, start + e.compressedSize);
  let bytes: Uint8Array;
  if (e.method === 0) bytes = raw;
  else if (e.method === 8) bytes = await inflateRaw(raw);
  else throw new Error(`.xlsx part ${name} uses an unsupported compression (${e.method})`);
  return new TextDecoder('utf-8').decode(bytes);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its entities decoded. */
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** An attribute of an XML start tag. */
const attr = (tag: string, name: string): string | null => {
  const hit = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return hit ? xmlText(hit[2] ?? hit[3] ?? '') : null;
};

/** All the `<t>` text inside a fragment — a shared or inline string, rich text included. */
const textRuns = (xml: string): string =>
  [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => xmlText(m[1])).join('');

/** `A1` → 0-based column. */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

type NumberKind = 'date' | 'datetime' | 'time' | null;

/** What a number format makes of a number: a date, a date and time, a time or duration, or a plain number. */
export function numberKind(id: number, code: string | undefined): NumberKind {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 31) || (id >= 34 && id <= 36) || (id >= 50 && id <= 58)) return 'date';
  if (id === 22) return 'datetime';
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47) || id === 32 || id === 33) return 'time';
  if (!code) return null;
  // Quoted text, escapes and colour/locale brackets say nothing about the
  // kind; an elapsed-time bracket ([h], [mm]) does.
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
    .toLowerCase();
  const date = /[dy]/.test(bare);
  const time = /[hs]/.test(bare);
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (time) return 'time';
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** An Excel serial day as `YYYY-MM-DD` (and its time, with `withTime`). */
function serialDate(v: number, withTime: boolean): string {
  const ms = Math.round((v - 25569) * 86400) * 1000;
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : day;
}

/** A fraction of a day as `H:MM:SS`; a duration may run past 24 hours. */
function serialTime(v: number): string {
  const total = Math.round(v * 86400);
  const hh = Math.floor(total / 3600);
  return `${hh}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function formatNumber(raw: string, kind: NumberKind): string {
  const v = Number(raw);
  if (!Number.isFinite(v) || !kind) return raw;
  if (kind === 'time') return serialTime(v);
  return serialDate(v, kind === 'datetime');
}

/** Number kinds by style index, from `xl/styles.xml`. */
function styleKinds(xml: string | null): NumberKind[] {
  if (!xml) return [];
  const codes = new Map<number, string>();
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode');
    if (Number.isFinite(id) && code !== null) codes.set(id, code);
  }
  const xfs = /<(?:\w+:)?cellXfs[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? '';
  return [...xfs.matchAll(/<(?:\w+:)?xf\s[^>]*>|<(?:\w+:)?xf\/>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    return numberKind(id, codes.get(id));
  });
}

/** The worksheet part a sheet name points at. */
function sheetPart(workbook: string, rels: string, sheet: string): string | null {
  const wanted = sheet.trim().toLowerCase();
  const tags = [...workbook.matchAll(/<(?:\w+:)?sheet\s[^>]*>/g)].map((m) => m[0]);
  const tag = tags.find((t) => (attr(t, 'name') ?? '').trim().toLowerCase() === wanted);
  if (!tag) return null;
  const rid = attr(tag, 'r:id') ?? attr(tag, 'id');
  const rel = [...rels.matchAll(/<(?:\w+:)?Relationship\s[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, 'Id') === rid);
  const target = rel ? attr(rel, 'Target') : null;
  if (!target) return null;
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

/** The names of a workbook's sheets, in order. */
export async function xlsxSheetNames(bytes: Uint8Array): Promise<string[]> {
  const entries = zipEntries(bytes);
  const workbook = (await zipText(bytes, entries, 'xl/workbook.xml')) ?? '';
  return [...workbook.matchAll(/<(?:\w+:)?sheet\s[^>]*>/g)].map((m) => attr(m[0], 'name') ?? '');
}

/**
 * The rows of one sheet, as text (see the file comment). Throws when the file
 * is not a workbook or has no sheet of that name — the message names it.
 */
export async function readXlsxSheet(bytes: Uint8Array, sheet: string): Promise<string[][]> {
  const entries = zipEntries(bytes);
  const workbook = await zipText(bytes, entries, 'xl/workbook.xml');
  const rels = await zipText(bytes, entries, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('not an .xlsx workbook');
  const part = sheetPart(workbook, rels, sheet);
  const xml = part ? await zipText(bytes, entries, part) : null;
  if (!xml) {
    const names = [...workbook.matchAll(/<(?:\w+:)?sheet\s[^>]*>/g)].map((m) => attr(m[0], 'name'));
    throw new Error(`no "${sheet}" sheet (it has ${names.join(', ') || 'none'})`);
  }
  const sharedXml = await zipText(bytes, entries, 'xl/sharedStrings.xml');
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<(?:\w+:)?si\/>|<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textRuns(m[1] ?? ''))
    : [];
  const kinds = styleKinds(await zipText(bytes, entries, 'xl/styles.xml'));

  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<(?:\w+:)?row(\s[^>]*?)?\/>|<(?:\w+:)?row(\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rowTag = rm[1] ?? rm[2] ?? '';
    const rowNo = Number(attr(`<row${rowTag}>`, 'r'));
    const index = Number.isFinite(rowNo) && rowNo > 0 ? rowNo - 1 : rows.length;
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[3] ?? '').matchAll(/<(?:\w+:)?c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const tag = `<c${cm[1] ?? ''}>`;
      const body = cm[2] ?? '';
      const ref = attr(tag, 'r');
      const col = ref ? columnOf(ref) : next;
      next = col + 1;
      const type = attr(tag, 't') ?? 'n';
      const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let text = '';
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = textRuns(body);
      else if (type === 'str' || type === 'e') text = xmlText(v ?? '');
      else if (type === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (v !== undefined) text = formatNumber(xmlText(v), kinds[Number(attr(tag, 's') ?? 0)] ?? null);
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
  }
  return rows;
}
