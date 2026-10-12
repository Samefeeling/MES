import { describe, expect, it } from 'vitest';
import {
  PRESS_CODES,
  bucketDone,
  bucketEnd,
  buildMachineRows,
  doneOrders,
  dueLevel,
  isBreakdown,
  openWork,
  pressCodeOf,
  reliability,
  unitFor,
} from '../src/core/maint';
import { parseMachinePmCsv, parseMangoMachineWorkOrdersCsv, parseMangoWorkOrdersCsv } from '../src/dal/sharepoint';
import { resolveMachinePmCsvPath } from '../src/dal';
import type { DieMaintenanceRequest, MachinePmEvent } from '../src/types';

const wo = (over: Partial<DieMaintenanceRequest>): DieMaintenanceRequest => ({
  id: 1,
  dieNumber: '',
  asset: 'AU - 1600T Toshiba Injection Molding Machine',
  status: 'done',
  maintType: 'repair',
  maintTypeRaw: '2. Breakdown',
  priority: 'normal',
  description: 'x',
  contact: 'Wisam Istefo',
  requestedBy: '',
  machineCode: '',
  jobNumber: '',
  mangoTicket: 'MWO 1',
  createdAt: '2026-09-01',
  closedAt: '2026-09-02',
  branch: 'Resero - Minto',
  ...over,
});

const pm = (over: Partial<MachinePmEvent>): MachinePmEvent => ({
  asset: 'AU - 125T Superjack Injection Moulding Machine',
  assetNumber: '',
  description: '',
  department: 'PMD - AU',
  branch: 'Resero - Minto',
  eventType: 'PM',
  owner: 'Aryan Apte',
  frequency: '1 months',
  startDate: '',
  dueDate: '2026-10-20',
  detail: 'Monthly maintenance',
  superseded: false,
  ...over,
});

const today = '2026-10-11';

describe('MachinePM.csv', () => {
  const header =
    'Name,Asset Number,Serial/Model Number,Description,Supplier,Region,Branch,Department,Owner of work,Event Frequency,Event Frequency Number,Event Start Date,Event Due Date,Event Detail,Event Email Text,Superseded';
  it('reads the equipment and its PM events by column name', () => {
    const rows = parseMachinePmCsv(
      [
        header,
        'AU - 125T Superjack HD-87,RCS123,,Superjack 125T,,Minto (AU),Resero - Minto,PMD - AU,Aryan Apte,months,3,1/07/2026,1/10/2026,Check heater bands,,FALSE',
        'AU - 125T Superjack HD-87,RCS123,,Superjack 125T,,Minto (AU),Resero - Minto,PMD - AU,Aryan Apte,months,3,1/04/2026,1/07/2026,Check heater bands,,TRUE',
        'AU - 3D Scanner,,,Scanner,,Minto (AU),Resero - Minto,Design - AU,,,,,,,,FALSE',
      ].join('\n'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      asset: 'AU - 125T Superjack HD-87',
      assetNumber: 'RCS123',
      owner: 'Aryan Apte',
      frequency: '3 months',
      startDate: '2026-07-01',
      dueDate: '2026-10-01',
      detail: 'Check heater bands',
      superseded: false,
    });
    expect(rows[1].superseded).toBe(true);
    expect(rows[2]).toMatchObject({ asset: 'AU - 3D Scanner', detail: '', dueDate: '' });
  });

  it('is found beside the Planning CSV unless set on its own', () => {
    expect(resolveMachinePmCsvPath({ VITE_PLANNING_CSV_PATH: '/sites/x/Shared Documents/PMD/Planning.csv' })).toBe(
      '/sites/x/Shared Documents/PMD/MachinePM.csv',
    );
    expect(resolveMachinePmCsvPath({ VITE_MACHINE_PM_CSV_PATH: '/a/b.csv', VITE_PLANNING_CSV_PATH: '/x/P.csv' })).toBe('/a/b.csv');
  });

  it('keeps the work order type and branch from the Mango report', () => {
    const header2 =
      'Number,Downtime,Labour Hours,Current Stage,Plant/Equipment,Brief Description,Employee,Created Date,Branch,To be completed by,Type of Maintenance,Assign to Action';
    const [r] = parseMangoMachineWorkOrdersCsv(
      [header2, 'MWO 02795,10,0.25,Stage 4 Closed,AU - 1300T LS Mtron Injection Molding Machine,Motor lock alarm,Joe,30/09/2026,Resero - Minto,,2. Breakdown,Wisam Istefo'].join('\n'),
    );
    expect(r).toMatchObject({ maintTypeRaw: '2. Breakdown', branch: 'Resero - Minto', downtime: '10', labourHours: '0.25' });
  });
});

