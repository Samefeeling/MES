/**
 * The Free and On Leave rolls in the crew column, and the names in them.
 *
 * Each roll is a drop target and each name is a grip, so a person is moved
 * between the two by dragging: out of Free into On Leave when they ring in,
 * back the other way when they turn up after all. The same drag also still
 * lands on a line, which is how somebody is moved between benches — one
 * gesture, three places worth dropping it.
 *
 * Marking somebody off used to mean finding their chip on a line, opening it
 * and ticking a box — three steps for the thing a supervisor does first, at
 * ten past seven, with the phone still in their hand. The names are already on
 * the board and the two answers are already lettered above them.
 *
 * It is the same fact either way: the drop writes exactly what the tick box
 * writes, dated to today, and nothing else moves. Nobody is taken off an order
 * for being dragged out of Free — see `planStore.setWorkerOnLeave`.
 */

import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { ReactNode } from 'react';
import type { Worker } from '@/domain/assembly';

export const CREW_ROLL_TYPE = 'crew-roll';

/** Which of the two rolls. `onLeave` is the one that stops the schedule. */
export type CrewRollKind = 'free' | 'onLeave';

export const crewRollDropId = (roll: CrewRollKind): string =>
  `${CREW_ROLL_TYPE}:${roll}`;

/** Unknown to @dnd-kit's data bag, which is typed `any` on both ends. */
type DragData = Record<string, unknown> | null | undefined;

/**
 * What a finished drag means, or nothing at all.
 *
 * Both ends are checked here rather than at the drop: a line dragged over a
 * roll, or a worker dropped on the heading beside one, are both "nothing", and
 * a drop that wrote a day off because the pointer was near enough is the kind
 * of write nobody thinks to look for afterwards.
 */
export function crewRollDrop(
  active: DragData,
  over: DragData,
): { workerId: string; onLeave: boolean } | null {
  if (!active || !over) return null;
  if (active.type !== 'worker' || over.type !== CREW_ROLL_TYPE) return null;
  const workerId = String(active.workerId ?? '');
  if (!workerId) return null;
  const roll = over.roll;
  if (roll !== 'free' && roll !== 'onLeave') return null;
  return { workerId, onLeave: roll === 'onLeave' };
}

export function CrewRoll({
  roll,
  label,
  listTitle,
  empty,
  count,
  children,
}: {
  roll: CrewRollKind;
  label: string;
  /** The whole list, for the hover — the strip itself is one line and scrolls. */
  listTitle: string;
  /** What the roll says when there is nobody in it. */
  empty: string;
  count: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: crewRollDropId(roll),
    data: { type: CREW_ROLL_TYPE, roll },
  });
  // Only lit while a person is in the air. A roll outlined during a bar drag
  // would be offering something it cannot take.
  const offered = active?.data.current?.type === 'worker';
  return (
    <div
      ref={setNodeRef}
      className={`team-roll ${offered ? 'offered' : ''} ${isOver ? 'taking' : ''}`}
    >
      <b className="team-roll-label">{label}</b>
      <span
        className={`team-names ${count === 0 ? 'none' : ''}`}
        title={listTitle}
        aria-live="polite"
      >
        {count === 0 ? empty : children}
      </span>
    </div>
  );
}

export function CrewName({
  worker,
  roll,
  className,
  title,
  onClick,
  draggable,
  children,
}: {
  worker: Worker;
  roll: CrewRollKind;
  className: string;
  title: string;
  /** Set only where the name leads somewhere — the hand-over queue. */
  onClick?: () => void;
  draggable: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${crewRollDropId(roll)}:${String(worker.id)}`,
    disabled: !draggable,
    data: { type: 'worker', workerId: String(worker.id) },
  });
  // Nothing is spread while the board is locked: a name that takes focus and
  // announces itself as a button, then does nothing, is worse than a name.
  const grip = draggable ? { ...listeners, ...attributes } : {};
  const classes =
    `${className} ${draggable ? 'grippable' : ''} ${isDragging ? 'lifted' : ''}`;
  return onClick ? (
    <button
      type="button"
      ref={setNodeRef}
      className={classes}
      title={title}
      onClick={onClick}
      {...grip}
    >
      {children}
    </button>
  ) : (
    <span ref={setNodeRef} className={classes} title={title} {...grip}>
      {children}
    </span>
  );
}
