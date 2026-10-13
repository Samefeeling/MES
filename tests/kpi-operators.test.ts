import { describe, expect, it } from 'vitest';

import { DEFAULT_KPI_THRESHOLDS } from '../src/core/kpi-thresholds';
import {
  applyMachineFilter,
  nextMachinePick,
  renderOperatorSection,
  type OperatorView,
} from '../src/ui/kpi-operators';
import { rec } from './helpers';
import type { ProductionRecord, StatusCode } from '../src/types';

/** One (machine, shift, order): slot 0 carries the operator and counters. */
const order = (machineCode: string, operator: string, codes: string, good: number): ProductionRecord[] =>
  [...codes].map((c, i) =>
    rec({
      machineCode,
      jobNumber: `J-${machineCode}`,
      shiftId: '2026-10-12-Day',
      slotIndex: i,
      statusCode: c as StatusCode,
      ...(i === 0 ? { operator, countStart: 0, countEnd: good } : {}),
    }),
  );

const view = (records: ProductionRecord[], machines: string[] = []): OperatorView => {
  const v: OperatorView = {
    records,
    stopsOn: () => true,
    machines: new Set(machines),
    perf: [],
    weekly: false,
    machineOrder: ['1600T', '1300T', '320T'],
    thresholds: DEFAULT_KPI_THRESHOLDS,
    pick: '',
    open: new Set(),
    total: null,
  };
  applyMachineFilter(v);
  return v;
};

const floor = [
  ...order('1600T', 'Ann', 'RRRR', 100),
  ...order('1300T', 'Ann', 'RRDDDDDDDDDD', 40), // a 5 h die change, over its 4 h
  ...order('320T', 'Bob', 'RRRR', 70),
];

describe('operator section machine pick', () => {
  it('from All, a machine narrows to it; then chips add and take away', () => {
    const present = ['1600T', '1300T', '320T'];
    let pick = nextMachinePick(new Set(), '1300T', present);
    expect([...pick]).toEqual(['1300T']);
    pick = nextMachinePick(pick, '320T', present);
    expect([...pick]).toEqual(['1300T', '320T']);
    pick = nextMachinePick(pick, '1300T', present);
    expect([...pick]).toEqual(['320T']);
    expect(nextMachinePick(pick, '320T', present).size).toBe(0); // last one off → All
    expect(nextMachinePick(new Set(['1600T', '1300T']), '320T', present).size).toBe(0); // every one → All
    expect(nextMachinePick(new Set(['1600T']), '', present).size).toBe(0);
  });

  it('counts only the picked machines: output, machines, stoppages and TOTAL', () => {
    const all = view(floor);
    expect(all.total?.output).toBe(210);
    expect(all.perf.find((p) => p.operator === 'Ann')!.machines.sort()).toEqual(['1300T', '1600T']);

    const v = view(floor, ['1600T', '320T']);
    expect(v.total?.output).toBe(170);
    const ann = v.perf.find((p) => p.operator === 'Ann')!;
    expect(ann.machines).toEqual(['1600T']);
    expect(ann.kpi.output).toBe(100);
    expect(ann.tally.die.flagged).toBe(0); // the 1300T die change is out of the pick

    const only1300 = view(floor, ['1300T']);
    expect(only1300.perf.map((p) => p.operator)).toEqual(['Ann']);
    expect(only1300.perf[0].tally.die.flagged).toBe(1);
  });

  it('a picked machine with no work in the new window drops out of the pick', () => {
    const v = view(floor, ['1300T', '550T']);
    expect([...v.machines]).toEqual(['1300T']);
    v.records = order('1600T', 'Ann', 'RR', 10);
    applyMachineFilter(v);
    expect(v.machines.size).toBe(0);
    expect(v.total?.output).toBe(10);
  });

  it('draws the chips and says Machine, not Press', () => {
    const html = renderOperatorSection(view(floor, ['1300T']));
    expect(html).toContain('data-op-machine="1300T" aria-pressed="true"');
    expect(html).toContain('data-op-machine="" aria-pressed="false"');
    expect(html).toContain('1 of 3 machines');
    expect(html).toContain('Operator output by machine');
    expect(html).toContain('<th>Machines</th>');
    expect(html).not.toMatch(/\bPress(es)?\b/);
  });

  it('puts each table under its chart: output on the left, stoppages on the right', () => {
    const html = renderOperatorSection(view(floor));
    const at = (s: string) => html.indexOf(s);
    expect(at('class="kpi-ops-grid"')).toBeGreaterThan(-1);
    expect(at('Operator output by machine')).toBeLessThan(at('Operator output &amp; yield'));
    expect(at('Operator output &amp; yield')).toBeLessThan(at('Stoppages over the limit'));
    expect(at('Stoppages over the limit')).toBeLessThan(at('Operator setups, startups'));
    // The stoppage table leaves Shifts to the output table beside it.
    const limits = html.slice(at('kpi-ops-limits'));
    expect(limits).not.toContain('>Shifts<');
  });

  it('every machine is in the cell, with a "+n" for each width step', () => {
    const recs = ['1600T', '1300T', '320T', '550T'].flatMap((mc) => order(mc, 'Ann', 'RR', 10));
    const html = renderOperatorSection({ ...view(recs), machineOrder: ['1600T', '1300T', '320T', '550T'] });
    const cell = html.slice(html.indexOf('kpi-ops-mcs'), html.indexOf('</div>', html.indexOf('kpi-ops-mcs')));
    expect(cell.match(/class="kpi-ops-press"/g)).toHaveLength(4);
    expect(cell).toContain('data-k="3"><i');
    expect(cell).toContain('<span class="kpi-ops-more" data-k="2">+2</span>');
    expect(cell).toContain('<span class="kpi-ops-more" data-k="3">+1</span>');
    expect(cell).not.toContain('data-k="4">+');
  });

  it('no chips with one machine in the window, nothing at all with none', () => {
    expect(renderOperatorSection(view(order('1600T', 'Ann', 'RR', 5)))).not.toContain('data-op-machine');
    expect(renderOperatorSection(view([]))).toBe('');
  });
});
