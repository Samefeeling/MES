import { describe, expect, it } from 'vitest';
import { JobId, MachineId, PartId } from '@/domain/ids';
import type { Job } from '@/domain/types';
import { changeBetween, changeLabel, planPresses, shiftCount, shiftText, sizeOf } from '@/engine/assembly/pressPlan';
import { parsePressPlanningCsv } from '@/data/csv/pressPlanning.parser';
import { mergePressPlan } from '@/data/csv/PlanningCsvSource';
import { parseDieColors, withDieColors } from '@/data/sharepoint/dieColor.parser';

const at = (s: string) => new Date(`2026-10-${s}`);

function press(
  id: string,
  part: string,
  machine: string,
  start: string,
  end: string,
  die: string | null,
  color: string | null = null,
  insert: string | null = null,
): Job {
  return {
    id: JobId(id),
    department: 'moulding',
    partNum: PartId(part),
    description: part,
    remainingQty: 100,
    qtyPerHr: 10,
    laborHrs: 10,
    dueDate: at(end),
    startDate: at(start),
    reqBy: null,
    released: true,
    priority: 3,
    materialPrep: 'unknown',
    tool: null,
    preferredMachine: MachineId(machine),
    orderType: null,
    line: null,
    completedQty: 0,
    predecessors: [],
    assignedWorkers: [],
    press: { machine, shifts: 'MAN', end: at(end), die, dieName: null, color, insert },
  };
}

describe('the changeover between two press orders', () => {
  it('is a 4 h die change when the die differs, naming both dies', () => {
    const change = changeBetween(press('A', 'P1', 'BATT1', '05T07:00', '05T15:00', '123'), press('B', 'P2', 'BATT1', '05T15:00', '05T23:00', '456'))!;
    expect(change).toMatchObject({ kind: 'die', hours: 4, fromDie: '123', toDie: '456' });
    expect(changeLabel(change)).toBe('Die Change · Die 123 → Die 456');
  });

  it('is a die change when either die is unknown — the safe answer', () => {
    expect(changeBetween(press('A', 'P1', 'M', '05T07:00', '05T08:00', null), press('B', 'P2', 'M', '05T08:00', '05T09:00', '456'))?.kind).toBe('die');
  });

  it('on one die: an insert change when the size in the description changes, else a colour change', () => {
    const desc = (j: Job, d: string): Job => ({ ...j, description: d });
    const a = desc(press('A', 'P1', 'M', '05T07:00', '05T08:00', '123', 'Navy'), 'Postura Max Chair - Size 3 - 350h - Navy');
    // Only the colour word differs.
    const slate = desc(press('B', 'P2', 'M', '05T08:00', '05T09:00', '123', 'Slate'), 'Postura Max Chair - Size 3 - 350h - Slate');
    expect(changeBetween(a, slate)).toMatchObject({ kind: 'colour', hours: 0.5 });
    // The height changes: a different insert, whatever the colour.
    const tall = desc(press('C', 'P3', 'M', '05T08:00', '05T09:00', '123', 'Navy'), 'Postura Max Chair - Size 4 - 460h - Navy');
    expect(changeBetween(a, tall)).toMatchObject({ kind: 'insert', hours: 0.5 });
    expect(changeBetween(a, { ...tall, press: { ...tall.press!, color: 'Slate' } })?.kind).toBe('insert');
    // Neither names a size: the same size as far as anyone can tell.
    const plain = (id: string, part: string, d: string) => desc(press(id, part, 'M', '05T08:00', '05T09:00', '9'), d);
    expect(changeBetween(plain('D', 'P4', 'Snc Shell Blue'), plain('E', 'P5', 'Snc Shell Slate'))?.kind).toBe('colour');
    // An insert field, where the source has one, outranks the description.
    expect(changeBetween({ ...a, press: { ...a.press!, insert: '16' } }, { ...slate, press: { ...slate.press!, insert: '18' } })?.kind).toBe('insert');
  });

  it('reads the size off a description', () => {
    expect(sizeOf('Progress Chair - Flame Resistant - 460h - Cove')).toBe('460h');
    expect(sizeOf('Postura Max Chair - Size 3 - 350 H - Navy')).toBe('350h|size3');
    expect(sizeOf('Viva Seat - Shadow PP Outdoor')).toBeNull();
    // A part number in the text is not a height.
    expect(sizeOf('Snc Shell Hal Holes Blue (PM8567)')).toBeNull();
  });

  it('is nothing for the same part again', () => {
    expect(changeBetween(press('A', 'P1', 'M', '05T07:00', '05T08:00', '1'), press('B', 'P1', 'M', '05T08:00', '05T09:00', '2'))).toBeNull();
  });
});

