/**
 * A line's load, day by day, against the people on it — the strip under the
 * line's header, and the columns the day's detail is drawn with.
 */
import { formatShortDay } from '@/lib/time';
import type { LineKey } from '@/domain/assembly';
import type { LineCapacity } from './crewCapacity';
import { loadBand } from '@/engine/assembly/workload';
import { isClosed, isWeekend } from '@/engine/assembly/dates';
import type { DayAxis } from './dayAxis';
import type { DayOrderEntry, LineDayLoad } from './boardView';
import { loadPickKey } from './levelLoad';
import type { WeekSpan } from './weekFold';
import { range } from './ganttColumns';

const hoursText = (hours: number) =>
  `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} h`;

/** A load as a percentage, or what stands in for one with nothing to divide by. */
export const pctText = (pct: number) => (Number.isFinite(pct) ? `${Math.round(pct)}%` : 'no crew');

/**
 * A folded line's days, one column each: as tall as the line's hours are
 * against what the crews it draws on can work that day, coloured by that
 * share. The figures in it are the hours with people on them, and — in blue —
 * the hours of orders nobody is on yet that have to be worked that day to make
 * their Due Date. A folded week is one column for the week.
 */
export function LineLoadStrip({
  days,
  capacity,
  spans,
  onOpen,
  axis,
  left,
  width,
  line,
  lineKey,
  picks,
  onPick,
  onLevel,
}: {
  days: LineDayLoad[];
  capacity: (LineCapacity | undefined)[];
  spans: readonly WeekSpan[];
  /** Days `from` up to `to` were pressed — one day, or a folded week: list their orders. */
  onOpen: (from: number, to: number, at: { x: number; y: number }) => void;
  axis: DayAxis;
  left: number;
  width: number;
  line: string;
  lineKey: LineKey;
  /** Picked for level loading: `line|day`. */
  picks: ReadonlySet<string>;
  onPick: (keys: string[]) => void;
  onLevel: (keys: string[], at: { x: number; y: number }) => void;
}) {
  const cell = (
    key: string,
    from: number,
    to: number,
    heading: string,
    detail: string[],
  ) => {
    const picked = days.slice(from, to);
    const hours = picked.reduce((n, d) => n + d.hours, 0);
    const waiting = picked.reduce((n, d) => n + d.unstaffedHours, 0);
    const crews = capacity.slice(from, to).filter((c): c is LineCapacity => Boolean(c) && c!.pct !== null);
    const cap = crews.reduce((n, c) => n + c.capacity, 0);
    const pool = crews.reduce((n, c) => n + c.demand, 0);
    const share = cap > 0 ? ((hours + waiting) / cap) * 100 : Infinity;
    const x = axis.offsets[from];
    // A week is picked as its days, so the pick outlives a zoom.
    const pickKeys = picked.map((d) => loadPickKey(lineKey, d.key));
    const isPicked = pickKeys.length > 0 && pickKeys.every((k) => picks.has(k));
    if (hours <= 0 && waiting <= 0) {
      // Nothing on it, but a day to come the crew works is room to level
      // into: it can still be picked. So is a weekend — it is only on the
      // board when the Weekends switch is on, which is turned on to plan
      // overtime; work levelled onto it goes with overtime approved.
      if (!picked.some((d) => !d.past && (!isClosed(d.date) || isWeekend(d.date)))) return null;
      const weekend = picked.every((d) => isWeekend(d.date));
      return (
        <button
          type="button"
          key={key}
          className={`aline-day empty${to - from > 1 ? ' week' : ''}${weekend ? ' weekend' : ''}${isPicked ? ' picked' : ''}`}
          style={{ left: x, width: axis.offsets[to] - x }}
          title={[
            `${line} · ${heading}: nothing planned`,
            weekend
              ? 'Weekend — overtime: picked and levelled, work goes onto it with weekend overtime approved, at the crews’ ordinary day'
              : crews.length > 0
                ? `${cap.toFixed(1)} h ${crews[0].pools.join(' + ')} can work`
                : 'No crew group lists this line — set one under Crew capacity',
            'Ctrl + click to pick it as room to level into, right-click to level the picked loads',
          ].join('\n')}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) onPick(pickKeys);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onLevel(pickKeys, { x: e.clientX, y: e.clientY });
          }}
        />
      );
    }
    return (
      <button
        type="button"
        key={key}
        className={`aline-day${to - from > 1 ? ' week' : ''}${crews.length === 0 ? ' idle' : ''}${isPicked ? ' picked' : ''}`}
        style={{ left: x, width: axis.offsets[to] - x }}
        title={[
          `${line} · ${heading}: ${hours.toFixed(1)} h with people on it`,
          ...detail,
          ...(waiting > 0 ? [`${waiting.toFixed(1)} h (blue) of orders waiting for a crew, to be worked by their Due Date`] : []),
          picked.every((d) => isWeekend(d.date))
            ? 'Weekend — overtime: no crew is rostered, so it is not read against capacity'
            : crews.length > 0
              ? `${pctText(share)} of the ${cap.toFixed(1)} h ${crews[0].pools.join(' + ')} can work` +
                ` · the crew as a whole is at ${pctText((pool / cap) * 100)}`
              : 'No crew group lists this line — set one under Crew capacity',
          'Click for the orders · Ctrl + click to pick it, right-click to level the picked loads',
        ].join('\n')}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            onPick(pickKeys);
            return;
          }
          onOpen(from, to, { x: e.clientX, y: e.clientY });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onLevel(pickKeys, { x: e.clientX, y: e.clientY });
        }}
      >
        <LoadColumn
          crewed={hours}
          waiting={waiting}
          capacity={cap}
          band={crews.length > 0 ? loadBand(share) : 'idle'}
        />
        <span className="aline-figures">
          {hours > 0 && <b>{hoursText(hours)}</b>}
          {waiting > 0 && <span className="aline-wait">{hoursText(waiting)}</span>}
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
              [],
            )
          : range(span.from, span.to).map((i) => {
              const day = days[i];
              return cell(
                day.key,
                i,
                i + 1,
                formatShortDay(day.date),
                day.orders.length
                  ? [
                      `${day.people} ${day.people === 1 ? 'person' : 'people'}, ` +
                        `${day.orders.length} of ${day.positions} positions (${day.orders.join(', ')})`,
                    ]
                  : [],
              );
            }),
      )}
    </div>
  );
}

