/**
 * A folded press's days — or PMD's, its presses added up — one column each:
 * as tall as the hours planned on the press against the hours it can run that
 * day, coloured by that share as an assembly line's strip is (see
 * `pressLoad`). Nothing on it is levelled or picked: the press plan is
 * Epicor's, and this board only reads it.
 */
import { formatShortDay } from '@/lib/time';
import { pressLoadBand } from '@/engine/assembly/workload';
import type { DayAxis } from './dayAxis';
import type { PressDayLoad } from './pressLoad';
import type { WeekSpan } from './weekFold';
import { range } from './ganttColumns';
import { LoadColumn, pctText } from './LineLoadStrip';

const hoursText = (hours: number) => `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} h`;

export function PressLoadStrip({
  days,
  spans,
  onOpen,
  axis,
  left,
  width,
  line,
}: {
  days: PressDayLoad[];
  spans: readonly WeekSpan[];
  /** Days `from` up to `to` were pressed — one day, or a folded week: list their orders. */
  onOpen: (from: number, to: number, at: { x: number; y: number }) => void;
  axis: DayAxis;
  left: number;
  width: number;
  line: string;
}) {
  const cell = (key: string, from: number, to: number, heading: string) => {
    const picked = days.slice(from, to);
    const hours = picked.reduce((n, d) => n + d.hours, 0);
    const change = picked.reduce((n, d) => n + d.changeHours, 0);
    const cap = picked.reduce((n, d) => n + d.capacity, 0);
    if (hours + change <= 0) return null;
    const presses = Math.max(...picked.map((d) => d.presses));
    const share = cap > 0 ? ((hours + change) / cap) * 100 : Infinity;
    const x = axis.offsets[from];
    return (
      <button
        type="button"
        key={key}
        className={`aline-day press${to - from > 1 ? ' week' : ''}${cap > 0 ? '' : ' idle'}`}
        style={{ left: x, width: axis.offsets[to] - x }}
        title={[
          `${line} · ${heading}: ${hours.toFixed(1)} h of orders` +
            (change > 0 ? ` + ${change.toFixed(1)} h changeover` : ''),
          cap > 0
            ? `${pctText(share)} of the ${cap.toFixed(0)} h ${presses === 1 ? 'the press' : `${presses} presses`} can run` +
              ' — 8 h a shift, for the shifts its orders are manned for'
            : 'No press time to read it against',
          'Click for the orders',
        ].join('\n')}
        onClick={(e) => onOpen(from, to, { x: e.clientX, y: e.clientY })}
      >
        <LoadColumn crewed={hours + change} waiting={0} capacity={cap} band={cap > 0 ? pressLoadBand(share) : 'idle'} />
        <span className="aline-figures">
          <b>{hoursText(hours + change)}</b>
        </span>
      </button>
    );
  };
  return (
    <div className="aline-load" style={{ left, width }}>
      {spans.map((span) =>
        span.folded
          ? cell(
              `week-${span.key}`,
              span.from,
              span.to,
              `${span.label} (${formatShortDay(span.first)}–${formatShortDay(span.last)})`,
            )
          : range(span.from, span.to).map((i) => cell(days[i].key, i, i + 1, formatShortDay(days[i].date))),
      )}
    </div>
  );
}