describe('the Mango export as it comes out of Mango (sample of 12/10/2026)', () => {
  // The full column layout of MangoWorkOrders.csv, in order.
  const COLS = [
    'Number', 'Downtime', 'Labour Hours', 'Current Stage', 'Plant/Equipment', 'Brief Description', 'Employee',
    'Created Date', 'Branch', 'To be completed by', 'Type of Maintenance', 'Identified By', 'Date identified', 'Time',
    'AM/PM', 'Work shift', 'Describe the issue', 'Actions taken', 'Region', 'Department', 'Assign to Action',
    'Work can be done to', 'Summary of work completed', 'Cost (parts, labour)', 'Corrective action taken',
    'Preventative action taken', 'Summary',
  ];
  const q = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (r: Record<string, string>): string => COLS.map((c) => q(r[c] ?? '')).join(',');
  const csv = [
    COLS.map(q).join(','),
    line({
      Number: 'MWO 02801', 'Current Stage': 'Stage 1 Coordinator Assessing',
      'Plant/Equipment': 'AU - 1600T Toshiba Injection Molding Machine', 'Brief Description': 'Nozzle leak, material stuck',
      Employee: 'Joe Talamaivao', 'Created Date': '11/10/2026', Branch: 'Resero - Minto', 'Type of Maintenance': '2. Breakdown',
      'Date identified': '10/10/2026', Time: '11', 'AM/PM': 'PM', 'Work shift': 'Night', 'Describe the issue': 'nozzle leak',
      'Actions taken': 'Sun, 11/10/2026, Joe Talamaivao (): Created', Region: 'Minto (AU)', Department: 'Manufacturing - AU',
    }),
    line({
      Number: 'MWO 02800', 'Current Stage': 'Stage 1 Coordinator Assessing',
      'Plant/Equipment': 'AU Die 326 Formware Oval End Cal AXMS5-291', 'Brief Description': 'New tool inspection for trial',
      'Created Date': '8/10/2026', Branch: 'Resero - Minto', 'Type of Maintenance': '5. Employee Suggestion',
    }),
    line({
      Number: 'MWO 02799', Downtime: '1', 'Labour Hours': '1', 'Current Stage': 'Stage 4 Closed',
      'Plant/Equipment': 'AU - 1600T Toshiba Injection Molding Machine', 'Brief Description': 'robot light curtain not working',
      'Created Date': '7/10/2026', Branch: 'Resero - Minto', 'To be completed by': '9/10/2026',
      'Type of Maintenance': '2. Breakdown',
      'Actions taken': 'Wed, 07/10/2026, Tin Maung (): Created\nThu, 08/10/2026, Wisam Istefo (Stage 2 Being Investigated): Power restored',
      // Region is the raiser's, not the plant's: Minto orders say ACT or NSW.
      Region: 'Australian Capital Territory (AU)', 'Assign to Action': 'Wisam Istefo',
      'Summary of work completed': 'Restore Power to the light curtain transmitter.',
      'Corrective action taken': 'Restore power.', 'Preventative action taken': 'N/A',
    }),
    line({
      Number: 'MWO 02797', 'Current Stage': 'Stage 1 Coordinator Assessing', 'Plant/Equipment': 'NZ - General Warehouse',
      'Brief Description': 'Mobile stairs', 'Created Date': '6/10/2026', Branch: 'Resero - Hastings',
      'Type of Maintenance': '4. Safety-related Maintenance',
    }),
    line({
      Number: 'MWO 02796', 'Current Stage': 'Stage 4 Closed', 'Plant/Equipment': 'NZ - Office Lighting',
      'Brief Description': 'Faulty light', 'Created Date': '1/10/2026', Branch: 'Resero - Hastings',
      'To be completed by': '2/10/2026', 'Type of Maintenance': '2. Breakdown', 'Describe the issue': 'Faulty light.',
      'Actions taken': 'Thu, 01/10/2026, Kim Ross (): Created\nFri, 02/10/2026, Chris Buckley (Stage 1 Coordinator Assessing): Starter ordered, fit by 20/10/2026',
      'Assign to Action': 'Chris Buckley',
      // Hastings closes with these two and leaves the work summary empty.
      'Corrective action taken': 'Light replaced', 'Preventative action taken': 'New starter installed.',
    }),
    line({
      Number: 'MWO 02802', 'Current Stage': 'Stage 3 Awaiting Parts', 'Plant/Equipment': 'AU - Encore Cold Saw',
      'Brief Description': 'Blade guard', 'Created Date': '5/10/2026', Branch: 'Resero - Minto',
      'To be completed by': '20/10/2026', 'Type of Maintenance': '4. Safety-related Maintenance', 'Assign to Action': 'Wisam Istefo',
    }),
  ].join('\r\n');

  const machine = parseMangoMachineWorkOrdersCsv(csv);
  const byTicket = (t: string): DieMaintenanceRequest => machine.find((r) => r.mangoTicket === t)!;

  it('sends a die to the Tool page and every other asset to the Machine side, whatever the branch', () => {
    expect(machine.map((r) => r.mangoTicket).sort()).toEqual(['MWO 02796', 'MWO 02797', 'MWO 02799', 'MWO 02801', 'MWO 02802']);
    expect(parseMangoWorkOrdersCsv(csv).map((r) => [r.mangoTicket, r.dieNumber])).toEqual([['MWO 02800', '326']]);
    expect(byTicket('MWO 02799').branch).toBe('Resero - Minto');
    expect(byTicket('MWO 02797').branch).toBe('Resero - Hastings');
    expect(pressCodeOf(byTicket('MWO 02799').asset ?? '')).toBe('1600T');
  });

  it('reads the stage, type, owner and day-first dates', () => {
    expect(byTicket('MWO 02801')).toMatchObject({ status: 'open', contact: '', createdAt: '2026-10-11', closedAt: '' });
    expect(byTicket('MWO 02802').status).toBe('in-progress'); // any Stage 2 or 3
    expect(byTicket('MWO 02799')).toMatchObject({ status: 'done', contact: 'Wisam Istefo', dueDate: '2026-10-09', downtime: '1' });
    expect(machine.filter(isBreakdown).map((r) => r.mangoTicket).sort()).toEqual(['MWO 02796', 'MWO 02799', 'MWO 02801']);
  });

  it('dates a closed order by the last entry of its actions log, not a date typed in a note', () => {
    expect(byTicket('MWO 02799').closedAt).toBe('2026-10-08');
    expect(byTicket('MWO 02796').closedAt).toBe('2026-10-02'); // not the 20/10 in the note
  });

  it('says what was done from whichever columns the site fills, and which orders booked hours', () => {
    const done = doneOrders(machine);
    expect(done.find((d) => d.ticket === 'MWO 02799')).toMatchObject({
      summary: 'Restore Power to the light curtain transmitter.',
      prevention: '', // N/A
      hours: 1,
      booked: true,
    });
    expect(done.find((d) => d.ticket === 'MWO 02796')).toMatchObject({
      detail: '', // "Faulty light." says no more than "Faulty light"
      summary: 'Light replaced',
      prevention: 'New starter installed.',
      hours: 0,
      booked: false,
    });
  });

  it('puts the longest-waiting undated request first among the undated', () => {
    const undated = openWork(machine, [], '2026-10-12').filter((o) => o.level === 'none');
    expect(undated.map((o) => [o.ticket, o.raised])).toEqual([
      ['MWO 02797', '2026-10-06'],
      ['MWO 02801', '2026-10-11'],
    ]);
  });
});

