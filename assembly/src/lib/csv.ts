/**
 * A small RFC 4180 CSV reader.
 *
 * Epicor exports quote any field containing a comma (part descriptions do), and
 * SharePoint hands the file back with a BOM and CRLF line endings, so a
 * `split(',')` would corrupt roughly one row in ten. This is ~40 lines and has
 * no dependency, which beats pulling a parser in for one file.
 */

export type CsvRow = string[];

/** Split CSV text into rows of raw string cells. Handles quotes and CRLF. */
export function parseCsv(text: string, delimiter = ','): CsvRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const rows: CsvRow[] = [];
  let row: CsvRow = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (src[i + 1] === '"') {
        field += '"'; // an escaped quote inside a quoted field
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // swallow; the \n that follows ends the row
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) {
    rows.pop();
  }
  return rows;
}

/**
 * Normalise a header for matching: case-folded, with separators and the
 * `Table_` prefix noise removed. `JobHead_ReqDueDate`, `ReqDueDate` and
 * `Req Due Date` all collapse to `reqduedate`.
 */
export const normalizeHeader = (h: string): string =>
  h
    .trim()
    .replace(/^(JobHead|JobOper|JobAsmbl|JobProd|Calculated|Part)[_.]/i, '')
    .replace(/[\s_.-]+/g, '')
    .toLowerCase();

/**
 * Locate columns by header name. Returns a `field → column index` map built
 * from a spec of `field → accepted header aliases`; a field whose aliases match
 * nothing is simply absent from the map.
 */
export function mapHeaders<F extends string>(
  header: CsvRow,
  aliases: Record<F, readonly string[]>,
): Partial<Record<F, number>> {
  const byName = new Map<string, number>();
  header.forEach((h, i) => {
    const key = normalizeHeader(h);
    if (key && !byName.has(key)) byName.set(key, i);
  });

  const out: Partial<Record<F, number>> = {};
  for (const [field, names] of Object.entries(aliases) as [
    F,
    readonly string[],
  ][]) {
    for (const name of names) {
      const at = byName.get(normalizeHeader(name));
      if (at !== undefined) {
        out[field] = at;
        break;
      }
    }
  }
  return out;
}
