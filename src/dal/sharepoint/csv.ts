// SharePoint data layer — the Epicor planning extract, and the CSV reading
// the other extracts share.
import type { PlanningOrder } from '../../types';
import { parseShiftPattern } from '../../core/shifts';

function excelDate(v: unknown): Date | null {
  if (v == null || v === '') return null;

  // Excel serial — happens when Graph is asked with valuesOnly=true or for
  // workbook ranges where the cell type is numeric DateTime. Decompose the
  // serial as UTC to extract the wall-clock components Excel intended, then
  // rebuild via the local Date constructor so a Sydney user gets 12:00
  // local for a cell that reads "12:00", not 12:00 UTC (= 22:00 Sydney).
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 200000) {
    const utcMs = (v - 25569) * 86400 * 1000;
    const u = new Date(utcMs);
    return new Date(
      u.getUTCFullYear(),
      u.getUTCMonth(),
      u.getUTCDate(),
      u.getUTCHours(),
      u.getUTCMinutes(),
      u.getUTCSeconds(),
    );
  }

  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;

  // Some exports write a date column as the raw Excel serial *string*
  // ("46234"). Treat a pure number in the plausible serial range (≈1954+)
  // as a serial so those dates aren't silently dropped. Small integers
  // (a "Time" of "7") stay untouched.
  if (/^\d{5,6}$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial <= 200000) return excelDate(serial);
  }

  // Year-first dates, EITHER separator:
  //  · Graph ISO 8601 "2026-05-25T12:00:00.000Z" (dashes, optional time/Z)
  //  · the Mango/Minto export's "2025/10/10" / "2026/07/31" (slashes,
  //    year-first — day last, confirmed by values >12 like 31).
  // Excel has no timezone — the "12:00" the user typed is wall-clock, not
  // UTC. Parsing via `new Date()` would treat the Z as UTC and shift by the
  // local offset (Sydney AEST: 10 h, the "10:00 PM" symptom). Extract the
  // components and anchor them to local time instead. The time portion is
  // optional so a bare "2026-05-25" / "2025/10/10" date is accepted too.
  const iso =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/i.exec(
      s,
    );
  if (iso) {
    return new Date(
      +iso[1], +iso[2] - 1, +iso[3],
      iso[4] ? +iso[4] : 0,
      iso[5] ? +iso[5] : 0,
      iso[6] ? +iso[6] : 0,
    );
  }

  // AU date with optional time, e.g. "25/05/2026", "25/05/2026 14:00",
  // or "25/05/2026 2:00:00 PM". JS's native parser is unreliable here
  // because en-US engines flip to MM/DD interpretation.
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(s);
  if (au) {
    let hour = au[4] ? parseInt(au[4], 10) : 0;
    if (au[7]) {
      const isPm = au[7].toLowerCase() === 'pm';
      if (isPm && hour < 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
    }
    return new Date(
      +au[3], +au[2] - 1, +au[1],
      hour, au[5] ? +au[5] : 0, au[6] ? +au[6] : 0,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// CSV parsing for the Epicor → CSV → SharePoint file → app pipeline.
// Tiny single-purpose parser: handles quoted fields with embedded commas
// and double-double-quote escapes; ignores BOM and CRLF/LF line endings.
// ---------------------------------------------------------------------------

export function parsePlanningCsv(text: string): PlanningOrder[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) throw new Error('Planning CSV is empty');
  const header = rows[0].map((c) => c.trim());
  const idx = (name: string): number => header.indexOf(name);
  const firstIdx = (...names: string[]): number => {
    for (const n of names) {
      const i = idx(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iJob = idx('JobHead_JobNum');
  if (iJob < 0) {
    throw new Error(
      `Planning CSV schema invalid: required column 'JobHead_JobNum' is missing (header: ${header.join(' | ')})`,
    );
  }
  const iPart = idx('JobHead_PartNum');
  const iMachine = idx('Machine');
  const iDesc = idx('JobHead_PartDescription');
  const iProd = idx('JobHead_ProdQty');
  const iRem = idx('Calculated_RemainingQty');
  const iStart = idx('JobHead_StartDate');
  const iDue = idx('JobHead_ReqDueDate');
  const iQty = idx('JobOper_ProdStandard');
  // Optional column: decimal hours-of-day for the planned start
  // (e.g. 18.68 → 18:40:48). Epicor emits this separately from the
  // date so JobHead_StartDate is just YYYY-MM-DD; we layer the
  // decimal-hours value back onto that date here. The Epicor field
  // is JobHead_StartHour; the remaining variants are kept as
  // defensive fallbacks so a header rename in the export tool
  // doesn't require a code change.
  const iStartTime = firstIdx(
    'JobHead_StartHour',
    'JobHead_StartTime',
    'JobHead_Start_Time',
    'Start_Time',
    'StartTime',
    'Start Time',
  );
  // Optional column: the shifts the press is crewed for ("MAN"). Matched
  // loosely — case, spaces and a plural "s" — because it is a hand-named
  // column in the export, not an Epicor field.
  const iShifts = header.findIndex((h) =>
    ['noofshift', 'noofshifts', 'shiftpattern'].includes(h.toLowerCase().replace(/[^a-z]/g, '')),
  );
  const out: PlanningOrder[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;
    // Trim the JobNum like Part # below — a stray trailing space / NBSP in
    // the Epicor export cell makes the exact-match lookups in orderForJob /
    // the Job# dropdown miss, so Order Qty + Product Description silently come
    // back blank for that order even though the row is present. (Reported:
    // SFM507057 / Batt1 wouldn't load its Qty + description.)
    const job = (row[iJob] ?? '').trim(); // trim() also strips NBSP / BOM
    if (!job) continue;
    let startIso = csvDateToIso(row[iStart] ?? '');
    // Layer the start-time decimal onto the start-date when the
    // column is present and parses as a finite non-negative number
    // less than 24. Anything else (blank, NaN, > 24) is ignored so
    // a missing value can't silently shift a job to midnight.
    if (startIso && iStartTime >= 0) {
      const raw = (row[iStartTime] ?? '').trim();
      if (raw !== '') {
        const decH = parseFloat(raw);
        if (isFinite(decH) && decH >= 0 && decH < 24) {
          startIso = applyDecimalHoursToIso(startIso, decH);
        }
      }
    }
    // Both fields now contain the actual Sydney wall-clock time. DueDate
    // is authoritative for the schedule end; duration is their elapsed
    // span, not the retired Calculated_RemaingLaborHrs export column.
    const dueIso = csvDateToIso(row[iDue] ?? '');
    let dur = 0;
    if (startIso && dueIso) {
      const startMs = new Date(startIso).getTime();
      const dueMs = new Date(dueIso).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(dueMs) && dueMs > startMs) {
        dur = (dueMs - startMs) / 3600_000;
      }
    }
    // Epicor now exports JobOper_ProdStandard as pieces/hour. The app's
    // established internal field is hours/piece, so invert once at the
    // boundary and keep every downstream calculation unit-safe.
    const piecesPerHour = parseFloat(row[iQty] ?? '0') || 0;
    const shifts = iShifts >= 0 ? parseShiftPattern(row[iShifts]) : undefined;
    out.push({
      id: 0,
      jobNumber: job,
      machineCode: (row[iMachine] ?? '').trim(),
      originalMachine: (row[iMachine] ?? '').trim(),
      // Trim Part # so a stray trailing space in the Excel cell can't
      // break the PMD_ProductDieColor Map lookup (operator swatch +
      // KPIs colour column both key on this).
      partNumber: (row[iPart] ?? '').trim(),
      partDescription: row[iDesc] ?? '',
      plannedStart: startIso,
      plannedEnd: dueIso,
      // Order Qty = total ProdQty; Job Left = remaining. Fall back to the
      // remaining value when the export predates the ProdQty column.
      orderQty:
        (iProd >= 0 ? parseFloat(row[iProd] ?? '0') : 0) ||
        parseFloat(row[iRem] ?? '0') ||
        0,
      jobRequired: parseFloat(row[iRem] ?? '0') || 0,
      qtyPerHr: piecesPerHour > 0 ? 1 / piecesPerHour : 0,
      duration: dur,
      released: true,
      isDieChange: false,
      manuallyAdded: false,
      source: 'ERP',
      ...(shifts ? { shifts } : {}),
    });
  }
  return out;
}

/**
 * Convert decimal hours-of-day to (hh, mm, ss). 18.68 → 18:40:48.
 * Rounds the seconds and carries 60 → 00 + next-minute / next-hour so
 * a value of 23.999999 doesn't materialise as 23:59:60 (which Date
 * happily accepts but quietly rolls into the next day).
 */
export function decimalHoursToHms(h: number): [number, number, number] {
  let hh = Math.floor(h);
  const remMin = (h - hh) * 60;
  let mm = Math.floor(remMin);
  let ss = Math.round((remMin - mm) * 60);
  if (ss === 60) {
    ss = 0;
    mm += 1;
  }
  if (mm === 60) {
    mm = 0;
    hh += 1;
  }
  return [hh, mm, ss];
}

/** Replace the wall-clock time of an ISO timestamp with the decimal
 *  hours-of-day value. Keeps the original calendar date untouched. */
function applyDecimalHoursToIso(iso: string, decimalHours: number): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  const [hh, mm, ss] = decimalHoursToHms(decimalHours);
  d.setHours(hh, mm, ss, 0);
  return localDateTimeIso(d);
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // A double-quote only OPENS a quoted field when it's the field's first
  // character (RFC 4180). A `"` in the middle of an unquoted field — an
  // inch mark ("6" tall"), or an unbalanced quote in free-text like
  // "Actions taken" — is then a literal character, not a delimiter, so it
  // can't flip the parser into quote mode and swallow the commas / newlines
  // that follow (which would desync every column after it, blanking cells
  // like "To be completed by" on later rows).
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fieldStart = true;
    } else if (c === '\r') {
      // skip — \n handles the row break
    } else if (c === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      fieldStart = true;
    } else {
      field += c;
      fieldStart = false;
    }
  }
  if (inQuotes) {
    throw new Error('CSV format invalid: unterminated quoted field');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

export function csvDateToIso(s: string): string {
  // PowerShell emits ISO; manually-edited CSVs sometimes carry en-AU
  // dd/mm/yyyy [HH:mm[:ss] [am/pm]] or bare dates. excelDate handles all
  // three and anchors the value to LOCAL time (Excel/Mango dates are
  // wall-clock, not UTC).
  const d = excelDate(s);
  if (!d) return '';
  // Serialise from the LOCAL calendar components — never via toISOString(),
  // which converts to UTC and rolls a bare date back a day in any UTC+
  // timezone (Sydney: 31/07/2026 → local midnight → 2026-07-30T14:00Z →
  // "2026-07-30"). A date-only value stays a stable YYYY-MM-DD; a datetime
  // keeps its wall-clock time with no Z so the day never shifts.
  const p = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  // Preserve an EXPLICIT midnight as a datetime. Looking only at the Date's
  // numeric components collapses "2026-07-01T00:00:00" to a bare date and
  // loses the fact that Epicor actually scheduled the job for midnight.
  const hasTime = /(?:T|\s)\d{1,2}:\d{2}/i.test(s.trim());
  return hasTime
    ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    : date;
}

function localDateTimeIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}
