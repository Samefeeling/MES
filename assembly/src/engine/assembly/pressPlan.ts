/**
 * The moulding plan as a sequence per press, with the changeover between each
 * pair of orders worked out and given its time.
 *
 * Between two orders on one press:
 *
 *   different die                 Die Change, 4 h — "Die 123 → Die 456"
 *   same die, different size      Insert Change, 30 min — the size the
 *                                 description names ("460h", "Size 3")
 *   same die, same size           Colour Change, 30 min — a colour change
 *                                 leaves the rest of the description alone
 *   same part again               nothing
 *
 * The allowances are the floor's standards, the same ones the PMD KPIs judge
 * a changeover against (`src/core/standards.ts` on the PMD side). Where the die
 * of either part is not known the two are taken to need a die change — the
 * expensive answer, because assuming a 30-minute swap on an unknown tool is
 * how a press plan comes out four hours optimistic. On the same die the size
 * decides: an insert field where the source has one, else every height and
 * size the part description carries. Two parts naming the same size — or
 * neither naming one — differ by colour.
 *
 * The changeover goes straight after the order before it. Epicor plans the
 * presses back to back, so where the gap to the next order is shorter than the
 * changeover the next order — and everything behind it on that press — moves
 * back by the difference; where the planner left room for it, nothing moves.
 *
 * Pure. No React, no store.
 */

import type { Job, PressChange, PressChangeKind } from '@/domain/types';

export const CHANGE_HOURS: Record<PressChangeKind, number> = {
  die: 4,
  insert: 0.5,
  colour: 0.5,
};

export const CHANGE_NAME: Record<PressChangeKind, string> = {
  die: 'Die Change',
  insert: 'Insert Change',
  colour: 'Colour Change',
};

/** On a bar, where the room is short — the PMD sheet's own D / I / C. */
export const CHANGE_SHORT: Record<PressChangeKind, string> = {
  die: 'DC',
  insert: 'IC',
  colour: 'CC',
};

const HOUR = 3_600_000;

const key = (v: string | null | undefined): string | null => {
  const k = (v ?? '').trim().toLowerCase();
  return k === '' ? null : k;
};

/**
 * The size a part description names, as one comparable key: every height
 * ("460h", "350 h") and size ("Size 3") in it, in order. Null with none — two
 * parts that both name no size are the same size as far as anyone can tell.
 */
export function sizeOf(description: string | null | undefined): string | null {
  const text = description ?? '';
  const found = [
    ...[...text.matchAll(/\b(\d{2,4})\s*h\b/gi)].map((m) => `${m[1]}h`),
    ...[...text.matchAll(/\bsize\s*([0-9a-z]+)\b/gi)].map((m) => `size${m[1].toLowerCase()}`),
  ];
  return found.length > 0 ? found.join('|') : null;
}

const dieOf = (job: Job): string | null => job.press?.die ?? (job.tool ? String(job.tool) : null);

const sameDie = (a: Job, b: Job): boolean => {
  const da = key(dieOf(a));
  return da !== null && da === key(dieOf(b));
};

/** The changeover `next` needs after `prev` on the same press, or null for none. */
export function changeBetween(prev: Job, next: Job): PressChange | null {
  if (String(prev.partNum) === String(next.partNum)) return null;
  const fromDie = dieOf(prev);
  const toDie = dieOf(next);
  const fromColor = prev.press?.color ?? null;
  const toColor = next.press?.color ?? null;
  let kind: PressChangeKind;
  if (!key(fromDie) || !key(toDie) || key(fromDie) !== key(toDie)) kind = 'die';
  else {
    // The size is the insert: an insert field where the source has one, else
    // the size the description carries ("460h", "Size 3"). Only the colour
    // changing leaves the rest of the description as it was.
    const fromSize = key(prev.press?.insert) ?? sizeOf(prev.description);
    const toSize = key(next.press?.insert) ?? sizeOf(next.description);
    kind = fromSize !== toSize ? 'insert' : 'colour';
  }
  return {
    kind,
    hours: CHANGE_HOURS[kind],
    fromJob: String(prev.id),
    toJob: String(next.id),
    fromDie,
    toDie,
    fromColor,
    toColor,
  };
}

/** "Die Change · Die 123 → Die 456", "Colour Change · Black → Slate". */
export function changeLabel(change: PressChange): string {
  const die = (d: string | null) => (d ? `Die ${d}` : 'Die ?');
  if (change.kind === 'die') {
    // Neither die known: say why it is a die change rather than print "? → ?".
    if (!change.fromDie && !change.toDie) return `${CHANGE_NAME.die} · dies not in PMD_ProductDieColor`;
    return `${CHANGE_NAME.die} · ${die(change.fromDie)} → ${die(change.toDie)}`;
  }
  if (change.kind === 'colour') {
    return `${CHANGE_NAME.colour} · ${change.fromColor ?? '?'} → ${change.toColor ?? '?'}`;
  }
  return `${CHANGE_NAME.insert} · ${die(change.toDie)}`;
}

