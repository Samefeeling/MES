import { describe, expect, it } from 'vitest';
import { exportDate, parsePoDetailCsv } from '@/data/csv/poDetail.parser';
import { poAvailableDate } from '@/domain/types';
import { incomingSupply } from '@/engine/assembly/pickShortage';

// The sample as the planner pasted it — tab-separated, day-first dates.
const SAMPLE = [
  'PODetail_PartNum\tPODetail_LineDesc\tPORel_DueDate\tCalculated_OutstandingQty\tPORel_PONum\tVendor_Name\tPORel_PromiseDt\tPurAgent_Name\tContainerDetail_ContainerID\tRowIdent',
  '0765-CHARCO\tFrame Snc Auditto 4S Charcoal\t28/10/2026\t50\t504867\tWAILEEPO (CHINA) LIMITED\t30/09/2026\tRaw Materials Import\t\t0000000b-0000-0000-0000-000000000000',
  '0765-CHARCO\tFrame Snc Auditto 4S Charcoal\t13/11/2026\t50\t504950\tWAILEEPO (CHINA) LIMITED\t16/10/2026\tRaw Materials Import\t\t0000000c-0000-0000-0000-000000000000',
  '0881-BLACK\tSliding Bracket Assy Flatfold Tbl Black\t28/10/2026\t450\t504867\tWAILEEPO (CHINA) LIMITED\t30/09/2026\tRaw Materials Import\t\t0000000d-0000-0000-0000-000000000000',
  '0881-BLACK\tSliding Bracket Assy Flatfold Tbl Black\t30/10/2026\t250\t504878\tWAILEEPO (CHINA) LIMITED\t2/10/2026\tRaw Materials Import\t\t0000000e-0000-0000-0000-000000000000',
].join('\n');

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('PODetail.csv', () => {
  it('reads the sample: one release per row, dates day first', () => {
    const { values, errors } = parsePoDetailCsv(SAMPLE);
    expect(errors).toEqual([]);
    expect(values.map((p) => [String(p.partNum), p.poNum, p.outstandingQty, p.vendor])).toEqual([
      ['0765-CHARCO', '504867', 50, 'WAILEEPO (CHINA) LIMITED'],
      ['0765-CHARCO', '504950', 50, 'WAILEEPO (CHINA) LIMITED'],
      ['0881-BLACK', '504867', 450, 'WAILEEPO (CHINA) LIMITED'],
      ['0881-BLACK', '504878', 250, 'WAILEEPO (CHINA) LIMITED'],
    ]);
    // 2/10/2026 is the 2nd of October, not the 10th of February.
    expect(values[3].promiseDate).toEqual(day(2026, 10, 2));
    expect(values[3].dueDate).toEqual(day(2026, 10, 30));
  });

  it('reads the same export comma-separated, quoted and with ISO dates', () => {
    const csv = [
      'PODetail_PartNum,PORel_DueDate,Calculated_OutstandingQty,PORel_PONum,PORel_PromiseDt',
      '"0765-CHARCO","2026-10-28T00:00:00","1,050","504867","2026-11-02T00:00:00"',
      '"0765-CHARCO","2026-10-28","0","504868",""',
    ].join('\r\n');
    const { values, errors } = parsePoDetailCsv(csv);
    expect(errors).toEqual([]);
    // A fully received release is nothing coming, and is left out.
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ outstandingQty: 1050, dueDate: day(2026, 10, 28), promiseDate: day(2026, 11, 2) });
  });

  it('counts on a release at the later of its due and promise dates', () => {
    expect(poAvailableDate({ dueDate: day(2026, 10, 28), promiseDate: day(2026, 9, 30) })).toEqual(day(2026, 10, 28));
    expect(poAvailableDate({ dueDate: day(2026, 10, 28), promiseDate: day(2026, 11, 5) })).toEqual(day(2026, 11, 5));
    expect(poAvailableDate({ dueDate: null, promiseDate: day(2026, 11, 5) })).toEqual(day(2026, 11, 5));
    expect(poAvailableDate({ dueDate: null, promiseDate: null })).toBeNull();
  });

  it('refuses a date that does not exist, and says which row', () => {
    expect(exportDate('31/02/2026')).toBeNull();
    const { values, errors } = parsePoDetailCsv(
      'PODetail_PartNum,PORel_DueDate,Calculated_OutstandingQty\nX,31/02/2026,5\nY,1/3/2026,abc',
    );
    expect(values).toHaveLength(1);
    expect(errors).toEqual([
      'PODetail.csv row 2: unreadable PORel_DueDate "31/02/2026"',
      'PODetail.csv row 3: invalid Calculated_OutstandingQty',
    ]);
  });
});

describe('what is on order against a short pick line', () => {
  const pos = parsePoDetailCsv(SAMPLE).values.filter((p) => String(p.partNum) === '0881-BLACK');

  it('dates a shortfall by the release that, with those before it, covers it', () => {
    expect(incomingSupply(pos, 400)).toMatchObject({ qty: 700, availableDate: day(2026, 10, 28), coversShort: true });
    expect(incomingSupply(pos, 600)).toMatchObject({ qty: 700, availableDate: day(2026, 10, 30), coversShort: true });
  });

  it('says so when everything on order is still not enough', () => {
    expect(incomingSupply(pos, 900)).toMatchObject({ qty: 700, availableDate: day(2026, 10, 30), coversShort: false });
  });

  it('shows the next arrival on a line that is not short, and nothing with no PO', () => {
    expect(incomingSupply(pos, 0)?.availableDate).toEqual(day(2026, 10, 28));
    expect(incomingSupply([], 10)).toBeNull();
  });
});
