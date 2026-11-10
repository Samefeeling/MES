// Co-running orders: a single die can run 2-3 different parts at the same
// time on one press. The floor marks which parts genuinely run together
// with a Yes/No CoRun flag on PMD_ProductDieColor (sharing a die alone is
// not enough — different colours share a die and often run sequentially).
// This pure rule is shared by the operator sheet (status mirror, switch
// exemption) and the Trace board (showing every co-runner, not just one).

export interface DieCoRun {
  /** PMD_ProductDieColor.DieNumber for the part. */
  dieNumber: string;
  /** PMD_ProductDieColor.CoRun (Yes/No). */
  coRun: boolean;
  /** The part these belong to. Two orders for ONE part are never co-runners. */
  partNumber?: string;
  /** PMD_ProductDieColor colour name (ActualColor), '' when not recorded. */
  colour?: string;
  /** PMD_ProductDieColor colour hex, '' when not recorded. */
  hex?: string;
}

/**
 * Two parts co-run — produced simultaneously on one die — only when BOTH
 * carry CoRun = Yes AND share the same non-empty die number. Either side
 * missing its die mapping, or either flag off, means they do not co-run.
 */
export function partsCoRun(a: DieCoRun | undefined, b: DieCoRun | undefined): boolean {
  if (!a || !b) return false;
  if (!a.coRun || !b.coRun) return false;
  const da = a.dieNumber.trim();
  return da !== '' && da === b.dieNumber.trim();
}

const colourName = (v: string | undefined): string =>
  (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const colourHex = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * The list says these two parts are different colours.
 *
 * One shot fills every cavity from one barrel, so parts made together are
 * one colour; the colours of a die are run one after another. Only what the
 * list actually says counts: a name or a hex that agrees makes them the same
 * colour (a part entered as "Slate" beside one entered as "Slate Grey" with
 * the same hex is one colour), and a part with no colour recorded is not
 * called different from anything.
 */
export function coloursDiffer(a: DieCoRun, b: DieCoRun): boolean {
  const na = colourName(a.colour);
  const nb = colourName(b.colour);
  const ha = colourHex(a.hex);
  const hb = colourHex(b.hex);
  const names = na !== '' && nb !== '';
  const hexes = ha !== '' && hb !== '';
  if (!names && !hexes) return false;
  if (names && na === nb) return false;
  if (hexes && ha === hb) return false;
  return true;
}

/**
 * Two ORDERS co-run when their parts co-run (partsCoRun), they are two
 * different parts, and the list does not give the parts different colours.
 *
 * The colour test is what keeps a die's colours apart. Every colour of a
 * family die carries CoRun = Yes on the same die number, but slate runs with
 * slate and white with white, one pair after the other; linking a slate order
 * to a white one copied the white run's machine status onto the slate order.
 *
 * Order Quantity is NOT part of the rule. It used to stand in for the colour
 * test (equal quantities = made together), which was wrong for the way the
 * floor really runs an uneven pair: both parts together until the smaller
 * order is made, then that cavity is blocked and the die carries on with the
 * other. Those two orders co-run from the first shot — see
 * cavityBlockReminders for the hand-over between the two phases.
 */
export function ordersCoRun(a: DieCoRun | undefined, b: DieCoRun | undefined): boolean {
  if (!a || !b || !partsCoRun(a, b)) return false;
  const pa = (a.partNumber ?? '').trim().toUpperCase();
  const pb = (b.partNumber ?? '').trim().toUpperCase();
  if (pa !== '' && pa === pb) return false;
  return !coloursDiffer(a, b);
}

/** Where one order of a co-running group stands. */
export interface CoRunOrderProgress {
  jobNumber: string;
  /** The part the order makes — the cavity it fills. */
  partNumber: string;
  /** Pieces still to make (order total − good so far); null when unknown. */
  jobLeft: number | null;
  /** Pieces one full shift makes of this part at its standard; null when the
   *  order carries no standard. */
  shiftCapacity: number | null;
  /** The order has entries on this press in this shift. */
  onShift: boolean;
}

/** One part of the die and what is still to be made of it. */
export interface CoRunPartLeft {
  partNumber: string;
  /** Every order for the part that is in the group, in the order given. */
  jobNumbers: string[];
  /** Pieces still to make, over all of those orders. */
  left: number;
}

export interface CavityBlockReminder extends CoRunPartLeft {
  /** Pieces one full shift makes of the part; null once nothing is left and
   *  no order carried a standard. */
  shiftCapacity: number | null;
  /** Nothing left to make: block it now, not "when it is made". */
  done: boolean;
  /** The parts that still have more to make, and so carry on alone. */
  continuing: CoRunPartLeft[];
}

/**
 * Which cavities of a co-running die are about to be blocked.
 *
 * A cavity makes a PART, not an order, so the orders are added up by part
 * first: a part with 300 left on this order and another order for it waiting
 * behind is not about to run out, and telling the floor to block its cavity
 * would be wrong. A part is named when, over all its orders in the group, it
 * has less than one full shift of its standard output left AND another part
 * has more left than it does — that other part is why the die stays in the
 * press, and why this part's cavity has to be blocked rather than the die
 * pulled. Parts that run out together need no blocking (that is an ordinary
 * end of run), and neither does the last part standing.
 *
 * A finished part (nothing left) is named only on a shift it has entries in —
 * the shift it was finished on. After that the cavity is blocked and its
 * order is merely still in the planning list; repeating the reminder on every
 * later shift would teach the floor to ignore it.
 *
 * A part with an order whose Job Left is unknown is never named (what is left
 * of it cannot be worked out), but what IS known of it still counts as "more
 * left" for the others — it has at least that much.
 *
 * Nearest to finishing first.
 */
export function cavityBlockReminders(
  group: ReadonlyArray<CoRunOrderProgress>,
): CavityBlockReminder[] {
  interface PartAgg extends CoRunPartLeft {
    known: boolean;
    capacity: number | null;
    onShift: boolean;
  }
  const parts = new Map<string, PartAgg>();
  for (const o of group) {
    // An order with no part recorded stands for itself.
    const key = o.partNumber.trim().toUpperCase() || `job:${o.jobNumber}`;
    let p = parts.get(key);
    if (!p) {
      p = {
        partNumber: o.partNumber.trim(),
        jobNumbers: [],
        left: 0,
        known: true,
        capacity: null,
        onShift: false,
      };
      parts.set(key, p);
    }
    p.jobNumbers.push(o.jobNumber);
    if (o.jobLeft == null || !Number.isFinite(o.jobLeft) || o.jobLeft < 0) p.known = false;
    else p.left += o.jobLeft;
    if (p.capacity == null && o.shiftCapacity != null && o.shiftCapacity > 0) {
      p.capacity = o.shiftCapacity;
    }
    if (o.onShift) p.onShift = true;
  }
  const out: CavityBlockReminder[] = [];
  for (const p of parts.values()) {
    if (!p.known) continue;
    const done = p.left === 0;
    if (done) {
      if (!p.onShift) continue;
    } else if (p.capacity == null || p.left >= p.capacity) {
      continue;
    }
    const continuing: CoRunPartLeft[] = [];
    for (const x of parts.values()) {
      if (x === p || x.left <= p.left) continue;
      continuing.push({ partNumber: x.partNumber, jobNumbers: x.jobNumbers.slice(), left: x.left });
    }
    if (!continuing.length) continue;
    out.push({
      partNumber: p.partNumber,
      jobNumbers: p.jobNumbers.slice(),
      left: p.left,
      shiftCapacity: p.capacity,
      done,
      continuing,
    });
  }
  return out.sort((a, b) => a.left - b.left);
}
