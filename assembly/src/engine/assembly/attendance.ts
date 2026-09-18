/**
 * Who is not here today, and what that costs the board.
 *
 * Attendance used to be a fact about the *roster* and nothing else: somebody
 * marked off vanished from the line's name strip, from the crew picker and
 * from the "11 of 14" ratio — and stayed exactly where they were on the two
 * orders they were half-way through. The bar kept its length, the Expect Date
 * kept the hours they were not going to work, and the order that had nobody
 * but them on it was neither running nor anywhere on the list of orders
 * waiting for a crew. It simply sat there.
 *
 * So absence belongs here, on the supply side of the schedule, in the one
 * shape the day planner already understands: a day this person gives the
 * order nothing. Everything downstream then tells the truth by itself — three
 * hands become two and the bar lengthens, the last hand goes and the bar shows
 * the gap, and the board's load histogram loses the shift it was counting on.
 *
 * Nobody is taken off an order for being away. A half-built order belongs to
 * whoever was building it; a day off is not a hand-over, and deciding who
 * picks it up is the supervisor's call — the board's job is only to make the
 * hole impossible to miss.
 *
 * Three things can say someone is away, and they mean slightly different
 * things:
 *
 *  - `plannedLeave` on the roster — booked annual leave, known in advance and
 *    dated, so it applies on whichever day it names.
 *  - `onShift: false` — the roster's own attendance flag, which is only ever
 *    about today: the list is read fresh each morning and carries no history.
 *  - `absence` here — somebody marked off on the board, which is what the
 *    phone call at ten past seven produces. Dated, because a supervisor who
 *    knows on Monday that Tuesday is a hospital appointment should be able to
 *    say so on Monday.
 *
 * Pure. No React, no store.
 */

import type { Worker } from '@/domain/assembly';
import { toDayKey } from '@/lib/time';

/** Worker id → the local days they are away, as marked on the board. */
export type AbsenceDays = Readonly<Record<string, readonly string[]>>;

/**
 * Is this person away on `day`?
 *
 * `todayKey` is needed because `onShift` is undated — it is the roster's
 * answer for the shift being worked now, and reading it as an answer about
 * next Thursday would strike somebody off a week they will be at work for.
 */
export function isAwayOn(
  worker: Worker,
  day: string,
  absence: AbsenceDays,
  todayKey: string,
): boolean {
  if (absence[String(worker.id)]?.includes(day)) return true;
  if (worker.plannedLeave?.includes(day)) return true;
  return !worker.onShift && day === todayKey;
}

/**
 * The same question for the whole roster, asked once.
 *
 * The day planner asks it per person per day across every order on the board,
 * so the roster is indexed here rather than scanned each time. Somebody the
 * roster has never heard of is not away: a crew can carry an id the current
 * export no longer lists, and guessing that they are absent would quietly
 * stop an order the board has no business stopping.
 */
export function awayOnDay(
  workers: readonly Worker[],
  absence: AbsenceDays,
  today: Date,
): (workerId: string, day: string) => boolean {
  const todayKey = toDayKey(today);
  const byId = new Map(workers.map((worker) => [String(worker.id), worker]));
  return (workerId, day) => {
    const worker = byId.get(workerId);
    return worker ? isAwayOn(worker, day, absence, todayKey) : false;
  };
}

/** Everyone on the roster who is away on `day`, in roster order. */
export function awayWorkers(
  workers: readonly Worker[],
  absence: AbsenceDays,
  today: Date,
  day: string = toDayKey(today),
): Worker[] {
  const todayKey = toDayKey(today);
  return workers.filter((worker) =>
    isAwayOn(worker, day, absence, todayKey),
  );
}

/**
 * Mark somebody away, or take the mark off — returning the whole map.
 *
 * Days older than `keepFrom` go with it. The board keeps a fortnight of plan
 * behind it and this is the same kind of record; a year of "Tom was off on the
 * 3rd" is nothing anyone will ever ask the board again.
 */
export function withAbsence(
  absence: AbsenceDays,
  workerId: string,
  day: string,
  away: boolean,
  keepFrom: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [id, days] of Object.entries(absence)) {
    const kept = days.filter(
      (each) => each >= keepFrom && !(id === workerId && each === day),
    );
    if (kept.length > 0) next[id] = kept;
  }
  if (away) next[workerId] = [...(next[workerId] ?? []), day].sort();
  return next;
}
