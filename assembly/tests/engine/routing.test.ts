/**
 * The route each order takes, and where on it the board puts the order.
 *
 * The arithmetic the floor checks it against: UPL-SSS at 9 units splits its
 * 26.3 h into 4.5 sewing and 21.8 stapling — the sewing comes *out* of the
 * order, not on top of the line — and the order is at exactly one of the two
 * at a time. Gluing splits three ways and works the first two together.
 */

import { describe, it, expect } from 'vitest';
import { JobId, PartId, WorkCenterId } from '@/domain/ids';
import type { Job, JobMaterialLink } from '@/domain/types';
import {
  SEWING_HOURS_PER_UNIT,
  consumesFoam,
  expandRouting,
  routingOf,
  type OperationProgress,
} from '@/engine/assembly/routing';
import { jobNumOf, opRowId, tailHoursOf, workableOps } from '@/domain/routing';

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

/** Nothing booked anywhere. */
const fresh: OperationProgress = { done: () => 0, closed: () => false };

/** Everything confirmed at these rows. */
const confirmed = (...rows: string[]): OperationProgress => ({
  done: (id) => (rows.includes(id) ? 1e6 : 0),
  closed: () => false,
});

describe('routingOf', () => {
  it('gives an order off the benched lines no route at all', () => {
    expect(routingOf(job('A1', 'ASSY', 10), [])).toBeNull();
    expect(routingOf(job('A2', 'TBP', 10), [])).toBeNull();
    expect(routingOf(job('A3', 'UPL_CUT_SEW', 10), [])).toBeNull();
  });

  it('reads a foaming order off its foam component', () => {
    const links = [link('F1', 'FMV1234', 'Foam block', 'EA')];
    expect(consumesFoam('F1', links)).toBe(true);
    const ops = routingOf(job('F1', 'UPL_SOFTIE', 6.8), links)!;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ seq: 10, step: 'foaming', stdHours: 6.8 });
  });

  it('sews then staples every other UPL-SSS order, and splits the hours', () => {
    const ops = routingOf(job('S1', 'UPL_SOFTIE', 26.3), [])!;
    const sewing = SEWING_HOURS_PER_UNIT * 9;
    expect(ops.map((op) => op.step)).toEqual(['sewing', 'stapling']);
    expect(ops[0].stdHours).toBeCloseTo(sewing, 6);
    expect(ops[1].stdHours).toBeCloseTo(26.3 - sewing, 6);
    // The split divides the order's hours; it never adds to them.
    expect(ops[0].stdHours + ops[1].stdHours).toBeCloseTo(26.3, 6);
    expect(ops[1].after).toEqual([10]);
  });

  it('never lets the sewing rate eat more than the order carries', () => {
    const ops = routingOf(job('S2', 'UPL_SOFTIE', 2, { remainingQty: 100 }), [])!;
    expect(ops[0].stdHours).toBeCloseTo(2, 6);
    expect(ops[1].stdHours).toBeCloseTo(0, 6);
  });

  it('splits Gluing three ways and starts the first two together', () => {
    const ops = routingOf(job('G1', 'UPL_GLUING', 37.9), [])!;
    expect(ops.map((op) => op.step)).toEqual(['foaming', 'sewing', 'stapling']);
    for (const op of ops) expect(op.stdHours).toBeCloseTo(37.9 / 3, 6);
    expect(ops[0].after).toEqual([]);
    expect(ops[1].after).toEqual([]);
    expect(ops[2].after).toEqual([10, 20]);
  });
});

describe('the route itself', () => {
  it('counts each operation into exactly one tail', () => {
    const ops = routingOf(job('G1', 'UPL_GLUING', 30), [])!;
    // Foaming waits on nobody and is nobody's tail-mate: sewing runs beside it.
    expect(tailHoursOf(ops, 10)).toBeCloseTo(10, 6);
    expect(tailHoursOf(ops, 20)).toBeCloseTo(10, 6);
    expect(tailHoursOf(ops, 30)).toBeCloseTo(0, 6);
  });

  it('offers both parallel operations at once, and stapling only after both', () => {
    const ops = routingOf(job('G1', 'UPL_GLUING', 30), [])!;
    expect(workableOps(ops, new Set()).map((op) => op.seq)).toEqual([10, 20]);
    expect(workableOps(ops, new Set([10])).map((op) => op.seq)).toEqual([20]);
    expect(workableOps(ops, new Set([10, 20])).map((op) => op.seq)).toEqual([30]);
  });

  it('reads the order number back off a row key', () => {
    expect(String(opRowId('ASM8001', 20))).toBe('ASM8001#20');
    expect(jobNumOf('ASM8001#20')).toBe('ASM8001');
    // An order with no route is its own row.
    expect(jobNumOf('ASM8001')).toBe('ASM8001');
  });
});

