import { describe, expect, it } from 'vitest';
import {
  dependencyFocus,
  routeDependencies,
  type DependencyEdge,
  type RouteRect,
} from '@/features/assembly/dependencyRouter';

const rect = (
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): RouteRect => ({ id, left, top, right, bottom });

const edge = (
  key: string,
  source: RouteRect,
  target: RouteRect,
): DependencyEdge => ({
  key,
  sourceId: source.id,
  targetId: target.id,
  source,
  target,
});

describe('recursive dependency focus', () => {
  const chain = [
    { key: 'A-B', sourceId: 'A', targetId: 'B' },
    { key: 'B-C', sourceId: 'B', targetId: 'C' },
    { key: 'C-D', sourceId: 'C', targetId: 'D' },
    { key: 'D-E', sourceId: 'D', targetId: 'E' },
    { key: 'X-Y', sourceId: 'X', targetId: 'Y' },
  ];

  it('finds every parent and child beyond two levels', () => {
    const focus = dependencyFocus(chain, 'C');
    expect([...focus.edgeKeys].sort()).toEqual(['A-B', 'B-C', 'C-D', 'D-E']);
    expect([...focus.nodeIds].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('terminates safely if malformed data contains a cycle', () => {
    const focus = dependencyFocus(
      [...chain, { key: 'E-B', sourceId: 'E', targetId: 'B' }],
      'C',
    );
    expect(focus.edgeKeys.has('E-B')).toBe(true);
    expect(focus.nodeIds.size).toBe(5);
  });
});

describe('dependency route allocation', () => {
  it('leaves the supplier at its end and enters the successor at its start', () => {
    // The Gantt elbow: right edge to left edge, both at mid-height, turning
    // midway between the two — never up and over the top of the block.
    const source = rect('A', 0, 0, 20, 20);
    const target = rect('B', 180, 100, 220, 120);
    const [route] = routeDependencies([edge('A-B', source, target)], {
      minX: 0,
      maxX: 240,
    });

    expect(route.points).toEqual([
      { x: 20, y: 10 },
      { x: 99.5, y: 10 },
      { x: 99.5, y: 110 },
      { x: 179, y: 110 },
    ]);
    expect(route.path).toBe('M 20 10 H 99.5 V 110 H 179');
  });

  it('runs straight down the seam where two bars meet', () => {
    // Hand-overs are planned to the hour, so this is the common case: the
    // successor starts exactly where its supplier finishes.
    const source = rect('A', 0, 0, 100, 20);
    const target = rect('B', 100, 40, 200, 60);
    const [route] = routeDependencies([edge('A-B', source, target)]);

    // One vertical line at the join, less the arrowhead's approach.
    expect(route.path).toBe('M 100 10 H 99.5 V 50 H 99');
  });

  it('doubles back when the successor starts before its supplier finishes', () => {
    const source = rect('A', 200, 0, 400, 20);
    const target = rect('B', 40, 60, 160, 80);
    const [route] = routeDependencies([edge('A-B', source, target)]);

    // Out to the right of A, back through the gutter between the rows, and in
    // from the left of B — the doubling back is the point, not a glitch.
    expect(route.points).toEqual([
      { x: 400, y: 10 },
      { x: 409, y: 10 },
      { x: 409, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 70 },
      { x: 39, y: 70 },
    ]);
  });

  it('nudges apart two links that would draw as one line', () => {
    const source = rect('A', 0, 0, 20, 20);
    const target = rect('B', 180, 100, 220, 120);
    const routes = routeDependencies(
      [edge('one', source, target), edge('two', source, target)],
      { minX: 0, maxX: 240 },
    );
    expect(routes).toHaveLength(2);
    expect(routes[0].channelX).not.toBe(routes[1].channelX);
  });

  it('leaves links on other rows sharing a channel alone', () => {
    // Same seam, different rows: they never overlap, so both keep the join.
    const routes = routeDependencies([
      edge('top', rect('A', 0, 0, 100, 20), rect('B', 100, 20, 200, 40)),
      edge('low', rect('C', 0, 200, 100, 220), rect('D', 100, 220, 200, 240)),
    ]);
    expect(routes[0].channelX).toBe(routes[1].channelX);
  });
});