describe('the press plan', () => {
  it('runs each press in start order and puts the changeover straight after the order before it', () => {
    const [batt] = planPresses([
      press('B', 'P2', 'BATT1', '05T15:00', '05T23:00', '456'),
      press('A', 'P1', 'BATT1', '05T07:00', '05T15:00', '123'),
    ]);
    expect(batt.runs.map((r) => String(r.job.id))).toEqual(['A', 'B']);
    expect(batt.changes).toHaveLength(1);
    expect(batt.changes[0].start).toEqual(at('05T15:00'));
    expect(batt.changes[0].end).toEqual(at('05T19:00'));
  });

  it('moves the next order — and the ones behind it — back when there is no room for the change', () => {
    const [m] = planPresses([
      press('A', 'P1', 'M', '05T07:00', '05T15:00', '1'),
      press('B', 'P2', 'M', '05T15:00', '05T23:00', '2'),
      press('C', 'P2', 'M', '05T23:00', '06T03:00', '2'),
    ]);
    expect(m.runs.map((r) => [String(r.job.id), r.start.getHours(), r.pushedHours])).toEqual([
      ['A', 7, 0],
      ['B', 19, 4],
      ['C', 3, 4],
    ]);
  });

  it('moves nothing when the planner left room for the change', () => {
    const [m] = planPresses([
      press('A', 'P1', 'M', '05T07:00', '05T15:00', '1', 'Black'),
      press('B', 'P2', 'M', '05T16:00', '05T23:00', '1', 'Slate'),
    ]);
    expect(m.changes[0].change.kind).toBe('colour');
    expect(m.runs[1].pushedHours).toBe(0);
  });

  it('runs a co-run — two parts Epicor overlaps on one die — side by side, with no change', () => {
    const [m] = planPresses([
      press('L', 'LEFT', 'M', '05T07:00', '05T15:00', 'D1'),
      press('R', 'RIGHT', 'M', '05T07:00', '05T15:00', 'D1'),
      press('N', 'NEXT', 'M', '05T15:00', '05T20:00', 'D2'),
    ]);
    expect(m.changes.map((c) => c.change.kind)).toEqual(['die']);
    expect(m.runs.map((r) => r.start.getHours())).toEqual([7, 7, 19]);
  });

  it('has a press only while it has orders, and keeps presses apart', () => {
    const plan = planPresses([
      press('A', 'P1', '1300T', '05T07:00', '05T09:00', '1'),
      press('B', 'P2', 'BATT1', '05T07:00', '05T09:00', '2'),
      { ...press('X', 'P3', 'GONE', '05T07:00', '05T09:00', '3'), department: 'assembly' },
    ]);
    expect(plan.map((p) => p.machine)).toEqual(['1300T', 'BATT1']);
    expect(plan.every((p) => p.changes.length === 0)).toBe(true);
  });
});

describe('No of shift', () => {
  it('counts the letters, or reads the number', () => {
    expect([shiftCount('MAN'), shiftCount('M/A'), shiftCount('D'), shiftCount('3'), shiftCount('xyz'), shiftCount(null)]).toEqual([3, 2, 1, 3, null, null]);
    expect(shiftText('man')).toBe('MAN · 3 shifts');
    expect(shiftText('2')).toBe('2 shifts');
    expect(shiftText('days')).toBe('days');
  });
});

