/**
 * Local development / demo source. Reads a snapshot (`seed.json`) extracted
 * from the real PMD master workbook and maps it onto the domain model, so the
 * board is fully populated with no network or credentials.
 *
 * Seed dates are anchored to a fixed epoch; they are shifted forward so the
 * demo always reads as "today" rather than drifting into the past.
 */

import {
  JobId,
  MachineId,
  PartId,
  ToolId,
  WorkCenterId,
  WorkerId,
} from '@/domain/ids';
import type {
  BomLine,
  Department,
  DemandLine,
  InventoryItem,
  Job,
  JobMaterialLink,
  PoLine,
  RoutingEntry,
  WorkCenter,
} from '@/domain/types';
import type {
  MaterialPrepStatus,
  OrderType,
  Worker,
} from '@/domain/assembly';
import { readLineKey } from '@/domain/assembly';
import {
  assemblyWorkCenters,
  makeMachine,
} from '@/data/excel/parsers/machine.parser';
import { isVisibleMachine } from '@/domain/constants';
import { MS_PER_DAY } from '@/lib/time';
import { BaseDataSource } from '@/data/DataSource';
import { demoWorkers } from './roster';
import seed from './seed.json';

/** The day every seed date is expressed relative to. */
const SEED_EPOCH = new Date('2026-06-16T00:00:00');

/** Whole days to add so the seed reads as the current week. */
function seedOffsetDays(): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - SEED_EPOCH.getTime()) / MS_PER_DAY);
}

const OFFSET_MS = seedOffsetDays() * MS_PER_DAY;

/**
 * Shift a seed date onto the current week. Returns null for blanks and for the
 * Excel error strings (`#N/A`) that survive extraction — otherwise they become
 * an Invalid Date, which is *truthy* and slips past every `if (job.dueDate)`.
 */
const toDate = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? new Date(t + OFFSET_MS) : null;
};

// Simulate a touch of network latency so loading states are exercised.
const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export class MockSource extends BaseDataSource {
  readonly name = 'mock';

  async fetchWorkCenters(): Promise<WorkCenter[]> {
    const machines = seed.machines
      .map(makeMachine)
      .filter((m) => isVisibleMachine(m.id))
      .sort((a, b) => a.sortIndex - b.sortIndex);
    return delay([...machines, ...assemblyWorkCenters()]);
  }

  async fetchWorkers(): Promise<Worker[]> {
    return delay(demoWorkers());
  }

  async fetchJobs(): Promise<Job[]> {
    const jobs: Job[] = seed.jobs.map((j) => ({
      id: JobId(j.jobNum),
      department: (j.department ?? 'moulding') as Department,
      partNum: PartId(j.partNum),
      description: j.description ?? '',
      remainingQty: j.remainingQty ?? 0,
      qtyPerHr: j.qtyPerHr ?? null,
      laborHrs:
        j.laborHrs ??
        (j.qtyPerHr && j.qtyPerHr > 0 ? (j.remainingQty ?? 0) / j.qtyPerHr : 0),
      dueDate: toDate(j.dueDate),
      startDate: toDate(j.startDate),
      reqBy: toDate(j.reqBy),
      released: typeof j.released === 'boolean' ? j.released : null,
      priority: j.priority ?? 3,
      materialPrep: (j.materialPrep ?? 'unknown') as MaterialPrepStatus,
      tool: j.die ? ToolId(j.die) : null,
      preferredMachine: j.machine ? MachineId(j.machine) : null,
      orderType: (j.orderType ?? null) as OrderType | null,
      // The seed was written when UPL was one lane. Read through readLineKey
      // so the demo lands on the lines the board actually has.
      line: j.line ? WorkCenterId(readLineKey(j.line) ?? j.line) : null,
      completedQty: j.completedQty ?? 0,
      // Explicit predecessors only; the seed's material links carry the rest.
      predecessors: j.predecessor ? [JobId(j.predecessor)] : [],
      assignedWorkers: (j.assignedWorkers ?? []).map(WorkerId),
    }));
    return delay(jobs);
  }

  /**
   * The demo's dependency chain: cut & sew before upholstery before final
   * assembly, and the moulded shells those chairs are built from.
   */
  async fetchJobLinks(): Promise<JobMaterialLink[]> {
    const links: JobMaterialLink[] = (seed.jobLinks ?? []).map((l) => ({
      jobNum: JobId(l.jobNum),
      parentPart: PartId(l.parentPart),
      childPart: PartId(l.childPart),
      requiredQty: l.requiredQty ?? null,
      // The demo seed carries no descriptions or units; the line rules read
      // both, so demo orders are placed by the ERP column alone.
      childDescription: '',
      uom: '',
    }));
    return delay(links);
  }

  async fetchRouting(): Promise<RoutingEntry[]> {
    const routing: RoutingEntry[] = seed.routing.map((r) => ({
      partNum: PartId(r.partNum),
      machine: MachineId(r.machine),
      tool: r.die ? ToolId(r.die) : null,
      color: r.color ? (r.color.trim().toLowerCase() as never) : null,
      insert: r.insert ? (r.insert.trim().toLowerCase() as never) : null,
      description: r.description ?? '',
    }));
    return delay(routing);
  }

  async fetchInventory(): Promise<InventoryItem[]> {
    const inv: InventoryItem[] = seed.inventory.map((i) => ({
      partNum: PartId(i.partNum),
      description: i.description ?? '',
      typeCode: i.typeCode ?? null,
      onHand: i.onHand ?? 0,
      cmplWip: i.cmplWip ?? 0,
      supply: i.supply ?? 0,
      demand: i.demand ?? 0,
      freeOnHand: i.freeOnHand ?? 0,
    }));
    return delay(inv);
  }

  async fetchBom(): Promise<BomLine[]> {
    const bom: BomLine[] = seed.bom.map((b) => ({
      finishedPart: PartId(b.finishedPart),
      jobNum: b.jobNum ? JobId(b.jobNum) : null,
      componentPart: PartId(b.componentPart),
      requiredQty: b.requiredQty ?? 0,
      uom: b.uom ?? 'EA',
      dueDate: toDate(b.dueDate),
      outstandingQty: b.outstandingQty ?? 0,
    }));
    return delay(bom);
  }

  async fetchPo(): Promise<PoLine[]> {
    const po: PoLine[] = seed.po.map((p) => ({
      partNum: PartId(p.partNum),
      poNum: p.poNum ?? null,
      outstandingQty: p.outstandingQty ?? 0,
      dueDate: toDate(p.dueDate),
      promiseDate: toDate(p.promiseDate),
      buyer: p.buyer ?? null,
    }));
    return delay(po);
  }

  async fetchDemand(): Promise<DemandLine[]> {
    const demand: DemandLine[] = seed.demand.map((d) => ({
      partNum: PartId(d.partNum),
      reqDate: toDate(d.reqDate),
      reqQty: d.reqQty ?? 0,
    }));
    return delay(demand);
  }
}
