import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readXlsxSheet, xlsxSheetNames, numberKind } from '../src/core/xlsx';
import {
  attendanceByEmployee,
  attendanceCovers,
  attendanceWeeks,
  durationHours,
  mergeAttendance,
  parseTimesheet,
  timesheetDay,
  unusualWorkTypes,
} from '../src/core/attendance';
import { historyGroup, parseHistoryTable } from '../src/core/assembly-history';
import { chartBuckets, efficiencySeries } from '../src/core/assembly-efficiency';
import { readAttendance, readTimesheetFile, splitDelimited } from '../src/dal/sharepoint/attendance';
import { rosterFrom } from '../src/dal/sharepoint/assembly';

// ---- a minimal .xlsx writer, for the fixtures ---------------------------------

function zip(files: Record<string, string>, stored: string[] = []): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const store = stored.includes(name);
    const data = store ? raw : new Uint8Array(deflateRawSync(raw));
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, store ? 0 : 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, store ? 0 : 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i: number): string => String.fromCharCode(65 + i);

type Cell = string | { n: number; s: number } | null;

/** A workbook with a `Notes` sheet first and the `Export` sheet second; styles 1 = date, 2 = [h]:mm:ss, 3 = time. */
function workbook(rows: Cell[][]): Uint8Array {
  const shared: string[] = [];
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((c, i) => {
          if (c === null) return '';
          const ref = `${colName(i)}${r + 1}`;
          if (typeof c === 'string') {
            let idx = shared.indexOf(c);
            if (idx < 0) idx = shared.push(c) - 1;
            return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
          }
          return `<c r="${ref}" s="${c.s}"><v>${c.n}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return zip(
    {
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        '<sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Export" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Run notes</t></is></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
      'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
      'xl/styles.xml':
        '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="[h]:mm:ss"/></numFmts>' +
        '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="21"/></cellXfs></styleSheet>',
    },
    ['xl/worksheets/sheet1.xml'],
  );
}

const HEADER = [
  'Employee Id', 'First Name', 'Surname', 'Employee External Id', 'Timesheet Id', 'Status', 'Location', 'Dimension',
  'Start Date', 'Start Time', 'End Date', 'End Time', 'Duration', 'Total Duration', 'Units', 'Unit Type', 'Work Type',
];
const ASSY = 'Resero Pty Ltd / Operations / Factory / Assembly / Assembly Direct';
const ASSY_IND = 'Resero Pty Ltd / Operations / Factory / Assembly / Assembly Indirect';

/** 26/10/2026 is Excel day 46321. */
const D = (day: number): { n: number; s: number } => ({ n: 46321 + day, s: 1 });
const H = (hours: number): { n: number; s: number } => ({ n: hours / 24, s: 2 });

describe('readXlsxSheet', () => {
  it('reads the named sheet, with shared strings, dates and durations written as the export shows them', async () => {
    const bytes = workbook([
      ['Timesheet report'],
      HEADER,
      ['10872482', 'CHANTHAN', 'PEOV', '73039', '144289939', 'Processed', ASSY, '', D(0), { n: 7 / 24, s: 3 }, D(0), null, H(7.6), H(7.6), '0', 'Hours', 'Long Service Leave Taken'],
    ]);
    expect(await xlsxSheetNames(bytes)).toEqual(['Notes', 'Export']);
    const rows = await readXlsxSheet(bytes, 'export');
    expect(rows[0]).toEqual(['Timesheet report']);
    expect(rows[1]).toEqual(HEADER);
    expect(rows[2].slice(0, 3)).toEqual(['10872482', 'CHANTHAN', 'PEOV']);
    expect(rows[2][8]).toBe('2026-10-26');
    expect(rows[2][9]).toBe('7:00:00');
    expect(rows[2][11]).toBe(''); // a missing cell keeps the columns after it in place
    expect(rows[2][13]).toBe('7:36:00');
    expect(rows[2][16]).toBe('Long Service Leave Taken');
  });

  it('names the sheets it has when the one asked for is not there', async () => {
    await expect(readXlsxSheet(workbook([HEADER]), 'Timesheets')).rejects.toThrow(/no "Timesheets" sheet \(it has Notes, Export\)/);
    await expect(readXlsxSheet(new TextEncoder().encode('Employee Id,Work Type'), 'Export')).rejects.toThrow(/not an \.xlsx/);
  });

  it('tells dates, times and plain numbers apart by their format', () => {
    expect(numberKind(14, undefined)).toBe('date');
    expect(numberKind(22, undefined)).toBe('datetime');
    expect(numberKind(46, undefined)).toBe('time');
    expect(numberKind(164, '[h]:mm:ss')).toBe('time');
    expect(numberKind(165, 'dd/mm/yyyy h:mm')).toBe('datetime');
    expect(numberKind(166, '[$-409]d-mmm-yy')).toBe('date');
    expect(numberKind(167, '0.00')).toBe(null);
    expect(numberKind(168, '"hours" 0.0')).toBe(null);
  });
});

describe('parseTimesheet', () => {
  const row = (over: Partial<Record<(typeof HEADER)[number], string>>): string[] =>
    HEADER.map((h) => over[h] ?? '');
  const base = { 'Employee Id': '10872482', 'First Name': 'CHANTHAN', Surname: 'PEOV', Status: 'Processed', Location: ASSY, 'Start Date': '27/10/2026' };

  it('reads worked, leave and indirect lines, and leaves out what does not count', () => {
    const out = parseTimesheet(
      [
        ['Pay run 44'],
        HEADER,
        row({ ...base, 'Start Date': '26/10/2026', 'Total Duration': '7:36:00', 'Duration': '7:36:00', 'Work Type': 'Long Service Leave Taken', 'Timesheet Id': '1' }),
        row({ ...base, 'Total Duration': '7:36:00', 'Work Type': '', 'Timesheet Id': '2' }),
        row({ ...base, 'Total Duration': '2:00:00', 'Work Type': 'Overtime 1.5x', 'Timesheet Id': '3' }),
        row({ ...base, 'Start Date': '28/10/2026', 'Total Duration': '7:36:00', 'Work Type': 'Ordinary', Location: ASSY_IND, 'Timesheet Id': '4' }),
        row({ ...base, 'Start Date': '29/10/2026', 'Total Duration': '7:36:00', 'Work Type': 'Public Holiday', 'Timesheet Id': '5' }),
        row({ ...base, 'Start Date': '30/10/2026', 'Total Duration': '7:36:00', 'Work Type': 'Ordinary', Status: 'Rejected', 'Timesheet Id': '6' }),
        row({ ...base, 'Start Date': '30/10/2026', 'Total Duration': '7:36:00', 'Work Type': 'Ordinary', Location: 'Resero Pty Ltd / Operations / Office', 'Timesheet Id': '7' }),
        row({ 'Employee Id': '', 'Total Duration': '45:36:00' }), // a total under the table
      ],
      'TimesheetReport-PayRun44.xlsx',
    );
    expect(out.errors).toEqual([]);
    expect(out.entries.map((e) => [e.day, e.kind, Math.round(e.hours * 100) / 100, e.workType])).toEqual([
      ['2026-10-26', 'leave', 7.6, 'Long Service Leave Taken'],
      ['2026-10-27', 'direct', 7.6, ''],
      ['2026-10-27', 'direct', 2, 'Overtime 1.5x'],
      ['2026-10-28', 'indirect', 7.6, 'Ordinary'],
      ['2026-10-29', 'leave', 7.6, 'Public Holiday'],
    ]);
    expect(out.entries[0].name).toBe('CHANTHAN PEOV');
    expect(unusualWorkTypes(out.entries)).toEqual([]);
  });

  it('falls back from Total Duration to Duration, Units in hours, then the clock times', () => {
    const out = parseTimesheet(
      [
        HEADER,
        row({ ...base, Duration: '8.5', 'Work Type': 'Ordinary' }),
        row({ ...base, Units: '4', 'Unit Type': 'Hours', 'Work Type': 'Training' }),
        row({ ...base, 'Start Time': '7:00:00', 'End Time': '2:36 PM', 'Work Type': 'Ordinary' }),
        row({ ...base, Units: '2', 'Unit Type': 'Days', 'Work Type': 'Annual Leave' }),
        row({ ...base, 'Start Date': 'tomorrow', 'Total Duration': '7:36:00' }),
      ],
      'f.xlsx',
    );
    expect(out.entries.map((e) => Math.round(e.hours * 100) / 100)).toEqual([8.5, 4, 7.6, 15.2]);
    expect(out.errors[0]).toMatch(/^f\.xlsx row 6: no readable Start Date or Duration \(Employee Id "10872482", Start Date "tomorrow", Total Duration "7:36:00"/);
    expect(unusualWorkTypes(out.entries)).toEqual(['Training']);
  });

  it('says so when the sheet has no timesheet header', () => {
    expect(parseTimesheet([['Name', 'Hours']], 'x.xlsx').errors[0]).toMatch(/no header row/);
  });

  it('counts a line two overlapping exports both hold once', () => {
    const one = parseTimesheet([HEADER, row({ ...base, 'Timesheet Id': '9', 'Total Duration': '7:36:00', 'Work Type': 'Ordinary' })], 'a.xlsx');
    const two = parseTimesheet(
      [HEADER, row({ ...base, 'Timesheet Id': '9', 'Total Duration': '7:36:00', 'Work Type': 'Ordinary' }), row({ ...base, 'Timesheet Id': '10', 'Start Date': '28/10/2026', 'Total Duration': '7:36:00', 'Work Type': 'Ordinary' })],
      'b.xlsx',
    );
    expect(mergeAttendance([one, two]).entries).toHaveLength(2);
  });

  it('reads days and durations in the forms the export uses', () => {
    expect(timesheetDay('26/10/2026')).toBe('2026-10-26');
    expect(timesheetDay('2026-10-26 00:00:00')).toBe('2026-10-26');
    expect(timesheetDay('31/02/2026')).toBe(null);
    expect(durationHours('7:36:00')).toBeCloseTo(7.6);
    expect(durationHours('45:36')).toBeCloseTo(45.6);
    expect(durationHours('7.6')).toBeCloseTo(7.6);
    expect(durationHours('')).toBeNaN();
  });
});

describe('weeks and people', () => {
  const entry = (employeeId: string, day: string, hours: number, kind: 'direct' | 'indirect' | 'leave' = 'direct', location = ASSY) => ({
    employeeId, name: employeeId, day, hours, kind, workType: kind === 'leave' ? 'Annual Leave' : 'Ordinary', location,
  });

  it('a period is covered only when every week in it has a timesheet', () => {
    const weeks = attendanceWeeks([entry('1', '2026-10-27', 7.6), entry('1', '2026-11-03', 7.6)]);
    expect([...weeks]).toEqual(['2026-10-26', '2026-11-02']);
    expect(attendanceCovers(weeks, '2026-10-26', '2026-11-08')).toBe(true);
    expect(attendanceCovers(weeks, '2026-10-30', '2026-10-30')).toBe(true);
    expect(attendanceCovers(weeks, '2026-10-26', '2026-11-09')).toBe(false);
  });

  it("adds up each person's direct, indirect and leave hours in a window", () => {
    const by = attendanceByEmployee(
      [entry('1', '2026-10-26', 7.6, 'leave'), entry('1', '2026-10-27', 7.6), entry('1', '2026-10-27', 2), entry('1', '2026-10-28', 7.6, 'indirect'), entry('1', '2026-11-03', 7.6)],
      '2026-10-26',
      '2026-11-01',
    );
    expect(by.get('1')).toEqual({ direct: 9.6, indirect: 7.6, leave: 7.6, leaveDays: ['2026-10-26'] });
  });

  it('Std h of the export over direct hours, per line and for the floor; PMD and TBP left out', () => {
    const csv = parseHistoryTable([
      ['LaborDtl_CreateDate', 'LaborDtl_LaborQty', 'LaborDtl_LaborHrs', 'Calculated_PlannerID', 'LaborDtl_JobNum'],
      ['2026-10-27T00:00:00', '10', '30', 'UPL', 'J1'],
      ['2026-10-28T00:00:00', '5', '15.2', 'ASSY', 'J2'],
      ['2026-10-29T00:00:00', '5', '50', 'PMD', 'J3'],
      ['2026-10-29T00:00:00', '5', '40', 'TBP', 'J7'],
      ['2026-11-04T00:00:00', '5', '20', 'TABLE', 'J4'],
      ['2026-11-05T00:00:00', '5', '4', 'ODD', 'J5'],
      ['bad', '1', '1', 'UPL', 'J6'],
    ]);
    expect(csv.errors).toEqual(['CompletedJobs.csv: 1 rows with no readable day or hours were skipped.']);
    const attendance = [
      entry('u', '2026-10-27', 38), // UPL
      entry('a', '2026-10-27', 19), // Assembly
      entry('p', '2026-10-27', 38), // PMD: out
      entry('b', '2026-10-27', 38), // TBP: out
      entry('x', '2026-10-27', 5), // nobody's line: the floor only
      entry('a', '2026-10-28', 7.6, 'leave'),
      entry('u', '2026-10-28', 7.6, 'indirect'),
    ];
    const groups: Record<string, ReturnType<typeof historyGroup>> = { u: historyGroup('UPL_GLUING'), a: historyGroup('ASSY'), p: historyGroup('PMD'), b: historyGroup('TBP') };
    const weeks = chartBuckets('2026-10-26', '2026-11-09').buckets.slice(0, 2); // 15 days → weeks
    const out = efficiencySeries(
      { rows: csv.rows, done: [], attendance, covered: new Set(['2026-10-26']), groupOf: (id) => groups[id] ?? null },
      weeks,
    );
    expect(out.lines.map((l) => [l.name, l.points.map((p) => p.efficiency)])).toEqual([
      ['UPL', [79, null]],
      ['Assembly', [80, null]],
      ['Table', [null, null]],
    ]);
    // A week no timesheet covers and nobody confirmed: Std h, no hours.
    expect(out.lines.find((l) => l.name === 'Table')!.points[1]).toEqual({ stdHours: 20, timesheetHours: 0, estimatedHours: 0, efficiency: null, basis: null });
    // 45.2 Std h over 62 h; PMD's and TBP's hours and Std h left out; ODD counts for the floor.
    expect(out.floor[0]).toMatchObject({ stdHours: 45.2, timesheetHours: 62, efficiency: 73, basis: 'timesheet' });
  });

  it('maps planners, board line keys and Skills onto the history lines', () => {
    expect(['TBP', 'UPL_CUT_SEW', 'UPL-SSS', 'Gluing', 'ASSY', 'Assembly', 'TABLE', 'FACTORY_GENERAL', 'PMD', 'Office'].map(historyGroup)).toEqual([
      'TBP', 'UPL', 'UPL', 'UPL', 'Assembly', 'Assembly', 'Table', 'General', 'PMD', null,
    ]);
  });
});

describe('reading the Attendance folder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads every export in the folder, newest first, and a CSV saved from one', async () => {
    const xlsx = workbook([HEADER, ['10872482', 'CHANTHAN', 'PEOV', '', '1', 'Processed', ASSY, '', D(1), null, null, null, H(7.6), H(7.6), '', '', 'Ordinary']]);
    const csv = new TextEncoder().encode(`${HEADER.join(',')}\n10872482,CHANTHAN,PEOV,,2,Processed,${ASSY},,03/11/2026,,,,7:36:00,7:36:00,,,Ordinary\n`);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/Files?')) {
        expect(url).toContain("GetFolderByServerRelativeUrl('/sites/ops/Shared%20Documents/PMD/Attendance')");
        return new Response(
          JSON.stringify({
            value: [
              { Name: 'TimesheetReport-PayRun44.xlsx', ServerRelativeUrl: '/sites/ops/Shared Documents/PMD/Attendance/TimesheetReport-PayRun44.xlsx', TimeLastModified: '2026-10-30T00:00:00Z' },
              { Name: 'TimesheetReport-PayRun45.csv', ServerRelativeUrl: '/sites/ops/Shared Documents/PMD/Attendance/TimesheetReport-PayRun45.csv', TimeLastModified: '2026-11-06T00:00:00Z' },
              { Name: '~$TimesheetReport-PayRun45.xlsx', ServerRelativeUrl: '/x', TimeLastModified: '2026-11-07T00:00:00Z' },
              { Name: 'readme.txt', ServerRelativeUrl: '/y', TimeLastModified: '2026-11-07T00:00:00Z' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response((url.includes('PayRun44') ? xlsx : csv).slice(), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await readAttendance('https://t.sharepoint.com/sites/ops', '/sites/ops/Shared Documents/PMD/Attendance');
    expect(out.files).toEqual(['TimesheetReport-PayRun45.csv', 'TimesheetReport-PayRun44.xlsx']);
    expect(out.errors).toEqual([]);
    expect(out.entries.map((e) => [e.day, e.kind, Math.round(e.hours * 10) / 10])).toEqual([
      ['2026-10-27', 'direct', 7.6],
      ['2026-11-03', 'direct', 7.6],
    ]);
  });

  it('names a workbook without an Export sheet instead of failing the rest', async () => {
    const out = await readTimesheetFile('Bad.xlsx', zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships/>' }));
    expect(out.errors[0]).toMatch(/^Bad\.xlsx: no "Export" sheet/);
  });

  it('splits a tab-separated paste and a CSV alike', () => {
    expect(splitDelimited('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(splitDelimited('a,b\n"1,5",2\n')).toEqual([['a', 'b'], ['1,5', '2']]);
  });
});

describe('roster', () => {
  it("carries each person's payroll id, and their line from the board else their Skills", () => {
    const people = rosterFrom(
      [
        { Id: 7, PreferName: 'Chan', EmployeeId: 10872482, Skills: 'TBP, Assembly' },
        { Id: 8, PreferName: 'Mia', EmployeeID: '10872483', Skills: ['Gluing'] },
        { Id: 9, PreferName: 'Leo' },
      ],
      {},
      { '7': 'UPL_CUT_SEW' },
    );
    expect(people.map((p) => [p.name, p.employeeId, p.line])).toEqual([
      ['Chan', '10872482', 'UPL_CUT_SEW'],
      ['Mia', '10872483', 'Gluing'],
      ['Leo', '', ''],
    ]);
  });
});

describe("the real export's forms", () => {
  it('reads durations written as "7h 36m", and skips the Totals row the export ends on', () => {
    expect(durationHours('7h 36m')).toBeCloseTo(7.6);
    expect(durationHours('2085h 3m')).toBeCloseTo(2085.05);
    expect(durationHours('7h')).toBe(7);
    expect(durationHours('45m')).toBeCloseTo(0.75);
    expect(durationHours('0h 0m')).toBe(0);
    const out = parseTimesheet(
      [
        HEADER,
        HEADER.map((h) => ({ 'Employee Id': '10872482', 'Start Date': '27/10/2026', 'Total Duration': '7h 36m', 'Work Type': 'Ordinary', Location: ASSY, 'Start Time': '7:00:00', 'End Time': '15:30:00' } as Record<string, string>)[h] ?? ''),
        HEADER.map((h) => ({ 'Employee Id': 'Totals', 'Total Duration': '2085h 3m' } as Record<string, string>)[h] ?? ''),
      ],
      'TimesheetReport-PayRun2045380_1.xlsx',
    );
    expect(out.errors).toEqual([]);
    // 7:36 paid, not the 8:30 between the clock times.
    expect(out.entries.map((e) => Math.round(e.hours * 100) / 100)).toEqual([7.6]);
  });
});

describe('the KPI table', () => {
  it("takes each order's description from the export, and shows its first six words", async () => {
    const { firstWords } = await import('../src/core/assembly-history');
    const { lineLayout } = await import('../assembly/src/domain/lineLayout');
    const csv = parseHistoryTable([
      ['LaborDtl_CreateDate', 'LaborDtl_LaborHrs', 'Calculated_PlannerID', 'LaborDtl_JobNum', 'JobAsmbl_Description'],
      ['2026-10-27T00:00:00', '3', 'TABLE', 'J1', 'Classroom Table 1200x600 MDF Top Grey Frame Castors\nColour: Oak'],
    ]);
    expect(csv.rows[0]).toMatchObject({ jobNum: 'J1', description: 'Classroom Table 1200x600 MDF Top Grey Frame Castors' });
    expect(firstWords(csv.rows[0].description!)).toBe('Classroom Table 1200x600 MDF Top Grey');
    // Roster lines (a board key, or a Skills word) are read by the board's layout.
    const layout = lineLayout({ lineNames: { UPL_GLUING: 'Upholstery', UPL_SOFTIE: 'Smart Soft Seating' }, uplByProcess: true });
    expect(['UPL_CUT_SEW', 'Cut/Sewing', 'UPL_GLUING', 'UPL', 'Gluing', 'UPL_SOFTIE', 'SSS', 'ASSY', 'TABLE', 'FACTORY_GENERAL', 'TBP'].map((r) => layout.nameOf(r))).toEqual([
      'UPL-CUT', 'UPL-CUT', 'Upholstery + Smart Soft Seating', 'Upholstery + Smart Soft Seating', 'Upholstery + Smart Soft Seating',
      'Upholstery + Smart Soft Seating', 'Upholstery + Smart Soft Seating', 'Assembly', 'Table', 'General', 'TBP',
    ]);
  });
});