/** What a pressed day lists: a heading, its figures, and the orders by line. */
export interface DayDetailContent {
  title: string;
  summary: string;
  groups: { name: string; entries: DayOrderEntry[] }[];
  /** Set for one whole day on every line: the board can be narrowed to it. */
  day?: string;
}

/**
 * A load as a column: as tall as the hours asked are against the hours the
 * crews can work. Solid in the day's band for work with people on it, blue on
 * top for orders nobody is on yet. Past capacity the column is scaled to fit
 * and a tick marks where capacity sits, so what is over reads above it.
 */
export function LoadColumn({
  crewed,
  waiting,
  capacity,
  band,
  label,
}: {
  crewed: number;
  waiting: number;
  capacity: number;
  band: string;
  label?: string;
}) {
  const asked = crewed + waiting;
  const scale = Math.max(asked, capacity) || 1;
  const pct = (h: number) => `${Math.min(100, (h / scale) * 100)}%`;
  return (
    <span className={`load-col ${band}`}>
      <i className="lc-crewed" style={{ height: pct(crewed) }} />
      <i className="lc-waiting" style={{ bottom: pct(crewed), height: pct(waiting) }} />
      {asked > capacity && capacity > 0 && <i className="lc-cap" style={{ bottom: pct(capacity) }} />}
      {label && <b className="lc-label">{label}</b>}
    </span>
  );
}
