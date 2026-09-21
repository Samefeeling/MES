/**
 * One order per bench, out of the one order the export gives.
 *
 * The arithmetic the floor checks it against: UPL-SSS at 9 units splits
 * 33.1 h into 6.8 foaming, 4.5 sewing and 21.8 stapling — the sewing comes
 * *out* of the stapling order, not on top of the line.
 */

import { describe, it, expect } from 'vitest';
import { JobId, PartId, WorkCenterId } from '@/domain/ids';
import type { Job, JobMaterialLink } from '@/domain/types';
import {
  SEWING_HOURS_PER_UNIT,
  consumesFoam,
  expandStepOrders,
} from '@/engine/assembly/steps';

const job = (
  id: string,
  line: string,
  laborHrs: number,
  over: Partial<Job> = {},
): Job => ({
  id: JobId(id),
  department: 'assembly',
  partNum: PartId('CHAIR'),
  description: id,
  remainingQty: 9,
  qtyPerHr: null,
  laborHrs,
  dueDate: null,
  startDate: null,
  reqBy: null,
  released: true,
  priority: 3,
  materialPrep: 'ready',
  tool: null,
  preferredMachine: null,
  orderType: 'upholstery',
  line: WorkCenterId(line),
  completedQty: 0,
  predecessors: [],
  assignedWorkers: [],
  ...over,
});

const link = (
  jobNum: string,
  child: string,
  desc = '',
  uom = 'EA',
): JobMaterialLink => ({
  jobNum: JobId(jobNum),
  parentPart: PartId('CHAIR'),
  childPart: PartId(child),
  requiredQty: 1,
  childDescription: desc,
  uom,
});

/** id → the row, for reading an expansion back. */
const byId = (rows: Job[]) => new Map(rows.map((r) => [String(r.id), r]));

describe('what makes an order a foaming order', () => {
  it('is foam in its material rows, by part number or by description', () => {
    expect(consumesFoam('J1', [link('J1', 'FM0012')])).toBe(true);
    expect(consumesFoam('J1', [link('J1', 'X1', 'Foam: 100mm seat')])).toBe(true);
    expect(consumesFoam('J1', [link('J1', 'SB0012', 'Screw')])).toBe(false);
    // Another order's foam is another order's business.
    expect(consumesFoam('J1', [link('J2', 'FM0012')])).toBe(false);
  });
});

describe('UPL-SSS: two order numbers and a derived sewing row', () => {
  it('leaves a foaming order whole, on the foaming bench', () => {
    const rows = expandStepOrders(
      [job('FOAM1', 'UPL_SOFTIE', 6.8)],
      [link('FOAM1', 'FM0012')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].laborHrs).toBe(6.8);
    expect(String(rows[0].line)).toBe('UPL_SOFTIE_FOAM');
    expect(rows[0].step).toEqual({
      sourceJobId: JobId('FOAM1'),
      step: 'foaming',
      derived: false,
    });
  });

  it('carves the sewing out of a stapling order rather than adding to it', () => {
    const rows = byId(expandStepOrders([job('STAP1', 'UPL_SOFTIE', 26.3)], []));
    const sew = rows.get('STAP1#SEW')!;
    const staple = rows.get('STAP1')!;

    // 9 units at half an hour each.
    expect(sew.laborHrs).toBeCloseTo(4.5, 10);
    expect(staple.laborHrs).toBeCloseTo(26.3 - 4.5, 10);
    // The line's total is what it always was.
    expect(sew.laborHrs + staple.laborHrs).toBeCloseTo(26.3, 10);
  });

  it('keeps the order number on the stapling row and derives the sewing one', () => {
    const rows = byId(expandStepOrders([job('STAP1', 'UPL_SOFTIE', 26.3)], []));
    expect(rows.get('STAP1')!.step!.derived).toBe(false);
    expect(rows.get('STAP1#SEW')!.step!.derived).toBe(true);
    expect(String(rows.get('STAP1#SEW')!.step!.sourceJobId)).toBe('STAP1');
  });

  it('sequences the sewing before the stapling', () => {
    const rows = byId(expandStepOrders([job('STAP1', 'UPL_SOFTIE', 26.3)], []));
    expect(rows.get('STAP1')!.predecessors.map(String)).toEqual(['STAP1#SEW']);
    expect(rows.get('STAP1#SEW')!.predecessors).toEqual([]);
  });

  it('rates the sewing on the whole order, part-built or not', () => {
    const rows = byId(
      expandStepOrders(
        [job('STAP1', 'UPL_SOFTIE', 26.3, { completedQty: 4, remainingQty: 5 })],
        [],
      ),
    );
    // Still nine units of sewing in the order; four of them are behind it.
    expect(rows.get('STAP1#SEW')!.laborHrs).toBeCloseTo(
      SEWING_HOURS_PER_UNIT * 9,
      10,
    );
  });

  it('never gives the stapling row negative hours', () => {
    const rows = byId(expandStepOrders([job('TINY', 'UPL_SOFTIE', 1)], []));
    expect(rows.get('TINY')!.laborHrs).toBe(0);
  });
});

describe('UPL-Gluing: one order number, three even benches', () => {
  const rows = () => byId(expandStepOrders([job('GLU1', 'UPL_GLUING', 37.9)], []));

  it('splits the hours three ways', () => {
    const out = rows();
    for (const id of ['GLU1#FOAM', 'GLU1#SEW', 'GLU1']) {
      expect(out.get(id)!.laborHrs).toBeCloseTo(37.9 / 3, 10);
    }
  });

  it('puts each row on its own bench', () => {
    const out = rows();
    expect(String(out.get('GLU1#FOAM')!.line)).toBe('UPL_GLUING_FOAM');
    expect(String(out.get('GLU1#SEW')!.line)).toBe('UPL_GLUING_SEW');
    expect(String(out.get('GLU1')!.line)).toBe('UPL_GLUING_STAPLE');
  });

  it('works foaming and sewing side by side, and staples after both', () => {
    const out = rows();
    expect(out.get('GLU1#FOAM')!.predecessors).toEqual([]);
    expect(out.get('GLU1#SEW')!.predecessors).toEqual([]);
    expect(out.get('GLU1')!.predecessors.map(String).sort()).toEqual([
      'GLU1#FOAM',
      'GLU1#SEW',
    ]);
  });

  it('keeps the order number on the stapling row', () => {
    const out = rows();
    expect(out.get('GLU1')!.step!.derived).toBe(false);
    expect(out.get('GLU1#FOAM')!.step!.derived).toBe(true);
    expect(out.get('GLU1#SEW')!.step!.derived).toBe(true);
  });

  it('gives every row the order\'s own quantity', () => {
    // A bench works the whole order; a row claiming a third of the units
    // would give the bar the wrong length and the shift the wrong target.
    for (const row of rows().values()) expect(row.remainingQty).toBe(9);
  });
});

describe('everything else is left exactly as it was', () => {
  it('does not touch the other lines', () => {
    const others = [
      job('A', 'ASSY', 10),
      job('B', 'UPL_CUT_SEW', 10),
      job('C', 'TABLE', 10),
    ];
    expect(expandStepOrders(others, [])).toEqual(others);
  });

  it('does not touch a moulding order that happens to name the line', () => {
    const press = [job('M1', 'UPL_GLUING', 10, { department: 'moulding' })];
    expect(expandStepOrders(press, [])).toEqual(press);
  });
});
