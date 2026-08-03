import type {
  BdCode,
  DieChangeLog,
  DieComponentCondition,
  DieMaintenanceRequest,
  DieMaster,
  Machine,
  Operator,
  PlanningOrder,
  ProductDieColor,
  ProductionRecord,
  RejectCategory,
  ShiftCode,
  StatusCode,
  Supervisor,
} from '../types';
import { bdAsBdCodes } from '../core/breakdown';
import { dieChangeEventKey } from '../core/die';
import { generateDieChanges } from '../core/planning';
import {
  SLOTS_PER_SHIFT,
  buildShiftId,
  currentSlotIndex,
  shiftBounds,
} from '../core/shifts';

// Deterministic PRNG so the demo/tests are stable (Appendix A).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MACHINE_DEFS: Array<[string, string, number]> = [
  ['125T', '125 Tonne Press', 1],
  ['320T', '320 Tonne Press', 2],
  ['550T', '550 Tonne Press', 3],
  ['850T', '850 Tonne Press', 4],
  ['1600T', '1600 Tonne Press', 5],
  ['Batt1', 'Battery Cell Line 1', 6],
  ['Batt2', 'Battery Cell Line 2', 7],
  ['HS', 'High-Speed Press', 8],
];

// Appendix A — realistic OEE (run-slot ratio) per machine.
const OEE_RATE: Record<string, number> = {
  '125T': 0.9,
  '320T': 0.75,
  '550T': 0.6,
  '850T': 0.88,
  '1600T': 0.5,
  Batt1: 0.85,
  Batt2: 0.7,
  HS: 0.92,
};

// Per-machine bias for the non-R status mix (Appendix A: e.g. 1600T → D).
const NONR_BIAS: Record<string, StatusCode[]> = {
  '125T': ['O', 'S', 'C'],
  '320T': ['B', 'M', 'O'],
  '550T': ['B', 'B', 'M', 'O', 'D'],
  '850T': ['S', 'C', 'O'],
  '1600T': ['D', 'D', 'D', 'I', 'B'],
  Batt1: ['C', 'P', 'O'],
  Batt2: ['B', 'O', 'M'],
  HS: ['S', 'O'],
};

// [name, roster shift] — 4 operators per shift so the operator sheet's
// shift-filtered roster has a realistic list to narrow to.
const OPERATOR_NAMES: Array<[string, ShiftCode]> = [
  ['Tin Maung', 'Day'],
  ['Tony Lee', 'Day'],
  ['Gabriel Mehana-Lee', 'Day'],
  ['John Taylor', 'Day'],
  ['Trong (Danny) Nguyen', 'Afternoon'],
  ['Bounpanh Walakone', 'Afternoon'],
  ['Heng Ong', 'Afternoon'],
  ['Phong Xuan', 'Afternoon'],
  ['Van Minh Ma', 'Night'],
  ['Joe Talamaivao', 'Night'],
  ['Edin Kulelija', 'Night'],
  ['Karl Stevens', 'Night'],
];
const SUPERVISOR_NAMES: Array<[string, ShiftCode]> = [
  ['Christopher King', 'Day'],
  ['Jean-Michel Thomas', 'Afternoon'],
  ['Jeff Penn', 'Night'],
];

export function seedMachines(): Machine[] {
  return MACHINE_DEFS.map(([machineCode, displayName, sequence], i) => ({
    id: i + 1,
    machineCode,
    displayName,
    sequence,
    active: true,
  }));
}

export function seedOperators(): Operator[] {
  return OPERATOR_NAMES.map(([operatorName, shift], i) => ({
    id: i + 1,
    operatorName,
    employeeId: `E${String(1000 + i)}`,
    active: true,
    shift,
  }));
}

export function seedSupervisors(): Supervisor[] {
  return SUPERVISOR_NAMES.map(([operatorName, shift], i) => ({
    id: i + 1,
    operatorName,
    active: true,
    shift,
  }));
}

const PRODUCT_DEFS: Array<[string, string, number, number]> = [
  ['G08770030', 'Viva Backrest 3597', 28.5, 2],
  ['INSC00689', 'Integra Chair - Navy', 41.0, 1],
  ['INSC00000NRX003', 'Integra Chair - Fire Retardant', 44.2, 1],
  ['B14220011', 'Battery Tray Lid', 19.8, 4],
  ['HS-PLT-0091', 'High-Speed Pallet Insert', 7.4, 8],
  ['G08770044', 'Viva Armrest Left', 22.1, 2],
];