describe('expandRouting', () => {
  it('leaves orders off the benched lines exactly as they are', () => {
    const plain = job('A1', 'ASSY', 10);
    expect(expandRouting([plain], [], fresh)).toEqual([plain]);
  });

  it('puts a new UPL-SSS order on the sewing bench and nowhere else', () => {
    const rows = expandRouting([job('S1', 'UPL_SOFTIE', 26.3)], [], fresh);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe('S1#10');
    expect(rows[0].operation).toMatchObject({
      step: 'sewing',
      index: 1,
      of: 2,
      last: false,
    });
    expect(String(rows[0].line)).toBe('UPL_SOFTIE_SEW');
    expect(rows[0].laborHrs).toBeCloseTo(4.5, 6);
  });

  it('moves the order to stapling once the sewing is confirmed', () => {
    const rows = expandRouting(
      [job('S1', 'UPL_SOFTIE', 26.3)],
      [],
      confirmed('S1#10'),
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe('S1#20');
    expect(String(rows[0].line)).toBe('UPL_SOFTIE_STAPLE');
    expect(rows[0].laborHrs).toBeCloseTo(21.8, 6);
    expect(rows[0].operation).toMatchObject({ last: true, tailHours: 0 });
  });

  it('treats a closed operation as finished however little was counted', () => {
    const rows = expandRouting([job('S1', 'UPL_SOFTIE', 26.3)], [], {
      done: () => 0,
      closed: (id) => id === 'S1#10',
    });
    expect(String(rows[0].id)).toBe('S1#20');
  });

  it('carries the whole order in front of an operation that does not receive', () => {
    const [sew] = expandRouting(
      [job('S1', 'UPL_SOFTIE', 26.3, { remainingQty: 4, completedQty: 5 })],
      [],
      fresh,
    );
    // Epicor's 5 completed are 5 received, which says nothing about sewing.
    expect(sew.remainingQty).toBe(9);
    expect(sew.completedQty).toBe(0);
  });

  it('keeps the ERP figures on the operation that does receive', () => {
    const [staple] = expandRouting(
      [job('S1', 'UPL_SOFTIE', 26.3, { remainingQty: 4, completedQty: 5 })],
      [],
      confirmed('S1#10'),
    );
    expect(staple.remainingQty).toBe(4);
    expect(staple.completedQty).toBe(5);
  });

  it('shows a Gluing order on two benches at once, then on the third', () => {
    const fresh2 = expandRouting([job('G1', 'UPL_GLUING', 30)], [], fresh);
    expect(fresh2.map((row) => String(row.line))).toEqual([
      'UPL_GLUING_FOAM',
      'UPL_GLUING_SEW',
    ]);
    // Two rows, one order number — the number is on both, the key is not.
    expect(new Set(fresh2.map((r) => String(r.operation!.jobNum)))).toEqual(
      new Set(['G1']),
    );
    const half = expandRouting([job('G1', 'UPL_GLUING', 30)], [], confirmed('G1#10'));
    expect(half.map((row) => String(row.line))).toEqual(['UPL_GLUING_SEW']);
    const both = expandRouting(
      [job('G1', 'UPL_GLUING', 30)],
      [],
      confirmed('G1#10', 'G1#20'),
    );
    expect(both.map((row) => String(row.line))).toEqual(['UPL_GLUING_STAPLE']);
  });

  it('never shows one order on more benches than are working it', () => {
    const rows = expandRouting(
      [job('S1', 'UPL_SOFTIE', 26.3), job('G1', 'UPL_GLUING', 30)],
      [],
      fresh,
    );
    // One for the softie, two for the parallel pair on Gluing. Not five.
    expect(rows).toHaveLength(3);
  });

  it('holds a finished order on its last bench rather than dropping it', () => {
    const rows = expandRouting(
      [job('S1', 'UPL_SOFTIE', 26.3, { remainingQty: 0, completedQty: 9 })],
      [],
      confirmed('S1#10'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toMatchObject({ seq: 20, last: true });
  });

  it('gives a foaming order one operation and receives on it', () => {
    const rows = expandRouting(
      [job('F1', 'UPL_SOFTIE', 6.8)],
      [link('F1', 'FMV1234', 'Foam block')],
      fresh,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toMatchObject({ step: 'foaming', of: 1, last: true });
    expect(rows[0].laborHrs).toBeCloseTo(6.8, 6);
  });

  it('adds up to the line total it always had', () => {
    const rows = expandRouting(
      [job('F1', 'UPL_SOFTIE', 6.8), job('S1', 'UPL_SOFTIE', 26.3)],
      [link('F1', 'FMV1234', 'Foam block')],
      fresh,
    );
    const onTheBenches = rows.reduce((sum, row) => sum + row.laborHrs, 0);
    const onTheirWay = rows.reduce(
      (sum, row) => sum + (row.operation?.tailHours ?? 0),
      0,
    );
    expect(onTheBenches + onTheirWay).toBeCloseTo(33.1, 6);
  });
});
