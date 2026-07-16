import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dateOnly,
  decimalHoursToHms,
  isStaleLiveHeader,
  odataString,
  parsePlanningCsv,
  sanitizeBodyStrings,
  SharePointDataLayer,
  shiftEndedLongAgo,
  toServerRelativePath,
} from '../src/dal/sharepoint';

describe('SharePoint DAL surface', () => {
  it('accepts the string siteUrl shorthand for backwards compat', () => {
    const sp = new SharePointDataLayer('https://example.sharepoint.com/sites/foo');
    expect(sp).toBeInstanceOf(SharePointDataLayer);
  });
});

describe('parsePlanningCsv', () => {
  it('parses headers + rows with the expected Epicor column names', () => {
    const csv =
      'JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_StartDate,JobHead_ReqDueDate,Calculated_RemaingLaborHrs,JobOper_ProdStandard\n' +
      'J100,P1,"Widget, large",250,2026-06-02T07:00:00,2026-06-05T15:00:00,8.5,30\n' +
      'J101,P2,Bolt,0,,,0,0\n';
    const out = parsePlanningCsv(csv);
    expect(out).toHaveLength(2);
    expect(out[0].jobNumber).toBe('J100');
    expect(out[0].partNumber).toBe('P1');
    expect(out[0].partDescription).toBe('Widget, large');
    expect(out[0].jobRequired).toBe(250);
    // No JobHead_ProdQty column → Order Qty falls back to the remaining qty.
    expect(out[0].orderQty).toBe(250);
    expect(out[0].duration).toBe(8.5);
    expect(out[0].qtyPerHr).toBe(30);
    expect(out[0].plannedStart).not.toBe('');
    expect(out[1].jobNumber).toBe('J101');
    expect(out[1].plannedStart).toBe('');
  });

  it('maps JobHead_ProdQty to Order Qty, keeping Calculated_RemainingQty for Job Left', () => {
    const csv =
      'JobHead_JobNum,JobHead_ProdQty,Calculated_RemainingQty\n' +
      'J500,1000,250\n';
    const out = parsePlanningCsv(csv);
    expect(out[0].orderQty).toBe(1000); // total order
    expect(out[0].jobRequired).toBe(250); // remaining → Job Left
  });

  it('trims stray whitespace / NBSP off the JobNum so order lookups match', () => {
    // Epicor export had a trailing NBSP on the JobNum cell; the exact-match
    // lookups (orderForJob, Job# dropdown) then missed and Order Qty +
    // Product Description came back blank. Reported: SFM507057 / Batt1.
    const csv =
      'JobHead_JobNum,JobHead_PartNum,JobHead_ProdQty\n' +
      '"SFM507057  ",P7,1400\n' +
      '  SFM507058 ,P8,900\n';
    const out = parsePlanningCsv(csv);
    expect(out[0].jobNumber).toBe('SFM507057');
    expect(out[0].orderQty).toBe(1400);
    expect(out[1].jobNumber).toBe('SFM507058');
  });

  it('skips empty rows and ignores a UTF-8 BOM', () => {
    const csv = '﻿JobHead_JobNum,JobHead_PartNum\n\nJ200,P9\n';
    const out = parsePlanningCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0].jobNumber).toBe('J200');
    expect(out[0].partNumber).toBe('P9');
  });

  it('handles AU date format from PS default culture', () => {
    const csv =
      'JobHead_JobNum,JobHead_StartDate,JobHead_ReqDueDate,Calculated_RemaingLaborHrs\n' +
      'J300,02/06/2026 7:00 am,05/06/2026 3:00 pm,4\n';
    const out = parsePlanningCsv(csv);
    expect(out[0].jobNumber).toBe('J300');
    // Parsed as local 2026-06-02 07:00 → ISO with local offset
    expect(out[0].plannedStart).toMatch(/2026-06-0[12]T/);
  });

  it('layers JobHead_StartHour decimal hours onto JobHead_StartDate', () => {
    // 18.68 → 18:40:48 per Epicor's decimal-hours convention.
    const csv =
      'JobHead_JobNum,JobHead_StartDate,JobHead_ReqDueDate,Calculated_RemaingLaborHrs,JobHead_StartHour\n' +
      'J400,2026-06-02,2026-06-05,2,18.68\n';
    const out = parsePlanningCsv(csv);
    const t = new Date(out[0].plannedStart);
    expect(t.getHours()).toBe(18);
    expect(t.getMinutes()).toBe(40);
    expect(t.getSeconds()).toBe(48);
    // plannedEnd should derive from the precise start + duration (2h).
    const end = new Date(out[0].plannedEnd);
    expect(end.getHours()).toBe(20);
    expect(end.getMinutes()).toBe(40);
  });

  it('falls back through StartTime / Start_Time / Start Time header variants', () => {
    for (const colName of ['Start_Time', 'StartTime', 'Start Time']) {
      const csv =
        `JobHead_JobNum,JobHead_StartDate,${colName}\n` + `J5,2026-06-02,7.5\n`;
      const out = parsePlanningCsv(csv);
      const t = new Date(out[0].plannedStart);
      expect(t.getHours()).toBe(7);
      expect(t.getMinutes()).toBe(30);
    }
  });

  it('ignores a missing / blank / out-of-range start-time cell', () => {
    const csv =
      'JobHead_JobNum,JobHead_StartDate,JobHead_StartHour\n' +
      'J6,2026-06-02T07:00:00,\n' + // blank → keep existing 07:00
      'J7,2026-06-02T07:00:00,99\n'; // > 24 → ignored
    const out = parsePlanningCsv(csv);
    expect(new Date(out[0].plannedStart).getHours()).toBe(7);
    expect(new Date(out[1].plannedStart).getHours()).toBe(7);
  });

  it('preserves an explicit midnight as a datetime, not a bare date', () => {
    const out = parsePlanningCsv(
      'JobHead_JobNum,JobHead_StartDate\nJ-MID,2026-07-01T00:00:00\n',
    );
    expect(out[0].plannedStart).toBe('2026-07-01T00:00:00');
  });

  it('keeps decimal start times as local wall-clock ISO without a UTC suffix', () => {
    const out = parsePlanningCsv(
      'JobHead_JobNum,JobHead_StartDate,JobHead_StartHour\nJ-WALL,2026-07-01,18.68\n',
    );
    expect(out[0].plannedStart).toBe('2026-07-01T18:40:48');
  });

  it('rejects empty, wrong-schema and unterminated CSV instead of returning fake zero orders', () => {
    expect(() => parsePlanningCsv('')).toThrow(/empty/i);
    expect(() => parsePlanningCsv('<html>login</html>')).toThrow(/JobHead_JobNum/);
    expect(() => parsePlanningCsv('JobHead_JobNum,Description\nJ1,"broken')).toThrow(
      /unterminated/i,
    );
  });
});

describe('decimalHoursToHms', () => {
  it('converts the Epicor 18.68 example to 18:40:48', () => {
    expect(decimalHoursToHms(18.68)).toEqual([18, 40, 48]);
  });
  it('carries 60-second rounding into the next minute / hour', () => {
    // 23.999999 should not produce 23:59:60 — it must roll to 24:00:00.
    expect(decimalHoursToHms(23.999999)).toEqual([24, 0, 0]);
  });
  it('handles midnight (0)', () => {
    expect(decimalHoursToHms(0)).toEqual([0, 0, 0]);
  });
  it('handles fractional hours common in Epicor (7.5 → 07:30:00)', () => {
    expect(decimalHoursToHms(7.5)).toEqual([7, 30, 0]);
  });
});

describe('toServerRelativePath', () => {
  it('passes a clean server-relative path through unchanged', () => {
    expect(toServerRelativePath('/sites/X/Shared Documents/A.csv')).toBe(
      '/sites/X/Shared Documents/A.csv',
    );
  });
  it('decodes %20 to spaces', () => {
    expect(
      toServerRelativePath('/sites/X/Shared%20Documents/General/Data/A.csv'),
    ).toBe('/sites/X/Shared Documents/General/Data/A.csv');
  });
  it('extracts the path from a full https URL', () => {
    expect(
      toServerRelativePath(
        'https://tenant.sharepoint.com/sites/X/Shared%20Documents/A.csv',
      ),
    ).toBe('/sites/X/Shared Documents/A.csv');
  });
  it('strips query strings (e.g. ?d=… from SP web links)', () => {
    expect(
      toServerRelativePath(
        'https://tenant.sharepoint.com/sites/X/Shared%20Documents/A.csv?d=abc',
      ),
    ).toBe('/sites/X/Shared Documents/A.csv');
  });
  it('adds a leading slash if missing', () => {
    expect(toServerRelativePath('sites/X/Y.csv')).toBe('/sites/X/Y.csv');
  });
  it('returns empty when given empty', () => {
    expect(toServerRelativePath('')).toBe('');
    expect(toServerRelativePath('   ')).toBe('');
  });
});

describe('OData string literals', () => {
  it('doubles apostrophes before URL encoding', () => {
    expect(odataString("O'Brien's Job")).toBe("O''Brien''s Job");
  });
});