// Die master mirroring PMD_ProductDieColor: die / colour / category per
// Part #. The two Viva parts share DIE-3597 (a real co-run pattern) so
// the Die Management tab's per-die rollup has a multi-part die to show.
const DIE_COLOR_DEFS: Array<[string, string, string, string, string, string, boolean]> = [
  // partNumber, hex, colour name, category, dieNumber, die description, coRun
  ['G08770030', '#334155', 'Slate Grey', 'Seating', 'DIE-3597', 'Viva Backrest/Armrest 2-cav', true],
  ['G08770044', '#334155', 'Slate Grey', 'Seating', 'DIE-3597', 'Viva Backrest/Armrest 2-cav', true],
  ['INSC00689', '#1e3a8a', 'Navy', 'Seating', 'DIE-0689', 'Integra Chair Shell', false],
  ['INSC00000NRX003', '#7f1d1d', 'Fire Red', 'Seating', 'DIE-0689', 'Integra Chair Shell', false],
  ['B14220011', '#0f766e', 'Teal', 'Battery', 'DIE-1422', 'Battery Tray Lid 4-cav', false],
  ['HS-PLT-0091', '#78350f', 'Umber', 'Pallets', 'DIE-0091', 'HS Pallet Insert 8-cav', false],
];

export function seedProductDieColors(): ProductDieColor[] {
  return DIE_COLOR_DEFS.map(([partNumber, hex, name, category, dieNumber, die, coRun]) => ({
    partNumber,
    hex,
    name,
    category,
    dieNumber,
    die,
    coRun,
  }));
}

/** PMD_DieMaster parity: the die ASSET register. One row per physical
 *  tool, covering all four ToolStatus colours so the demo table shows the
 *  full traffic-light range. DIE-3597's "problems" matches its seeded
 *  open repair request; DIE-1422's "serviced" matches its closed one. */
export function seedDieMaster(now: Date): DieMaster[] {
  const stamp = (daysAgo: number): string => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  };
  const row = (
    dieNumber: string,
    description: string,
    cavities: number,
    cycleTime: number,
    dieWeightKg: number,
    lifeCycle: number,
    toolStatus: DieMaster['toolStatus'],
    daysAgo: number,
    lastServiceDaysAgo: number | null,
    availableInDays: number | null = null,
  ): DieMaster => ({
    dieNumber,
    description,
    cavities,
    cycleTime,
    dieWeightKg,
    leanReady: cavities <= 2,
    toolInjectorPlate: cavities >= 4 ? 'Yes' : 'No',
    // Changeover is recorded in HOURS on PMD_DieMaster.
    changeOverIn: 1 + cavities * 0.25,
    changeOverOut: 0.5 + cavities * 0.25,
    // Observed median — empty until a KPI import has run.
    changeOverMedian: null,
    lifeCycle,
    dateStamp: stamp(daysAgo),
    lastServiceDate: lastServiceDaysAgo == null ? '' : stamp(lastServiceDaysAgo),
    availableDate: availableInDays == null ? '' : stamp(-availableInDays),
    toolStatus,
    maintenanceLevel: '',
    notes: '',
  });
  const custom = row(
    'DIE-3597', 'Viva Backrest/Armrest 2-cav', 2, 28.5, 780, 1_000_000, 'problems', 1, 45,
  );
  // One die carries a CUSTOMISED plan so the demo shows the per-die
  // override path (the others fall back to the default template).
  custom.maintenanceLevel = [
    'L1 | every die change | Wipe parting line; Blow out vents; Check armrest slide gibs',
    'L2 | 8,000 shots | Polish vent land on cav 2 (flash history); Grease ejector & guide pins; Flow-test both water circuits',
    'L3 | 80,000 shots | Full strip & ultrasonic clean; Re-spot parting line (flash zone); Replace O-rings; Check backrest core for wash',
  ].join('\n');
  return [
    custom,
    // In service, with a maintenance-confirmed return date 5 days out —
    // exercises the Available column's date path. The DieDescription
    // deliberately differs from PMD_ProductDieColor's Die text so the
    // demo shows the board preferring the toolroom's own name.
    row('DIE-0689', 'INTEGRA CHAIR SHELL 1-CAV', 1, 41.0, 1450, 800_000, 'in-service', 3, 60, 5),
    row('DIE-1422', 'Battery Tray Lid 4-cav', 4, 19.8, 260, 1_200_000, 'serviced', 4, 4),
    row('DIE-0091', 'HS Pallet Insert 8-cav', 8, 7.4, 190, 2_000_000, 'to-be-serviced', 9, null),
  ];
}

