// Two-tier breakdown taxonomy from breakdown_classification_taxonomy.md.
// Operator picks the Category first, then the specific Cause. The code
// prefix doubles as the Pareto grouping (ELE*, HYD*, ...).

import type { BdCode, BreakdownSlotDetail, ProductionRecord } from '../types';

interface BdCategory {
  prefix: string;
  label: string;
  emoji: string;
  sequence: number;
}

export const BD_CATEGORIES: BdCategory[] = [
  { prefix: 'ELE', label: 'Electrical', emoji: '⚡', sequence: 1 },
  { prefix: 'MEC', label: 'Mechanical', emoji: '⚙', sequence: 2 },
  { prefix: 'HYD', label: 'Hydraulic', emoji: '💧', sequence: 3 },
  { prefix: 'HEA', label: 'Heating / Temp', emoji: '🔥', sequence: 4 },
  { prefix: 'CTL', label: 'Controls / PLC', emoji: '🖥', sequence: 5 },
  { prefix: 'TOOL', label: 'Tooling / Mould', emoji: '🔧', sequence: 6 },
  { prefix: 'SAF', label: 'Safety', emoji: '🛑', sequence: 7 },
  { prefix: 'AUX', label: 'Auxiliary', emoji: '🤖', sequence: 8 },
  { prefix: 'UTL', label: 'Utilities', emoji: '🔌', sequence: 9 },
  { prefix: 'MAT', label: 'Material', emoji: '📦', sequence: 10 },
  { prefix: 'OTH', label: 'Other', emoji: '❓', sequence: 11 },
];

export interface BdCause {
  code: string;
  cause: string;
  owner: string;
}