describe('which press an equipment name is', () => {
  it('knows the nine presses, under either spelling of moulding', () => {
    expect(PRESS_CODES).toHaveLength(9);
    expect(PRESS_CODES.slice(0, 3)).toEqual(['125T', '150T', '320T']);
    expect(PRESS_CODES.slice(-2)).toEqual(['Batt1', 'Batt2']);
    expect(pressCodeOf('AU - 1600T Toshiba Injection Molding Machine')).toBe('1600T');
    expect(pressCodeOf('AU - 125T Superjack Injection Moulding Machine')).toBe('125T');
    expect(pressCodeOf('AU - Batt-2 BattenFeld Injection Moulding Machine')).toBe('Batt2');
  });

  it('does not take a robot or a saw for a press', () => {
    expect(pressCodeOf('AU - 125T Robot')).toBe('');
    expect(pressCodeOf('AU - Encore Cold Saw')).toBe('');
    expect(pressCodeOf('AU - 999T Injection Molding Machine')).toBe('');
  });
});

describe('due dates', () => {
  it('reads overdue, this week, later and none', () => {
    expect(dueLevel('2026-10-10', today)).toBe('overdue');
    expect(dueLevel('2026-10-11', today)).toBe('soon');
    expect(dueLevel('2026-10-18', today)).toBe('soon');
    expect(dueLevel('2026-10-19', today)).toBe('ok');
    expect(dueLevel('', today)).toBe('none');
  });
});