/** A couple of maintenance requests so the demo shows the whole Fabrico-
 *  style lifecycle: one live request (open) and one already closed. */
export function seedDieMaintenance(now: Date): DieMaintenanceRequest[] {
  const daysAgo = (n: number): string => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };
  return [
    {
      id: 1,
      dieNumber: 'DIE-3597',
      status: 'open',
      maintType: 'repair',
      priority: 'high',
      description: 'Flash on cavity 2 parting line — D02 rejects climbing on Viva Backrest.',
      contact: 'Toolroom Team',
      requestedBy: 'Christopher King',
      machineCode: '320T',
      jobNumber: '',
      mangoTicket: '',
      createdAt: daysAgo(6),
      closedAt: '',
      // Mango "To be completed by" already passed → red (overdue) in Maint.
      dueDate: daysAgo(2),
    },
    {
      id: 3,
      dieNumber: 'DIE-0689',
      status: 'in-progress',
      maintType: 'inspection',
      priority: 'normal',
      description: 'Hot-runner temperature drift — schedule a check.',
      contact: 'Toolroom Team',
      requestedBy: 'Karl Stevens',
      machineCode: '1600T',
      jobNumber: '',
      mangoTicket: '',
      createdAt: daysAgo(1),
      closedAt: '',
      // Due in a few days → amber (due soon).
      dueDate: daysAgo(-3),
    },
    {
      id: 4,
      dieNumber: 'DIE-0091',
      status: 'open',
      maintType: 'cleaning',
      priority: 'low',
      description: 'Routine vent clean booked for next campaign.',
      contact: 'Maintenance Team',
      requestedBy: 'Jeff Penn',
      machineCode: 'HS',
      jobNumber: '',
      mangoTicket: '',
      createdAt: daysAgo(1),
      closedAt: '',
      // Plenty of runway → green (on track).
      dueDate: daysAgo(-20),
    },
    {
      id: 2,
      dieNumber: 'DIE-1422',
      status: 'done',
      maintType: 'cleaning',
      priority: 'normal',
      description: 'Scheduled vent clean after battery tray campaign.',
      contact: 'Maintenance Team',
      requestedBy: 'Jeff Penn',
      machineCode: 'Batt1',
      jobNumber: '',
      mangoTicket: 'MAN-30412',
      createdAt: daysAgo(5),
      closedAt: daysAgo(4),
      // Mango report detail — demo parity with the CSV mirror.
      downtime: '2',
      labourHours: '3.5',
      issueDetail: 'Vents blocked with residue after the long battery tray campaign; short shots on cavities 3-4.',
      workSummary: 'Stripped and ultrasonic-cleaned all vent inserts, polished parting line.',
      correctiveAction: 'Vent inserts cleaned and re-lapped.',
      preventativeAction: 'Added vent clean to the campaign-end checklist.',
    },
  ];
}

/** Two setter condition reports (PMD_DieChangeLog) so the demo shows the
 *  Maint-column flags + Status override: DIE-0091 has a DAMAGED moulding
 *  surface (→ effective Status Problems, priority service), DIE-0689 is
 *  merely worn on venting (→ amber Maint chip only). */
export function seedDieChangeLogs(now: Date): DieChangeLog[] {
  const day = (n: number): string => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const allGood = (): Record<string, DieComponentCondition> => ({});
  return [
    {
      id: 1,
      eventKey: dieChangeEventKey('850T', day(2), 'Day', 'SFM506888', 2),
      eventStartSlot: 2,
      eventEndSlot: 5,
      date: day(2),
      shift: 'Day',
      dieSetter: 'Anil Pattarath',
      machineCode: '850T',
      changeOver: ['Die'],
      jobNumber: 'SFM506888',
      dieNumberOut: 'DIE-0091',
      dieDescriptionOut: 'HS Pallet Insert 8-cav',
      dieNumberIn: 'DIE-1422',
      dieDescriptionIn: 'Battery Tray Lid 4-cav',
      components: { ...allGood(), MouldingSurfaces: 'damaged', GuidePins: 'worn' },
      componentsIn: {},
      problemDescription: 'Cavity 6 surface gouged near the gate; guide pins showing wear lines.',
      problemDescriptionIn: '',
      createdAt: new Date(new Date(now).setDate(now.getDate() - 2)).toISOString(),
    },
    {
      id: 2,
      eventKey: dieChangeEventKey('1600T', day(4), 'Night', 'SFM506811', 4),
      eventStartSlot: 4,
      eventEndSlot: 7,
      date: day(4),
      shift: 'Night',
      dieSetter: 'Van Minh Ma',
      machineCode: '1600T',
      changeOver: ['Die'],
      jobNumber: 'SFM506811',
      dieNumberOut: 'DIE-0689',
      dieDescriptionOut: 'Integra Chair Shell',
      dieNumberIn: 'DIE-3597',
      dieDescriptionIn: 'Viva Backrest/Armrest 2-cav',
      components: { ...allGood(), Venting: 'worn' },
      componentsIn: {},
      problemDescription: 'Vents crusting up — clean at next service.',
      problemDescriptionIn: '',
      createdAt: new Date(new Date(now).setDate(now.getDate() - 4)).toISOString(),
    },
  ];
}

