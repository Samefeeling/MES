/**
 * Order cube from the cubics sheet.
 *
 * A quantity is packed into the stacks the sheet lists for its part so the
 * total volume is smallest — five ottomans are a stack of four and a single
 * (1.27 + 0.41 m³), not two pairs and a single (0.68 × 2 + 0.41 m³). A stack
 * may go out short (three on a four-high stack) when that is what the
 * sheet's sizes leave.
 */

import { cubicKey, type CubicItem, type CubicStack, type OrderCube } from '@/domain/cubics';
import type { WaybillLine } from '@/domain/dispatch';

/** Above this many units the cheapest stack is repeated instead of searched. */
const SEARCH_LIMIT = 5000;

/** Smallest volume, m³, that holds `qty` units in the given stack sizes. */
export function stackedVolume(qty: number, stacks: readonly CubicStack[]): number {
  const units = Math.ceil(qty - 1e-9);
  if (units <= 0 || stacks.length === 0) return 0;

  const best = stacks.reduce((a, b) => (b.volumeM3 / b.qty < a.volumeM3 / a.qty ? b : a));
  let repeated = 0;
  let rest = units;
  if (units > SEARCH_LIMIT) {
    const k = Math.ceil((units - SEARCH_LIMIT) / best.qty);
    repeated = k * best.volumeM3;
    rest = units - k * best.qty;
  }

  const f = new Float64Array(rest + 1);
  for (let q = 1; q <= rest; q++) {
    let min = Infinity;
    for (const s of stacks) {
      const v = f[Math.max(0, q - s.qty)] + s.volumeM3;
      if (v < min) min = v;
    }
    f[q] = min;
  }
  return repeated + f[rest];
}

const isGoodsLine = (line: WaybillLine): boolean =>
  line.fulfillment.trim().toLowerCase() !== 'other';

/** The cube of an order's goods lines, or null when it has none. */
export function orderCube(
  lines: readonly WaybillLine[],
  master: ReadonlyMap<string, CubicItem>,
): OrderCube | null {
  const goods = lines.filter((l) => isGoodsLine(l) && l.leftToShip > 0);
  if (goods.length === 0) return null;
  const cube: OrderCube = {
    volumeM3: 0,
    weightKg: 0,
    linesWithoutWeight: 0,
    goodsLines: goods.length,
    matchedLines: 0,
    unmatched: [],
  };
  for (const line of goods) {
    const item = master.get(cubicKey(line.part));
    if (!item) {
      cube.unmatched.push({ part: line.part, qty: line.leftToShip });
      continue;
    }
    cube.matchedLines++;
    cube.volumeM3 += stackedVolume(line.leftToShip, item.stacks);
    if (item.weightKg === null) cube.linesWithoutWeight++;
    else cube.weightKg += item.weightKg * line.leftToShip;
  }
  return cube;
}

export const cubicMaster = (items: readonly CubicItem[]): Map<string, CubicItem> =>
  new Map(items.map((i) => [cubicKey(i.code), i]));
