/**
 * The waybill export → dispatch orders.
 *
 * One row per order line, the shape Epicor's open-release BAQ produces:
 *
 *   InPicking, Cust. ID, On Hold, CreditHold, Ship Via, Description, Order,
 *   Line, Rel, Part, Selling Requested Qty, ShippedQty, LeftToShip,
 *   AllocatedQty, UOM, ExpDeliveryDt, Ship By, Need By, ReleaseVal,
 *   FulfillmentMethod, Status, City
 *
 Fuller exports add `PickListComment`, `ShipToCustName` and the ship-to
 * address; they are read when present.
 *
 * Columns are matched by header name, so the BAQ can be reordered. When a
 * name appears twice (a part `Description` beside the ship-via one, a
 * customer `City` beside the ship-to one) the column whose values look like
 * delivery zones is taken for `Description`, and the last `City` for the
 * ship-to city; the columns used are reported. Dates are Australian
 * `d/mm/yyyy`.
 *
 * The order is the unit dispatch plans with, so lines are rolled up:
 * - **volume** is the order's freight line (`FRTNSW`, `FRTSEB`, … in `CBM`),
 *   the cube Epicor already calculated for the consignment;
 * - **packed volume** is read from the pick-list comment, where the
 *   warehouse writes the measured cube once packed (`2C` = 2 m³);
 * - **readiness** comes from the goods lines (everything but `Other`): a line
 *   is ready when its `Status` is `Ready` or it is fully allocated.
 */

import { mapHeaders, normalizeHeader, parseCsv } from '@/lib/csv';
import {
  FREIGHT_VOLUME_PARTS,
  type DayKey,
  type Readiness,
  type ShipmentOrder,
  type WaybillLine,
} from '@/domain/dispatch';

const ALIASES = {
  inPicking: ['InPicking'],
  custId: ['Cust. ID', 'CustID', 'CustomerID'],
  onHold: ['On Hold', 'OnHold'],
  creditHold: ['CreditHold', 'Credit Hold'],
  shipVia: ['Ship Via', 'ShipVia', 'ShipViaCode'],
  zone: ['Description', 'ShipViaDescription'],
  order: ['Order', 'OrderNum'],
  line: ['Line', 'OrderLine'],
  rel: ['Rel', 'OrderRelNum'],
  part: ['Part', 'PartNum'],
  requestedQty: ['Selling Requested Qty', 'SellingReqQty'],
  shippedQty: ['ShippedQty', 'Shipped Qty'],
  leftToShip: ['LeftToShip', 'Left To Ship'],
  allocatedQty: ['AllocatedQty', 'Allocated Qty'],
  uom: ['UOM', 'IUM', 'SalesUM'],
  expDelivery: ['ExpDeliveryDt', 'Exp Delivery Dt'],
  shipBy: ['Ship By', 'ShipBy', 'ReqDate'],
  needBy: ['Need By', 'NeedBy', 'NeedByDate'],
  releaseValue: ['ReleaseVal', 'Release Val'],
  fulfillment: ['FulfillmentMethod', 'Fulfillment Method'],
  status: ['Status'],
  city: ['ShipToCity', 'Ship To City', 'City'],
  pickListComment: ['PickListComment', 'Pick List Comment', 'PickList Comment'],
  shipToName: ['ShipToCustName', 'Ship To Cust Name', 'ShipToName', 'Ship To Name'],
  address1: ['ShipToAddress1', 'Ship To Address1', 'Address1', 'Address'],
  address2: ['ShipToAddress2', 'Ship To Address2', 'Address2'],
  address3: ['ShipToAddress3', 'Ship To Address3', 'Address3'],
  state: ['ShipToState', 'Ship To State', 'State'],
  postcode: ['ShipToZip', 'Ship To Zip', 'Zip', 'PostCode', 'Postcode', 'Post Code'],
} as const;

type Field = keyof typeof ALIASES;

/** Columns the dispatch plan cannot work without (plus Need By or Ship By). */
const REQUIRED: Field[] = ['order', 'zone'];

/** A spreadsheet column letter: 0 → A, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** What each field was read from: header as written and its column letter. */
export type ColumnsUsed = Partial<Record<Field, { header: string; column: string }>>;

export interface WaybillParseResult {
  lines: WaybillLine[];
  orders: ShipmentOrder[];
  warnings: string[];
  columns: ColumnsUsed;
  /** Set when the file is not a waybill export at all. */
  error: string | null;
}

