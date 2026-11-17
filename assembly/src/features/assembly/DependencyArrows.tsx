import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { OrderRow } from '@/engine/assembly/board';
import type { PressChangeKind } from '@/domain/types';
import {
  dependencyFocus,
  routeDependencies,
  type DependencyEdge,
  type RouteRect,
  type RoutedDependency,
} from './dependencyRouter';

/** A press changeover's arrow: from the end of the change down to the next order. */
export interface ChangeArrow {
  key: string;
  kind: PressChangeKind;
  path: string;
}

interface Drawing {
  width: number;
  height: number;
  arrows: (RoutedDependency & { focused: boolean })[];
  changes: ChangeArrow[];
}

const EMPTY: Drawing = { width: 0, height: 0, arrows: [], changes: [] };

/** Under this, the next order starts where the change ends: straight down. */
const STRAIGHT_DOWN_PX = 8;

/**
 * From the end of a changeover down to the order the press changes over to.
 *
 * The next order starts where the change ends, so the arrow drops straight
 * from there onto the top of its bar, as a project plan draws a finish-to-start
 * link. Where the plan left a gap after the change, it drops to the next bar's
 * height and runs right into its start. Measured from the bottom of the change,
 * not its side, so it never crosses the label written beside it.
 */
export function changeArrowPath(change: RouteRect, next: RouteRect): string {
  const x = change.right;
  const top = change.bottom;
  if (next.top <= top) return '';
  if (next.left - x <= STRAIGHT_DOWN_PX) {
    // Onto the bar's top, inside it even where the bar starts a hair before
    // the change ends (a co-run overlapping its last minutes).
    const at = Math.min(Math.max(x, next.left + 3), Math.max(next.left + 3, next.right - 3));
    return `M ${at} ${top} V ${next.top - 1}`;
  }
  const mid = (next.top + next.bottom) / 2;
  return `M ${x} ${top} V ${mid} H ${next.left - 1}`;
}

const boxOf = (
  element: HTMLElement,
  host: DOMRect,
  id: string,
): RouteRect => {
  const box = element.getBoundingClientRect();
  return {
    id,
    left: box.left - host.left,
    top: box.top - host.top,
    right: box.right - host.left,
    bottom: box.bottom - host.top,
  };
};

