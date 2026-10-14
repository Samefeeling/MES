/**
 * From the job's side: when its order is planned to leave (the waybill's Ship
 * By), whether the job is off the line by then, and whether it is the one line
 * the order is waiting for.
 */

import { describe, expect, it } from 'vitest';
import type { WaybillLine } from '@/domain/dispatch';
import type { BuildJob, OrderBuild } from '@/engine/dispatch/assemblyLink';
import type { LineSupply } from '@/engine/dispatch/lineSupply';
import { shipByJob } from '@/engine/dispatch/shipBy';

const line = (ln: string, patch: Partial<WaybillLine> = {}): WaybillLine => ({
  order: '18532',
  line: ln,
  rel: '1',
  custId: 'C',
  shipVia: 'ANMS',
  zone: 'NSW-Metro-South',
  city: 'Dalmeny',
  part: `P${ln}`,
  requestedQty: 0,
  shippedQty: 0,
  leftToShip: 4,
  allocatedQty: 0,
  uom: 'EA',
  expDelivery: '2026-10-28',
  shipBy: '2026-10-21',
  needBy: '2026-10-28',
  releaseValue: 0,
  fulfillment: 'Stock',
  status: '',
  inPicking: false,
  onHold: false,
  creditHold: false,
  pickListComment: '',
  shipToName: '',
  address: '',
  state: '',
  postcode: '',
  ...patch,
});

const job = (patch: Partial<BuildJob> = {}): BuildJob => ({
  jobId: '018532-5-1',
  orderLine: '5',
  rel: '1',
  lineName: 'UPL-Gluing › Sewing',
  partNum: 'P5',
  description: 'Lounge',
  remainingQty: 4,
  start: null,
  expect: new Date(2026, 9, 22, 14),
  due: null,
  state: 'dated',
  ...patch,
});

const builds = (j: BuildJob): Map<string, OrderBuild> => new Map([['18532', { order: '18532', jobs: [j] }]]);

const supplied = (readyBy: string | null): Map<string, LineSupply[]> =>
  new Map([
    [
      '18532',
      [{ order: '18532', line: '7', rel: '1', part: 'P7', fulfillment: 'BTO', shortQty: 4, pieces: [], uncoveredQty: 0, readyBy }],
    ],
  ]);

const lines = [
  line('5', { fulfillment: 'Job' }),
  line('6', { allocatedQty: 4, status: 'Ready' }),
  line('7', { fulfillment: 'BTO' }),
  line('9', { fulfillment: 'Other', part: 'FRTNSW', uom: 'CBM' }),
];
const today = '2026-10-14';

describe('shipByJob', () => {
  it('reads the job against its line’s Ship By, and names it the line the order waits on', () => {
    const info = shipByJob(lines, builds(job()), supplied('2026-10-20'), today).get('018532-5-1')!;
    expect(info).toMatchObject({
      order: '18532',
      line: '5',
      shipBy: '2026-10-21',
      needBy: '2026-10-28',
      expect: '2026-10-22',
      verdict: 'late',
      others: 2,
      othersByShip: 2,
      othersLatest: '2026-10-20',
      othersUnknown: 0,
      holds: true,
    });
  });

  it('does not hold the order when another line is in later', () => {
    const info = shipByJob(lines, builds(job()), supplied('2026-10-25'), today).get('018532-5-1')!;
    expect(info).toMatchObject({ holds: false, othersByShip: 1, othersLatest: '2026-10-25' });
  });

  it('cannot say it holds the order while another line has no date', () => {
    expect(shipByJob(lines, builds(job()), supplied(null), today).get('018532-5-1')).toMatchObject({
      holds: false,
      othersUnknown: 1,
    });
  });

  it('is on time, tight, undated or done against Ship By', () => {
    const at = (j: BuildJob) => shipByJob(lines, builds(j), supplied('2026-10-20'), today).get('018532-5-1')!.verdict;
    expect(at(job({ expect: new Date(2026, 9, 20) }))).toBe('ok');
    expect(at(job({ expect: new Date(2026, 9, 21, 15) }))).toBe('same-day');
    expect(at(job({ expect: null, state: 'no-crew' }))).toBe('unknown');
    expect(at(job({ state: 'done' }))).toBe('done');
  });

  it('says nothing of a job whose line is not on the waybill, or has no Ship By', () => {
    expect(shipByJob(lines, builds(job({ jobId: '018532-8-1', orderLine: '8' })), new Map(), today).size).toBe(0);
    expect(shipByJob([line('5', { fulfillment: 'Job', shipBy: null })], builds(job()), new Map(), today).size).toBe(0);
  });
});
