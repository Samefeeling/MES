import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completionsBetween,
  doneQtyByJob,
  doneQtyThrough,
  confirmWindow,
  isAssemblyPlanner,
  parseCompletedJobsCsv,
} from '@/engine/assembly/completedJobs';
import { setFactoryCalendar } from '@/engine/assembly/dates';

const sample = readFileSync(resolve(__dirname, '../fixtures/CompletedJobs.sample.tsv'), 'utf8');

describe('CompletedJobs.csv', () => {
  it('reads the Epicor export as it comes, tab-separated with multi-line descriptions', () => {
    const { rows, errors } = parseCompletedJobsCsv(sample);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      jobNum: '018474-10-1',
      day: '2026-11-18',
      time: '15:02',
      qty: 100,
      hours: 12.5,
      planner: 'TABLE',
      partNum: 'PODSE00010',
      description: 'C-Leg Table - Square Top - no Drawer - Performance Edge - 600w x 600d - Standard Laminate - 720h',
    });
    expect(rows[3]).toMatchObject({ jobNum: '508202', time: '06:27', planner: 'TBP' });
  });

  it('reads a comma-separated copy and a day given only as dd/mm/yyyy', () => {
    const csv = 'LaborDtl_JobNum,LaborDtl_LaborQty,LaborDtl_LaborHrs,Calculated_PlannerID,Calculated_CreateDateTime\n' +
      'J1,"1,200",3,ASSY,05/11/2026 7:04\nJ2,x,1,ASSY,05/11/2026 7:04\n';
    const { rows, errors } = parseCompletedJobsCsv(csv);
    expect(rows).toEqual([expect.objectContaining({ jobNum: 'J1', day: '2026-11-05', time: '07:04', qty: 1200 })]);
    expect(errors).toEqual(['CompletedJobs.csv row 3: no readable order, day or quantity.']);
  });

  it('names a missing column rather than reading nothing quietly', () => {
    expect(parseCompletedJobsCsv('JobNum,Qty\nJ1,4\n').errors[0]).toMatch(/LaborDtl_LaborQty/);
  });

  it('leaves PMD out: moulding records its own operators', () => {
    expect(['TABLE', 'ASSY', 'TBP', 'UPL'].every(isAssemblyPlanner)).toBe(true);
    expect(isAssemblyPlanner('PMD')).toBe(false);
    expect(isAssemblyPlanner(' pmd ')).toBe(false);
    expect(isAssemblyPlanner('')).toBe(false);
  });

  it('folds an order reported twice in a day into one completion', () => {
    const { rows } = parseCompletedJobsCsv(sample);
    const done = completionsBetween(rows, '2026-11-18', '2026-11-18');
    expect(done.map((c) => c.jobNum)).toEqual(['018474-10-1', '018474-4-1', '508202', 'SFM508163']);
    expect(done[0]).toMatchObject({ key: '018474-10-1|2026-11-18', qty: 150, hours: 18.75, entries: 2, lastAt: '2026-11-18T15:03' });
    expect(completionsBetween(rows, '2026-11-19', '2026-11-20')).toEqual([]);
  });
});

describe('the days a supervisor is asked about', () => {
  afterEach(() => setFactoryCalendar({ listed: [], holidays: true }));

  it('is yesterday on an ordinary morning', () => {
    expect(confirmWindow(new Date(2026, 10, 18, 7))).toEqual({ from: '2026-11-17', to: '2026-11-17' });
  });

  it('is Friday to Sunday on a Monday', () => {
    expect(confirmWindow(new Date(2026, 10, 16, 7))).toEqual({ from: '2026-11-13', to: '2026-11-15' });
  });

  it('reaches back over a public holiday or an RDO', () => {
    // Christmas and Boxing Day 2026 are a Friday and a Saturday; Monday 28th is the substitute.
    expect(confirmWindow(new Date(2026, 11, 29, 7))).toEqual({ from: '2026-12-24', to: '2026-12-28' });
    setFactoryCalendar({ listed: [{ day: '2026-11-17', name: 'RDO' }] });
    expect(confirmWindow(new Date(2026, 10, 18, 7))).toEqual({ from: '2026-11-16', to: '2026-11-17' });
  });
});

describe('how much of each order the export shows reported', () => {
  const rows = parseCompletedJobsCsv(
    'LaborDtl_CreateDate,LaborDtl_LaborQty,Calculated_PlannerID,LaborDtl_JobNum\n' +
      '2026-11-17T00:00:00,100,TABLE,J1\n2026-11-18T00:00:00,50,TABLE,J1\n2026-11-18T00:00:00,5,PMD,SFM1\n',
  ).rows;

  it('totals every day of every order, PMD’s included', () => {
    expect(doneQtyByJob(rows)).toEqual({ J1: 150, SFM1: 5 });
  });

  it('runs a total up to a day', () => {
    expect(doneQtyThrough(rows, 'J1', '2026-11-17')).toBe(100);
    expect(doneQtyThrough(rows, 'J1', '2026-11-18')).toBe(150);
  });
});