describe('MTBF and MTTR', () => {
  it('spreads the window, less downtime, over the breakdowns', () => {
    const rel = reliability(
      [
        wo({ createdAt: '2026-09-01', downtime: '10' }),
        wo({ createdAt: '2026-10-01', downtime: '2' }),
        // Not a breakdown: does not count.
        wo({ createdAt: '2026-09-15', maintTypeRaw: '3. Preventive Maintenance', maintType: 'inspection', downtime: '5' }),
      ],
      today,
      '2026-07-14', // the export starts here: 90 days to today inclusive
    );
    expect(rel.windowDays).toBe(90);
    expect(rel.breakdowns).toBe(2);
    expect(rel.downtimeH).toBe(12);
    expect(rel.mttrH).toBe(6);
    expect(rel.mtbfH).toBeCloseTo((90 * 24 - 12) / 2);
    expect(rel.availability).toBeCloseTo(rel.mtbfH! / (rel.mtbfH! + 6));
  });

  it('has no MTBF without a breakdown and no MTTR without downtime', () => {
    expect(reliability([], today, '').mtbfH).toBeNull();
    const rel = reliability([wo({ createdAt: '2026-10-01' })], today, '');
    expect(rel.windowDays).toBe(365);
    expect(rel.mttrH).toBeNull();
    expect(rel.mtbfH).not.toBeNull();
  });
});

describe('the machine rows', () => {
  it('lists the nine presses first, joins orders and PM by name, and says what is wrong', () => {
    const rows = buildMachineRows(
      [
        pm({ dueDate: '2026-10-09', detail: 'Overdue oil change' }),
        pm({ dueDate: '2026-11-30', detail: 'Later' }),
        pm({ dueDate: '2026-01-01', superseded: true }),
        pm({ asset: 'AU - Encore Cold Saw', dueDate: '2026-12-01' }),
      ],
      [
        wo({ status: 'in-progress', closedAt: '' }), // open breakdown on 1600T
        wo({ asset: 'AU - Hastings Forklift', branch: 'Resero - Hastings' }), // other site: left out
      ],
      today,
      '',
    );
    expect(rows.slice(0, 9).map((r) => r.code)).toEqual([...PRESS_CODES]);
    expect(rows.map((r) => r.asset)).toContain('AU - Encore Cold Saw');
    expect(rows.map((r) => r.asset)).not.toContain('AU - Hastings Forklift');
    const p125 = rows.find((r) => r.code === '125T')!;
    expect(p125.asset).toBe('AU - 125T Superjack Injection Moulding Machine'); // MachinePM's spelling
    expect(p125.pm.map((e) => e.detail)).toEqual(['Overdue oil change', 'Later']);
    expect(p125.nextPm?.dueDate).toBe('2026-10-09');
    expect(p125.state).toBe('overdue');
    const p1600 = rows.find((r) => r.code === '1600T')!;
    expect(p1600.openOrders).toBe(1);
    expect(p1600.state).toBe('breakdown');
    expect(rows.find((r) => r.code === '150T')!.state).toBe('ok');
  });
});

describe('the team page', () => {
  const orders = [
    wo({
      closedAt: '2026-10-05',
      labourHours: '2',
      contact: 'Wisam Istefo',
      issueDetail: 'Burst under load at the clamp',
      workSummary: 'Replaced the hose',
    }),
    wo({ closedAt: '2026-10-06', labourHours: '1.5', contact: '' }),
    wo({ closedAt: '2026-08-01', labourHours: '4', contact: 'Chris Buckley' }),
    wo({ status: 'open', closedAt: '', dueDate: '2026-10-09', contact: 'Chris Buckley', mangoTicket: 'MWO 9' }),
  ];

  it('counts the closed orders and their labour on the day they closed', () => {
    const done = doneOrders(orders);
    expect(done.map((d) => [d.day, d.owner, d.hours])).toEqual([
      ['2026-10-06', 'Unassigned', 1.5],
      ['2026-10-05', 'Wisam Istefo', 2],
      ['2026-08-01', 'Chris Buckley', 4],
    ]);
    expect(done[1]).toMatchObject({ summary: 'Replaced the hose', detail: 'Burst under load at the clamp' });
    expect(bucketEnd('2026-10-05', 'week')).toBe('2026-10-11');
    expect(bucketEnd('2026-02-01', 'month')).toBe('2026-02-28');
    const weeks = bucketDone(done, '2026-09-28', today, 'week');
    expect(weeks.map((b) => b.start)).toEqual(['2026-09-28', '2026-10-05']);
    expect(weeks[1]).toMatchObject({ count: 2, hours: 3.5 });
  });

  it('picks a bucket size for the span', () => {
    expect(unitFor('2026-09-12', today)).toBe('day');
    expect(unitFor('2026-04-01', today)).toBe('week');
    expect(unitFor('2025-10-12', today)).toBe('month');
  });

  it('lists open orders and live PM, overdue first', () => {
    const items = openWork(orders, [pm({ dueDate: '2026-10-15' }), pm({ superseded: true, dueDate: '2026-01-01' })], today);
    expect(items.map((i) => [i.kind, i.level, i.owner])).toEqual([
      ['MR', 'overdue', 'Chris Buckley'],
      ['PM', 'soon', 'Aryan Apte'],
    ]);
  });
});
