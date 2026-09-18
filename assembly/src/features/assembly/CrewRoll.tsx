/**
 * The Free and Absent rolls in the crew column, and the names in them.
 *
 * Each roll is a drop target and each name is a grip, so a person can be moved
 * between the two by dragging: out of Free into Absent when they ring in, back
 * the other way when they turn up after all. The same drag also still lands on
 * a line, which is how somebody is moved between benches — one gesture, three
 * places worth dropping it.
 */

import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { ReactNode } from 'react';
import type { Worker } from '@/domain/assembly';
import { CREW_ROLL_TYPE, crewRollDropId, type CrewRollKind } from './crewRoll';

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
