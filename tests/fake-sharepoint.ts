/**
 * A SharePoint site, as far as the data layer can tell: lists held in memory
 * and served over the REST calls `dal/sharepoint` makes — the form digest,
 * `getbytitle(...)/items` with `$filter`, item create / MERGE / DELETE, and
 * files by server-relative URL.
 *
 * For end-to-end tests of the data layer through its public methods: what one
 * device writes, another reads, with nothing inside the class stubbed. It
 * answers `fetch`, so install it with `site.install()` and put the previous
 * `fetch` back with the function that returns.
 */

type Row = Record<string, unknown>;

export interface WireCall {
  method: string;
  /** Path and query below the site, percent-decoded. */
  url: string;
  body?: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const spError = (status: number, message: string): Response =>
  json({ error: { code: '-1, Microsoft.SharePoint.SPException', message: { lang: 'en-US', value: message } } }, status);

export class FakeSharePoint {
  readonly siteUrl: string;
  private lists = new Map<string, Row[]>();
  private files = new Map<string, string>();
  private fileTimes = new Map<string, string>();
  private fileWrites = 0;
  private absent = new Set<string>();
  private nextId = 1;
  /** Every request made, in order. */
  readonly calls: WireCall[] = [];
  /** Requests this site had no answer for. A test should end with none. */
  readonly unanswered: string[] = [];

  constructor(siteUrl = 'https://example.sharepoint.com/sites/pmd') {
    this.siteUrl = siteUrl;
  }

  /** Create a list (or add rows to it). Rows get an `ID` when they have none. */
  seed(title: string, rows: Row[] = []): this {
    const held = this.lists.get(title) ?? [];
    for (const row of rows) held.push({ ID: this.nextId++, ...row });
    this.lists.set(title, held);
    return this;
  }

  /**
   * A column this site's list does not have. The lists here have no schema —
   * a row carries what was written to it — so every column exists until a
   * test says one does not; a read that names it in `$select` is then
   * refused, as SharePoint refuses it.
   */
  withoutColumn(title: string, name: string): this {
    this.absent.add(`${title}|${name}`);
    return this;
  }

  /** A file in a document library, by server-relative path. */
  seedFile(serverRelativePath: string, text: string): this {
    this.files.set(serverRelativePath.toLowerCase(), text);
    // Each write is a new TimeLastModified, as a re-upload is.
    this.fileTimes.set(
      serverRelativePath.toLowerCase(),
      new Date(Date.UTC(2026, 0, 1) + ++this.fileWrites * 60_000).toISOString(),
    );
    return this;
  }

  rows(title: string): Row[] {
    return (this.lists.get(title) ?? []).map((row) => ({ ...row }));
  }

  /** Writes made, as `METHOD list` lines — the shape of what went out. */
  writes(): string[] {
    return this.calls
      .filter((call) => call.method !== 'GET' && !call.url.endsWith('/contextinfo'))
      .map((call) => `${call.method} ${/getbytitle\('([^']+)'\)/.exec(call.url)?.[1] ?? call.url}`);
  }

  /** Answer `fetch` from this site. Returns the function that undoes it. */
  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  }

  private async handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!raw.startsWith(this.siteUrl)) return this.miss('GET', raw);
    const headers = new Headers(init.headers);
    const verb = (init.method ?? 'GET').toUpperCase();
    const method = verb === 'POST' ? (headers.get('X-HTTP-Method') ?? 'POST').toUpperCase() : verb;
    const url = decodeURIComponent(raw.slice(this.siteUrl.length));
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : undefined;
    this.calls.push({ method, url, ...(body ? { body } : {}) });

    if (url === '/_api/contextinfo') {
      return json({ d: { GetContextWebInformation: { FormDigestValue: 'digest', FormDigestTimeoutSeconds: 1800 } } });
    }
    if (url.startsWith('/_api/web/currentuser')) {
      return json({ d: { Id: 7, Title: 'E2E User', Email: 'e2e@example.com', LoginName: 'e2e', IsSiteAdmin: false } });
    }

    const file = /^\/_api\/web\/GetFileByServerRelative(?:Url|Path)\((?:decodedurl=)?'([^']+)'\)\/\$value/i.exec(url);
    if (file) {
      const text = this.files.get(file[1].toLowerCase());
      return text === undefined ? spError(404, 'File Not Found.') : new Response(text, { status: 200 });
    }
    const fileInfo = /^\/_api\/web\/GetFileByServerRelative(?:Url|Path)\((?:decodedurl=)?'([^']+)'\)(?:\?.*)?$/i.exec(url);
    if (fileInfo && method === 'GET') {
      const modified = this.fileTimes.get(fileInfo[1].toLowerCase());
      return modified === undefined ? spError(404, 'File Not Found.') : json({ d: { TimeLastModified: modified } });
    }

    const list = /^\/_api\/web\/lists\/getbytitle\('([^']+)'\)(.*)$/i.exec(url);
    if (!list) return this.miss(method, url);
    const [, title, rest] = list;
    const rows = this.lists.get(title);
    if (!rows) return spError(404, `List '${title}' does not exist at site with URL '${this.siteUrl}'.`);
    const [path, query = ''] = rest.split(/\?(.*)/s);

    if (path === '' && method === 'GET') {
      return json({ d: { Title: title, ListItemEntityTypeFullName: `SP.Data.${title.replace(/[^A-Za-z0-9]/g, '_')}ListItem` } });
    }
    if (path === '/fields' && method === 'GET') {
      const names = new Set(rows.flatMap((row) => Object.keys(row)));
      return json({ d: { results: [...names].map((name) => ({ InternalName: name, StaticName: name, Title: name, TypeAsString: 'Text' })) } });
    }
    if (path === '/items' && method === 'GET') {
      const params = new URLSearchParams(query.replace(/\+/g, '%2B'));
      const filter = params.get('$filter');
      const kept = filter ? rows.filter((row) => evalFilter(filter, row)) : rows;
      // $select: only the columns named — and, as SharePoint does, a 400 for
      // one the list does not have (see `withoutColumn`).
      const select = params.get('$select');
      if (select) {
        const asked = select.split(',').map((name) => name.trim()).filter(Boolean);
        const missing = asked.find((name) => this.absent.has(`${title}|${name}`));
        if (missing) return spError(400, `The field or property '${missing}' does not exist.`);
        return json({
          d: {
            results: kept.map((row) => {
              const all: Row = { ...row, Id: row.ID };
              return Object.fromEntries(asked.filter((name) => name in all).map((name) => [name, all[name]]));
            }),
          },
        });
      }
      return json({ d: { results: kept.map((row) => ({ ...row, Id: row.ID })) } });
    }
    if (path === '/items' && method === 'POST') {
      const { __metadata: _type, ...fields } = body ?? {};
      const row: Row = { ID: this.nextId++, ...fields };
      rows.push(row);
      return json({ d: { ...row, Id: row.ID } }, 201);
    }
    const item = /^\/items\((\d+)\)(.*)$/.exec(path);
    if (item) {
      const at = rows.findIndex((row) => row.ID === Number(item[1]));
      if (at === -1) return spError(404, 'Item does not exist. It may have been deleted by another user.');
      if (item[2] === '' && method === 'MERGE') {
        const { __metadata: _type, ...fields } = body ?? {};
        rows[at] = { ...rows[at], ...fields };
        return new Response(null, { status: 204 });
      }
      if (item[2] === '' && method === 'DELETE') {
        rows.splice(at, 1);
        return new Response(null, { status: 200 });
      }
      if (item[2] === '' && method === 'GET') return json({ d: { ...rows[at], Id: rows[at].ID } });
      if (item[2] === '/AttachmentFiles' && method === 'GET') return json({ d: { results: [] } });
    }
    return this.miss(method, url);
  }

  private miss(method: string, url: string): Response {
    this.unanswered.push(`${method} ${url}`);
    return spError(404, 'Not found in the fake site.');
  }
}