// 10 PMD defect codes (D01-D10). Each gets its own fixed row on the
// operator sheet. The longer "Visual Signs" text is operator-training
// material and lives on PMD_RejectCategories, not in the app data model.
const DEFECT_CODES: Array<[string, string]> = [
  ['D01', 'ShortShot'],
  ['D02', 'FlashMelt-out'],
  ['D03', 'Burnmarks'],
  ['D04', 'SinksWarpage'],
  ['D05', 'FlowMarks'],
  ['D06', 'WhiteStressMarks'],
  ['D07', 'BubblesBlisters'],
  ['D08', 'CrackedDelamination'],
  ['D09', 'DamagedDirty'],
  ['D10', 'Contamination'],
];

export function seedRejectCategories(): RejectCategory[] {
  return DEFECT_CODES.map(([code, label], i) => ({
    code,
    label,
    sequence: i + 1,
  }));
}


// Two-tier breakdown classification from breakdown_classification_taxonomy.md
// (11 categories × 6-11 causes = 91 codes, ELE-01..OTH-99).
export function seedBdCodes(): BdCode[] {
  return bdAsBdCodes();
}

// Two ERP orders per machine per Day shift, across the same 7-day window the
// production seed fills, so historical shift navigation has a Gantt to show.
// dayBack -1 = TOMORROW: real Epicor planning always carries upcoming
// orders, and the Die Management "Scheduled" column needs future starts
// to demo against (production is only seeded for past/today).
export function seedPlanning(now: Date): PlanningOrder[] {
  const base: PlanningOrder[] = [];
  let id = 1;
  let mi = 0;
  for (const [machineCode] of MACHINE_DEFS) {
    for (let dayBack = 6; dayBack >= -1; dayBack--) {
      const day = new Date(now);
      day.setDate(day.getDate() - dayBack);
      day.setHours(0, 0, 0, 0);
      // +length keeps the index positive for dayBack -1 (JS % is signed).
      const a = PRODUCT_DEFS[(mi + dayBack + PRODUCT_DEFS.length) % PRODUCT_DEFS.length];
      const b = PRODUCT_DEFS[(mi + dayBack + 1 + PRODUCT_DEFS.length) % PRODUCT_DEFS.length];
      const s1 = new Date(day);
      s1.setHours(7, 0, 0, 0);
      const e1 = new Date(day);
      e1.setHours(11, 0, 0, 0);
      const e2 = new Date(day);
      e2.setHours(15, 0, 0, 0);
      base.push({
        id: id,
        jobNumber: `SFM50${String(6800 + id).padStart(4, '0')}`,
        machineCode,
        originalMachine: machineCode,
        partNumber: a[0],
        partDescription: a[1],
        plannedStart: s1.toISOString(),
        plannedEnd: e1.toISOString(),
        orderQty: 480,
        jobRequired: 240,
        // HOURS PER PIECE (Epicor JobOper_ProdStandard semantics — see
        // core/targets.ts): 1/60 h/pc = 60 pieces/hour.
        qtyPerHr: 1 / 60,
        duration: 4,
        released: true,
        isDieChange: false,
        manuallyAdded: false,
        source: 'ERP',
      });
      id++;
      base.push({
        id: id,
        jobNumber: `SFM50${String(6800 + id).padStart(4, '0')}`,
        machineCode,
        originalMachine: machineCode,
        partNumber: b[0],
        partDescription: b[1],
        plannedStart: e1.toISOString(),
        plannedEnd: e2.toISOString(),
        orderQty: 400,
        jobRequired: 200,
        // 1/50 h/pc = 50 pieces/hour.
        qtyPerHr: 1 / 50,
        duration: 4,
        released: true,
        isDieChange: false,
        manuallyAdded: false,
        source: 'ERP',
      });
      id++;
    }
    mi++;
  }
  return generateDieChanges(base);
}

