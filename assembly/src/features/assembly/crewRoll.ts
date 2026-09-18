/**
 * The two rolls in the crew column as a drop target.
 *
 * Marking somebody off used to mean finding their chip on a line, opening it
 * and ticking a box — three steps for the thing a supervisor does first, at
 * ten past seven, with the phone still in their hand. The names are already
 * on the board and the two answers are already lettered above them, so the
 * shortest way to say "Billy is not in" is to drag Billy into Absent.
 *
 * It is the same fact either way: the drop writes exactly what the tick box
 * writes, dated to today, and nothing else moves. Nobody is taken off an
 * order for being dragged out of Free — see `planStore.setWorkerAway`.
 */

export const CREW_ROLL_TYPE = 'crew-roll';

/** Which of the two rolls. `absent` is the one that stops the schedule. */
export type CrewRollKind = 'free' | 'absent';

export const crewRollDropId = (roll: CrewRollKind): string =>
  `${CREW_ROLL_TYPE}:${roll}`;

/** Unknown to @dnd-kit's data bag, which is typed `any` on both ends. */
type DragData = Record<string, unknown> | null | undefined;

/**
 * What a finished drag means, or nothing at all.
 *
 * Both ends are checked here rather than at the drop: a line dragged over a
 * roll, or a worker dropped on the heading beside one, are both "nothing", and
 * a drop that wrote an absence because the pointer was near enough is the kind
 * of write nobody thinks to look for afterwards.
 */
export function crewRollDrop(
  active: DragData,
  over: DragData,
): { workerId: string; away: boolean } | null {
  if (!active || !over) return null;
  if (active.type !== 'worker' || over.type !== CREW_ROLL_TYPE) return null;
  const workerId = String(active.workerId ?? '');
  if (!workerId) return null;
  const roll = over.roll;
  if (roll !== 'free' && roll !== 'absent') return null;
  return { workerId, away: roll === 'absent' };
}
