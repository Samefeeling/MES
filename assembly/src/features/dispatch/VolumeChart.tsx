/**
 * Volume leaving per day (or week), stacked by route, against the
 * marshalling area's daily capacity.
 *
 * One axis, m³. Columns are capped at 24px with a 2px gap between stacked
 * segments and a rounded top; the hit target is the whole band, which also
 * selects the day or week below. Every value in the tooltip is also in the
 * weekly table or the day strip, so hovering is never the only way to read it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DISPATCH_MODE_LABEL, type DispatchMode } from '@/domain/dispatch';
import { MODES, isoWeek, type Bucket } from './summary';
import { m3, pct, shortDay, weekdayOf } from './format';

const HEIGHT = 260;
const MARGIN = { top: 26, right: 16, bottom: 44, left: 52 };
const GAP = 2;
/** Matches the MES charts' `rx=3` bar ends. */
const RADIUS = 3;
const MAX_BAR = 24;

/** Round up to 1, 2, 2.5 or 5 × a power of ten, and the tick step. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 10, step: 2.5 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
}

/** A column segment whose top corners are rounded. */
export function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function VolumeChart({
  buckets,
  by,
  capacityM3,
  selected,
  today,
  onSelect,
}: {
  buckets: Bucket[];
  by: 'day' | 'week';
  /** Daily marshalling capacity; drawn as a reference line on the daily view. */
  capacityM3: number;
  selected: string | null;
  today: string;
  onSelect: (key: string) => void;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [by, buckets.length]);

  const showCapacity = by === 'day' && capacityM3 > 0;
  const peak = Math.max(0, ...buckets.map((b) => b.total), showCapacity ? capacityM3 : 0);
  const { top, step } = niceScale(peak * 1.05);
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = buckets.length > 0 ? innerW / buckets.length : innerW;
  const barW = Math.max(6, Math.min(MAX_BAR, band * 0.6));
  const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(innerW / 64))));
  const biggest = buckets.reduce((i, b, j) => (b.total > (buckets[i]?.total ?? -1) ? j : i), 0);
  // A total on every cap only while the columns have room for it.
  const capTotals = band >= 44;

  const label = (b: Bucket) =>
    by === 'day'
      ? `${weekdayOf(b.key)} ${shortDay(b.key)}`
      : `Week ${isoWeek(b.key)} (from ${shortDay(b.key)})`;

  const onKey = (e: KeyboardEvent, key: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(key);
    }
  };

  const hovered = hover !== null ? buckets[hover] : null;

  return (
    <div className="volume-chart" ref={wrap}>
      <ul className="chart-legend" aria-label="Routes">
        {MODES.map((mode) => (
          <li key={mode}>
            <span className={`swatch series-${mode}`} aria-hidden />
            {DISPATCH_MODE_LABEL[mode]}
          </li>
        ))}
        {showCapacity && (
          <li>
            <span className="swatch-line" aria-hidden />
            Marshalling capacity {Math.round(capacityM3)} m³ a day
          </li>
        )}
      </ul>

      {buckets.length === 0 ? (
        <p className="muted-note">Nothing planned in this window.</p>
      ) : (
        <svg width={width} height={HEIGHT} role="img" aria-label={`Volume shipped per ${by}, m³, stacked by route`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {t.toLocaleString('en-AU')}
              </text>
            </g>
          ))}
          <text className="axis-title" x={MARGIN.left - 8} y={MARGIN.top - 12} textAnchor="end">
            m³
          </text>

          {buckets.map((b, i) => {
            const cx = MARGIN.left + band * i + band / 2;
            const x = cx - barW / 2;
            const isSelected = selected === b.key;
            const segments = MODES.filter((mode) => b.volume[mode] > 0);
            let base = 0;
            return (
              <g
                key={b.key}
                className={`col${isSelected ? ' selected' : ''}${hover === i ? ' hovered' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${label(b)}: ${m3(b.total)}, ${b.orders} orders`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((h) => (h === i ? null : h))}
                onClick={() => onSelect(b.key)}
                onKeyDown={(e) => onKey(e, b.key)}
              >
                <rect
                  className="band"
                  x={MARGIN.left + band * i}
                  y={MARGIN.top}
                  width={band}
                  height={innerH}
                />
                {segments.map((mode, j) => {
                  const v = b.volume[mode];
                  const y0 = y(base);
                  base += v;
                  const y1 = y(base);
                  const isTop = j === segments.length - 1;
                  // The gap sits on top of every segment but the last.
                  const h = Math.max(0, y0 - y1 - (isTop ? 0 : GAP));
                  if (h <= 0) return null;
                  return isTop ? (
                    <path key={mode} className={`seg series-${mode}`} d={roundedTop(x, y1, barW, h, RADIUS)} />
                  ) : (
                    <rect key={mode} className={`seg series-${mode}`} x={x} y={y0 - h} width={barW} height={h} />
                  );
                })}
                {(capTotals || i === biggest) && (
                  <text className="cap" x={cx} y={y(b.total) - 6} textAnchor="middle">
                    {Math.round(b.total).toLocaleString('en-AU')}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text className={`xlabel${b.key === today ? ' today' : ''}`} x={cx} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle">
                    {by === 'day' ? weekdayOf(b.key) : `Wk ${isoWeek(b.key)}`}
                    <tspan x={cx} dy="1.25em">
                      {shortDay(b.key)}
                    </tspan>
                  </text>
                )}
              </g>
            );
          })}

          <line className="baseline" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} />
          {showCapacity && (
            <g className="capacity" pointerEvents="none">
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(capacityM3)}
                y2={y(capacityM3)}
                strokeDasharray="4 3"
              />
              <text x={width - MARGIN.right} y={y(capacityM3) - 6} textAnchor="end">
                Marshalling capacity {Math.round(capacityM3)}
              </text>
            </g>
          )}
        </svg>
      )}

      {hovered && hover !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(
              Math.max(0, MARGIN.left + band * hover + band / 2 - 135),
              Math.max(0, width - 280),
            ),
            top: 36,
          }}
          role="status"
        >
          <div className="tt-title">{label(hovered)}</div>
          <div className="tt-total">
            <strong>{m3(hovered.total)}</strong> · {hovered.orders} orders
            {hovered.weightKg > 0 && ` · ${Math.round(hovered.weightKg).toLocaleString('en-AU')} kg`}
          </div>
          {MODES.filter((mode) => hovered.loads[mode] > 0).map((mode: DispatchMode) => (
            <div key={mode} className="tt-row">
              <span className={`tt-key series-${mode}`} aria-hidden />
              <strong>{m3(hovered.volume[mode])}</strong>
              <span>
                {DISPATCH_MODE_LABEL[mode]} · {hovered.loads[mode]} load{hovered.loads[mode] === 1 ? '' : 's'}
              </span>
            </div>
          ))}
          {hovered.fill !== null && <div className="tt-foot">Vehicle and container fill {pct(hovered.fill)}</div>}
          {showCapacity && (
            <div className="tt-foot">
              {pct(hovered.total / capacityM3)} of marshalling capacity
              {hovered.total > capacityM3 && ' — over'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
