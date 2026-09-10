/**
 * The `Planning1.csv` adapter, tested against the real sample rows.
 *
 * The fixture is the four rows Resero sent, verbatim apart from a quoted
 * description added to exercise the CSV reader.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { parsePlanningCsv } from '@/data/csv/planning.parser';
import { remainingHours } from '@/engine/assembly/duration';
import { parseCsv, normalizeHeader, mapHeaders } from '@/lib/csv';

const sample = readFileSync(
  fileURLToPath(new URL('../fixtures/planning1.sample.csv', import.meta.url)),
  'utf8',
);

const byId = (text: string) =>
  new Map(parsePlanningCsv(text).values.map((j) => [String(j.id), j]));

describe('parseCsv', () => {
  it('keeps a comma inside a quoted field', () => {
    const rows = parseCsv('a,b\n"one, two",3\n');
    expect(rows[1]).toEqual(['one, two', '3']);
  });

  it('handles escaped quotes, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"say ""hi""",2\r\n');
    expect(rows[0]).toEqual(['a', 'b']);
    expect(rows[1]).toEqual(['say "hi"', '2']);
  });

  it('reads the last row when the file has no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toHaveLength(2);
  });
});

describe('header matching', () => {
  it('ignores the BAQ table prefix', () => {
    expect(normalizeHeader('JobHead_ReqDueDate')).toBe('reqduedate');
    expect(normalizeHeader('Calculated_LaborHrs')).toBe(
      normalizeHeader('LaborHrs'),
    );
  });

  it('finds columns wherever they sit', () => {
    const at = mapHeaders(['Calculated_LaborHrs', 'JobHead_JobNum'], {
      jobNum: ['JobNum'],
      laborHrs: ['LaborHrs'],
      missing: ['Nope'],
    });
    expect(at).toEqual({ jobNum: 1, laborHrs: 0 });
  });
});

describe('parsePlanningCsv', () => {
  const jobs = byId(sample);

  it('reads every order', () => {
    expect([...jobs.keys()]).toEqual([
      'SFM507615',
      'SFM507616',
      '018140-1-1',
      '018321-2-1',
    ]);
  });

  it('splits PMD rows from assembly rows', () => {
    expect(jobs.get('SFM507615')!.department).toBe('moulding');
    expect(jobs.get('SFM507615')!.preferredMachine).toBe('PMD');
    expect(jobs.get('SFM507615')!.line).toBeNull();

    expect(jobs.get('018140-1-1')!.department).toBe('assembly');
    expect(String(jobs.get('018140-1-1')!.line)).toBe('ASSY');
  });

  it('takes the export’s labour hours as the bar length', () => {
    expect(jobs.get('018140-1-1')!.laborHrs).toBeCloseTo(2.1, 5);
  });

  it('prefers RemainingLaborHrs when the export carries it', () => {
    const withRemaining = sample
      .replace('Calculated_LaborHrs', 'Calculated_RemainingLaborHrs')
      .replace(',2.1,', ',3.6,');
    const j = byId(withRemaining).get('018140-1-1')!;
    expect(j.laborHrs).toBeCloseTo(3.6, 5);
  });

  it('grosses the remaining hours up to the whole order', () => {
    // 18 of 30 left at 0.12 h/pc = 2.16 h remaining, so the order is 3.6 h.
    // Taking the export's figure as the total would discount it twice and
    // schedule 1.3 h of work that still has to be done.
    const partlyDone = sample.replace(
      '018140-1-1,CSSL01436,"Cosmic Stool, walnut",ASSY,30,30,2026-09-10T00:00:00,2026-09-11T00:00:00,2.1',
      '018140-1-1,CSSL01436,"Cosmic Stool, walnut",ASSY,30,18,2026-09-10T00:00:00,2026-09-11T00:00:00,2.16',
    );
    const j = byId(partlyDone).get('018140-1-1')!;
    expect(j.remainingQty).toBe(18);
    expect(j.completedQty).toBe(12);
    expect(j.laborHrs).toBeCloseTo(3.6, 5);
    expect(remainingHours(j)).toBeCloseTo(2.16, 5);
  });

  it('derives labour hours from qty x ProdStandard when the column is absent', () => {
    const withoutHours = [
      'JobHead_JobNum,JobHead_PartNum,JobHead_Department,Calculated_RemainingQty,JobOper_ProdStandard',
      '018321-2-1,DETR00081,ASSY,4,0.41667',
    ].join('\n');
    // 4 pcs x 0.41667 h/pc = 1.667 h, matching the export's own 1.67.
    expect(byId(withoutHours).get('018321-2-1')!.laborHrs).toBeCloseTo(
      1.667,
      3,
    );
  });

  it('inverts ProdStandard into a run rate', () => {
    expect(jobs.get('018140-1-1')!.qtyPerHr).toBeCloseTo(1 / 0.07, 6);
  });

  it('reads completed qty as ProdQty minus RemainingQty', () => {
    expect(jobs.get('018140-1-1')!.completedQty).toBe(0);

    const partlyDone = sample.replace(
      '018140-1-1,CSSL01436,"Cosmic Stool, walnut",ASSY,30,30',
      '018140-1-1,CSSL01436,"Cosmic Stool, walnut",ASSY,30,18',
    );
    const j = byId(partlyDone).get('018140-1-1')!;
    expect(j.completedQty).toBe(12);
    expect(j.remainingQty).toBe(18);
  });

  it('maps ReqDueDate to the due date', () => {
    const due = jobs.get('SFM507615')!.dueDate!;
    expect([due.getFullYear(), due.getMonth() + 1, due.getDate()]).toEqual([
      2026, 9, 30,
    ]);
  });

  it('folds StartDate and StartHour into one instant', () => {
    // 2026-09-29T00:00:00 + 23.3 h → 29 Sep 23:18.
    const s = jobs.get('SFM507615')!.startDate!;
    expect([s.getFullYear(), s.getMonth() + 1, s.getDate()]).toEqual([
      2026, 9, 29,
    ]);
    expect([s.getHours(), s.getMinutes()]).toEqual([23, 18]);
  });

  it('keeps midnight when the export carries no StartHour', () => {
    const noHour = sample
      .replace(',JobHead_StartHour', '')
      .replace(/,2[123]\.\d+(?=\n|$)/gm, '');
    const s = byId(noHour).get('SFM507615')!.startDate!;
    expect([s.getHours(), s.getMinutes()]).toEqual([0, 0]);
  });

  it('reads a date-only column as local midnight, not UTC', () => {
    const dateOnly = sample.replace(/2026-09-30T00:00:00/g, '2026-09-30');
    const due = byId(dateOnly).get('SFM507615')!.dueDate!;
    expect([due.getFullYear(), due.getMonth() + 1, due.getDate()]).toEqual([
      2026, 9, 30,
    ]);
    expect(due.getHours()).toBe(0);
  });

  it('infers Final Assembly for lines that run only that', () => {
    expect(jobs.get('018140-1-1')!.orderType).toBe('final-assembly');
  });

  it('reads the order type off the line, now that no line runs two of them', () => {
    // ERP's coarse "UPL" used to be one lane running both cutting/sewing and
    // upholstery, so the type had to stay blank. With no BOM to refine it the
    // row falls to Gluing, which runs upholstery and nothing else.
    const upl = sample.replace(
      '"Cosmic Stool, walnut",ASSY',
      '"Cosmic Stool, walnut",UPL',
    );
    const job = byId(upl).get('018140-1-1')!;
    expect(String(job.line)).toBe('UPL_GLUING');
    expect(job.orderType).toBe('upholstery');
  });

  it('finds the PMD/ASSY column by its values when the header is unfamiliar', () => {
    const renamed = sample.replace(
      'JobHead_Department',
      'JobHead_ResourceGrpID_Something',
    );
    const j = byId(renamed);
    expect(j.get('SFM507615')!.department).toBe('moulding');
    expect(String(j.get('018140-1-1')!.line)).toBe('ASSY');
  });

  it('treats a named press as a moulding row', () => {
    const press = sample.replace('Encore,PMD', 'Encore,1300T');
    const j = byId(press).get('SFM507615')!;
    expect(j.department).toBe('moulding');
    expect(String(j.preferredMachine)).toBe('1300T');
  });

  it('reports the headers it saw when a required column is missing', () => {
    const { values, errors } = parsePlanningCsv('Foo,Bar\n1,2\n');
    expect(values).toHaveLength(0);
    expect(errors[0]).toContain('jobNum');
    expect(errors[0]).toContain('Foo, Bar');
  });

  it('skips spacer rows and keeps the first of a duplicated job', () => {
    const messy = sample + ',,,,,,,,,,\nSFM507615,7911FR,Dupe,PMD,9,9,,,0.5,,\n';
    const parsed = parsePlanningCsv(messy);
    expect(parsed.values).toHaveLength(4);
    expect(parsed.values[0].description).toBe('Encore');
  });
});

describe('the labour-hours column', () => {
  /** The header row of the real export, with the hours column renamed. */
  const withHoursHeader = (name: string) =>
    sample.replace('Calculated_LaborHrs', name);

  it('reads the BAQ’s own spelling, "RemaingLaborHrs"', () => {
    // Not a typo on our side: this is what the live export calls the column.
    const j = byId(withHoursHeader('Calculated_RemaingLaborHrs')).get(
      '018140-1-1',
    )!;
    // 30 pieces, 2.1 remaining hours — the same total as the correctly
    // spelled column gives.
    expect(remainingHours(j)).toBeCloseTo(2.1, 6);
  });

  it('reads it however it is spelled, as long as it reads as labour hours', () => {
    for (const name of [
      'Calculated_RemainingLaborHrs',
      'Calculated_RemaingLabourHrs',
      'RemainingLabourHours',
    ]) {
      const j = byId(withHoursHeader(name)).get('018140-1-1');
      expect(remainingHours(j!)).toBeCloseTo(2.1, 6);
    }
  });

  it('prefers the remaining-hours column when both are there', () => {
    // Two hours columns that disagree: remaining wins, because that is the
    // number Resero plans with.
    const both =
      'JobHead_JobNum,JobHead_PartNum,JobHead_Department,JobHead_ProdQty,' +
      'Calculated_RemainingQty,Calculated_RemaingLaborHrs,Calculated_LaborHrs\n' +
      'J1,P1,ASSY,10,10,2.5,99\n';
    expect(remainingHours(byId(both).get('J1')!)).toBeCloseTo(2.5, 6);
  });

  it('says so once, with the headers, when there is no hours column at all', () => {
    const noHours = sample
      .replace('Calculated_LaborHrs', 'SomethingElse')
      .replace('JobOper_ProdStandard', 'AlsoNotHours');
    const { values, errors } = parsePlanningCsv(noHours);

    expect(values).toHaveLength(4); // the orders still load
    const complaint = errors.filter((e) => /labour-hours column/.test(e));
    expect(complaint).toHaveLength(1); // once for the file, not once a row
    expect(complaint[0]).toContain('RemaingLaborHrs');
    expect(complaint[0]).toContain('SomethingElse');
  });

  it('names the row when an assembly order’s cells are blank', () => {
    const blank = sample.replace(
      /^(018140-1-1,.*?,ASSY,30,30,[^,]*,[^,]*),[^,]*,[^,]*,/m,
      '$1,,,',
    );
    const { errors } = parsePlanningCsv(blank);
    expect(errors.some((e) => e.includes('018140-1-1'))).toBe(true);
  });

  it('says nothing about a press job, which this board never schedules', () => {
    // The PMD lane mirrors moulding's own plan on moulding's own dates, so
    // hours it does not carry are not this board's problem — and a real
    // export has enough of these rows to bury the orders that matter.
    const blank = sample.replace(
      'SFM507615,7911FR,Encore,PMD,34,34,2026-09-29T00:00:00,2026-09-30T00:00:00,0.77,0.022727,23.3',
      'SFM507615,7911FR,Encore,PMD,34,34,2026-09-29T00:00:00,2026-09-30T00:00:00,,,23.3',
    );
    const { values, errors } = parsePlanningCsv(blank);
    expect(values.map((j) => String(j.id))).toContain('SFM507615');
    expect(errors.some((e) => e.includes('SFM507615'))).toBe(false);
  });
});