export const BD_TAXONOMY: BdCause[] = [
  // Electrical
  { code: 'ELE-01', cause: 'Main power loss / supply trip to machine', owner: 'Maintenance' },
  { code: 'ELE-02', cause: 'Motor fault (drive / pump motor)', owner: 'Maintenance' },
  { code: 'ELE-03', cause: 'Servo / VFD drive fault or alarm', owner: 'Maintenance' },
  { code: 'ELE-04', cause: 'Blown fuse / tripped circuit breaker', owner: 'Maintenance' },
  { code: 'ELE-05', cause: 'Wiring / connector / loose terminal', owner: 'Maintenance' },
  { code: 'ELE-06', cause: 'Limit / proximity sensor electrical fault', owner: 'Maintenance' },
  { code: 'ELE-07', cause: 'Control power supply / transformer fault', owner: 'Maintenance' },
  { code: 'ELE-08', cause: 'Earth fault / insulation fault', owner: 'Maintenance' },
  { code: 'ELE-09', cause: 'Contactor / relay failure', owner: 'Maintenance' },
  // Mechanical
  { code: 'MEC-01', cause: 'Clamp / toggle mechanism fault', owner: 'Maintenance' },
  { code: 'MEC-02', cause: 'Ejector mechanism jam or fault', owner: 'Maintenance / Setter' },
  { code: 'MEC-03', cause: 'Screw / barrel seized or worn', owner: 'Maintenance' },
  { code: 'MEC-04', cause: 'Check ring / non-return valve failure', owner: 'Maintenance' },
  { code: 'MEC-05', cause: 'Tie bar / platen fault', owner: 'Maintenance' },
  { code: 'MEC-06', cause: 'Gearbox / coupling / bearing failure', owner: 'Maintenance' },
  { code: 'MEC-07', cause: 'Belt / chain / drive failure', owner: 'Maintenance' },
  { code: 'MEC-08', cause: 'Nozzle blocked / seized / leaking', owner: 'Setter / Maintenance' },
  { code: 'MEC-09', cause: 'Injection carriage / sled movement fault', owner: 'Maintenance' },
  { code: 'MEC-10', cause: 'Lubrication system failure / low grease', owner: 'Maintenance' },
  { code: 'MEC-11', cause: 'Abnormal noise / vibration', owner: 'Operator → Maintenance' },
  // Hydraulic
  { code: 'HYD-01', cause: 'Hydraulic pump failure', owner: 'Maintenance' },
  { code: 'HYD-02', cause: 'Low oil level / oil leak', owner: 'Maintenance' },
  { code: 'HYD-03', cause: 'High oil temperature alarm', owner: 'Maintenance' },
  { code: 'HYD-04', cause: 'Pressure low / not building', owner: 'Maintenance' },
  { code: 'HYD-05', cause: 'Valve fault (proportional / directional / relief)', owner: 'Maintenance' },
  { code: 'HYD-06', cause: 'Accumulator fault', owner: 'Maintenance' },
  { code: 'HYD-07', cause: 'Filter blocked / clogged', owner: 'Maintenance' },
  { code: 'HYD-08', cause: 'Cylinder / seal leak (clamp, inject, ejector)', owner: 'Maintenance' },
  { code: 'HYD-09', cause: 'Hose / fitting burst or leak', owner: 'Maintenance' },
  { code: 'HYD-10', cause: 'Oil contamination / condition alarm', owner: 'Maintenance' },
  // Heating
  { code: 'HEA-01', cause: 'Barrel heater band failure', owner: 'Maintenance' },
  { code: 'HEA-02', cause: 'Thermocouple fault (open / reversed / drift)', owner: 'Maintenance' },
  { code: 'HEA-03', cause: 'Zone over-temperature alarm', owner: 'Setter / Maintenance' },
  { code: 'HEA-04', cause: 'Zone under-temperature / slow heat-up', owner: 'Setter / Maintenance' },
  { code: 'HEA-05', cause: 'Hot runner / manifold heater fault', owner: 'Maintenance' },
  { code: 'HEA-06', cause: 'Mould temperature controller (TCU) fault', owner: 'Maintenance' },
  { code: 'HEA-07', cause: 'Heater contactor / SSR failure', owner: 'Maintenance' },
  { code: 'HEA-08', cause: 'Nozzle heater failure', owner: 'Maintenance' },
  // Controls / PLC / HMI
  { code: 'CTL-01', cause: 'Machine controller fault / lock-up', owner: 'Maintenance / Setter' },
  { code: 'CTL-02', cause: 'HMI / screen frozen or blank', owner: 'Setter / Maintenance' },
  { code: 'CTL-03', cause: 'PLC fault / alarm', owner: 'Maintenance' },
  { code: 'CTL-04', cause: 'Communication / network fault', owner: 'Maintenance' },
  { code: 'CTL-05', cause: 'Parameter / recipe corrupted or lost', owner: 'Setter' },
  { code: 'CTL-06', cause: 'Encoder / position feedback fault', owner: 'Maintenance' },
  { code: 'CTL-07', cause: 'I/O module fault', owner: 'Maintenance' },
  { code: 'CTL-08', cause: 'Controller reboot / power-cycle required', owner: 'Setter / Maintenance' },
  // Tooling / Mould
  { code: 'TOOL-01', cause: 'Part stuck / not ejecting', owner: 'Operator / Setter' },
  { code: 'TOOL-02', cause: 'Mould damage (cavity / core / insert)', owner: 'Toolroom' },
  { code: 'TOOL-03', cause: 'Mould protection triggered (low-pressure protect)', owner: 'Operator / Setter' },
  { code: 'TOOL-04', cause: 'Slide / lifter / core-pull fault', owner: 'Toolroom / Setter' },
  { code: 'TOOL-05', cause: 'Mould cooling line blocked or leaking', owner: 'Maintenance / Setter' },
  { code: 'TOOL-06', cause: 'Hot runner blockage / gate freeze-off', owner: 'Setter / Toolroom' },
  { code: 'TOOL-07', cause: 'Ejector pin broken / bent', owner: 'Toolroom' },
  { code: 'TOOL-08', cause: 'Mould not closing / mismatch / misalignment', owner: 'Setter / Toolroom' },
  { code: 'TOOL-09', cause: 'Vent blocked / fouled', owner: 'Toolroom' },
  { code: 'TOOL-10', cause: 'Mould change / setup overrun', owner: 'Setter' },
  // Safety / Interlock
  { code: 'SAF-01', cause: 'Safety gate / guard door open or fault', owner: 'Operator → Maintenance' },
  { code: 'SAF-02', cause: 'Light curtain / safety mat triggered', owner: 'Operator' },
  { code: 'SAF-03', cause: 'Emergency stop activated', owner: 'Operator' },
  { code: 'SAF-04', cause: 'Safety interlock fault / will not reset', owner: 'Maintenance' },
  { code: 'SAF-05', cause: 'Two-hand control fault', owner: 'Maintenance' },
  { code: 'SAF-06', cause: 'Purge guard interlock open / fault', owner: 'Operator / Maintenance' },
  { code: 'SAF-07', cause: 'Robot safety zone breach', owner: 'Operator / Setter' },
  { code: 'SAF-08', cause: 'Lockout / Tagout (LOTO) in place', owner: 'Maintenance' },
  { code: 'SAF-09', cause: 'Pressure / safety relief activation', owner: 'Maintenance' },
  // Auxiliary
  { code: 'AUX-01', cause: 'Robot / sprue picker fault', owner: 'Setter / Maintenance' },
  { code: 'AUX-02', cause: 'Conveyor stopped / jammed', owner: 'Operator' },
  { code: 'AUX-03', cause: 'Material dryer / hopper dryer fault', owner: 'Maintenance' },
  { code: 'AUX-04', cause: 'Mould temp unit / chiller fault', owner: 'Maintenance' },
  { code: 'AUX-05', cause: 'Granulator / regrind unit fault', owner: 'Operator / Maintenance' },
  { code: 'AUX-06', cause: 'Material loader / feeder fault', owner: 'Operator / Maintenance' },
  { code: 'AUX-07', cause: 'Gravimetric / dosing unit fault', owner: 'Setter / Maintenance' },
  { code: 'AUX-08', cause: 'End-of-arm tooling (EOAT) fault', owner: 'Setter' },
  { code: 'AUX-09', cause: 'Vacuum / suction fault', owner: 'Maintenance' },
  // Utilities
  { code: 'UTL-01', cause: 'Site power outage', owner: 'Facilities' },
  { code: 'UTL-02', cause: 'Compressed air loss / low pressure', owner: 'Facilities' },
  { code: 'UTL-03', cause: 'Cooling water loss / low flow', owner: 'Facilities' },
  { code: 'UTL-04', cause: 'Cooling water high temperature', owner: 'Facilities' },
  { code: 'UTL-05', cause: 'Chilled water system down', owner: 'Facilities' },
  { code: 'UTL-06', cause: 'Water leak', owner: 'Facilities' },
  { code: 'UTL-07', cause: 'Gas / nitrogen supply fault (gas-assist)', owner: 'Facilities' },
  // Material / Feed
  { code: 'MAT-01', cause: 'Material run-out / hopper empty', owner: 'Operator' },
  { code: 'MAT-02', cause: 'Material bridging / blockage at throat', owner: 'Operator' },
  { code: 'MAT-03', cause: 'Wrong material / contamination', owner: 'Operator / Setter' },
  { code: 'MAT-04', cause: 'Regrind / blend ratio fault', owner: 'Operator / Setter' },
  { code: 'MAT-05', cause: 'Wet material / drying not complete', owner: 'Operator / Setter' },
  { code: 'MAT-06', cause: 'Masterbatch / colour feed fault', owner: 'Operator / Setter' },
  // Other
  { code: 'OTH-01', cause: 'Awaiting maintenance / spare part', owner: 'Maintenance' },
  { code: 'OTH-02', cause: 'Under investigation', owner: 'Operator / Maintenance' },
  { code: 'OTH-03', cause: 'Operator-related stoppage', owner: 'Operator' },
  { code: 'OTH-99', cause: 'Other (enter free-text note)', owner: '—' },
];