/** `d/mm/yyyy` (or ISO `yyyy-mm-dd`) to a day key; anything else is null. */
export function parseAuDate(raw: string): DayKey | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!au) return null;
  const day = Number(au[1]);
  const month = Number(au[2]);
  const year = au[3].length === 2 ? 2000 + Number(au[3]) : Number(au[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const num = (raw: string | undefined): number => {
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

const bool = (raw: string | undefined): boolean =>
  /^(true|yes|y|1)$/i.test((raw ?? '').trim());

const FREIGHT = new Set<string>(FREIGHT_VOLUME_PARTS);

/**
 * Cube in a pick-list comment: `2C`, `1.5 C`, `2CBM`, `0.8 m3`. Several
 * figures in one comment (`1C + 0.5C`) are added. Words that merely start
 * with a C (`2 cartons`, `3 chairs`) are not cube.
 */
export function parsePackedCube(comment: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*(?:cbm|cube?s?|c|m3|m³)(?![a-z])/gi;
  let total = 0;
  let found = false;
  for (const m of comment.matchAll(re)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) {
      total += v;
      found = true;
    }
  }
  return found ? Math.round(total * 1000) / 1000 : null;
}

/** Looks like a delivery zone (`NSW-Metro`, `QLD- Metro`, `Export-ROW`)? */
const ZONE_LIKE = /^(NSW|ACT|QLD|VIC|SA|WA|TAS|NT|NZ|Export|Hong Kong)\b/i;

/** Is this a line whose quantity is the consignment's cube? */
export const isFreightVolumeLine = (line: WaybillLine): boolean =>
  FREIGHT.has(line.part.trim().toUpperCase()) && line.uom.trim().toUpperCase() === 'CBM';

const isGoodsLine = (line: WaybillLine): boolean =>
  line.fulfillment.trim().toLowerCase() !== 'other';

const isLineReady = (line: WaybillLine): boolean =>
  line.status.trim().toLowerCase() === 'ready' ||
  (line.leftToShip > 0 && line.allocatedQty >= line.leftToShip);

const mostCommon = (values: (string | null)[]): string | null => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
};

/** Roll an order's lines up into the unit dispatch plans with. */
export function toShipmentOrder(id: string, lines: WaybillLine[]): ShipmentOrder {
  const first = lines[0];
  const notes: string[] = [];

  const freight = lines.filter(isFreightVolumeLine);
  let volumeM3: number | null = null;
  if (freight.length > 0) {
    // One order carried both `FRTTAS` and `FRTSEB` with the same cube — the
    // same consignment priced twice, not two consignments. Take the largest
    // rather than double the volume, and say so.
    volumeM3 = Math.max(...freight.map((l) => l.leftToShip));
    if (freight.length > 1) {
      notes.push(
        `${freight.length} freight lines (${freight
          .map((l) => `${l.part} ${l.leftToShip}`)
          .join(', ')}) — largest used`,
      );
    }
  } else {
    notes.push('No freight (CBM) line — volume unknown');
  }

  const goods = lines.filter(isGoodsLine);
  const ready = goods.filter(isLineReady).length;
  const partial = goods.some((l) => l.status.trim().toUpperCase() === 'PARTIAL');
  const readiness: Readiness =
    goods.length === 0
      ? 'no-goods'
      : ready === goods.length
        ? 'ready'
        : ready > 0 || partial
          ? 'partial'
          : 'not-ready';

  const shipBy = mostCommon(lines.map((l) => l.shipBy));
  const needBy = mostCommon(lines.map((l) => l.needBy));
  if (new Set(lines.map((l) => l.needBy).filter(Boolean)).size > 1) {
    notes.push('Lines carry different Need By dates — most common used');
  }
  if (!needBy && !shipBy) notes.push('No Need By or Ship By date');

  // The comment is usually written once per order and repeated on every
  // line; different comments on different lines are each counted.
  const comments = [...new Set(lines.map((l) => l.pickListComment.trim()).filter(Boolean))];
  const packed = comments.map(parsePackedCube).filter((v): v is number => v !== null);
  const packedM3 = packed.length > 0 ? Math.round(packed.reduce((a, b) => a + b, 0) * 1000) / 1000 : null;
  if (packed.length > 1) {
    notes.push(`${packed.length} different pick-list cubes (${comments.join(' | ')}) — added together`);
  }

  const text = (pick: (l: WaybillLine) => string) => mostCommon(lines.map((l) => pick(l).trim() || null)) ?? '';

  return {
    id,
    custId: first.custId,
    shipToName: text((l) => l.shipToName),
    address: text((l) => l.address),
    state: text((l) => l.state),
    postcode: text((l) => l.postcode),
    shipVia: first.shipVia,
    zone: first.zone,
    city: first.city.replace(/ /g, ' ').trim(),
    shipBy,
    needBy,
    expDelivery: mostCommon(lines.map((l) => l.expDelivery)),
    pickListComment: comments.join(' | '),
    packedM3,
    volumeM3,
    value: lines.reduce((sum, l) => sum + l.releaseValue, 0),
    goodsValue: goods.reduce((sum, l) => sum + l.releaseValue, 0),
    freightValue: lines.filter((l) => !isGoodsLine(l)).reduce((sum, l) => sum + l.releaseValue, 0),
    lineCount: lines.length,
    goodsLines: goods.length,
    readyLines: ready,
    readiness,
    inPicking: lines.some((l) => l.inPicking),
    onHold: lines.some((l) => l.onHold),
    creditHold: lines.some((l) => l.creditHold),
    notes,
  };
}

export function parseWaybillCsv(text: string): WaybillParseResult {
  const rows = parseCsv(text);
  const empty = { lines: [], orders: [], warnings: [], columns: {} };
  if (rows.length === 0) return { ...empty, error: 'The file is empty.' };

  const header = rows[0];
  const col = mapHeaders(header, ALIASES);
  const missing = REQUIRED.filter((f) => col[f] === undefined);
  if (col.needBy === undefined && col.shipBy === undefined) missing.push('needBy');
  if (missing.length > 0) {
    return {
      ...empty,
      error:
        'Not a waybill export: no ' +
        missing.map((f) => `"${ALIASES[f][0]}"`).join(', ') +
        ' column.',
    };
  }

  const warnings: string[] = [];
  const body = rows.slice(1);
  const sameName = (at: number | undefined): number[] =>
    at === undefined
      ? []
      : header.flatMap((h, i) => (normalizeHeader(h) === normalizeHeader(header[at]) ? [i] : []));

  // Two columns named `Description`: the delivery zone is the one whose
  // values look like zones.
  const zoneCols = sameName(col.zone);
  if (zoneCols.length > 1) {
    const score = (i: number) => body.filter((r) => ZONE_LIKE.test((r[i] ?? '').trim())).length;
    col.zone = zoneCols.reduce((best, i) => (score(i) > score(best) ? i : best));
    warnings.push(
      `${zoneCols.length} "${header[col.zone].trim()}" columns — delivery zone read from column ${columnLetter(col.zone)}`,
    );
  }
  // Two columns named `City`: the ship-to city is the later one.
  const cityCols = sameName(col.city);
  if (cityCols.length > 1) {
    col.city = cityCols[cityCols.length - 1];
    warnings.push(
      `${cityCols.length} "${header[col.city].trim()}" columns — ship-to city read from column ${columnLetter(col.city)}`,
    );
  }

  const columns: ColumnsUsed = {};
  for (const f of Object.keys(ALIASES) as Field[]) {
    const at = col[f];
    if (at !== undefined) columns[f] = { header: header[at].trim(), column: columnLetter(at) };
  }

  const cell = (row: string[], f: Field): string => {
    const at = col[f];
    return at === undefined ? '' : (row[at] ?? '').trim();
  };

  const lines: WaybillLine[] = [];
  body.forEach((row, i) => {
    if (row.every((c) => c.trim() === '')) return;
    const order = cell(row, 'order');
    if (!order) {
      warnings.push(`Row ${i + 2}: no Order number, skipped`);
      return;
    }
    const date = (f: Field): DayKey | null => {
      const raw = cell(row, f);
      const parsed = parseAuDate(raw);
      if (raw && !parsed) warnings.push(`Row ${i + 2}: unreadable ${ALIASES[f][0]} "${raw}"`);
      return parsed;
    };
    lines.push({
      order,
      line: cell(row, 'line'),
      rel: cell(row, 'rel'),
      custId: cell(row, 'custId'),
      shipVia: cell(row, 'shipVia'),
      zone: cell(row, 'zone'),
      city: cell(row, 'city'),
      part: cell(row, 'part'),
      requestedQty: num(cell(row, 'requestedQty')),
      shippedQty: num(cell(row, 'shippedQty')),
      leftToShip: num(cell(row, 'leftToShip')),
      allocatedQty: num(cell(row, 'allocatedQty')),
      uom: cell(row, 'uom'),
      expDelivery: date('expDelivery'),
      shipBy: date('shipBy'),
      needBy: date('needBy'),
      releaseValue: num(cell(row, 'releaseValue')),
      fulfillment: cell(row, 'fulfillment'),
      status: cell(row, 'status'),
      inPicking: bool(cell(row, 'inPicking')),
      onHold: bool(cell(row, 'onHold')),
      creditHold: bool(cell(row, 'creditHold')),
      pickListComment: cell(row, 'pickListComment'),
      shipToName: cell(row, 'shipToName'),
      address: [cell(row, 'address1'), cell(row, 'address2'), cell(row, 'address3')].filter(Boolean).join(', '),
      state: cell(row, 'state'),
      postcode: cell(row, 'postcode'),
    });
  });

  const byOrder = new Map<string, WaybillLine[]>();
  for (const line of lines) {
    const list = byOrder.get(line.order);
    if (list) list.push(line);
    else byOrder.set(line.order, [line]);
  }
  const orders = [...byOrder].map(([id, ls]) => toShipmentOrder(id, ls));
  return { lines, orders, warnings, columns, error: null };
}