describe('dateOnly (shiftId UTC→local round-trip)', () => {
  // Without converting UTC→local first, a Day shift that begins 07:00 in
  // a positive-offset timezone (e.g. Sydney +10) gets dateOnly'd from a
  // UTC string anchored on the previous calendar day — the shiftId is
  // off by one day, the operator filter / KPI shiftIds set / rejects map
  // all miss, and the page renders empty. Verify the round-trip works
  // regardless of which local timezone the test runner sits in.
  function roundTrip(year: number, month0: number, day: number, hour: number): string {
    return dateOnly(new Date(year, month0, day, hour, 0, 0, 0).toISOString());
  }
  it('matches the local calendar date for Day shift start (07:00 local)', () => {
    expect(roundTrip(2026, 5, 2, 7)).toBe('2026-06-02');
  });
  it('matches the local calendar date for Afternoon shift start (15:00 local)', () => {
    expect(roundTrip(2026, 5, 2, 15)).toBe('2026-06-02');
  });
  it('matches the local calendar date for Night shift start (23:00 local)', () => {
    expect(roundTrip(2026, 5, 2, 23)).toBe('2026-06-02');
  });
  it('handles month boundaries (last day of month, midday shift)', () => {
    expect(roundTrip(2026, 5, 30, 15)).toBe('2026-06-30');
  });
  it('keeps a midnight-UTC shift marker on its own calendar date', () => {
    // The exact shape writeRejects / shiftDateMarker stamp rows with —
    // adding any positive offset (+0…+14) to midnight stays the same day,
    // so the shift date is recovered in Sydney, Auckland and UTC alike.
    expect(dateOnly('2026-06-20T00:00:00.000Z')).toBe('2026-06-20');
    expect(dateOnly('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(dateOnly('2026-12-31T00:00:00.000Z')).toBe('2026-12-31');
  });
  it('falls back to slice when the value is not a parseable date', () => {
    expect(dateOnly('not-a-date')).toBe('not-a-date');
    expect(dateOnly('')).toBe('');
    expect(dateOnly(null)).toBe('');
  });
});

describe('listProduction backfills editCache from PMD_LiveStatus', () => {
  // Regression for the SFM507068 14:23 incident: editCache had only
  // slot 0 (S) and slot 9 (R), but PMD_LiveStatus had the full
  // SSRRRRRRRR / reject 18 snapshot pushed minutes earlier. Sign-off
  // aggregates editCache, so without the backfill the supervisor's
  // press of "Sign off & Save" burned S·······R / reject 11 into
  // PMD_Production and silently dropped 8 slots and 7 rejects.

  // Minimal localStorage shim. Installed once for the describe block so
  // the coalesced persistEditCache setTimeout — which fires a tick after
  // listProduction returns — still has somewhere to write. Cleared
  // (store.clear()) between tests so cache state doesn't leak.
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        store.set(k, v);
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
      clear: (): void => {
        store.clear();
      },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('merges LiveStatus slots that the local cache is missing, leaving cache slots intact', async () => {
    store.clear();
    {
      const dal = new SharePointDataLayer({
        siteUrl: 'https://example.sharepoint.com/sites/x',
      });
      const machineCode = 'Batt1';
      // Use the most recent Day shift that is still inside the 24 h
      // live-retention cap — this test isolates the per-slot merge
      // logic, not staleness sweeping. A fixed "yesterday" broke after
      // 15:00 local: yesterday's Day shift (ends 15:00) slid past the
      // 24 h cap and the sweep deleted the seeded tuple, so the test
      // passed in the morning and failed at night. Day shift ends at
      // 15:00, so: after 15:00 use TODAY's (already ended, 0-9 h old),
      // before 15:00 use YESTERDAY's (ended 9-24 h ago).
      const pad2 = (n: number): string => String(n).padStart(2, '0');
      const yd = new Date();
      if (yd.getHours() < 15) yd.setDate(yd.getDate() - 1);
      const dateStr = `${yd.getFullYear()}-${pad2(yd.getMonth() + 1)}-${pad2(yd.getDate())}`;
      const shiftId = `${dateStr}-Day`;
      const jobNumber = 'SFM507068';

      // Seed editCache with the partial state that survived the
      // reload: just slot 0 (S, 100 good) and slot 9 (R, 3 rejects).
      const seed = [
        {
          id: -1,
          machineCode,
          shiftId,
          jobNumber,
          slotIndex: 0,
          statusCode: 'S',
          countStart: 100,
          countEnd: 0,
          rejects: '{}',
          purge: 0,
          bdIssue: '',
          handoverNote: '',
          operator: 'Joe',
          supervisor: 'Sue',
          locked: false,
          lockedBy: '',
          lockedAt: '',
          updatedAt: '',
          qcBy: '',
        },
        {
          id: -2,
          machineCode,
          shiftId,
          jobNumber,
          slotIndex: 9,
          statusCode: 'R',
          countStart: 0,
          countEnd: 0,
          rejects: JSON.stringify({ D01: 3 }),
          purge: 0,
          bdIssue: '',
          handoverNote: '',
          operator: 'Joe',
          supervisor: 'Sue',
          locked: false,
          lockedBy: '',
          lockedAt: '',
          updatedAt: '',
          qcBy: '',
        },
      ];
      // Inject directly into the private cache via bracket access.
      const cache = (dal as unknown as {
        editCache: Map<string, Array<(typeof seed)[0]>>;
      }).editCache;
      cache.set(`${machineCode}|${shiftId}|${jobNumber}`, seed);

      // Stub the three fetchers. PMD_LiveStatus reports the full
      // SSRRRRRRRR timeline with reject 18 — what was actually
      // mirrored from the operator iPad before the reload.
      const liveHeader = {
        machineCode,
        date: dateStr,
        shift: 'Day',
        jobNumber,
        partNumber: 'P1',
        partDescription: 'Widget',
        timeline: 'SSRRRRRRRR······',
        countStart: 100,
        countEnd: 200,
        reject: 18,
        operator: 'Joe',
        supervisor: 'Sue',
        runTime: 4,
        downTime: 0,
        handover: '',
        qcChecks: '',
        rejectsBySlot: JSON.stringify({
          '2': { D01: 2 },
          '3': { D01: 2 },
          '4': { D01: 2 },
          '5': { D01: 2 },
          '6': { D01: 2 },
          '7': { D01: 2 },
          '8': { D01: 3 },
          '9': { D01: 3 },
        }),
      };
      const liveRejects = [
        { timeline: '08:00', code: 'D01', category: 'R', qty: 2 },
        { timeline: '08:30', code: 'D01', category: 'R', qty: 2 },
        { timeline: '09:00', code: 'D01', category: 'R', qty: 2 },
        { timeline: '09:30', code: 'D01', category: 'R', qty: 2 },
        { timeline: '10:00', code: 'D01', category: 'R', qty: 2 },
        { timeline: '10:30', code: 'D01', category: 'R', qty: 2 },
        { timeline: '11:00', code: 'D01', category: 'R', qty: 3 },
        { timeline: '11:30', code: 'D01', category: 'R', qty: 3 },
      ];
      const key = `${machineCode}|${shiftId}|${jobNumber}`;
      const overrides = dal as unknown as {
        fetchHeaders: (list: string) => Promise<unknown[]>;
        fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
        fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      };
      overrides.fetchHeaders = async (list: string): Promise<unknown[]> =>
        list === 'PMD_LiveStatus' ? [liveHeader] : [];
      overrides.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> =>
        new Map([[key, liveRejects]]);
      overrides.fetchBreakdownTimelines = async (): Promise<
        Map<string, string>
      > => new Map();

      await dal.listProduction({ machineCode, shiftId });

      const merged = cache.get(key)!;
      const bySlot = new Map(merged.map((s) => [s.slotIndex, s]));
      // Slot 0: editCache value preserved (S, countStart 100). Must
      // NOT be overwritten by the snapshot.
      expect(bySlot.get(0)!.statusCode).toBe('S');
      expect(bySlot.get(0)!.countStart).toBe(100);
      // Slot 9: editCache value preserved (3 D01 rejects).
      expect(JSON.parse(bySlot.get(9)!.rejects)).toEqual({ D01: 3 });
      // Slots 1-8 backfilled from LiveStatus.
      expect(bySlot.get(1)!.statusCode).toBe('S');
      for (let i = 2; i <= 8; i++) {
        expect(bySlot.get(i)!.statusCode).toBe('R');
      }
      // Total slots present in the merged cache covers 0..9 (the
      // active SSRRRRRRRR window — empty trailing slots are not
      // materialised by expandHeaderToSlots).
      const activeSlots = [...bySlot.keys()].filter((i) => i <= 9).sort((a, b) => a - b);
      expect(activeSlots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // Reject sum across the merged cache = 18 (editCache slot 9's 3
      // + the seven backfilled slots' 2+2+2+2+2+2+3 = 15). This is the
      // exact number that aggregateSlots would push into
      // PMD_Production.Reject on Sign Off & Save.
      let total = 0;
      for (const s of merged) {
        const r = JSON.parse(s.rejects || '{}') as Record<string, number>;
        for (const v of Object.values(r)) total += v;
      }
      expect(total).toBe(18);
    }
  });

  it('skips backfill when the tuple is already signed off', async () => {
    store.clear();
    {
      const dal = new SharePointDataLayer({
        siteUrl: 'https://example.sharepoint.com/sites/x',
      });
      const machineCode = 'Batt1';
      const shiftId = '2026-06-13-Day';
      const jobNumber = 'SFM507068';
      const cache = (dal as unknown as {
        editCache: Map<string, unknown[]>;
      }).editCache;
      // Pre-seeded cache from a stale device — should be PURGED on
      // read because the same tuple is signed off in PMD_Production.
      cache.set(`${machineCode}|${shiftId}|${jobNumber}`, [
        {
          id: -1,
          machineCode,
          shiftId,
          jobNumber,
          slotIndex: 0,
          statusCode: 'S',
          countStart: 0,
          countEnd: 0,
          rejects: '{}',
          purge: 0,
          bdIssue: '',
          handoverNote: '',
          operator: '',
          supervisor: '',
          locked: false,
          lockedBy: '',
          lockedAt: '',
          updatedAt: '',
          qcBy: '',
        },
      ]);

      const prodHeader = {
        machineCode,
        date: '2026-06-13',
        shift: 'Day',
        jobNumber,
        partNumber: 'P1',
        partDescription: 'Widget',
        timeline: 'SSRRRRRRRR······',
        countStart: 100,
        countEnd: 200,
        reject: 18,
        operator: 'Joe',
        supervisor: 'Sue',
        runTime: 4,
        downTime: 0,
        handover: '',
        qcChecks: '',
        rejectsBySlot: '',
      };
      const overrides = dal as unknown as {
        fetchHeaders: (list: string) => Promise<unknown[]>;
        fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
        fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      };
      // Also return a stale PMD_LiveStatus row for the SAME tuple —
      // simulating the brief window after sign-off but before
      // deleteLiveRow lands (or a deleteLiveRow that failed). The
      // backfill MUST skip this tuple: PMD_Production is canonical,
      // and re-hydrating from a stale live mirror would re-introduce
      // the very rows lockShift's editCache.delete just cleared.
      const staleLive = { ...prodHeader, timeline: 'SSRRRR··········', reject: 12 };
      overrides.fetchHeaders = async (list: string): Promise<unknown[]> => {
        if (list === 'PMD_Production') return [prodHeader];
        if (list === 'PMD_LiveStatus') return [staleLive];
        return [];
      };
      overrides.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> =>
        new Map();
      overrides.fetchBreakdownTimelines = async (): Promise<
        Map<string, string>
      > => new Map();

      await dal.listProduction({ machineCode, shiftId });
      // editCache purged for the signed-off tuple — neither the stale
      // local taps nor the stale LiveStatus row re-populate it. The
      // canonical PMD_Production row stands alone.
      expect(cache.has(`${machineCode}|${shiftId}|${jobNumber}`)).toBe(false);
    }
  });
});

describe('isStaleLiveHeader', () => {
  // Day shift on 2026-06-10 runs 07:00–15:00. 8h grace ends at 23:00.
  const daySid = '2026-06-10-Day';
  const fields = (timeline = ''): { date: string; shift: string; timeline?: string } => ({
    date: '2026-06-10',
    shift: 'Day',
    timeline,
  });

  it('flags a past-shift row whose timeline has no machine status', () => {
    // 24 h after start (2026-06-11 07:00) — well past the 8 h grace.
    const now = new Date(2026, 5, 11, 7, 0, 0);
    expect(isStaleLiveHeader(fields(''), now)).toBe(true);
    expect(isStaleLiveHeader(fields('················'), now)).toBe(true);
    expect(isStaleLiveHeader({ ...fields(), timeline: undefined }, now)).toBe(true);
  });

  it('keeps a past-shift row that has ANY machine status letter', () => {
    const now = new Date(2026, 5, 11, 7, 0, 0);
    // Single 'R' anywhere in the 16-slot timeline is enough to keep.
    expect(isStaleLiveHeader(fields('R···············'), now)).toBe(false);
    // Mid-timeline B too.
    expect(isStaleLiveHeader(fields('·······B········'), now)).toBe(false);
  });

  it('keeps the row while the 8 h grace is still active', () => {
    // 22:00 same day = 7h past shift end (15:00). Still within grace.
    const now = new Date(2026, 5, 10, 22, 0, 0);
    expect(isStaleLiveHeader(fields(''), now)).toBe(false);
  });

  it('tips into stale at the exact end of the grace window', () => {
    // shift end = 15:00. grace ends at 23:00. At the exact equality
    // (b.end + grace === now), the helper returns true — the row has
    // had its full 8 h grace and nothing landed on the timeline.
    const atBoundary = new Date(2026, 5, 10, 23, 0, 0);
    expect(isStaleLiveHeader(fields(''), atBoundary)).toBe(true);
    // 1 ms before the boundary → still kept.
    const justBefore = new Date(2026, 5, 10, 22, 59, 59, 999);
    expect(isStaleLiveHeader(fields(''), justBefore)).toBe(false);
  });

  it('keeps a row that is for a future shift (planned tap-ahead)', () => {
    // now is BEFORE the day starts — date row is for the future.
    const now = new Date(2026, 5, 9, 12, 0, 0);
    expect(isStaleLiveHeader(fields(''), now)).toBe(false);
  });

  it('keeps rows with unparseable shift ids (defensive)', () => {
    const now = new Date(2026, 5, 15, 0, 0, 0);
    expect(
      isStaleLiveHeader({ date: 'nope', shift: 'Day', timeline: '' }, now),
    ).toBe(false);
  });

  it('respects a custom grace window', () => {
    // 24 h after shift start is well past the default 8 h grace, but
    // not past a 24 h grace.
    const now = new Date(2026, 5, 11, 7, 0, 0);
    expect(isStaleLiveHeader(fields(''), now, 24 * 3600_000)).toBe(false);
  });

  // Pin the shift-bounds reasoning into the test (so if shiftBounds
  // changes, the assertions break loudly here).
  it('matches the documented shift-end arithmetic (Day end = 15:00)', () => {
    // 8h after 15:00 = 23:00 same day. At 22:59:59 → still active grace.
    const safe = new Date(2026, 5, 10, 22, 59, 59);
    // At 23:00:01 → past grace, becomes stale (empty timeline).
    const past = new Date(2026, 5, 10, 23, 0, 1);
    void daySid;
    expect(isStaleLiveHeader(fields(''), safe)).toBe(false);
    expect(isStaleLiveHeader(fields(''), past)).toBe(true);
  });
});

describe('shiftEndedLongAgo', () => {
  // Day shift 2026-06-10 runs 07:00–15:00; +8h grace ends 23:00.
  const sid = '2026-06-10-Day';
  it('false while the shift is still running', () => {
    expect(shiftEndedLongAgo(sid, new Date(2026, 5, 10, 10, 0))).toBe(false);
  });
  it('false within the grace window after the shift ends', () => {
    expect(shiftEndedLongAgo(sid, new Date(2026, 5, 10, 22, 0))).toBe(false);
  });
  it('true once the grace window has fully elapsed', () => {
    expect(shiftEndedLongAgo(sid, new Date(2026, 5, 10, 23, 0, 1))).toBe(true);
  });
  it('true for a shift days in the past (the 03/06 experiment case)', () => {
    expect(shiftEndedLongAgo('2026-06-03-Afternoon', new Date(2026, 5, 16, 0, 0))).toBe(true);
  });
  it('false for an unparseable shift id (defensive)', () => {
    expect(shiftEndedLongAgo('garbage', new Date(2026, 5, 16))).toBe(false);
  });
  it('honours a custom grace window', () => {
    // 24 h after START is past the default 8 h grace but not the hard cap (measured from shift END).
    const now = new Date(2026, 5, 11, 7, 0);
    expect(shiftEndedLongAgo(sid, now)).toBe(true);
    expect(shiftEndedLongAgo(sid, now, 48 * 3600_000)).toBe(false);
  });
});

describe('pushLiveSnapshot does not re-broadcast old shifts', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('skips a stale tuple (old experiment WITH status) but pushes a current one', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    // Two tuples seeded into editCache: one from an abandoned 03/06
    // experiment (has real status letters), one for a shift happening
    // right now.
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const todayId = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    // Pick whichever shift code is live right now is overkill; instead
    // build a shift that definitely spans "now" by using a wide Day
    // window check is awkward — simpler: assert the OLD one is skipped
    // and that at least the planning call ran. We still prove the
    // current-shift push path by seeding a tuple whose shift has NOT
    // ended (start today, far future end via a Night code if needed).
    const mkSlot = (job: string, shiftId: string): Record<string, unknown> => ({
      id: -1, machineCode: 'A', shiftId, jobNumber: job, slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 10, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '', operator: 'Joe',
      supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '', lockedAt: '',
      createdAt: '', updatedAt: '',
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set('A|2026-06-03-Afternoon|EXP1', [mkSlot('EXP1', '2026-06-03-Afternoon')]);
    cache.set(`A|${todayId}-Night|CUR1`, [mkSlot('CUR1', `${todayId}-Night`)]);
    // Both tuples were authored on this device — the skip under test is
    // the shift-age rule, not the authored-tuple rule.
    const dirty = (dal as unknown as { dirtyTuples: Set<string> }).dirtyTuples;
    dirty.add('A|2026-06-03-Afternoon|EXP1');
    dirty.add(`A|${todayId}-Night|CUR1`);

    const pushed: string[] = [];
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      upsertHeaderInto: (list: string, h: { jobNumber: string }) => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.upsertHeaderInto = async (_list: string, h: { jobNumber: string }): Promise<void> => {
      pushed.push(h.jobNumber);
    };

    await dal.pushLiveSnapshot!();

    // The 03/06 experiment must NOT be pushed; the current Night shift
    // (ends tomorrow 07:00) must be.
    expect(pushed).not.toContain('EXP1');
    expect(pushed).toContain('CUR1');
  });
});

describe('device-class write rule (canWrite hook)', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const pad = (n: number): string => String(n).padStart(2, '0');
  const now = new Date();
  const todayId = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const shiftId = `${todayId}-Night`; // ends tomorrow 07:00 → always "live"

  function liveHeader(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      machineCode: 'Batt1',
      date: todayId,
      shift: 'Night',
      jobNumber: 'SFM900',
      timeline: 'R···············',
      countStart: 0,
      countEnd: 10,
      reject: 0,
      operator: 'Joe',
      supervisor: 'Sue',
      ...over,
    };
  }

  it('read-only device: pushLiveSnapshot is a no-op (no clobber from a PC)', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => false,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM900`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 10, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    const pushed: string[] = [];
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      upsertHeaderInto: (list: string, h: { jobNumber: string }) => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.upsertHeaderInto = async (_l, h): Promise<void> => { pushed.push(h.jobNumber); };

    await dal.pushLiveSnapshot!();
    expect(pushed).toEqual([]);
  });

  it('writable device: pushLiveSnapshot stamps THIS deviceId as OwnerDevice (diagnostics)', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const me = dal.getDeviceId!();
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM900`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 10, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    (dal as unknown as { dirtyTuples: Set<string> }).dirtyTuples.add(`Batt1|${shiftId}|SFM900`);
    let pushedOwner: unknown;
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      upsertHeaderInto: (list: string, h: { ownerDevice?: string }) => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.upsertHeaderInto = async (_l, h): Promise<void> => { pushedOwner = h.ownerDevice; };

    await dal.pushLiveSnapshot!();
    expect(pushedOwner).toBe(me);
  });

  it('writable device: no claim arbitration — pushes even when LiveStatus already has another device as owner', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM900`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 10, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    (dal as unknown as { dirtyTuples: Set<string> }).dirtyTuples.add(`Batt1|${shiftId}|SFM900`);
    const pushed: string[] = [];
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      upsertHeaderInto: (list: string, h: { jobNumber: string }) => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    // Load the live mirror first so under the OLD claim logic this device
    // would have skipped the push. Under the new device-class rule it
    // pushes regardless — every iPad writes freely.
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [liveHeader({ ownerDevice: 'device-AAA' })] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.upsertHeaderInto = async (_l, h): Promise<void> => { pushed.push(h.jobNumber); };

    await dal.listProduction({ machineCode: 'Batt1', shiftId });
    await dal.pushLiveSnapshot!();
    expect(pushed).toContain('SFM900');
  });

  it('mirrorHealth records a successful push and a failed one (badge feed)', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM900`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 10, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    (dal as unknown as { dirtyTuples: Set<string> }).dirtyTuples.add(`Batt1|${shiftId}|SFM900`);
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      upsertHeaderInto: (list: string, h: unknown) => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.upsertHeaderInto = async (): Promise<void> => {};

    expect(dal.mirrorHealth!().okAt).toBeNull();
    await dal.pushLiveSnapshot!();
    const ok = dal.mirrorHealth!();
    expect(ok.writable).toBe(true);
    expect(ok.okAt).not.toBeNull();
    expect(ok.failAt).toBeNull();

    o.upsertHeaderInto = async (): Promise<void> => {
      throw new Error('403 access denied');
    };
    await dal.pushLiveSnapshot!();
    const bad = dal.mirrorHealth!();
    expect(bad.failAt).not.toBeNull();
    expect(bad.error).toContain('403 access denied');
  });

  it('viewed (non-authored) tuple is NEVER pushed — kills the stale echo loop', async () => {
    // iPad1 glanced at Batt2's shift once (backfilled into editCache),
    // then kept re-broadcasting that stale 1-slot copy every 60 s,
    // overwriting the editing iPad's fresh mirror. A tuple with no local
    // authorship (not in dirtyTuples) must not be mirrored outward.
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt2|${shiftId}|SFM901`, [{
      id: -1, machineCode: 'Batt2', shiftId, jobNumber: 'SFM901', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 10, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    // Deliberately NOT added to dirtyTuples — this device only viewed it.
    const pushed: string[] = [];
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      upsertHeaderInto: (list: string, h: { jobNumber: string }) => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.upsertHeaderInto = async (_l, h): Promise<void> => { pushed.push(h.jobNumber); };

    await dal.pushLiveSnapshot!();
    expect(pushed).toEqual([]);
  });

  it('writable device: a merely-VIEWED tuple is replaced by the live mirror on read', async () => {
    // iPad1 viewing Batt2: its first backfill left a 1-slot copy in
    // editCache; the editing iPad has since mirrored countEnd=50. The
    // old merge-by-absence kept iPad1's stale copy forever; a tuple this
    // device never authored must now track the mirror wholesale.
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    const key = `Batt1|${shiftId}|SFM900`;
    cache.set(key, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 5, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: '', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      deleteLiveRow: () => Promise<void>;
    };
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [liveHeader({ countEnd: 50 })] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.deleteLiveRow = async (): Promise<void> => {};

    const recs = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = recs.find((r) => r.slotIndex === 0 && r.jobNumber === 'SFM900')!;
    expect(slot0.countEnd).toBe(50);
  });

  it('writable device: an AUTHORED tuple keeps its local slots over the live mirror', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    const key = `Batt1|${shiftId}|SFM900`;
    cache.set(key, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 60, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: '', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    (dal as unknown as { dirtyTuples: Set<string> }).dirtyTuples.add(key);
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      deleteLiveRow: () => Promise<void>;
    };
    // Mirror lags behind the local edits (countEnd 50 < local 60).
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [liveHeader({ countEnd: 50 })] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.deleteLiveRow = async (): Promise<void> => {};

    const recs = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = recs.find((r) => r.slotIndex === 0 && r.jobNumber === 'SFM900')!;
    expect(slot0.countEnd).toBe(60);
  });

  it('read-only device: listProduction REPLACES stale local editCache with live mirror', async () => {
    // PC viewer symptom: PC's editCache held reject=1 from an earlier
    // glance; iPad pushed reject=23 + full QC to PMD_LiveStatus. Under
    // the device-class rule the PC drops its cache wholesale and shows
    // what the iPad is actually doing.
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => false,
    });
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    const key = `Batt1|${shiftId}|SFM900`;
    cache.set(key, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM900', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 5, rejects: '{}', purgeKg: null,
      rejectCount: 1, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: '', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    const liveFromIpad = liveHeader({
      timeline: 'RRRR············',
      countEnd: 50,
      reject: 23,
    });
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [liveFromIpad] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const rows = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = rows.find((r) => r.jobNumber === 'SFM900' && r.slotIndex === 0);
    expect(slot0).toBeTruthy();
    expect(slot0!.rejectCount).toBe(23);
    expect(slot0!.supervisor).toBe('Sue');
    const runSlots = rows.filter(
      (r) => r.jobNumber === 'SFM900' && r.statusCode === 'R',
    );
    expect(runSlots.length).toBe(4);
  });

  it('signed tuple re-edited after unlock: fresher live mirror wins on another device', async () => {
    // Reported on 550T: signed off in the morning, unlocked + re-edited on
    // the floor iPad, but a PC's Trace still showed the morning data. The
    // PC has no editCache for the tuple and only sees the still-locked
    // PMD_Production row + a fresh PMD_LiveStatus row. The live row's
    // Modified is newer than the signed row's → it must win.
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const signedProd = {
      machineCode: 'Batt1', date: todayId, shift: 'Night', jobNumber: 'SFM900',
      timeline: 'SS··············', countStart: 0, countEnd: 200, reject: 8,
      operator: 'Joe', supervisor: 'Sue',
      reopened: true, // supervisor re-opened it on the server (Reopened=Yes)
      modified: '2026-01-01T00:00:00Z', // signed in the morning
    };
    const liveReEdit = liveHeader({
      timeline: 'RRRR············', countEnd: 50, reject: 23,
      modified: '2026-01-02T00:00:00Z', // re-edited AFTER sign-off
    });
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [liveReEdit] : [signedProd];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const rows = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = rows.find((r) => r.jobNumber === 'SFM900' && r.slotIndex === 0);
    expect(slot0!.rejectCount).toBe(23); // live data, not signed 8
    expect(slot0!.locked).toBe(false);   // shown as in-progress re-edit
    const runs = rows.filter((r) => r.jobNumber === 'SFM900' && r.statusCode === 'R');
    expect(runs.length).toBe(4);         // RRRR from live, not SS from signed
  });

  it('signed tuple with a STALE leftover live row (older Modified): signed wins', async () => {
    // A failed deleteLiveRow at sign-off leaves a live row, but it stopped
    // being pushed BEFORE sign-off → its Modified is older than the signed
    // row's. The comparison must keep the signed row winning (no inverse bug).
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const signedProd = {
      machineCode: 'Batt1', date: todayId, shift: 'Night', jobNumber: 'SFM900',
      timeline: 'SSRRRRRR········', countStart: 0, countEnd: 200, reject: 8,
      operator: 'Joe', supervisor: 'Sue',
      modified: '2026-01-02T00:00:00Z', // signed AFTER the leftover push
    };
    const staleLive = liveHeader({
      timeline: 'RRRR············', countEnd: 50, reject: 23,
      modified: '2026-01-01T00:00:00Z', // leftover, pushed before sign-off
    });
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [staleLive] : [signedProd];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const rows = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = rows.find((r) => r.jobNumber === 'SFM900' && r.slotIndex === 0);
    expect(slot0!.rejectCount).toBe(8); // signed wins
    expect(slot0!.locked).toBe(true);
  });

  it('fresher live shadow on a NOT-reopened signed tuple loses + gets deleted (SFM507147)', async () => {
    // Reported: SFM507147 was re-signed in the morning from one device, but
    // the floor iPad's leftover editCache re-mirrored a PMD_LiveStatus row
    // AFTER that sign-off. Timestamp-only re-edit detection let the shadow
    // win → the row read locked=false → the KPIs (locked-only) hid a signed
    // order. With no Reopened=Yes on the signed row, the shadow must LOSE
    // and be deleted on sight.
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const signedProd = {
      machineCode: 'Batt1', date: todayId, shift: 'Night', jobNumber: 'SFM900',
      timeline: 'RRRR············', countStart: 0, countEnd: 200, reject: 8,
      operator: 'Joe', supervisor: 'Sue',
      // no reopened flag — signed and canonical
      modified: '2026-01-01T00:00:00Z',
    };
    const shadow = liveHeader({
      timeline: 'RR··············', countEnd: 50, reject: 23,
      modified: '2026-01-02T00:00:00Z', // re-mirrored AFTER the sign-off
    });
    const deleted: string[] = [];
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      deleteLiveRow: (mc: string, sid: string, job: string) => Promise<void>;
    };
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [shadow] : [signedProd];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.deleteLiveRow = async (mc, sid, job): Promise<void> => {
      deleted.push(`${mc}|${sid}|${job}`);
    };

    const rows = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = rows.find((r) => r.jobNumber === 'SFM900' && r.slotIndex === 0);
    expect(slot0!.locked).toBe(true); // signed row canonical → KPIs count it
    expect(slot0!.rejectCount).toBe(8); // signed data, not the shadow's 23
    expect(deleted).toContain(`Batt1|${shiftId}|SFM900`); // shadow cleaned up
  });

  it('Reopened=Yes signed row reads as unlocked + reopened on every device', async () => {
    // Authoritative server-side unlock: the PMD_Production row stays put but
    // carries Reopened=Yes, so EVERY device (no editCache needed) sees it as
    // editable-for-correction rather than locked.
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const reopenedProd = {
      machineCode: 'Batt1', date: todayId, shift: 'Night', jobNumber: 'SFM900',
      timeline: 'RRRR············', countStart: 0, countEnd: 200, reject: 8,
      operator: 'Joe', supervisor: 'Sue',
      reopened: true,
      modified: '2026-01-01T00:00:00Z',
    };
    const o = dal as unknown as {
      fetchHeaders: (l: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (l: string): Promise<unknown[]> =>
      l === 'PMD_LiveStatus' ? [] : [reopenedProd];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const rows = await dal.listProduction({ machineCode: 'Batt1', shiftId });
    const slot0 = rows.find((r) => r.jobNumber === 'SFM900' && r.slotIndex === 0);
    expect(slot0!.locked).toBe(false); // reopened → editable, not locked
    expect(slot0!.reopened).toBe(true);
  });
});

describe('unlock → edit → re-sign-off (SFM507068 redesign)', () => {
  // Shared shim from the pushLiveSnapshot describe block above.
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  // Realistic SFM507068 row that's currently signed off in PMD_Production:
  // partNum + description set, count 100 → 200, 8 rejects across slots 2..9,
  // timeline SSRRRRRRRR.
  function existingSignedRow() {
    return {
      machineCode: '1300T',
      date: '2026-06-13',
      shift: 'Day',
      jobNumber: 'SFM507068',
      partNumber: 'V11690',
      partDescription: 'Ned Stool - Slate - recycled plastics',
      timeline: 'SSRRRRRRRR······',
      countStart: 100,
      countEnd: 200,
      reject: 8,
      operator: 'Heng Ong',
      supervisor: 'Bounpanh Wa',
      runTime: 5,
      downTime: 0,
      handover: '',
      qcChecks: '',
      // 8 rejects distributed across slots 2..9 — mirrors what
      // lockShift writes into RejectsBySlot on sign-off. Without this,
      // expandHeaderToSlots has no per-slot reject info to rebuild
      // and aggregateSlots on re-sign-off would write reject=0.
      rejectsBySlot: JSON.stringify({
        '2': { D01: 1 }, '3': { D01: 1 }, '4': { D01: 1 }, '5': { D01: 1 },
        '6': { D01: 1 }, '7': { D01: 1 }, '8': { D01: 1 }, '9': { D01: 1 },
      }),
    };
  }
  // setTimeout(0) microtask flush so persistEditCache /
  // persistUnlockedTuples land in the shim's store before we test
  // them.
  const flushPersist = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('unlockShift does NOT delete PMD_Production / BreakDownlog / Rejects / LiveStatus', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const deleted: string[] = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      deleteByFilter: (list: string) => Promise<void>;
      deleteLiveRow: (mc: string, sid: string, job: string) => Promise<void>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existingSignedRow()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.deleteByFilter = async (list: string): Promise<void> => {
      deleted.push(list);
    };
    o.deleteLiveRow = async (): Promise<void> => {
      deleted.push('PMD_LiveStatus(via deleteLiveRow)');
    };

    await dal.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');

    expect(deleted).toEqual([]);
  });

  it('rehydrates editCache from the signed-off row and marks the tuple unlocked', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existingSignedRow()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    await dal.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');

    const key = '1300T|2026-06-13-Day|SFM507068';
    const cache = (dal as unknown as { editCache: Map<string, Array<{ partNumber: string; partDescription?: string; countStart: number | null; countEnd: number | null; statusCode: string; locked: boolean }>> }).editCache;
    const slots = cache.get(key);
    expect(slots).toBeDefined();
    // partNum + description carried through expandHeaderToSlots → editCache.
    const slot0 = slots!.find((s) => s.countStart != null)!;
    expect(slot0.partNumber).toBe('V11690');
    expect(slot0.partDescription).toBe('Ned Stool - Slate - recycled plastics');
    expect(slot0.countStart).toBe(100);
    expect(slot0.countEnd).toBe(200);
    // Locked flag flipped so the side panel is editable.
    expect(slots!.every((s) => s.locked === false)).toBe(true);
    // Timeline letters survived: S + S + 8×R.
    const statuses = slots!.map((s) => s.statusCode).filter(Boolean).sort();
    expect(statuses).toEqual(['R','R','R','R','R','R','R','R','S','S']);
    // Tuple marked unlocked.
    const unlocked = (dal as unknown as { unlockedTuples: Set<string> }).unlockedTuples;
    expect(unlocked.has(key)).toBe(true);
    // Public probe the operator UI uses to force-load Operator /
    // Supervisor from the canonical PMD_Production row.
    expect(dal.isUnlockedTuple?.('1300T', '2026-06-13-Day', 'SFM507068')).toBe(true);
    expect(dal.isUnlockedTuple?.('1300T', '2026-06-13-Day', 'OTHER')).toBe(false);
  });

  it('self-heal does NOT purge editCache for an unlocked tuple even when PMD_Production still has the locked row', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existingSignedRow()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    await dal.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');
    const key = '1300T|2026-06-13-Day|SFM507068';
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    const slotsBefore = cache.get(key)!.length;

    // A subsequent listProduction (e.g. the reload() after unlock)
    // would have purged the cache via the signedKeys self-heal under
    // the old design. Under the new design, the unlockedTuples flag
    // protects it.
    await dal.listProduction({ machineCode: '1300T', shiftId: '2026-06-13-Day' });

    expect(cache.has(key)).toBe(true);
    expect(cache.get(key)!.length).toBe(slotsBefore);
  });

  it('lockShift after unlock PATCHes via merge: partNum/Desc come from cache even if planning lost the order', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const writes: Array<{ list: string; body: Record<string, unknown> }> = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: (key: Record<string, unknown>) => Promise<void>;
      replaceRejectEvents: (key: Record<string, unknown>) => Promise<void>;
      deleteLiveRow: () => Promise<void>;
      listPlanning: () => Promise<unknown[]>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existingSignedRow()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.upsertHeaderInto = async (list: string, h: Record<string, unknown>): Promise<void> => {
      writes.push({ list, body: h });
    };
    o.replaceBreakdownEvents = async (): Promise<void> => { /* noop */ };
    o.replaceRejectEvents = async (): Promise<void> => { /* noop */ };
    o.deleteLiveRow = async (): Promise<void> => { /* noop */ };
    // Planning has aged this order out (Epicor drops completed orders).
    // The OLD lockShift would have written empty PartNum here.
    o.listPlanning = async (): Promise<unknown[]> => [];

    await dal.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');
    await dal.lockShift('1300T', '2026-06-13-Day', 'Bounpanh Wa', 'Heng Ong', 'SFM507068');

    const prodWrite = writes.find((w) => w.list === 'PMD_Production');
    expect(prodWrite).toBeDefined();
    // The key win: cache-first lookup preserves the original part info.
    expect(prodWrite!.body.partNumber).toBe('V11690');
    expect(prodWrite!.body.partDescription).toBe('Ned Stool - Slate - recycled plastics');
    // And the rest of the row's data survives the round-trip.
    expect(prodWrite!.body.countStart).toBe(100);
    expect(prodWrite!.body.countEnd).toBe(200);
    expect(prodWrite!.body.reject).toBe(8);
    expect(prodWrite!.body.timeline).toBe('SSRRRRRRRR······');
    // Tuple unlock flag cleared after successful commit.
    const unlocked = (dal as unknown as { unlockedTuples: Set<string> }).unlockedTuples;
    expect(unlocked.has('1300T|2026-06-13-Day|SFM507068')).toBe(false);
  });

  it('lockShift with EMPTY editCache for the tuple does NOT write a blank placeholder over the existing row', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const writes: Array<{ list: string; body: Record<string, unknown> }> = [];
    const o = dal as unknown as {
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
      listPlanning: () => Promise<unknown[]>;
    };
    o.upsertHeaderInto = async (list: string, h: Record<string, unknown>): Promise<void> => {
      writes.push({ list, body: h });
    };
    o.replaceBreakdownEvents = async (): Promise<void> => { /* noop */ };
    o.replaceRejectEvents = async (): Promise<void> => { /* noop */ };
    o.deleteLiveRow = async (): Promise<void> => { /* noop */ };
    o.listPlanning = async (): Promise<unknown[]> => [];

    // editCache empty → lockShift should bail without writing anything.
    await dal.lockShift('1300T', '2026-06-13-Day', 'Sup', 'Op', 'SFM507068');

    expect(writes).toEqual([]);
  });

  it('unlockedTuples survives a page reload (persisted to localStorage)', async () => {
    store.clear();
    const dal1 = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const o = dal1 as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existingSignedRow()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    await dal1.unlockShift('1300T', '2026-06-13-Day', 'SFM507068');
    await flushPersist();

    // Simulate page reload: brand-new DAL instance, same localStorage.
    const dal2 = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const unlocked = (dal2 as unknown as { unlockedTuples: Set<string> }).unlockedTuples;
    expect(unlocked.has('1300T|2026-06-13-Day|SFM507068')).toBe(true);
    const cache = (dal2 as unknown as { editCache: Map<string, unknown[]> }).editCache;
    expect(cache.has('1300T|2026-06-13-Day|SFM507068')).toBe(true);
  });
});

describe('PMD_Production denormalisation: jobRequired + partDescription survive unlock', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  // 1300T Day shift 507071 from the supervisor's screenshot:
  // OrderQty 176, partNum V11690, "Ned Stool - Slate ..." description.
  function existing507071() {
    return {
      machineCode: '1300T',
      date: '2026-06-15',
      shift: 'Day',
      jobNumber: '507071',
      partNumber: 'V11690',
      partDescription: 'Ned Stool - Slate - recycled plastics',
      jobRequired: 176,
      timeline: 'R···············',
      countStart: 61,
      countEnd: 115,
      reject: 8,
      operator: 'Heng Ong',
      supervisor: 'Bounpanh Wa',
      runTime: 0.5,
      downTime: 0,
      handover: '',
      qcChecks: '',
      // Per-slot rejects wiped by an earlier broken unlock. Total
      // Reject=8 lives on the header but per-slot detail is gone.
      rejectsBySlot: '',
    };
  }

  it('expand → rehydrate carries partDescription AND jobRequired to canonical slot 0', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existing507071()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    await dal.unlockShift('1300T', '2026-06-15-Day', '507071');

    const key = '1300T|2026-06-15-Day|507071';
    const cache = (dal as unknown as {
      editCache: Map<string, Array<{
        slotIndex: number; partNumber: string; partDescription?: string;
        jobRequired?: number; countStart: number | null; rejectCount: number;
      }>>;
    }).editCache;
    const slots = cache.get(key)!;
    const canon = slots.find((s) => s.slotIndex === 0)!;
    expect(canon.partNumber).toBe('V11690');
    expect(canon.partDescription).toBe('Ned Stool - Slate - recycled plastics');
    expect(canon.jobRequired).toBe(176);
    expect(canon.countStart).toBe(61);
    // Reject TOTAL preserved on canonical slot even when per-slot detail
    // is gone (broken-unlock recovery case).
    expect(canon.rejectCount).toBe(8);
  });

  it('lockShift preserves jobRequired from cache when planning has dropped the order', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const writes: Array<{ list: string; body: Record<string, unknown> }> = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
      listPlanning: () => Promise<unknown[]>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existing507071()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.upsertHeaderInto = async (list: string, h: Record<string, unknown>): Promise<void> => {
      writes.push({ list, body: h });
    };
    o.replaceBreakdownEvents = async (): Promise<void> => { /* noop */ };
    o.replaceRejectEvents = async (): Promise<void> => { /* noop */ };
    o.deleteLiveRow = async (): Promise<void> => { /* noop */ };
    o.listPlanning = async (): Promise<unknown[]> => []; // Epicor dropped it

    await dal.unlockShift('1300T', '2026-06-15-Day', '507071');
    await dal.lockShift('1300T', '2026-06-15-Day', 'Bounpanh', 'Heng', '507071');

    const prod = writes.find((w) => w.list === 'PMD_Production')!;
    // Order Qty preserved via cache-first lookup.
    expect(prod.body.jobRequired).toBe(176);
    expect(prod.body.partNumber).toBe('V11690');
    expect(prod.body.partDescription).toBe('Ned Stool - Slate - recycled plastics');
    // Reject total preserved even though per-slot rejects were missing
    // (broken-unlock recovery): aggregateSlots returns 0, but the
    // canonical slot 0's rejectCount=8 wins.
    expect(prod.body.reject).toBe(8);
    expect(prod.body.countStart).toBe(61);
    expect(prod.body.countEnd).toBe(115);
    expect(prod.body.timeline).toBe('R···············');
  });

  it('persists CycleTime + ShiftTarget at sign-off (from planning) so past shifts recompute', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const writes: Array<{ list: string; body: Record<string, unknown> }> = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
      listPlanning: () => Promise<unknown[]>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [existing507071()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.upsertHeaderInto = async (list: string, h: Record<string, unknown>): Promise<void> => {
      writes.push({ list, body: h });
    };
    o.replaceBreakdownEvents = async (): Promise<void> => { /* noop */ };
    o.replaceRejectEvents = async (): Promise<void> => { /* noop */ };
    o.deleteLiveRow = async (): Promise<void> => { /* noop */ };
    // Planning still carries the order with a real cycle time (0.05 h/pc)
    // and order total 176; gross this tuple = 115−61−8 = 46 good.
    o.listPlanning = async (): Promise<unknown[]> => [
      { jobNumber: '507071', orderQty: 176, qtyPerHr: 0.05, isDieChange: false },
    ];

    await dal.unlockShift('1300T', '2026-06-15-Day', '507071');
    await dal.lockShift('1300T', '2026-06-15-Day', 'Bounpanh', 'Heng', '507071');

    const prod = writes.find((w) => w.list === 'PMD_Production')!;
    // Cycle time captured from planning so a future past-shift review can
    // rebuild Shift Target after Epicor drops the order.
    expect(prod.body.cycleTime).toBe(0.05);
    // Shift Target snapshot recomputes from Job Left AT SHIFT START. This
    // is the job's only shift, so nothing was made before it began: Job
    // Left = the full 176. 176 × 0.05 = 8.8 h ≥ 8 h → the job does not
    // finish inside the shift → target = a full shift, floor(8/0.05) = 160.
    expect(prod.body.shiftTarget).toBe(160);
  });

  it('re-sign-off keeps CycleTime from the rehydrated row when planning has dropped it', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const writes: Array<{ list: string; body: Record<string, unknown> }> = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
      listPlanning: () => Promise<unknown[]>;
    };
    // Existing signed row already carries CycleTime=0.05 in the column.
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [{ ...existing507071(), cycleTime: 0.05 }] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.upsertHeaderInto = async (list: string, h: Record<string, unknown>): Promise<void> => {
      writes.push({ list, body: h });
    };
    o.replaceBreakdownEvents = async (): Promise<void> => { /* noop */ };
    o.replaceRejectEvents = async (): Promise<void> => { /* noop */ };
    o.deleteLiveRow = async (): Promise<void> => { /* noop */ };
    o.listPlanning = async (): Promise<unknown[]> => []; // Epicor dropped it

    await dal.unlockShift('1300T', '2026-06-15-Day', '507071');
    await dal.lockShift('1300T', '2026-06-15-Day', 'Bounpanh', 'Heng', '507071');

    const prod = writes.find((w) => w.list === 'PMD_Production')!;
    // Survives via the rehydrated canonical slot even though planning is empty.
    expect(prod.body.cycleTime).toBe(0.05);
  });

  it('sign-off survives a Reopened column mis-typed as text (primitive→Edm.String 400)', async () => {
    // Reported: one iPad failed sign-off with "POST 400 Cannot convert a
    // primitive value to the expected type 'Edm.String'". Cause: the Reopened
    // column was created as text, so the boolean write is rejected. The retry
    // must strip the offending field and let the rest of the row land.
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const posts: Record<string, unknown>[] = [];
    const o = dal as unknown as {
      post: (url: string, body: Record<string, unknown>, ifMatch?: string) => Promise<void>;
      postWithFieldRetry: (
        list: string,
        url: string,
        body: Record<string, unknown>,
        ifMatch?: string,
      ) => Promise<void>;
      rejectedFields: Map<string, Set<string>>;
    };
    o.post = async (_url, body): Promise<void> => {
      posts.push(body);
      if ('Reopened' in body) {
        throw new Error(
          "POST 400 Cannot convert a primitive value to the expected type 'Edm.String'.",
        );
      }
      // succeeds once Reopened is stripped
    };
    const body = {
      __metadata: { type: 'SP.Data.MockListItem' },
      Title: 'Batt2',
      Reopened: false,
      CountStart: 0,
      CountEnd: 100,
    };
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', body, '*');
    // First attempt threw; the retry posted WITHOUT Reopened and succeeded.
    expect(posts.length).toBe(2);
    expect('Reopened' in posts[1]).toBe(false);
    // Numeric fields (CountStart/End) survive — only the mistyped field is dropped.
    expect(posts[1].CountStart).toBe(0);
    // Future writes strip Reopened up front (no repeated bisect).
    expect(o.rejectedFields.get('PMD_Production')?.has('Reopened')).toBe(true);
  });

  it('sign-off survives a missing column AND a mistyped column in one body (550T)', async () => {
    // Reported on 550T: a 2×-cavities sign-off carried Cavities (column not
    // yet on the tenant) AND Reopened (column mistyped as text) in the same
    // POST. The old single-shot retry stripped one offender, then the bare
    // retry hit the second error and the whole sign-off failed. The loop
    // must strip both and land the row.
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const posts: Record<string, unknown>[] = [];
    const o = dal as unknown as {
      post: (url: string, body: Record<string, unknown>, ifMatch?: string) => Promise<void>;
      postWithFieldRetry: (
        list: string,
        url: string,
        body: Record<string, unknown>,
        ifMatch?: string,
      ) => Promise<void>;
      rejectedFields: Map<string, Set<string>>;
    };
    o.post = async (_url, body): Promise<void> => {
      posts.push(body);
      if ('Cavities' in body) {
        throw new Error(
          "POST 400 The property 'Cavities' does not exist on type 'SP.Data.PMD_ProductionListItem'.",
        );
      }
      if ('Reopened' in body) {
        throw new Error(
          "POST 400 Cannot convert a primitive value to the expected type 'Edm.String'.",
        );
      }
    };
    await o.postWithFieldRetry('PMD_Production', 'https://x/items', {
      __metadata: { type: 'SP.Data.MockListItem' },
      Title: '550T',
      Cavities: 2,
      Reopened: false,
      CountEnd: 100,
    });
    const last = posts[posts.length - 1];
    expect('Cavities' in last).toBe(false);
    expect('Reopened' in last).toBe(false);
    expect(last.CountEnd).toBe(100); // the rest of the row landed
    const banned = o.rejectedFields.get('PMD_Production')!;
    expect(banned.has('Cavities')).toBe(true);
    expect(banned.has('Reopened')).toBe(true);
  });

  it('never strips a core count field to make a sign-off look successful', async () => {
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const posts: Record<string, unknown>[] = [];
    const o = dal as unknown as {
      post: (url: string, body: Record<string, unknown>) => Promise<void>;
      postWithFieldRetry: (
        list: string,
        url: string,
        body: Record<string, unknown>,
      ) => Promise<void>;
      rejectedFields: Map<string, Set<string>>;
    };
    o.post = async (_url, body): Promise<void> => {
      posts.push(body);
      throw new Error(
        "POST 400 The property 'CountEnd' does not exist on type 'SP.Data.PMD_ProductionListItem'.",
      );
    };
    await expect(
      o.postWithFieldRetry('PMD_Production', 'https://x/items', {
        __metadata: { type: 'SP.Data.MockListItem' },
        Title: 'Batt1',
        CountStart: 0,
        CountEnd: 100,
      }),
    ).rejects.toThrow(/CountEnd/);
    expect(posts).toHaveLength(1);
    expect(posts[0].CountEnd).toBe(100);
    expect(o.rejectedFields.get('PMD_Production')?.has('CountEnd')).not.toBe(true);
  });

  it('upsertHeaderInto does NOT write jobRequired=0 (would blank a real value via MERGE)', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    // Use the unprivate path: call upsertHeaderInto through lockShift
    // with a tuple whose cache lacks jobRequired (so jobRequiredOf
    // returns 0) and assert the upsert body OMITS the field.
    const writes: Array<Record<string, unknown>> = [];
    const o = dal as unknown as {
      itemType: () => Promise<string>;
      getAllItems: () => Promise<unknown[]>;
      postWithFieldRetry: (
        list: string,
        url: string,
        body: Record<string, unknown>,
      ) => Promise<void>;
    };
    o.itemType = async (): Promise<string> => 'SP.Data.MockListItem';
    o.getAllItems = async (): Promise<unknown[]> => [];
    o.postWithFieldRetry = async (_l: string, _u: string, body: Record<string, unknown>): Promise<void> => {
      writes.push(body);
    };
    // Call the private upsertHeaderInto directly.
    await (dal as unknown as {
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
    }).upsertHeaderInto('PMD_Production', {
      machineCode: '1300T',
      date: '2026-06-15',
      shift: 'Day',
      jobNumber: '507071',
      partNumber: 'V11690',
      partDescription: 'Ned Stool - Slate - recycled plastics',
      jobRequired: 0, // 0 means "we don't know" — must not be written
      timeline: 'R···············',
      countStart: 61,
      countEnd: 115,
      reject: 8,
      operator: 'Heng',
      supervisor: 'Bounpanh',
      runTime: 0.5,
      downTime: 0,
      handover: '',
      qcChecks: '',
      rejectsBySlot: '',
    });
    expect(writes.length).toBe(1);
    expect('JobRequired' in writes[0]).toBe(false);
  });

  it('re-reads after create and collapses a concurrent duplicate to the lowest ID', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    let reads = 0;
    const deleted: string[] = [];
    const o = dal as unknown as {
      itemType: () => Promise<string>;
      getAllItems: () => Promise<Record<string, unknown>[]>;
      postWithFieldRetry: () => Promise<void>;
      del: (url: string) => Promise<void>;
      upsertHeaderInto: (list: string, h: Record<string, unknown>) => Promise<void>;
    };
    o.itemType = async () => 'SP.Data.MockListItem';
    o.getAllItems = async () => {
      reads++;
      return reads === 1
        ? []
        : [
            { ID: 8, SlotStart_x003a_: '2026-07-14T00:00:00.000Z' },
            { ID: 7, SlotStart_x003a_: '2026-07-14T00:00:00.000Z' },
          ];
    };
    o.postWithFieldRetry = async () => {};
    o.del = async (url) => {
      deleted.push(url);
    };
    await o.upsertHeaderInto('PMD_Production', {
      machineCode: 'Batt1',
      date: '2026-07-14',
      shift: 'Day',
      jobNumber: 'SFM-RACE',
      partNumber: 'P1',
      partDescription: 'Widget',
      jobRequired: 100,
      cycleTime: 0.1,
      cavities: 1,
      timeline: 'R···············',
      countStart: 0,
      countEnd: 10,
      reject: 0,
      operator: 'Joe',
      supervisor: 'Sue',
      runTime: 0.5,
      downTime: 0,
      handover: '',
      qcChecks: '',
      rejectsBySlot: '',
    });
    expect(reads).toBe(2);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('items(8)');
  });
});

describe('PMD_Rejects is the source of truth on read (SFM507067 drift)', () => {
  // A signed-off PMD_Production row can carry a stale Reject column total
  // (e.g. 20) while PMD_Rejects holds the real per-code events (summing to
  // 28). expandHeaderToSlots must surface the EVENT total, never blend the
  // column into slot 0 — otherwise Trace / Operator / KPI show a number
  // that disagrees with the PMD_Rejects list the floor actually trusts.
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  function driftedHeader() {
    return {
      machineCode: '1300T',
      date: '2026-06-19',
      shift: 'Day',
      jobNumber: 'SFM507067',
      partNumber: 'V11690',
      partDescription: 'Ned Stool',
      timeline: 'SRRR·SRRR·SRRRRO',
      countStart: 0,
      countEnd: 111,
      reject: 20, // STALE column — the floor's PMD_Rejects says 28
      operator: 'John Taylor',
      supervisor: 'Christopher King',
      runTime: 5,
      downTime: 0,
      handover: '',
      qcChecks: '',
      rejectsBySlot: '',
    };
  }

  // 28 rejects spread across real slots, exactly what PMD_Rejects holds.
  const rejectEvents = [
    { id: 1, timeline: '1', code: 'D01', category: 'R', qty: 3 },
    { id: 2, timeline: '2', code: 'D09', category: 'R', qty: 1 },
    { id: 3, timeline: '3', code: 'D01', category: 'R', qty: 1 },
    { id: 4, timeline: '3', code: 'D09', category: 'R', qty: 1 },
    { id: 5, timeline: '5', code: 'D01', category: 'R', qty: 5 },
    { id: 6, timeline: '9', code: 'D01', category: 'R', qty: 1 },
    { id: 7, timeline: '11', code: 'D01', category: 'R', qty: 12 },
    { id: 8, timeline: '13', code: 'D09', category: 'R', qty: 2 },
    { id: 9, timeline: '14', code: 'D09', category: 'R', qty: 2 },
  ]; // sums to 28

  function sumRejects(records: Array<{ rejects: string }>): number {
    let n = 0;
    for (const r of records) {
      try {
        const obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
        n += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
      } catch {
        /* ignore */
      }
    }
    return n;
  }

  it('expanded slots total the PMD_Rejects events (28), not the stale column (20) — no double count', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const key = '1300T|2026-06-19-Day|SFM507067';
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [driftedHeader()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> =>
      new Map([[key, rejectEvents]]);
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = await dal.listProduction({
      shiftId: '2026-06-19-Day',
      jobNumber: 'SFM507067',
    });
    // Trace / operator sum the per-slot `rejects` JSON: must equal the
    // event total, never 20 (column shadow) and never 48 (column + events).
    expect(sumRejects(recs)).toBe(28);
  });

  it('falls back to the Reject column when PMD_Rejects has no events (legacy row)', async () => {
    store.clear();
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
    });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [driftedHeader()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = (await dal.listProduction({
      shiftId: '2026-06-19-Day',
      jobNumber: 'SFM507067',
    })) as Array<{ slotIndex: number; rejectCount: number }>;
    // No events at all → the surviving column total is preserved on slot 0
    // rather than zeroed (don't destroy legacy data).
    const slot0 = recs.find((r) => r.slotIndex === 0)!;
    expect(slot0.rejectCount).toBe(20);
  });
});

describe('signed-off history, 24h live cap, and Signoff timestamp', () => {
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      length: 0,
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const pad = (n: number): string => String(n).padStart(2, '0');
  const dayId = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function signedHeader(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      machineCode: '1300T',
      date: '2026-06-13',
      shift: 'Day',
      jobNumber: 'SFM700',
      partNumber: 'P1',
      partDescription: 'Widget',
      timeline: 'RRRR············',
      countStart: 0,
      countEnd: 40,
      reject: 4,
      operator: 'Joe',
      supervisor: 'Sue',
      ...over,
    };
  }

  it('listSignedOffProduction reads PMD_Production only — never live/cache', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const lists: string[] = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> => {
      lists.push(list);
      return list === 'PMD_Production' ? [signedHeader()] : [];
    };
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = await dal.listSignedOffProduction({ jobNumber: 'SFM700' });
    // PMD_LiveStatus must NOT have been consulted.
    expect(lists).toEqual(['PMD_Production']);
    const slot0 = recs.find((r) => r.slotIndex === 0)!;
    expect(slot0.jobNumber).toBe('SFM700');
    expect(slot0.locked).toBe(true);
  });

  it('lockedAt comes from the persisted Signoff timestamp, not the read clock', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const signedAtIso = '2026-06-13T15:42:00.000Z';
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [signedHeader({ signOff: signedAtIso })] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = await dal.listSignedOffProduction({ jobNumber: 'SFM700' });
    expect(recs.every((r) => r.lockedAt === signedAtIso)).toBe(true);
  });

  it('round-trips frozen JobLeft + ShiftTarget onto the canonical record', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    // The stub bypasses fetchHeaders' field mapping, so pass HeaderRow
    // fields (camelCase) directly — these are what the real fetchHeaders
    // would have produced from the JobLeft / ShiftTarget columns.
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production'
        ? [signedHeader({ jobLeft: 300, shiftTarget: 40 })]
        : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = await dal.listSignedOffProduction({ jobNumber: 'SFM700' });
    const slot0 = recs.find((r) => r.slotIndex === 0)!;
    expect(slot0.jobLeft).toBe(300);
    expect(slot0.shiftTarget).toBe(40);
  });

  it('leaves jobLeft/shiftTarget undefined when the columns are absent', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production' ? [signedHeader()] : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = await dal.listSignedOffProduction({ jobNumber: 'SFM700' });
    const slot0 = recs.find((r) => r.slotIndex === 0)!;
    expect(slot0.jobLeft).toBeUndefined();
    expect(slot0.shiftTarget).toBeUndefined();
  });

  it('lockShift stamps the Signoff column', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const today = dayId(new Date());
    const shiftId = `${today}-Day`;
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM700`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM700', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 40, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    let prodBody: Record<string, unknown> | null = null;
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      itemType: () => Promise<string>;
      getAllItems: () => Promise<unknown[]>;
      postWithFieldRetry: (l: string, u: string, b: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.itemType = async (): Promise<string> => 'SP.X';
    o.getAllItems = async (): Promise<unknown[]> => [];
    o.postWithFieldRetry = async (_l, _u, b): Promise<void> => { prodBody = b; };
    o.replaceBreakdownEvents = async (): Promise<void> => {};
    o.replaceRejectEvents = async (): Promise<void> => {};
    o.deleteLiveRow = async (): Promise<void> => {};

    const before = Date.now();
    await dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM700');
    expect(prodBody).not.toBeNull();
    const stamp = Date.parse(prodBody!.Signoff as string);
    expect(Number.isFinite(stamp)).toBe(true);
    expect(stamp).toBeGreaterThanOrEqual(before);
  });

  it('lockShift writes UI-supplied Job Left to the JobLeft column', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const today = dayId(new Date());
    const shiftId = `${today}-Day`;
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM700`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM700', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 40, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    let prodBody: Record<string, unknown> | null = null;
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      itemType: () => Promise<string>;
      getAllItems: () => Promise<unknown[]>;
      postWithFieldRetry: (l: string, u: string, b: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.itemType = async (): Promise<string> => 'SP.X';
    o.getAllItems = async (): Promise<unknown[]> => [];
    o.postWithFieldRetry = async (_l, _u, b): Promise<void> => { prodBody = b; };
    o.replaceBreakdownEvents = async (): Promise<void> => {};
    o.replaceRejectEvents = async (): Promise<void> => {};
    o.deleteLiveRow = async (): Promise<void> => {};

    // UI computed Job Left = 217 (cross-shift Good already burnt down
    // from a larger order). The column must mirror this exactly — not
    // the DAL's tuple-only estimate (which would be (required − 40)).
    await dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM700', 217);
    expect(prodBody).not.toBeNull();
    expect(prodBody!.JobLeft).toBe(217);
  });

  it('lockShift recomputes JobLeft as remaining-at-start from the lists', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const today = dayId(new Date());
    const shiftId = `${today}-Day`;
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM700`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM700', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 40, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    let prodBody: Record<string, unknown> | null = null;
    const o = dal as unknown as {
      listPlanning: () => Promise<{ jobNumber: string; orderQty: number }[]>;
      itemType: () => Promise<string>;
      getAllItems: () => Promise<unknown[]>;
      postWithFieldRetry: (l: string, u: string, b: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
    };
    // Planning seeds jobRequired = 100. No other shift of the job exists
    // anywhere, so "still needed when this shift began" = the full 100 —
    // NOT 100 − 40: this shift's own 40 were made AFTER it began. (The
    // old tuple-only fallback wrote 60 here, quietly mixing at-start and
    // at-end semantics in the same column.)
    o.listPlanning = async (): Promise<{ jobNumber: string; orderQty: number }[]> => [
      { jobNumber: 'SFM700', orderQty: 100 } as { jobNumber: string; orderQty: number },
    ];
    o.itemType = async (): Promise<string> => 'SP.X';
    o.getAllItems = async (): Promise<unknown[]> => [];
    o.postWithFieldRetry = async (_l, _u, b): Promise<void> => { prodBody = b; };
    o.replaceBreakdownEvents = async (): Promise<void> => {};
    o.replaceRejectEvents = async (): Promise<void> => {};
    o.deleteLiveRow = async (): Promise<void> => {};

    await dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM700', null);
    expect(prodBody).not.toBeNull();
    expect(prodBody!.JobLeft).toBe(100);
  });

  it('lockShift denormalises PlannedStart from planning (KPI Schedule Adherence)', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const today = dayId(new Date());
    const shiftId = `${today}-Day`;
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM700`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM700', slotIndex: 0,
      statusCode: 'R', countStart: 0, countEnd: 40, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '',
    }]);
    let prodBody: Record<string, unknown> | null = null;
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      itemType: () => Promise<string>;
      getAllItems: () => Promise<unknown[]>;
      postWithFieldRetry: (l: string, u: string, b: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [
      { jobNumber: 'SFM700', orderQty: 100, plannedStart: '2026-07-01T18:40:00' },
    ];
    o.itemType = async (): Promise<string> => 'SP.X';
    o.getAllItems = async (): Promise<unknown[]> => [];
    o.postWithFieldRetry = async (_l, _u, b): Promise<void> => { prodBody = b; };
    o.replaceBreakdownEvents = async (): Promise<void> => {};
    o.replaceRejectEvents = async (): Promise<void> => {};
    o.deleteLiveRow = async (): Promise<void> => {};

    await dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM700');
    expect(prodBody).not.toBeNull();
    expect(prodBody!.PlannedStart).toBe('2026-07-01T18:40:00');
  });

  it('round-trips PlannedStart onto the canonical record', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production'
        ? [signedHeader({ plannedStart: '2026-07-01T18:40:00' })]
        : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();

    const recs = await dal.listSignedOffProduction({ jobNumber: 'SFM700' });
    const slot0 = recs.find((r) => r.slotIndex === 0)!;
    expect(slot0.plannedStart).toBe('2026-07-01T18:40:00');
  });

  it('lockShift JobLeft recompute overrides a contaminated frozen value', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const today = dayId(new Date());
    const shiftId = `${today}-Night`;
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    // The SFM507147 shape: the canonical slot carries a frozen jobLeft of
    // 397 — poisoned at freeze time by a phantom LiveStatus shadow the
    // freezing iPad could see. The lists actually hold two earlier signed
    // shifts totalling 350 good, so the column must get 1536 − 350 = 1186.
    cache.set(`Batt1|${shiftId}|SFM700`, [{
      id: -1, machineCode: 'Batt1', shiftId, jobNumber: 'SFM700', slotIndex: 0,
      statusCode: 'R', countStart: 428, countEnd: 593, rejects: '{}', purgeKg: null,
      rejectCount: 0, bdIssue: '', mangoTicket: '', handoverNote: '',
      operator: 'Joe', supervisor: 'Sue', qcBy: '', locked: false, lockedBy: '',
      lockedAt: '', createdAt: '', updatedAt: '', jobRequired: 1536, jobLeft: 397,
    }]);
    let prodBody: Record<string, unknown> | null = null;
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      itemType: () => Promise<string>;
      getAllItems: () => Promise<unknown[]>;
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      postWithFieldRetry: (l: string, u: string, b: Record<string, unknown>) => Promise<void>;
      replaceBreakdownEvents: () => Promise<void>;
      replaceRejectEvents: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.itemType = async (): Promise<string> => 'SP.X';
    o.getAllItems = async (): Promise<unknown[]> => [];
    // Stub bypasses field mapping — HeaderRow (camelCase) shapes.
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_Production'
        ? [
            signedHeader({ machineCode: 'Batt1', date: today, shift: 'Day', countStart: 78, countEnd: 254, reject: 0 }),
            signedHeader({ machineCode: 'Batt1', date: today, shift: 'Afternoon', countStart: 254, countEnd: 428, reject: 0 }),
          ]
        : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.postWithFieldRetry = async (_l, _u, b): Promise<void> => { prodBody = b; };
    o.replaceBreakdownEvents = async (): Promise<void> => {};
    o.replaceRejectEvents = async (): Promise<void> => {};
    o.deleteLiveRow = async (): Promise<void> => {};

    await dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM700', 397);
    expect(prodBody).not.toBeNull();
    expect(prodBody!.JobLeft).toBe(1186);
  });

  it('24h hard cap sweeps an old live row that still carries status', async () => {
    store.clear();
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const old = new Date();
    old.setDate(old.getDate() - 3); // 3 days ago → past the 24h cap
    const oldDate = dayId(old);
    const deleted: string[] = [];
    const o = dal as unknown as {
      fetchHeaders: (list: string) => Promise<unknown[]>;
      fetchRejectsByKey: () => Promise<Map<string, unknown[]>>;
      fetchBreakdownTimelines: () => Promise<Map<string, string>>;
      deleteLiveRow: (mc: string, sid: string, job: string) => Promise<void>;
    };
    o.fetchHeaders = async (list: string): Promise<unknown[]> =>
      list === 'PMD_LiveStatus'
        ? [signedHeader({ date: oldDate, jobNumber: 'SFM700', supervisor: '', timeline: 'RRRR············' })]
        : [];
    o.fetchRejectsByKey = async (): Promise<Map<string, unknown[]>> => new Map();
    o.fetchBreakdownTimelines = async (): Promise<Map<string, string>> => new Map();
    o.deleteLiveRow = async (_mc, sid, job): Promise<void> => { deleted.push(`${sid}|${job}`); };

    await dal.listProduction({ machineCode: '1300T' });
    // The old (status-bearing, never-signed-off) live row is swept even
    // though isStaleLiveHeader (status-empty only) would have kept it.
    expect(deleted).toContain(`${oldDate}-Day|SFM700`);
  });
});

describe('sanitizeBodyStrings', () => {
  it('strips C0/C1 controls (except \\t \\n \\r) and U+2028/U+2029/BOM from string values', () => {
    const body: Record<string, unknown> = {
      __metadata: { type: 'SP.X' },
      // NUL inside a handover; U+2028 line separator from a Word paste.
      Handover: 'Machine: ok \u0000\u2028\nMold: fine \u0001',
      // BOM in the middle of a JobNumber (CSV gift from Excel export).
      JobNumber: 'SFM\uFEFF507104',
      Operator: 'Tony Lee',
      // Whitespace must be preserved.
      Notes: 'a\tb\nc\rd',
      CountStart: 0,
      JobRequired: 480,
    };
    sanitizeBodyStrings(body);
    expect(body.Handover).toBe('Machine: ok \nMold: fine ');
    expect(body.JobNumber).toBe('SFM507104');
    expect(body.Operator).toBe('Tony Lee');
    expect(body.Notes).toBe('a\tb\nc\rd');
    expect(body.CountStart).toBe(0);
    expect(body.JobRequired).toBe(480);
    expect(body.__metadata).toEqual({ type: 'SP.X' });
  });
});

describe('listRejectPareto byShift breakdown', () => {
  it('uses PMD_Rejects for code/qty/shift but resolves labels from the category master', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    // Real PMD_Rejects rows are stamped at shiftDateMarker(shiftId) —
    // midnight UTC of the SHIFT'S calendar date — regardless of the actual
    // clock time the reject was logged (writeRejects, sharepoint.ts). All
    // three shifts of 2026-06-20 therefore carry the SAME 00:00:00Z stamp;
    // using that here keeps the test timezone-independent (an earlier
    // version stamped T20:00Z / T23:00Z, which dateOnly correctly rolled to
    // 06-21 under a UTC+ runtime, dropping two shifts).
    const MARK = '2026-06-20T00:00:00.000Z';
    const rejectRows = [
      // RejectCategory is MachineStatus in the real PMD_Rejects schema. It
      // must contribute neither the Pareto key nor its human label.
      { Title: 'Batt1', Shift: 'Day', Date: MARK, RejectCode: 'D05', RejectCategory: 'R', RejectNumber: 5 },
      { Title: 'Batt1', Shift: 'Afternoon', Date: MARK, RejectCode: 'D05', RejectCategory: 'R', RejectNumber: 3 },
      { Title: 'Batt1', Shift: 'Night', Date: MARK, RejectCode: 'D05', RejectCategory: 'R', RejectNumber: 2 },
      { Title: 'Batt1', Shift: 'Night', Date: MARK, RejectCode: 'D09', RejectCategory: 'S', RejectNumber: 4 },
    ];
    const categoryRows = [
      { Title: 'D05', Description: 'Short shot' },
      { Title: 'D09', Description: 'Black spot' },
    ];
    const o = dal as unknown as { getAllItems: (list: string) => Promise<unknown[]> };
    o.getAllItems = async (list: string): Promise<unknown[]> =>
      list === 'PMD_RejectCategories' ? categoryRows : rejectRows;

    const slices = await dal.listRejectPareto({ from: '2026-06-20', to: '2026-06-20' });
    const d05 = slices.find((s) => s.code === 'D05')!;
    expect(d05.value).toBe(10);
    expect(d05.label).toBe('Short shot');
    expect(d05.byShift).toEqual({ Day: 5, Afternoon: 3, Night: 2 });
    expect(d05.byStatus).toEqual({ R: 10 });
    // Sum of the shift split equals the slice total.
    const sum = d05.byShift!.Day + d05.byShift!.Afternoon + d05.byShift!.Night;
    expect(sum).toBe(d05.value);

    const d09 = slices.find((s) => s.code === 'D09')!;
    expect(d09.label).toBe('Black spot');
    expect(d09.byShift).toEqual({ Day: 0, Afternoon: 0, Night: 4 });
    expect(d09.byStatus).toEqual({ S: 4 });
    expect(slices.every((s) => s.label !== 'R' && s.label !== 'S')).toBe(true);
    // D05 (10) sorts before D09 (4).
    expect(slices[0].code).toBe('D05');
  });
});

describe('listProductDieColors CoRun flag', () => {
  it('parses CoRun as a real boolean (Yes/No column) and a "Yes" string', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const rows = [
      // SP Yes/No column → real boolean true
      { PartNum: 'P1', ColorHex: '#112233', ActualColor: 'Navy', Category: 'Battens', DieNumber: 'D-9', CoRun: true },
      // choice/text column → "Yes" string
      { PartNum: 'P2', ColorHex: '#445566', ActualColor: 'Teal', Category: 'Battens', DieNumber: 'D-9', CoRun: 'Yes' },
      // explicit No → false
      { PartNum: 'P3', ColorHex: '#778899', ActualColor: 'Grey', Category: 'Battens', DieNumber: 'D-9', CoRun: false },
      // absent CoRun → defaults to false, but row still kept for its die/colour
      { PartNum: 'P4', ColorHex: '#aabbcc', ActualColor: 'Sand', Category: 'Battens', DieNumber: 'D-9' },
    ];
    const o = dal as unknown as { getAllItems: () => Promise<unknown[]> };
    o.getAllItems = async (): Promise<unknown[]> => rows;

    const out = await dal.listProductDieColors!();
    const byPart = new Map(out.map((c) => [c.partNumber, c]));
    expect(byPart.get('P1')!.coRun).toBe(true);
    expect(byPart.get('P2')!.coRun).toBe(true);
    expect(byPart.get('P3')!.coRun).toBe(false);
    expect(byPart.get('P4')!.coRun).toBe(false);
    // The die number still rides along for every row.
    expect(byPart.get('P1')!.dieNumber).toBe('D-9');
  });

  it('keeps a CoRun-only row that has no colour/category/die', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const rows = [{ PartNum: 'P9', CoRun: true }];
    const o = dal as unknown as { getAllItems: () => Promise<unknown[]> };
    o.getAllItems = async (): Promise<unknown[]> => rows;
    const out = await dal.listProductDieColors!();
    expect(out.find((c) => c.partNumber === 'P9')?.coRun).toBe(true);
  });
});

describe('sign-off multi-list write protocol', () => {
  it('inserts replacement rows before deleting old rows and exposes a restoring rollback', async () => {
    const dal = new SharePointDataLayer({ siteUrl: 'https://example.sharepoint.com/sites/x' });
    const calls: string[] = [];
    const posted: Record<string, unknown>[] = [];
    let nextId = 20;
    const o = dal as unknown as {
      getAllItems: () => Promise<Record<string, unknown>[]>;
      itemType: () => Promise<string>;
      post: (url: string, body: Record<string, unknown>) => Promise<Response>;
      del: (url: string) => Promise<void>;
      replaceRowsWithRollback: (
        list: string,
        filter: string,
        exact: { field: string; date: string },
        bodies: Record<string, unknown>[],
        restoreFields: string[],
      ) => Promise<() => Promise<void>>;
    };
    o.getAllItems = async () => [
      { ID: 10, Date: '2026-07-14T00:00:00.000Z', Value: 'old' },
    ];
    o.itemType = async () => 'SP.Data.MockListItem';
    o.post = async (_url, body) => {
      posted.push(body);
      calls.push(body.Value === 'old' ? 'restore-old' : 'insert-new');
      return new Response(JSON.stringify({ d: { ID: nextId++ } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    o.del = async (url) => {
      calls.push(url.includes('(10)') ? 'delete-old' : 'delete-new');
    };
    const undo = await o.replaceRowsWithRollback(
      'Mock',
      "Title eq 'Batt1'",
      { field: 'Date', date: '2026-07-14' },
      [{ Date: '2026-07-14T00:00:00.000Z', Value: 'new' }],
      ['Date', 'Value'],
    );
    expect(calls).toEqual(['insert-new', 'delete-old']);
    await undo();
    expect(calls).toEqual(['insert-new', 'delete-old', 'delete-new', 'restore-old']);
    expect(posted[posted.length - 1]?.Value).toBe('old');
  });

  function stagedDal(failHeader = false): {
    dal: SharePointDataLayer;
    calls: string[];
    cache: Map<string, unknown[]>;
    shiftId: string;
  } {
    const dal = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/x',
      canWrite: () => true,
    });
    const calls: string[] = [];
    const shiftId = '2026-07-14-Day';
    const cache = (dal as unknown as { editCache: Map<string, unknown[]> }).editCache;
    cache.set(`Batt1|${shiftId}|SFM-TX`, [
      {
        id: -1,
        machineCode: 'Batt1',
        shiftId,
        jobNumber: 'SFM-TX',
        partNumber: 'P1',
        partDescription: 'Widget',
        slotIndex: 0,
        statusCode: 'R',
        countStart: 0,
        countEnd: 20,
        rejectCount: 0,
        rejects: '{}',
        purgeKg: null,
        operator: 'Joe',
        supervisor: 'Sue',
        bdIssue: '',
        mangoTicket: '',
        handoverNote: '',
        qcBy: '',
        locked: false,
        lockedBy: '',
        lockedAt: '',
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const o = dal as unknown as {
      listPlanning: () => Promise<unknown[]>;
      replaceBreakdownEvents: () => Promise<() => Promise<void>>;
      replaceRejectEvents: () => Promise<() => Promise<void>>;
      upsertProductionHeader: () => Promise<void>;
      deleteLiveRow: () => Promise<void>;
    };
    o.listPlanning = async (): Promise<unknown[]> => [];
    o.replaceBreakdownEvents = async () => {
      calls.push('breakdown');
      return async (): Promise<void> => {
        calls.push('undo-breakdown');
      };
    };
    o.replaceRejectEvents = async () => {
      calls.push('rejects');
      return async (): Promise<void> => {
        calls.push('undo-rejects');
      };
    };
    o.upsertProductionHeader = async (): Promise<void> => {
      calls.push('header');
      if (failHeader) throw new Error('header unavailable');
    };
    o.deleteLiveRow = async (): Promise<void> => {
      calls.push('live-cleanup');
    };
    return { dal, calls, cache, shiftId };
  }

  it('writes both detail lists before publishing the signed header', async () => {
    const { dal, calls, shiftId } = stagedDal();
    await dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM-TX');
    expect(calls.slice(0, 4)).toEqual(['breakdown', 'rejects', 'header', 'live-cleanup']);
  });

  it('rolls both detail replacements back when the final header write fails', async () => {
    const { dal, calls, cache, shiftId } = stagedDal(true);
    await expect(
      dal.lockShift('Batt1', shiftId, 'Sue', 'Joe', 'SFM-TX'),
    ).rejects.toThrow(/PMD_Production write failed.*header unavailable/);
    expect(calls).toEqual([
      'breakdown',
      'rejects',
      'header',
      'undo-rejects',
      'undo-breakdown',
    ]);
    // A failed sign-off remains editable/retryable; cache is cleared only
    // after every list write succeeds.
    expect(cache.has(`Batt1|${shiftId}|SFM-TX`)).toBe(true);
  });
});
