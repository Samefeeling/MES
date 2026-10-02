/**
 * Reading and writing the one stored plan.
 *
 * The board used to write everything back on a 600 ms debounce, which meant
 * the plan was whoever had touched it last. Two supervisors working the same
 * week overwrote each other a keystroke at a time, and neither could tell
 * which board they were looking at.
 *
 * So the two halves of the plan are now written on two different triggers —
 * see `persistence/planParts.ts` for which is which:
 *
 *  - **Planning** is published by pressing **Save**. That makes this browser's
 *    version the one current plan. Until then it is a draft held here and
 *    nowhere else, and it is dropped — silently, by never having been written
 *    — when the board is refreshed or the page is left. Whoever saves last is
 *    the plan; everyone else's unsaved work goes.
 *
 *  - **Shift records** (production start, the shift's own bookings, and the
 *    days orders were last seen in an export) are written as they are made,
 *    onto whatever planning is current at that moment. The operator booking a
 *    shift is not the person deciding where the order sits, and their entry
 *    must not need anybody to press anything to survive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataStore } from '@/store/dataStore';
import { useIgnoredOrders } from '@/store/ignoredOrders';
import { usePlanStore } from '@/store/planStore';
import { toDayKey } from '@/lib/time';
import {
  CURRENT_PLAN_ID,
  createPlanRepository,
  dailyPlanId,
  joinPlan,
  mergeShiftRecords,
  planningFingerprint,
  planningOf,
  shiftRecordsOf,
  type PersistedPlan,
  type PlanningPart,
  type ShiftRecordPart,
} from '@/persistence';

const repo = createPlanRepository();

/** The name the working plan is stored under; there is only ever the one. */
const PLAN_NAME = 'Working plan';

/*
 * The two halves as the stores hold them this instant.
 *
 * Read straight out of the stores rather than out of a React ref, because
 * every caller below wants them *after* something has just been written to a
 * store — a bootstrap, a pull, a reconcile — and a ref assigned during render
 * is still one render behind at that point.
 */
const planningNow = (): PlanningPart => {
  const p = usePlanStore.getState();
  return {
    containers: p.containers,
    assembly: {
      ignoredOrderIds: useIgnoredOrders.getState().ids,
      lineLayoutVersion: p.lineLayoutVersion,
      manualOrders: p.manualOrders,
      workerLines: p.workerLines,
      virtualLines: p.virtualLines,
      lineNames: p.lineNames,
      lineOrder: p.lineOrder,
      crewPools: p.crewPools,
      orderCrewAssignments: p.orderCrewAssignments,
      orderStarts: p.orderStarts,
      orderOvertime: p.orderOvertime,
      orderDoubleBooked: p.orderDoubleBooked,
    },
  };
};

const recordsNow = (): ShiftRecordPart => {
  const p = usePlanStore.getState();
  return {
    assembly: {
      workerOnLeave: p.workerOnLeave,
      orderActualStarts: p.orderActualStarts,
      progress: p.progress,
      progressBaselines: p.progressBaselines,
      production: p.production,
      lastSeen: p.lastSeen,
    },
  };
};

/** Wait this long after the last shift record before writing it. */
const RECORD_DEBOUNCE_MS = 600;

/**
 * The local day an ISO timestamp falls on, for deciding whether a stored plan
 * was last written today or on an earlier day. A stored plan with no readable
 * time is treated as today's, which files nothing: better one unrecorded day
 * than a day of history filed under the wrong date.
 */
const dayOfIso = (at: string): string => {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? toDayKey(new Date()) : toDayKey(when);
};

/**
 * How the read of the stored plan went.
 *
 * `loaded` also covers a repository that has nothing stored yet — a new board
 * is not a failure. `failed` is the state nothing may be written from: the
 * board has been laid out from the export alone, with nobody allocated and no
 * pins, and writing that back would put it over the plan the repository is
 * still holding.
 */
export type StoredState = 'reading' | 'loaded' | 'failed';

export interface PlanPersistence {
  stored: StoredState;
  /** Why the last read or write failed, for the banner. */
  error: string | null;
  /** Kept apart from `error`: the plan saving is not the history filing. */
  archiveError: string | null;
  /** Planning edits are being held here and have not been published. */
  dirty: boolean;
  saving: boolean;
  /** True once the shift records have reached the repository at least once. */
  settled: boolean;
  /** Publish this browser's planning as the one current plan. */
  save: () => void;
  /** Take the stored current plan, dropping any unsaved planning held here. */
  pull: () => Promise<void>;
  /** Read the stored plan again after a failure. */
  retry: () => void;
}