/**
 * Appendix A — seed PROD records: all 8 machines, last 7 days, Day shift only.
 * "Today" is partial: only slots from 07:00 to the current time are filled.
 */
export function seedProduction(now: Date, planning: PlanningOrder[]): ProductionRecord[] {
  const rng = mulberry32(20260517);
  const recs: ProductionRecord[] = [];
  let id = 1;
  const stamp = now.toISOString();

  for (let dayBack = 6; dayBack >= 0; dayBack--) {
    const day = new Date(now);
    day.setDate(day.getDate() - dayBack);
    day.setHours(0, 0, 0, 0);
    const isToday = dayBack === 0;

    for (const [machineCode] of MACHINE_DEFS) {
      const shiftId = buildShiftId(day, 'Day');
      const orders = planning
        .filter((p) => p.machineCode === machineCode && !p.isDieChange && p.released)
        .sort(
          (x, y) => new Date(x.plannedStart).getTime() - new Date(y.plannedStart).getTime(),
        );
      if (orders.length === 0) continue;

      const rate = OEE_RATE[machineCode] ?? 0.75;
      const bias = NONR_BIAS[machineCode] ?? ['O', 'B', 'M'];
      const lastSlot = isToday
        ? (currentSlotIndex(shiftId, now) ?? -1)
        : SLOTS_PER_SHIFT - 1;
      if (lastSlot < 0) continue;

      const b = shiftBounds(shiftId)!;
      for (let slot = 0; slot <= lastSlot && slot < SLOTS_PER_SHIFT; slot++) {
        const slotMid = new Date(b.start.getTime() + slot * 30 * 60_000);
        // Order whose planned window covers this slot (fallback: first order).
        const order =
          orders.find(
            (o) =>
              new Date(o.plannedStart) <= slotMid && slotMid < new Date(o.plannedEnd),
          ) ?? orders[Math.min(orders.length - 1, slot < 8 ? 0 : 1)];

        const isRun = rng() < rate;
        const status: StatusCode = isRun
          ? 'R'
          : bias[Math.floor(rng() * bias.length)];

        const onSlot0 = slot === 0;
        // qtyPerHr is HOURS PER PIECE — half a slot-hour over it gives the
        // slot's piece count (≈25-30 at 1/60 h/pc).
        const good = Math.round((0.5 / order.qtyPerHr) * (0.85 + rng() * 0.2));
        const rejQty = rng() < 0.3 ? 1 + Math.floor(rng() * 3) : 0;

        recs.push({
          id: id++,
          machineCode,
          shiftId,
          jobNumber: order.jobNumber,
          partNumber: order.partNumber,
          slotIndex: slot,
          statusCode: status,
          countStart: onSlot0 ? 0 : null,
          countEnd: onSlot0 ? good * (lastSlot + 1) : null,
          rejectCount: rejQty,
          // Spread reject quantity across a couple of defect codes so the
          // KPI Pareto has a realistic distribution to chart, not a single
          // bar. Weighted toward the lower codes (ShortShot / Flash) the
          // way a real floor's scrap mix skews.
          rejects: rejQty
            ? JSON.stringify({
                [DEFECT_CODES[Math.floor(rng() * rng() * DEFECT_CODES.length)][0]]: rejQty,
              })
            : '{}',
          purgeKg: onSlot0 && rng() < 0.4 ? +(rng() * 2).toFixed(1) : null,
          operator: OPERATOR_NAMES[(id + dayBack) % OPERATOR_NAMES.length][0],
          supervisor: dayBack > 0 ? SUPERVISOR_NAMES[dayBack % SUPERVISOR_NAMES.length][0] : '',
          bdIssue: status === 'B' ? 'MEC-11' : '', // Abnormal noise / vibration — generic seed
          mangoTicket: status === 'B' ? `MAN-3${String(1000 + id).slice(-4)}` : '',
          handoverNote:
            onSlot0 && dayBack === 1
              ? 'Bearing noise on warm-up — monitored, no action taken.'
              : '',
          qcBy: '',
          locked: dayBack > 0,
          lockedBy: dayBack > 0 ? SUPERVISOR_NAMES[dayBack % SUPERVISOR_NAMES.length][0] : '',
          lockedAt: dayBack > 0 ? stamp : '',
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
    }
  }
  return recs;
}
