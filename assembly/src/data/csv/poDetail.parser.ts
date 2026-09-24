/**
 * Open purchase-order releases exported from Epicor as `PODetail.csv`.
 *
 * One row per release still to arrive: the part (`PODetail_PartNum`), how many
 * are outstanding (`Calculated_OutstandingQty`), the PO (`PORel_PONum`) and two
 * dates — the date the release is due (`PORel_DueDate`) and the date the
 * supplier promised (`PORel_PromiseDt`). The goods are counted on as
 * available at the later of the two: a promise earlier than the due date is
 * not a reason to plan on them sooner, and one later than it is the supplier
 * saying they will be late.
 */

import { PartId } from '@/domain/ids';
import type { PoLine } from '@/domain/types';
import { normalizeHeader, parseCsv } from '@/lib/csv';

const aliases = {
  part: ['podetailpartnum', 'partnum'],
  qty: ['outstandingqty', 'podetailoutstandingqty'],
  due: ['porelduedate', 'duedate'],
  promise: ['porelpromisedt', 'promisedt', 'promisedate'],
  poNum: ['porelponum', 'podetailponum', 'ponum'],
  vendor: ['vendorname', 'vendor'],
  buyer: ['puragentname', 'buyer'],
  description: ['podetaillinedesc', 'linedesc'],
} as const;

const column = (headers: string[], names: readonly string[]): number =>
  names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;

const numberValue = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.replaceAll(',', '').trim());
  return Number.isFinite(value) ? value : null;
};

/**
 * A date as this plant's exports write it: day first (`28/10/2026`,
 * `2/10/2026`, optionally with a time after it), or ISO (`2026-10-28`,
 * `2026-10-28T00:00:00`). Always local midnight of that day — `new Date` would
 * read `2/10/2026` as the 10th of February, and a bare ISO date as UTC.
 */
export function exportDate(raw: string | undefined): Date | null {
  const v = raw?.trim() ?? '';
  if (v === '') return null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(v);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const d = dmy
    ? new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))
    : ymd
      ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
      : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  // 31/02 rolls into March; a date that does not exist is not a date.
  const day = Number((dmy ?? ymd)![dmy ? 1 : 3]);
  return d.getDate() === day ? d : null;
}

/** Comma unless the header row is plainly tab-separated (a paste from Excel). */
const delimiterOf = (text: string): string => {
  const first = text.slice(0, text.indexOf('\n') >>> 0);
  return first.includes('\t') && !first.includes(',') ? '\t' : ',';
};

export function parsePoDetailCsv(text: string): {
  values: PoLine[];
  errors: string[];
} {
  const rows = parseCsv(text, delimiterOf(text));
  if (rows.length === 0) return { values: [], errors: ['PODetail.csv is empty'] };
  const headers = rows[0].map(normalizeHeader);
  const col = Object.fromEntries(
    Object.entries(aliases).map(([key, names]) => [key, column(headers, names)]),
  ) as Record<keyof typeof aliases, number>;
  if (col.part < 0 || col.qty < 0 || (col.due < 0 && col.promise < 0)) {
    return {
      values: [],
      errors: [
        'PODetail.csv needs PODetail_PartNum, Calculated_OutstandingQty and ' +
          'PORel_DueDate or PORel_PromiseDt columns',
      ],
    };
  }

  const errors: string[] = [];
  const values: PoLine[] = [];
  rows.slice(1).forEach((row, index) => {
    const part = row[col.part]?.trim();
    if (!part) return;
    const qty = numberValue(row[col.qty]);
    if (qty === null) {
      errors.push(`PODetail.csv row ${index + 2}: invalid Calculated_OutstandingQty`);
      return;
    }
    if (qty <= 0) return; // fully received: nothing is coming
    const cell = (i: number) => (i >= 0 ? row[i]?.trim() || null : null);
    const dueDate = exportDate(cell(col.due) ?? undefined);
    const promiseDate = exportDate(cell(col.promise) ?? undefined);
    if (cell(col.due) && !dueDate) {
      errors.push(`PODetail.csv row ${index + 2}: unreadable PORel_DueDate "${cell(col.due)}"`);
    }
    if (cell(col.promise) && !promiseDate) {
      errors.push(`PODetail.csv row ${index + 2}: unreadable PORel_PromiseDt "${cell(col.promise)}"`);
    }
    values.push({
      partNum: PartId(part),
      poNum: cell(col.poNum),
      outstandingQty: qty,
      dueDate,
      promiseDate,
      buyer: cell(col.buyer),
      vendor: cell(col.vendor),
    });
  });
  return { values, errors };
}