export function bdCategoryOf(code: string): BdCategory | undefined {
  const m = /^([A-Z]+)-/.exec(code);
  if (!m) return undefined;
  return BD_CATEGORIES.find((c) => c.prefix === m[1]);
}

export function bdCausesFor(prefix: string): BdCause[] {
  return BD_TAXONOMY.filter((c) => c.code.startsWith(prefix + '-'));
}

export function bdLabelFor(code: string): string {
  const c = BD_TAXONOMY.find((x) => x.code === code);
  return c ? c.cause : code;
}

/** Encode each B slot into PMD_BreakDownLog.BDCause. Values stay readable
 * in SharePoint while the slot key preserves multiple causes in one job. */
export function encodeBreakdownCauseMap(records: ReadonlyArray<ProductionRecord>): string {
  const bySlot: Record<string, string> = {};
  for (const record of records) {
    if (record.statusCode !== 'B') continue;
    const code = record.bdIssue.trim().toUpperCase();
    if (!code) continue;
    const cause =
      record.bdCause?.trim() ||
      (code === 'OTH-99' ? record.mangoTicket.trim() : '') ||
      bdLabelFor(code);
    bySlot[String(record.slotIndex)] = `${code}${cause ? ` — ${cause}` : ''}`;
  }
  return Object.keys(bySlot).length ? JSON.stringify(bySlot) : '';
}