export interface PressRun {
  job: Job;
  start: Date;
  end: Date;
  /** How far a changeover in front of it pushed it back, in hours. */
  pushedHours: number;
}

export interface PressSlot {
  change: PressChange;
  start: Date;
  end: Date;
}

export interface PressSequence {
  machine: string;
  runs: PressRun[];
  changes: PressSlot[];
}

/** When an order is planned to run: Epicor's start to its end, else its hours from the start. */
function plannedRun(job: Job): { start: Date; end: Date } | null {
  const start = job.startDate ?? job.dueDate;
  if (!start) return null;
  const end = job.press?.end;
  if (end && end.getTime() > start.getTime()) return { start, end };
  const hours = Math.max(job.laborHrs, 0.25);
  return { start, end: new Date(start.getTime() + hours * HOUR) };
}

/**
 * Every press that has an order, its orders in the order Epicor runs them, and
 * the changeovers between them. A press with nothing on it is not here.
 */
export function planPresses(jobs: readonly Job[]): PressSequence[] {
  const byMachine = new Map<string, { job: Job; start: Date; end: Date }[]>();
  for (const job of jobs) {
    const machine = job.press?.machine;
    if (job.department !== 'moulding' || !machine) continue;
    const run = plannedRun(job);
    if (!run) continue;
    const held = byMachine.get(machine);
    const entry = { job, ...run };
    if (held) held.push(entry);
    else byMachine.set(machine, [entry]);
  }

  const out: PressSequence[] = [];
  for (const [machine, planned] of byMachine) {
    planned.sort(
      (a, b) => a.start.getTime() - b.start.getTime() || String(a.job.id).localeCompare(String(b.job.id)),
    );
    const runs: PressRun[] = [];
    const changes: PressSlot[] = [];
    /** The order the next one follows, as Epicor planned it and as it now runs. */
    let last: { job: Job; plannedEnd: number; run: PressRun } | null = null;
    for (const p of planned) {
      const length = p.end.getTime() - p.start.getTime();
      // Two orders Epicor overlaps on one die are a co-run — parts that share
      // the tool and come out of the same shot — not a queue: no changeover,
      // and the second moves only as far as the first did.
      if (last && p.start.getTime() < last.plannedEnd && sameDie(last.job, p.job)) {
        const shift: number = last.run.pushedHours * HOUR;
        const start: Date = new Date(p.start.getTime() + shift);
        const run: PressRun = { job: p.job, start, end: new Date(start.getTime() + length), pushedHours: last.run.pushedHours };
        runs.push(run);
        if (run.end.getTime() > last.run.end.getTime()) last = { job: p.job, plannedEnd: p.end.getTime(), run };
        continue;
      }
      let ready = -Infinity;
      if (last) {
        ready = last.run.end.getTime();
        const change = changeBetween(last.job, p.job);
        if (change) {
          const from = last.run.end;
          const to = new Date(from.getTime() + change.hours * HOUR);
          changes.push({ change, start: from, end: to });
          ready = to.getTime();
        }
      }
      const startMs = Math.max(p.start.getTime(), ready);
      const run: PressRun = {
        job: p.job,
        start: new Date(startMs),
        end: new Date(startMs + length),
        pushedHours: (startMs - p.start.getTime()) / HOUR,
      };
      runs.push(run);
      last = { job: p.job, plannedEnd: p.end.getTime(), run };
    }
    out.push({ machine, runs, changes });
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine, undefined, { numeric: true }));
}

/**
 * How many shifts a "No of shift" value crews the press for: one letter a
 * shift (M or D, A, N — "MAN" is three), or the count written as a number.
 * Null for anything else, which is shown as written rather than guessed at.
 */
export function shiftCount(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters || /[^MDAN]/.test(letters)) return null;
  const shifts = new Set([...letters].map((l) => (l === 'D' ? 'M' : l)));
  return shifts.size;
}

/** "MAN · 3 shifts", "2 shifts", or the cell as written when it reads as neither. */
export function shiftText(raw: string | null): string | null {
  if (!raw) return null;
  const n = shiftCount(raw);
  if (n === null) return raw;
  const count = `${n} shift${n === 1 ? '' : 's'}`;
  return /^\d+$/.test(raw.trim()) ? count : `${raw.trim().toUpperCase()} · ${count}`;
}
