import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { OrderRow } from '@/engine/assembly/board';
import {
  dependencyFocus,
  routeDependencies,
  type DependencyEdge,
  type RouteRect,
  type RoutedDependency,
} from './dependencyRouter';

interface Drawing {
  width: number;
  height: number;
  arrows: (RoutedDependency & { focused: boolean })[];
}

const EMPTY: Drawing = { width: 0, height: 0, arrows: [] };

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
  }, [root, labelWidth, drawing.arrows.length]);

  if (drawing.arrows.length === 0) return null;
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
      </defs>
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