/** Decode the slot map. A legacy/plain BDCause value is applied to every B
 * slot using the row's dominant BDCode, so hand-entered SharePoint rows are
 * still useful rather than silently disappearing. */
export function decodeBreakdownCauseMap(
  value: string,
  dominantCode = '',
  timeline = '',
): BreakdownSlotDetail[] {
  const text = value.trim();
  const fallbackCode = dominantCode.trim().toUpperCase();
  const detail = (slotIndex: number, raw: string): BreakdownSlotDetail | null => {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 15) return null;
    const entry = raw.trim();
    if (!entry) return null;
    const split = entry.indexOf(' — ');
    const code = (split >= 0 ? entry.slice(0, split) : fallbackCode).trim().toUpperCase();
    const cause = (split >= 0 ? entry.slice(split + 3) : entry).trim();
    if (!code && !cause) return null;
    return { slotIndex, code, cause };
  };

  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed)
          .map(([slot, raw]) => detail(Number(slot), typeof raw === 'string' ? raw : ''))
          .filter((item): item is BreakdownSlotDetail => item !== null)
          .sort((a, b) => a.slotIndex - b.slotIndex);
      }
    } catch {
      // Plain-text fallback below.
    }
  }

  if (!text) return [];
  return Array.from(timeline).flatMap((status, slotIndex) => {
    if (status !== 'B') return [];
    const item = detail(slotIndex, text);
    return item ? [item] : [];
  });
}

export interface BreakdownDetail {
  code: string;
  cause: string;
  owner: string;
  category: string;
}

/** Full taxonomy detail for hover/drilldown views. Unknown legacy codes
 * remain displayable instead of disappearing. */
export function breakdownDetailFor(
  code: string,
  master: ReadonlyMap<string, BdCode> = new Map(),
): BreakdownDetail {
  const normalised = code.trim().toUpperCase();
  const fromMaster = master.get(normalised);
  const found = BD_TAXONOMY.find((x) => x.code === normalised);
  return {
    code: normalised,
    // PMD_BreakdownMaster.Cause is authoritative. The compiled taxonomy
    // remains a resilient fallback for an unreadable list / legacy code.
    cause: fromMaster?.label || found?.cause || normalised || 'Cause not recorded',
    owner: fromMaster?.owner || found?.owner || '—',
    category:
      fromMaster?.subCategory || bdCategoryOf(normalised)?.label || 'Other / legacy',
  };
}

/** Who owns the fix for a cause. Routes a Mango improvement ticket to the
 *  department that can actually action it; '' when nobody is named — an
 *  unknown code, or one the taxonomy deliberately leaves open (OTH-99).
 *  Reads through breakdownDetailFor so the owner behind a ticket is the
 *  same one the breakdown drilldown shows. */
export function bdOwnerFor(code: string, master?: ReadonlyMap<string, BdCode>): string {
  const owner = breakdownDetailFor(code, master).owner;
  return owner === '—' ? '' : owner;
}

/** Adapter so the existing PMD_BdCodes list returns the same shape. */
export function bdAsBdCodes(): BdCode[] {
  return BD_TAXONOMY.map((c, i) => ({
    code: c.code,
    label: c.cause,
    subCategory: bdCategoryOf(c.code)?.label ?? '',
    sequence: i + 1,
    owner: c.owner,
  }));
}