describe('Planning.csv', () => {
  const csv = [
    'JobHead_JobNum,JobHead_PartNum,Machine,JobHead_PartDescription,JobHead_ProdQty,Calculated_RemainingQty,JobHead_StartDate,JobHead_ReqDueDate,JobOper_ProdStandard,JobHead_StartHour,No of shift',
    'SFM507615,7911FR,BATT1,Encore,34,30,2026-10-05T00:00:00,2026-10-05T15:30:00,12,7.5,MAN',
    'SFM507616,7912FR,1300T,"Encore, HB",58,58,2026-10-06T00:00:00,,10,6,MA',
    ',,,,,,,,,,',
  ].join('\n');

  it('reads each press order with its machine, its run and its shifts', () => {
    const { values, errors } = parsePressPlanningCsv(csv);
    expect(errors).toEqual([]);
    expect(values).toHaveLength(2);
    const [a, b] = values;
    expect(a).toMatchObject({ department: 'moulding', remainingQty: 30, completedQty: 4, qtyPerHr: 12 });
    expect(a.startDate).toEqual(new Date(2026, 9, 5, 7, 30));
    expect(a.press).toMatchObject({ machine: 'BATT1', shifts: 'MAN', end: new Date(2026, 9, 5, 15, 30) });
    expect(a.laborHrs).toBe(8);
    // No due date: the run is the work at its rate.
    expect(b.description).toBe('Encore, HB');
    expect(b.press?.end).toBeNull();
    expect(b.laborHrs).toBeCloseTo(5.8);
  });

  it('says so, and gives nothing, when the machine column is missing', () => {
    const { values, errors } = parsePressPlanningCsv('JobHead_JobNum,JobHead_PartNum\nA,B');
    expect(values).toEqual([]);
    expect(errors[0]).toMatch(/machine/);
  });

  it('tells each order its die and colour from PMD_ProductDieColor', () => {
    const dies = parseDieColors([
      { PartNum: '7911FR', DieNumber: 123, Die: 'Encore', ActualColor: 'Black' },
      { PartNum: '7912FR', Die: 'Encore HB', ColorHex: '#334455' },
      { Title: '' },
    ]);
    const [a, b] = withDieColors(parsePressPlanningCsv(csv).values, dies);
    expect(a.press).toMatchObject({ die: '123', dieName: 'Encore', color: 'Black' });
    // No DieNumber: the die's name is the die.
    expect(b.press).toMatchObject({ die: 'Encore HB', color: '#334455' });
  });

  it('stands in for Planning1.csv’s press rows and adds the ones it lacks', () => {
    const fromPlanning1 = { ...press('SFM507615', '7911FR', 'PMD', '01T00:00', '02T00:00', null), press: undefined };
    const assembly = { ...press('018140-1-1', 'CSSL', 'x', '01T00:00', '02T00:00', null), department: 'assembly' as const, press: undefined };
    const merged = mergePressPlan([fromPlanning1, assembly], parsePressPlanningCsv(csv).values);
    expect(merged.map((j) => [String(j.id), j.press?.machine ?? null])).toEqual([
      ['SFM507615', 'BATT1'],
      ['018140-1-1', null],
      ['SFM507616', '1300T'],
    ]);
  });
});

describe('PMD on the board', () => {
  it('draws one sub-line per press with orders, changeovers between them, and no line for an idle press', async () => {
    const { computeAssemblyGantt } = await import('@/engine/assembly/board');
    const { buildIndexes } = await import('@/engine/indexes');
    const { LINES, isPressLine } = await import('@/domain/assembly');
    const jobs = [
      press('A', 'P1', 'BATT1', '05T07:00', '05T15:00', '1', 'Black'),
      press('B', 'P2', 'BATT1', '05T15:00', '05T23:00', '2', 'Black'),
      press('C', 'P3', '1300T', '05T07:00', '05T12:00', '9'),
    ];
    const dataset = {
      workCenters: LINES.map((line) => ({ id: line.id, kind: 'area' as const, name: line.name, department: 'assembly' as const, sortIndex: line.sortIndex })),
      jobs,
      routing: [],
      inventory: [],
      bom: [],
      po: [],
      demand: [],
      jobLinks: [],
      workers: [],
      fetchedAt: new Date(2026, 9, 2),
    };
    const view = computeAssemblyGantt({
      dataset,
      indexes: buildIndexes(dataset),
      containers: {},
      orderStarts: {},
      orderActualStarts: {},
      orderCrewAssignments: {},
      progress: {},
      production: {},
      workers: [],
      today: new Date(2026, 9, 2),
    });
    const pmd = view.groups.filter((g) => g.line.key === 'PMD' || isPressLine(String(g.line.key)));
    expect(pmd.map((g) => [g.line.name, g.line.parent ?? null])).toEqual([
      ['PMD', null],
      ['1300T', 'PMD'],
      ['BATT1', 'PMD'],
    ]);
    // PMD counts the presses' orders, not their changeovers.
    expect(pmd[0].benchOrders).toBe(3);
    const batt = pmd[2];
    expect(batt.rows.map((r) => r.job.press?.change?.kind ?? String(r.job.id))).toEqual(['A', 'die', 'B']);
    const b = batt.rows[2];
    expect(b.start).toEqual(at('05T19:00'));
    expect(b.status.reason).toMatch(/4\.0 h after Epicor's start/);
  });
});