const reason = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function usePlanPersistence(): PlanPersistence {
  const status = useDataStore((s) => s.status);
  const dataset = useDataStore((s) => s.dataset);

  const ignoredOrderIds = useIgnoredOrders((s) => s.ids);
  const containers = usePlanStore((s) => s.containers);
  const manualOrders = usePlanStore((s) => s.manualOrders);
  const lineLayoutVersion = usePlanStore((s) => s.lineLayoutVersion);
  const workerLines = usePlanStore((s) => s.workerLines);
  const virtualLines = usePlanStore((s) => s.virtualLines);
  const lineNames = usePlanStore((s) => s.lineNames);
  const lineOrder = usePlanStore((s) => s.lineOrder);
  const crewPools = usePlanStore((s) => s.crewPools);
  const orderCrewAssignments = usePlanStore((s) => s.orderCrewAssignments);
  const orderStarts = usePlanStore((s) => s.orderStarts);
  const orderOvertime = usePlanStore((s) => s.orderOvertime);
  const orderDoubleBooked = usePlanStore((s) => s.orderDoubleBooked);

  const workerOnLeave = usePlanStore((s) => s.workerOnLeave);
  const orderActualStarts = usePlanStore((s) => s.orderActualStarts);
  const progress = usePlanStore((s) => s.progress);
  const progressBaselines = usePlanStore((s) => s.progressBaselines);
  const production = usePlanStore((s) => s.production);
  const lastSeen = usePlanStore((s) => s.lastSeen);

  // Rebuilt whenever any slice it is made of changes; `planningNow` reads the
  // same slices back out of the store, so the two can never disagree.
  const planning: PlanningPart = useMemo(
    planningNow,
    [
      containers,
      ignoredOrderIds,
      lineLayoutVersion,
      manualOrders,
      workerLines,
      virtualLines,
      lineNames,
      lineOrder,
      crewPools,
      orderCrewAssignments,
      orderStarts,
      orderOvertime,
      orderDoubleBooked,
    ],
  );

  const records: ShiftRecordPart = useMemo(
    recordsNow,
    [
      workerOnLeave,
      orderActualStarts,
      progress,
      progressBaselines,
      production,
      lastSeen,
    ],
  );

  /**
   * The planning this browser last read or published — what a shift record
   * falls back onto when the repository cannot be read before writing it.
   */
  const published = useRef<PlanningPart | null>(null);

  const [stored, setStored] = useState<StoredState>('reading');
  const [error, setError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [settled, setSettled] = useState(false);
  /** Fingerprint of the planning that is on the repository, or null while
   *  it has not been read. Anything else on the board is a draft. */
  const [clean, setClean] = useState<string | null>(null);

  const bootstrapped = useRef(false);
  /**
   * The plan last written to `current`, and the local day it was written on.
   *
   * The working plan is one row that every write overwrites, so the state a
   * day closed in would be gone the moment the next one landed. This is what
   * makes a day's history: on the first write of a new day the previous day's
   * last stored plan is filed under its own id before it is overwritten, which
   * is both the record of what that day ended as and — because the board is
   * never reset overnight — the record of what this one started from.
   *
   * Seeded from the stored plan on the way in, so the first write after a
   * board is opened in the morning files what was left last night, whether or
   * not anybody had this tab open at midnight. Both writers go through
   * `store` below, so a day is filed whether it was a Save or a shift entry
   * that first touched the plan today.
   */
  const storedPlan = useRef<{ day: string; plan: PersistedPlan } | null>(null);
  /** A Save is in the air. The record write reads-then-writes, so letting the
   *  two overlap would put the planning read before the Save back over it. */
  const savingNow = useRef(false);
  const writeTimer = useRef<number | undefined>(undefined);
  const writeGeneration = useRef(0);
  const [attempt, setAttempt] = useState(0);

  /**
   * Write the working plan, filing yesterday's closing state first.
   *
   * Failing to file is not a reason to stop saving the plan itself: the
   * archive is for looking back, and a board that refused to work because it
   * could not write history would be the worse failure. It is said in its own
   * banner and the day is left unfiled.
   */
  const store = useCallback(async (plan: PersistedPlan): Promise<void> => {
    const today = toDayKey(new Date());
    const previous = storedPlan.current;
    if (previous && previous.day < today) {
      try {
        await repo.saveSnapshot({
          ...previous.plan,
          id: dailyPlanId(previous.day),
          name: `Plan on ${previous.day}`,
        });
        setArchiveError(null);
      } catch (e) {
        setArchiveError(reason(e));
      }
    }
    await repo.save(plan);
    storedPlan.current = { day: today, plan };
  }, []);

  /** Put a stored plan's planning half on the board. */
  const adopt = useCallback((part: PlanningPart) => {
    const plan = usePlanStore.getState();
    plan.setContainers(part.containers);
    plan.setAssemblyPlan(part.assembly);
    if (part.assembly.ignoredOrderIds) {
      useIgnoredOrders.setState({ ids: part.assembly.ignoredOrderIds });
    }
  }, []);

  /**
   * Take the board as it stands to be the published plan.
   *
   * Called after the reconcile rather than before it. Filing this export's
   * orders onto their lines is something the board does to itself on every
   * load, and a board that counted that as an unsaved edit would open asking
   * to be saved before anybody had touched it.
   */
  const markClean = useCallback(() => {
    const part = planningNow();
    published.current = part;
    setClean(planningFingerprint(part));
  }, []);

  // Read the stored plan once, then lay the export over it.
  useEffect(() => {
    if (status !== 'ready' || !dataset) return;
    const plan = usePlanStore.getState();
    if (bootstrapped.current) {
      plan.reconcile(dataset.workCenters, dataset.jobs, undefined, dataset.jobLinks);
      return;
    }
    bootstrapped.current = true;
    repo
      .load()
      .then((persisted) => {
        if (persisted) {
          storedPlan.current = { day: dayOfIso(persisted.savedAt), plan: persisted };
          adopt(planningOf(persisted));
          plan.setAssemblyPlan(shiftRecordsOf(persisted).assembly);
        }
        plan.reconcile(dataset.workCenters, dataset.jobs, undefined, dataset.jobLinks);
        markClean();
        setStored('loaded');
        setError(null);
      })
      .catch((e) => {
        // Still lay the board out, so the export is readable while the
        // repository is unreachable — but say so, and write nothing.
        plan.reconcile(dataset.workCenters, dataset.jobs, undefined, dataset.jobLinks);
        setStored('failed');
        setError(reason(e));
      });
  }, [status, dataset, attempt, adopt, markClean]);

  /*
   * Write the shift's own records, debounced.
   *
   * They are landed on whatever planning the repository currently holds
   * rather than on this browser's draft of it, so booking a shift never
   * publishes the planning draft sitting underneath it. When the repository
   * cannot be read first, the last planning this browser read or published is
   * used: it is the newest one that can be proved, and losing the shift's
   * entry over a failed read would be the worse of the two trades.
   */
  useEffect(() => {
    if (stored !== 'loaded') return;
    setSettled(false);
    const generation = ++writeGeneration.current;

    const write = async (): Promise<void> => {
      // Wait out a Save rather than racing it: Save is writing these same
      // records anyway, and a planning read taken before it landed would be
      // written straight back over it.
      if (savingNow.current) {
        writeTimer.current = window.setTimeout(() => void write(), RECORD_DEBOUNCE_MS);
        return;
      }
      let base = published.current;
      let storedRecords: ShiftRecordPart | null = null;
      try {
        const current = await repo.load();
        if (current) {
          base = planningOf(current);
          storedRecords = shiftRecordsOf(current);
        }
      } catch {
        /* keep the last planning this browser can prove */
      }
      if (!base) return;
      try {
        // Bookings made on other boards since this one last read the plan are
        // kept, not overwritten — see mergeShiftRecords.
        await store(joinPlan(CURRENT_PLAN_ID, PLAN_NAME, base, mergeShiftRecords(records, storedRecords)));
        if (generation === writeGeneration.current) {
          setError(null);
          setSettled(true);
        }
      } catch (e) {
        setError(reason(e));
        setStored('failed');
      }
    };

    window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(() => void write(), RECORD_DEBOUNCE_MS);
    return () => window.clearTimeout(writeTimer.current);
  }, [records, stored, store]);

  const save = useCallback(() => {
    if (stored !== 'loaded' || saving) return;
    const part = planningNow();
    savingNow.current = true;
    setSaving(true);
    // Planning is this board's to publish whole; the shift records under it
    // keep what other boards have booked since (see mergeShiftRecords).
    void repo
      .load()
      .then((current) => (current ? shiftRecordsOf(current) : null), () => null)
      .then((storedRecords) =>
        store(joinPlan(CURRENT_PLAN_ID, PLAN_NAME, part, mergeShiftRecords(recordsNow(), storedRecords))),
      )
      .then(() => {
        published.current = part;
        setClean(planningFingerprint(part));
        setError(null);
      })
      .catch((e) => setError(reason(e)))
      .finally(() => {
        savingNow.current = false;
        setSaving(false);
      });
  }, [stored, saving, store]);

  const pull = useCallback(async () => {
    // Only from a board that read the stored plan in the first place. A failed
    // read left the shift's own records unread as well, so promoting it to
    // "loaded" here would start the record write on an empty board and put
    // that over the bookings the repository is still holding. `retry` is the
    // way back from a failed read.
    if (stored !== 'loaded') return;
    try {
      const current = await repo.load();
      if (current) {
        adopt(planningOf(current));
        // The export has moved on while that plan was stored, so file this
        // one's orders against it before anybody reads the board.
        const data = useDataStore.getState().dataset;
        if (data) usePlanStore.getState().reconcile(data.workCenters, data.jobs, undefined, data.jobLinks);
      }
      // Clean either way: with a stored plan the board is now it, and with
      // none there is nothing for a draft to be a draft against.
      markClean();
      setError(null);
    } catch (e) {
      setError(reason(e));
    }
  }, [adopt, markClean, stored]);

  const retry = useCallback(() => {
    bootstrapped.current = false;
    setStored('reading');
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const dirty =
    stored === 'loaded' && clean !== null && planningFingerprint(planning) !== clean;

  return { stored, error, archiveError, dirty, saving, settled, save, pull, retry };
}
