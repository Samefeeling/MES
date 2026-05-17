import type {
  BdCode,
  Machine,
  Operator,
  PlanningOrder,
  Product,
  ProductionRecord,
  RejectCategory,
  StatusCode,
  Supervisor,
} from '../types';
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

const OPERATOR_NAMES = [
  'Tin Maung',
  'Tony Lee',
  'Gabriel Mehana-Lee',
  'John Taylor',
  'Trong (Danny) Nguyen',
  'Bounpanh Walakone',
  'Heng Ong',
  'Phong Xuan',
  'Van Minh Ma',
  'Joe Talamaivao',
  'Edin Kulelija',
  'Karl Stevens',
];
const SUPERVISOR_NAMES = ['Christopher King', 'Jean-Michel Thomas', 'Jeff Penn'];

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
  return OPERATOR_NAMES.map((operatorName, i) => ({
    id: i + 1,
    operatorName,
    employeeId: `E${String(1000 + i)}`,
    active: true,
  }));
}

export function seedSupervisors(): Supervisor[] {
  return SUPERVISOR_NAMES.map((operatorName, i) => ({
    id: i + 1,
    operatorName,
    active: true,
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

export function seedProducts(): Product[] {
  return PRODUCT_DEFS.map(([partNumber, description, standardCycleSec, cavities], i) => ({
    id: i + 1,
    partNumber,
    description,
    standardCycleSec,
    cavities,
    active: true,
  }));
}

export function seedRejectCategories(): RejectCategory[] {
  const labels: Record<string, string> = {
    P1: 'Short shot',
    P2: 'Flash',
    P3: 'Sink mark',
    P4: 'Warpage',
    P5: 'Burn mark',
    P6: 'Splay / silver streak',
    P7: 'Weld line',
    P8: 'Black spot / contamination',
    P9: 'Dimensional out of spec',
    P11: 'Surface scratch',
    P12: 'Colour mismatch',
    P13: 'Insert missing / misplaced',
    P14: 'Gate vestige',
    P15: 'Ejector pin mark',
    P16: 'Drag mark',
    P17: 'Void / bubble',
    P18: 'Brittleness / cracking',
    P19: 'Delamination',
    P20: 'Incomplete trim',
    P21: 'Mixed part',
    P22: 'Damaged in handling',
  }; // 21 PMD-standard reject codes (§2.1)
  return Object.keys(labels).map((code, i) => ({
    code,
    label: labels[code],
    sequence: i + 1,
  }));
}

export function seedBdCodes(): BdCode[] {
  const groups: Array<[string, string[]]> = [
    ['Hydraulic', ['Pump failure', 'Hose burst', 'Valve stuck', 'Oil leak', 'Low pressure']],
    ['Electrical', ['Drive fault', 'Sensor failure', 'Wiring fault', 'PLC fault', 'Heater band open']],
    ['Mechanical', ['Toggle wear', 'Tie-bar issue', 'Ejector jam', 'Clamp misalign', 'Bearing failure']],
    ['Mould/Tool', ['Mould stuck', 'Cooling blocked', 'Core pin broken', 'Hot runner fault']],
    ['Robot/Auto', ['Robot fault', 'Gripper fail', 'Conveyor jam', 'Vision fault']],
    ['Process', ['Material starvation', 'Feed throat block', 'Dryer fault', 'Temperature drift', 'Material contamination']],
    ['Utilities', ['Air supply loss', 'Water cooling loss', 'Power dip']],
  ];
  const out: BdCode[] = [];
  let seq = 1;
  for (const [subCategory, labels] of groups) {
    for (const label of labels) {
      out.push({ code: `BD${String(seq).padStart(2, '0')}`, label, subCategory, sequence: seq });
      seq++;
    }
  }
  return out; // 31 codes
}

// Two ERP orders per machine per Day shift, across the same 7-day window the
// production seed fills, so historical shift navigation has a Gantt to show.
export function seedPlanning(now: Date): PlanningOrder[] {
  const base: PlanningOrder[] = [];
  let id = 1;
  let mi = 0;
  for (const [machineCode] of MACHINE_DEFS) {
    for (let dayBack = 6; dayBack >= 0; dayBack--) {
      const day = new Date(now);
      day.setDate(day.getDate() - dayBack);
      day.setHours(0, 0, 0, 0);
      const a = PRODUCT_DEFS[(mi + dayBack) % PRODUCT_DEFS.length];
      const b = PRODUCT_DEFS[(mi + dayBack + 1) % PRODUCT_DEFS.length];
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
        jobRequired: 240,
        qtyPerHr: 60,
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
        jobRequired: 200,
        qtyPerHr: 50,
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
        const good = Math.round(order.qtyPerHr * 0.5 * (0.85 + rng() * 0.2));
        const rejQty = rng() < 0.3 ? 1 + Math.floor(rng() * 3) : 0;

        recs.push({
          id: id++,
          machineCode,
          shiftId,
          jobNumber: order.jobNumber,
          slotIndex: slot,
          statusCode: status,
          countStart: onSlot0 ? 0 : null,
          countEnd: onSlot0 ? good * (lastSlot + 1) : null,
          rejectCount: rejQty,
          rejects: rejQty ? JSON.stringify({ P11: rejQty }) : '{}',
          operator: OPERATOR_NAMES[(id + dayBack) % OPERATOR_NAMES.length],
          supervisor: dayBack > 0 ? SUPERVISOR_NAMES[dayBack % SUPERVISOR_NAMES.length] : '',
          bdIssue: status === 'B' ? 'BD01' : '',
          mangoTicket: status === 'B' ? `MAN-3${String(1000 + id).slice(-4)}` : '',
          handoverNote:
            onSlot0 && dayBack === 1
              ? 'Bearing noise on warm-up — monitored, no action taken.'
              : '',
          locked: dayBack > 0,
          lockedBy: dayBack > 0 ? SUPERVISOR_NAMES[dayBack % SUPERVISOR_NAMES.length] : '',
          lockedAt: dayBack > 0 ? stamp : '',
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
    }
  }
  return recs;
}
