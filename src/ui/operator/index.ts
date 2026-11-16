// Operator sheet — opening it on a press, and the clock that keeps it current.
import { S, setSheetDal, loadView, setSheetState } from './state';
import { parseRejects, inSignoffReminderWindow, currentJobNeedsSignoff, sid } from './sheet';
import type { PmdDataLayer } from '../../dal';
import type { BdCode } from '../../types';
import { dieKey } from '../../core/cavities';
import { currentShift, buildShiftId } from '../../core/shifts';
import { reload } from './data';
import { renderNowLine, render } from './render';
import { toast } from '../toast';

let nowTimer: ReturnType<typeof setInterval> | undefined;

export function jobTotals(job: string = S!.selJob): number {
  let rej = 0;
  for (const r of S!.prod.filter((x) => x.jobNumber === job)) {
    const obj = parseRejects(r);
    rej += Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
  }
  return rej;
}

export async function renderOperator(
  dal: PmdDataLayer,
  machineCode: string,
  now: Date = new Date(),
): Promise<void> {
  setSheetDal(dal);
  const [machines, planning, operators, supervisors, rcats, bdCodeList, dieColorList, dieMasterList] =
    await Promise.all([
      dal.listMachines(),
      dal.listPlanning({}),
      dal.listOperators(),
      dal.listSupervisors(),
      dal.listRejectCategories(),
      dal.listBdCodes().catch((e) => {
        console.warn('[pmd] operator breakdown master unavailable, using fallback:', e);
        return [] as BdCode[];
      }),
      dal.listProductDieColors
        ? dal.listProductDieColors().catch((e) => {
            // Colour/die metadata is optional on the operator sheet. Keep the
            // production workflow available, while logging the missing lookup;
            // management views surface the same failure in their data banner.
            console.warn('[pmd] operator part/die mapping unavailable:', e);
            return [];
          })
        : Promise.resolve([]),
      // The die asset register, for Cavities. Optional the same way: a
      // tenant without PMD_DieMaster keeps counting 1 piece per cycle,
      // which is exactly what the sheet did before this lookup existed.
      dal.listDieMaster
        ? dal.listDieMaster().catch((e) => {
            console.warn('[pmd] die register unavailable — cavities default to 1:', e);
            return [];
          })
        : Promise.resolve([]),
    ]);
  // Key by upper-trimmed Part # so the swatch lookup is tolerant of
  // case / whitespace drift between PMD_ProductDieColor and
  // Planning.csv's JobHead_PartNum.
  const dieColors = new Map(
    dieColorList.map((c) => [
      c.partNumber.trim().toUpperCase(),
      { hex: c.hex, name: c.name, dieNumber: c.dieNumber, die: c.die, coRun: c.coRun },
    ]),
  );
  const dieCavities = new Map(dieMasterList.map((d) => [dieKey(d.dieNumber), d.cavities]));
  const bdCodes = new Map(
    bdCodeList.map((row) => [row.code.trim().toUpperCase(), row]),
  );
  const cs = currentShift(now);
  const vd = new Date(now);
  vd.setHours(0, 0, 0, 0);

  // Resume the last per-tab view if the URL machine matches it. The route's
  // machineCode wins (operator deep-linked to a specific press), but date
  // / shift / selJob / selected operator+supervisor come back from
  // sessionStorage so an inadvertent tap on KPIs and back doesn't reset
  // their context.
  const saved = loadView();
  const startMc = machineCode || saved?.mc || machines[0]?.machineCode || '';
  let viewDate = vd;
  let shiftCode = cs.code;
  let selJob = '';
  let selOperator = '';
  let selSupervisor = '';
  if (saved && saved.mc === startMc) {
    const d = new Date(saved.viewDateIso);
    if (!isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      viewDate = d;
    }
    if (saved.shiftCode) shiftCode = saved.shiftCode;
    if (saved.selJob) selJob = saved.selJob;
    if (saved.selOperator) selOperator = saved.selOperator;
    if (saved.selSupervisor) selSupervisor = saved.selSupervisor;
  }

  setSheetState({
    mc: startMc,
    viewDate,
    shiftCode,
    selJob,
    prod: [],
    planning,
    machines,
    operators,
    supervisors,
    showAllPlanningOrders: false,
    rejCats: rcats,
    bdCodes,
    selOperator,
    selSupervisor,
    // Names restored with a saved view belong to that view's press and shift.
    namesFor: selOperator || selSupervisor ? `${startMc}|${buildShiftId(viewDate, shiftCode)}` : '',
    viewLevel: 1,
    jobTotalGood: 0,
    unsignedEarlier: [],
    jobFacts: null,
    coRunGood: null,
    carried: null,
    selSet: new Set<number>(),
    dieColors,
    dieCavities,
  });
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(nowTick, 30_000);
  // Boot: let the live press activity override a stale restored job (see
  // reload's preferLiveJob doc).
  await reload(true);
}

/** Shift id the sign-off reminder toast has already fired for, so the
 *  one-shot nag doesn't repeat every 30 s while in the window. */
let signoffReminderShownFor: string | null = null;

/** Half-minute heartbeat: redraw the now-line and, once per shift, fire the
 *  shift-ending sign-off reminder (toast + a single render so the banner
 *  appears without waiting for the next edit). */
function nowTick(): void {
  renderNowLine();
  if (!inSignoffReminderWindow() || !currentJobNeedsSignoff()) return;
  if (signoffReminderShownFor === sid()) return;
  signoffReminderShownFor = sid();
  toast(`Shift ends soon — sign off ${S!.selJob} before you leave`, 'warn');
  render();
}

export function operatorPollTick(): void {
  if (!S) return;
  renderNowLine();
  // The PMD_LiveStatus mirror is NOT pushed from here any more: it runs
  // app-lifetime from main.ts (60 s tick + on-wake push), so leaving the
  // operator page — or the route timer being cleared — can no longer
  // silence this device's mirror. The DAL's own stuck-guard watchdog
  // handles reentrancy.
}