// ---- $filter ---------------------------------------------------------------

type Token = { kind: 'word' | 'string' | 'number' | 'punct'; text: string };

function tokens(filter: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(datetime)?'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w.]*)|([(),]))/gy;
  let at = 0;
  while (at < filter.length) {
    re.lastIndex = at;
    const m = re.exec(filter);
    if (!m) throw new Error(`fake SharePoint cannot read $filter at: ${filter.slice(at)}`);
    at = re.lastIndex;
    if (m[2] !== undefined) out.push({ kind: 'string', text: m[2].replace(/''/g, "'") });
    else if (m[3] !== undefined) out.push({ kind: 'number', text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: 'word', text: m[4] });
    else out.push({ kind: 'punct', text: m[5] });
  }
  return out;
}

/** Dates compare as instants; a date-only cell is that day at midnight UTC. */
function comparable(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(text)) {
    const time = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
    if (!Number.isNaN(time)) return time;
  }
  return text;
}

/** The subset of OData `$filter` the data layer writes: comparisons joined by
 *  and / or, parentheses, and startswith / substringof. */
export function evalFilter(filter: string, row: Row): boolean {
  const list = tokens(filter);
  let at = 0;
  const peek = (): Token | undefined => list[at];
  const take = (): Token => list[at++];
  const isWord = (text: string): boolean => peek()?.kind === 'word' && peek()!.text.toLowerCase() === text;

  const operand = (): unknown => {
    const token = take();
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.text === 'null') return null;
    if (token.text === 'true') return true;
    if (token.text === 'false') return false;
    return row[token.text];
  };
  const primary = (): boolean => {
    if (peek()?.text === '(') {
      take();
      const inner = or();
      take(); // ')'
      return inner;
    }
    if (isWord('not')) {
      take();
      return !primary();
    }
    if (isWord('startswith') || isWord('substringof')) {
      const fn = take().text.toLowerCase();
      take(); // '('
      const a = operand();
      take(); // ','
      const b = operand();
      take(); // ')'
      const [hay, needle] = fn === 'startswith' ? [a, b] : [b, a];
      const text = String(hay ?? '').toLowerCase();
      const part = String(needle ?? '').toLowerCase();
      return fn === 'startswith' ? text.startsWith(part) : text.includes(part);
    }
    const left = comparable(operand());
    const op = take().text.toLowerCase();
    const right = comparable(operand());
    // SharePoint text comparison is case-insensitive.
    const fold = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);
    const [a, b] = [fold(left), fold(right)] as [string | number | boolean | null, string | number | boolean | null];
    switch (op) {
      case 'eq': return a === b;
      case 'ne': return a !== b;
      case 'gt': return a !== null && b !== null && a > b;
      case 'ge': return a !== null && b !== null && a >= b;
      case 'lt': return a !== null && b !== null && a < b;
      case 'le': return a !== null && b !== null && a <= b;
      default: throw new Error(`fake SharePoint does not know the operator "${op}" in: ${filter}`);
    }
  };
  const and = (): boolean => {
    let value = primary();
    while (isWord('and')) {
      take();
      const next = primary();
      value = value && next;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (isWord('or')) {
      take();
      const next = and();
      value = value || next;
    }
    return value;
  };
  return or();
}