export function DependencyArrows({
  root,
  rows,
  focusJobId,
  labelWidth,
}: {
  root: RefObject<HTMLDivElement | null>;
  rows: OrderRow[];
  focusJobId: string | null;
  /** Where the day grid starts — everything left of it is frozen columns. */
  labelWidth: number;
}) {
  const [drawing, setDrawing] = useState<Drawing>(EMPTY);
  const layer = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) {
      setDrawing(EMPTY);
      return;
    }
    let frame = 0;

    const measure = () => {
      const hostRect = host.getBoundingClientRect();
      const bars = new Map<string, RouteRect>();
      host.querySelectorAll<HTMLElement>('[data-job-id]').forEach((element) => {
        const id = element.dataset.jobId;
        if (id) bars.set(id, boxOf(element, hostRect, id));
      });

      // Press changeovers: the change on one bar, down to the next order's.
      const changes: ChangeArrow[] = [];
      host.querySelectorAll<HTMLElement>('[data-change-to]').forEach((element) => {
        const to = element.dataset.changeTo;
        const kind = [...element.classList].find((c): c is PressChangeKind =>
          c === 'die' || c === 'insert' || c === 'colour',
        );
        const next = to ? bars.get(to) : undefined;
        if (!to || !kind || !next) return;
        const path = changeArrowPath(boxOf(element, hostRect, to), next);
        if (path) changes.push({ key: `change->${to}`, kind, path });
      });

      const edges: DependencyEdge[] = [];
      for (const row of rows) {
        const targetId = String(row.job.id);
        const target = bars.get(targetId);
        if (!target) continue;
        for (const dependency of row.predecessors) {
          const sourceId = String(dependency.onJobId);
          const source = bars.get(sourceId);
          if (!source) continue;
          edges.push({
            key: `${sourceId}->${targetId}`,
            sourceId,
            targetId,
            source,
            target,
          });
        }
      }

      // Iterative traversal expands every ancestor and descendant, not just
      // the first two levels visible around the selected job.
      const focus = dependencyFocus(edges, focusJobId);
      const arrows = routeDependencies(edges, {
        minX: labelWidth,
        maxX: host.scrollWidth - 2,
      }).map((arrow) => ({
        ...arrow,
        focused: focus.edgeKeys.has(arrow.key),
      }));
      setDrawing({
        width: host.scrollWidth,
        height: host.scrollHeight,
        arrows,
        changes,
      });
    };
    const queueMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    queueMeasure();
    const observer = new ResizeObserver(queueMeasure);
    observer.observe(host);
    host
      .querySelectorAll<HTMLElement>('[data-job-id]')
      .forEach((element) => observer.observe(element));
    window.addEventListener('resize', queueMeasure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', queueMeasure);
    };
  }, [focusJobId, labelWidth, root, rows]);

  /*
   * Keep the arrows out from under the frozen columns.
   *
   * The layer spans the whole board, and the grid slides beneath the Order,
   * date and Team columns as it is scrolled right. Those columns hide it on an
   * ordinary row, but a row drawn faded — the moulding plan, an order closed
   * today — is one composited layer, so a quarter of whatever is behind it
   * comes through, enough for an arrow to cut across the dates. Clipping off
   * exactly the strip they cover settles it wherever the board is scrolled to.
   */
  useLayoutEffect(() => {
    const scroller = root.current?.parentElement;
    if (!scroller) return;
    const clip = () => {
      // Straight to the node: this fires on every scroll frame, and nothing
      // else on the board depends on the number.
      if (layer.current) {
        const hidden = scroller.scrollLeft + labelWidth;
        layer.current.style.clipPath = `inset(0 0 0 ${hidden}px)`;
      }
    };
    clip();
    scroller.addEventListener('scroll', clip, { passive: true });
    return () => scroller.removeEventListener('scroll', clip);
  }, [root, labelWidth, drawing.arrows.length, drawing.changes.length]);

  if (drawing.arrows.length === 0 && drawing.changes.length === 0) return null;
  return (
    <svg
      ref={layer}
      className="dependency-layer"
      width={drawing.width}
      height={drawing.height}
      aria-hidden="true"
    >
      <defs>
        <marker
          id="dependency-arrowhead"
          markerWidth="7"
          markerHeight="7"
          refX="6"
          refY="3.5"
          orient="auto"
        >
          <path className="dependency-marker" d="M 0 0 L 7 3.5 L 0 7 z" />
        </marker>
        <marker
          id="dependency-arrowhead-focus"
          markerWidth="7"
          markerHeight="7"
          refX="6"
          refY="3.5"
          orient="auto"
        >
          <path className="dependency-marker-focus" d="M 0 0 L 7 3.5 L 0 7 z" />
        </marker>
        {(['die', 'insert', 'colour'] as const).map((kind) => (
          <marker
            key={kind}
            id={`change-arrowhead-${kind}`}
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path className={`change-marker ${kind}`} d="M 0 0 L 7 3.5 L 0 7 z" />
          </marker>
        ))}
      </defs>
      {drawing.changes.map((arrow) => (
        <path
          key={arrow.key}
          className={`change-link ${arrow.kind}`}
          d={arrow.path}
          markerEnd={`url(#change-arrowhead-${arrow.kind})`}
        />
      ))}
      {drawing.arrows.map((arrow) => (
        <g
          key={arrow.key}
          className={`dependency-link ${arrow.focused ? 'focused' : ''}`}
        >
          <path className="dependency-casing" d={arrow.path} />
          <path
            className="dependency-arrow"
            d={arrow.path}
            markerEnd={
              arrow.focused
                ? 'url(#dependency-arrowhead-focus)'
                : 'url(#dependency-arrowhead)'
            }
          />
        </g>
      ))}
    </svg>
  );
}
