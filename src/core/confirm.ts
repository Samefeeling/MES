// ---------------------------------------------------------------------
// Confirmed-tuple registry — the anti-garbage gate for the live mirror.
//
// The floor's junk-data problem: browsing presses/orders used to leave
// half-created (machine, shift, job) tuples behind (an auto-carried
// Count Start, a co-run seeded timeline), and the 60 s live mirror then
// broadcast them to PMD_LiveStatus forever. The fix is an explicit
// operator confirmation: after picking machine + order + operator +
// supervisor, the worker taps ✅ Confirm — only THEN does the tuple
// become eligible for the live mirror, auto-carries, and grid entry.
// Unconfirmed selections are discarded when the worker navigates away.
//
// The registry is per-device (localStorage): confirmation is a statement
// by THIS iPad's worker that this press is really running this order.
// Keys are `machine|shiftId|job`; entries self-prune once the shift date
// is more than PRUNE_DAYS old, so the list never grows unbounded.
// ---------------------------------------------------------------------

const STORE_KEY = 'pmd_confirmed_tuples_v1';
const PRUNE_DAYS = 3;

export function confirmKey(machineCode: string, shiftId: string, jobNumber: string): string {
  return `${machineCode}|${shiftId}|${jobNumber}`;
}

/** Drop keys whose shiftId date is more than PRUNE_DAYS before `today`
 *  (YYYY-MM-DD). Pure — exported for tests. Malformed keys are dropped. */
export function pruneConfirmedKeys(keys: string[], today: string): string[] {
  const cutoff = new Date(`${today}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - PRUNE_DAYS);
  return keys.filter((k) => {
    const m = /^[^|]+\|(\d{4}-\d{2}-\d{2})-[^|]+\|.+$/.exec(k);
    if (!m) return false;
    const d = new Date(`${m[1]}T00:00:00`);
    return isFinite(d.getTime()) && d >= cutoff;
  });
}

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function save(keys: Set<string>): void {
  try {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify(pruneConfirmedKeys(Array.from(keys), todayStr)),
    );
  } catch {
    /* storage blocked — confirmation then only lasts the session */
  }
}

/** True when this device's worker confirmed (machine, shift, job). */
export function isTupleConfirmed(
  machineCode: string,
  shiftId: string,
  jobNumber: string,
): boolean {
  if (typeof localStorage === 'undefined') return true; // node tests / no storage: no gate
  return load().has(confirmKey(machineCode, shiftId, jobNumber));
}

export function confirmTuple(machineCode: string, shiftId: string, jobNumber: string): void {
  if (typeof localStorage === 'undefined') return;
  const keys = load();
  keys.add(confirmKey(machineCode, shiftId, jobNumber));
  save(keys);
}

/** Presses OTHER than `currentMachine` that are already running `job`,
 *  judged from cross-machine production rows (one shift's worth). A die is
 *  unique, so the same order can't legitimately run on two presses at once
 *  — the operator UI warns on confirm when this returns anything. "Running"
 *  means the row carries real evidence: a machine-status letter or a
 *  signed-off lock, never a bare browse selection. Pure, deduped, sorted;
 *  exported for tests. */
export function pressesRunningJobElsewhere(
  rows: ReadonlyArray<{
    machineCode: string;
    jobNumber: string;
    statusCode?: string;
    locked?: boolean;
  }>,
  currentMachine: string,
  job: string,
): string[] {
  if (!job) return [];
  const machines = new Set<string>();
  for (const r of rows) {
    if (r.machineCode === currentMachine || r.jobNumber !== job) continue;
    if (r.statusCode || r.locked) machines.add(r.machineCode);
  }
  return [...machines].sort();
}
