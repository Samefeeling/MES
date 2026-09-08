export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DependencyEdge {
  key: string;
  sourceId: string;
  targetId: string;
  source: RouteRect;
  target: RouteRect;
}

export interface RoutedDependency extends DependencyEdge {
  channelX: number;
  points: RoutePoint[];
  path: string;
}

export interface DependencyFocus {
  edgeKeys: Set<string>;
  nodeIds: Set<string>;
}

interface GraphEdge {
  key: string;
  sourceId: string;
  targetId: string;
}

/**
 * Every ancestor and descendant of one job, found iteratively so a deep BOM
 * cannot exhaust the call stack. The visited sets also make bad cyclic data
 * harmless even though the data engine normally removes cycles first.
 */
export function dependencyFocus(
  edges: readonly GraphEdge[],
  focusId: string | null,
): DependencyFocus {
  const edgeKeys = new Set<string>();
  const nodeIds = new Set<string>();
  if (!focusId) return { edgeKeys, nodeIds };
  nodeIds.add(focusId);

  const incoming = new Map<string, GraphEdge[]>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const ins = incoming.get(edge.targetId) ?? [];
    ins.push(edge);
    incoming.set(edge.targetId, ins);
    const outs = outgoing.get(edge.sourceId) ?? [];
    outs.push(edge);
    outgoing.set(edge.sourceId, outs);
  }

  const walk = (
    adjacency: Map<string, GraphEdge[]>,
    next: (edge: GraphEdge) => string,
  ) => {
    const visited = new Set<string>();
    const pending = [focusId];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of adjacency.get(id) ?? []) {
        edgeKeys.add(edge.key);
        const related = next(edge);
        nodeIds.add(related);
        if (!visited.has(related)) pending.push(related);
      }
    }
  };
  walk(incoming, (edge) => edge.sourceId);
  walk(outgoing, (edge) => edge.targetId);
  return { edgeKeys, nodeIds };
}


const tidy = (n: number): number => Math.round(n * 10) / 10;

/** An orthogonal run of points as an SVG path. */
export const routePath = (points: RoutePoint[]): string => {
  const [first, ...rest] = points;
  return rest.reduce((path, point, index) => {
    const previous = points[index];
    return (
      path +
      (point.x === previous.x
        ? ` V ${tidy(point.y)}`
        : ` H ${tidy(point.x)}`)
    );
  }, `M ${tidy(first.x)} ${tidy(first.y)}`);
};

/** Where a connector meets a bar: the middle of its right or left edge. */
const midY = (rect: RouteRect): number => (rect.top + rect.bottom) / 2;

/** How far a backwards link steps clear of a bar before turning. */
const NUB = 9;
/** Two channels closer than this read as one line. */
const APART = 6;
/** Arrowheads stop this far short, so one lands on grid, not under the bar. */
const APPROACH = 1;

const overlapping = (a: RoutedDependency, top: number, bottom: number): boolean => {
  const ys = a.points.map((point) => point.y);
  return Math.max(Math.min(...ys), top) <= Math.min(Math.max(...ys), bottom);
};

/**
 * The elbow from the order that makes a part to the order that needs it.
 *
 * Out of the supplier's right-hand end, across, and into the left-hand end of
 * the order waiting — the shape every Gantt uses, and the one that reads as
 * "this finishes, then that starts". The turn happens midway between them,
 * which on this board is usually the seam itself: hand-overs are planned to
 * the hour, so the two bars abut and the connector is a single vertical line
 * straight down the join.
 *
 * A successor drawn starting *before* its supplier finishes has no forward
 * path. Rather than pretend, it steps out to the right, runs back through the
 * gap between the two rows and comes in from the left — a visible doubling
 * back, which is exactly what the schedule is saying.
 */
const pointsFor = (edge: DependencyEdge, channelX: number): RoutePoint[] => {
  const sourceX = edge.source.right;
  const sourceY = midY(edge.source);
  const targetY = midY(edge.target);
  // The arrowhead stops a pixel short of the bar so its tip lands on clear
  // grid. That pixel must not decide the shape of the route: bars that meet
  // exactly are forward links, and are most of this board.
  const targetX = edge.target.left - APPROACH;

  if (edge.target.left >= sourceX) {
    return [
      { x: sourceX, y: sourceY },
      { x: channelX, y: sourceY },
      { x: channelX, y: targetY },
      { x: targetX, y: targetY },
    ];
  }

  // Backwards: turn in the gutter between the two rows.
  const gutter =
    edge.target.top > edge.source.bottom
      ? (edge.source.bottom + edge.target.top) / 2
      : (edge.target.bottom + edge.source.top) / 2;
  return [
    { x: sourceX, y: sourceY },
    { x: sourceX + NUB, y: sourceY },
    { x: sourceX + NUB, y: gutter },
    { x: targetX - NUB, y: gutter },
    { x: targetX - NUB, y: targetY },
    { x: targetX, y: targetY },
  ];
};

/**
 * Route every dependency, locally.
 *
 * There is no obstacle avoidance and none is wanted: the layer is drawn under
 * the bars, so a connector passing behind one is hidden by it rather than
 * scribbled over it. Routing around them instead sent lines the length of the
 * board to find an empty column — correct, and unreadable.
 *
 * The only thing worth spreading is two connectors that would share a channel
 * over the same rows, which would draw as one line; those are nudged apart.
 */
export function routeDependencies(
  edges: readonly DependencyEdge[],
  options: { minX?: number; maxX?: number } = {},
): RoutedDependency[] {
  const minX = options.minX ?? Number.NEGATIVE_INFINITY;
  const maxX = options.maxX ?? Number.POSITIVE_INFINITY;
  const routed: RoutedDependency[] = [];

  // Shortest first, so a tight hand-over keeps the seam and a longer link
  // going the same way is the one nudged aside.
  const ordered = [...edges].sort(
    (a, b) =>
      Math.abs(a.target.left - a.source.right) -
        Math.abs(b.target.left - b.source.right) ||
      a.key.localeCompare(b.key),
  );

  for (const edge of ordered) {
    const from = edge.source.right;
    const to = edge.target.left - APPROACH;
    const top = Math.min(midY(edge.source), midY(edge.target));
    const bottom = Math.max(midY(edge.source), midY(edge.target));

    let channel = Math.max(minX, Math.min((from + to) / 2, maxX));
    // Only a channel already carrying a line across these same rows hides
    // anything; one on another part of the board is free to sit anywhere.
    for (let tries = 0; tries < 8; tries++) {
      const clash = routed.some(
        (other) =>
          Math.abs(other.channelX - channel) < APART &&
          overlapping(other, top, bottom),
      );
      if (!clash) break;
      channel = Math.min(maxX, channel + APART);
    }

    const points = pointsFor(edge, channel);
    routed.push({
      ...edge,
      channelX: channel,
      points,
      path: routePath(points),
    });
  }
  return routed;
}
