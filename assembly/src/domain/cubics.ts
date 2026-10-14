/**
 * Product cube master: the "Drews Cubics and Freight Calc" sheet.
 *
 * One row per part and stack size: an Astral ottoman takes 0.41 m³ on its
 * own, 0.68 m³ stacked two high and 1.27 m³ stacked four. Stacking is why a
 * per-unit volume overstates a load, so an order's cube is worked out from
 * the stacks its quantity actually makes up.
 */

export interface CubicStack {
  /** Units in the stack (the sheet's `Quantity`). */
  qty: number;
  /** Volume of the whole stack, m³ (`Volume per STACK`). */
  volumeM3: number;
  /** Stack dimensions in mm, when the sheet has them. */
  lengthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
}

export interface CubicItem {
  /** Part number as the sheet spells it; matched to the waybill's `Part`. */
  code: string;
  name: string;
  /** The sheet's first column, e.g. `SS`. */
  category: string;
  /** Section heading the row sits under, e.g. `SOFT SEATING`. */
  section: string;
  /** Stack options, smallest first. */
  stacks: CubicStack[];
  weightKg: number | null;
}

/** Codes are matched case-insensitively and without surrounding spaces. */
export const cubicKey = (code: string): string => code.trim().toUpperCase();

/** An order's cube from the sheet, over its goods lines. */
export interface OrderCube {
  /** Volume of the lines the sheet covers, m³. */
  volumeM3: number;
  /** Weight of the covered lines whose weight is known, kg. */
  weightKg: number;
  /** Covered lines that had no weight in the sheet. */
  linesWithoutWeight: number;
  goodsLines: number;
  matchedLines: number;
  /** Goods-line parts the sheet does not list, with the quantity left to ship. */
  unmatched: { part: string; qty: number }[];
}

/** Every goods line is in the sheet. */
export const isFullCube = (cube: OrderCube | null | undefined): cube is OrderCube =>
  !!cube && cube.goodsLines > 0 && cube.matchedLines === cube.goodsLines;
