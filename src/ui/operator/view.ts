// Operator sheet — the markup of the sheet: action bar, order details, the
// half-hour grid and the shift counters.
import type { Operator, ShiftCode, StatusCode } from '../../types';
import { shiftTagMatches, SUPERVISOR_QC_SLOTS } from '../../core/crew';
import { escapeHtml } from '../modal';
import {
  dateKey,
  SHIFTS,
  slotClock,
  SLOTS_PER_SHIFT,
  currentShift,
  currentSlotIndex,
} from '../../core/shifts';
import { S, dalRef } from './state';
import {
  shiftWindowLabel,
  sid,
  shiftOrders,
  selectedOrder,
  isPastShift,
  coRunLinks,
  jobInPlanning,
  occupyingOtherJob,
  slotRec,
  parseRejects,
  SLOT_PX,
  canonical,
} from './sheet';
import { dispZoomLabel } from './zoom';
import { compareOrdersByStart } from '../../core/planning';
import {
  isCarried,
  isReadOnlyDevice,
  cavitySource,
  cavities,
  needsConfirm,
  shiftTarget,
  shiftOutputWarning,
  jobLeftWarnTitle,
} from './data';
import { isSupervisor } from '../supervisor-auth';
import { lockInfo, rejectEntryBlocked, isJobLocked } from './lock';
import { STATUS_MAP, STATUSES } from '../../core/status';
import { breakdownDetailFor } from '../../core/breakdown';
import { blockedCavities, cavityNote, cavityChoices } from '../../core/cavities';
import { cavityGross } from '../../core/metrics';
import { jobTotals } from './index';
import { jobLeftPiecesFor } from '../../core/targets';
import { parseHandover } from './events';
import { MANGO_HOME_URL } from './photos';

/**
 * Names from a roster that belong to the selected shift, so the
 * Operator / Supervisor dropdowns only list the people actually rostered
 * on (e.g. Day) instead of the whole plant. A roster entry matches when:
 *   - it has no shift tag (untagged data must never hide a needed name), or
 *   - its shift and the selected shift are prefixes of one another
 *     (tolerates "Day" vs "Day Shift" vs a single-letter "D").
 * `alwaysInclude` (the currently-selected name) is appended even when it
 * falls outside the shift, so switching shifts never drops the name a
 * record already holds. De-duplicated, original order preserved.
 */
export function rosterNames(
  roster: Operator[],
  shiftCode: ShiftCode,
  alwaysInclude: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const o of roster) {
    if (!shiftTagMatches(o.shift, shiftCode)) continue;
    if (seen.has(o.operatorName)) continue;
    seen.add(o.operatorName);
    names.push(o.operatorName);
  }
  if (alwaysInclude && !seen.has(alwaysInclude)) names.push(alwaysInclude);
  return names;
}

/**
 * The rest of a roster: the people of the OTHER shifts, A–Z. Somebody on
 * overtime works a shift they are not rostered on, and has to be able to
 * put their own name on its sheet — so the pickers list the shift's own
 * people first (`rosterNames`) and these after, under their own heading.
 */
export function otherShiftNames(roster: Operator[], shown: ReadonlyArray<string>): string[] {
  const seen = new Set(shown);
  const names: string[] = [];
  for (const o of roster) {
    if (seen.has(o.operatorName)) continue;
    seen.add(o.operatorName);
    names.push(o.operatorName);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export const OTHER_SHIFTS_LABEL = 'Other shifts — overtime';

function selOpts(values: string[], selected: string, placeholder: string, others: string[] = []): string {
  const opt = (v: string): string =>
    `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`;
  return [`<option value="">— ${escapeHtml(placeholder)} —</option>`]
    .concat(values.map(opt))
    .concat(others.length ? [`<optgroup label="${OTHER_SHIFTS_LABEL}">${others.map(opt).join('')}</optgroup>`] : [])
    .join('');
}

export function buildActionBar(): string {
  const dateIso = dateKey(S!.viewDate);
  const tabs = SHIFTS.map(
    (s) =>
      `<button class="shift-btn${s.code === S!.shiftCode ? ' a' : ''}" data-shift="${s.code}">${escapeHtml(
        s.label,
      )}</button>`,
  ).join('');
  // Action bar trimmed for iPad portrait (≈810px wide): the explicit
  // "Now" button is redundant — tapping today on the date picker drops
  // you on the live shift anyway — and shortening the save label to
  // "Sign off" buys the ~80px needed for the bar to fit on one row.
  return `<div class="op-actionbar">
    <div class="ab-date">
      <input type="date" class="ab-date-input" data-meta="date" value="${dateIso}">
    </div>
    <div class="ab-shifts">${tabs}</div>
    <div class="ab-window" title="The physical clock window this shift covers — a Night shift starts the evening before and ends 07:00 the next morning, so its date is the START day.">🕑 ${escapeHtml(shiftWindowLabel(sid()))}</div>
    <div class="ab-zoom" title="Display size — scales the whole operator page. ⛶ = auto-fit everything on screen; − / + set a fixed size; tap the % to go back to auto-fit. Remembered on this device.">
      <button type="button" class="ab-zoom-btn" data-dispzoom="-" aria-label="Smaller">−</button>
      <button type="button" class="ab-zoom-val" data-dispzoom="fit" aria-label="Auto-fit">${dispZoomLabel()}</button>
      <button type="button" class="ab-zoom-btn" data-dispzoom="+" aria-label="Larger">+</button>
    </div>
    <div class="ab-right">
      <button class="btn-load" data-refresh title="Re-pull planning from SharePoint, show all orders &amp; recompute Job Left">⟳ Refresh</button>
      <button class="btn-save" data-saveclear>✅ Sign off</button>
    </div>
  </div>`;
}

export function buildMeta(): string {
  const machineOpts = S!.machines
    .map(
      (m) =>
        `<option value="${escapeHtml(m.machineCode)}"${
          m.machineCode === S!.mc ? ' selected' : ''
        }>${escapeHtml(m.machineCode)}</option>`,
    )
    .join('');
  const orders = shiftOrders();
  // Job# is a strict dropdown of the released orders for this press, sorted
  // by planned start (JobHead_StartDate now includes time), earliest first — the
  // next order to run is the first thing the operator sees. Free typing was
  // removed on request: workers were entering item / part numbers (and other
  // junk) into the Job# box. A just-released order appears after the 15-min
  // Epicor sync; ⟳ Refresh pulls it sooner.
  const sortedOrders = orders.slice().sort(compareOrdersByStart);
  const jobOpts = (): string => {
    const opts = sortedOrders.map((ord) => {
      const d = new Date(ord.plannedStart);
      const when = isFinite(d.getTime())
        ? ` · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '';
      // id > 0 = a real PMD_ManualOrders row (supervisor-added); id 0 =
      // the synthetic order rebuilt from PMD_Production history.
      const tag = ord.manuallyAdded
        ? ord.id > 0
          ? ' (manual)'
          : isCarried(ord.jobNumber) && !S!.prod.some((r) => r.jobNumber === ord.jobNumber)
            ? ' (carried over)'
            : ' (history)'
        : '';
      return `<option value="${escapeHtml(ord.jobNumber)}"${
        ord.jobNumber === S!.selJob ? ' selected' : ''
      }>${escapeHtml(`${ord.jobNumber}${when}${tag}`)}</option>`;
    });
    // A selected job missing from the list (legacy manual entry, or planning
    // aged it out mid-shift) must stay selectable — a <select> without its
    // current value would silently jump to the first option.
    if (S!.selJob && !sortedOrders.some((ord) => ord.jobNumber === S!.selJob)) {
      opts.unshift(
        `<option value="${escapeHtml(S!.selJob)}" selected>${escapeHtml(S!.selJob)}</option>`,
      );
    }
    if (!S!.selJob) opts.unshift('<option value="" selected>— pick job —</option>');
    return opts.length ? opts.join('') : '<option value="">— no orders —</option>';
  };
  const o = selectedOrder();
  const pastLocked = isPastShift() && !isSupervisor();
  let jobField: string;
  if (isReadOnlyDevice()) {
    // Non-iPad without supervisor sign-in: the Job# dropdown freezes on
    // whatever's currently selected. The device-class rule replaced the
    // old per-iPad OwnerDevice claim which was causing fights on the
    // floor — iPads write freely now, only PCs are read-only by default.
    jobField = `<input type="text" disabled value="${escapeHtml(S!.selJob)}" title="Read only — sign in as supervisor to edit">`;
  } else if (pastLocked) {
    // Past shift: same dropdown, but shiftOrders() already restricts it to
    // the jobs actually recorded on that shift.
    jobField = `<select data-meta="job" title="Past shift — pick from the jobs recorded on this shift">${jobOpts()}</select>`;
  } else {
    jobField = `<select data-meta="job">${jobOpts()}</select>`;
  }
  // Signed-off shifts: operator & supervisor are frozen to the values that
  // were recorded at sign-off. Without this an iPad tap on the dropdown
  // changes the canonical slot's operator/supervisor, but the rest of the
  // signed-off record stays — you end up looking at "the right numbers
  // signed off by the wrong name". Supervisor mode reveals the select
  // again so a correction can be made and re-signed off.
  const opSupLocked = lockInfo() !== null && !isSupervisor();
  const lockedOrSelect = (meta: 'operator' | 'supervisor', roster: Operator[], value: string): string => {
    if (isReadOnlyDevice())
      return `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Read only — sign in as supervisor to edit">`;
    if (opSupLocked)
      return `<input type="text" disabled value="${escapeHtml(value || '—')}" title="Signed off — sign in as supervisor to change">`;
    const list = rosterNames(roster, S!.shiftCode, value);
    return `<select data-meta="${meta}">${selOpts(list, value, meta, otherShiftNames(roster, list))}</select>`;
  };
  const opField = lockedOrSelect('operator', S!.operators, S!.selOperator);
  const supField = lockedOrSelect('supervisor', S!.supervisors, S!.selSupervisor);
  // Order Qty = total order quantity (Epicor JobHead_ProdQty), shown in the
  // meta row next to Job# / Part#. This is the whole-order size and stays
  // fixed; Job Left (side panel) = this total − Σ signed Good.
  const orderQty = o && !o.isDieChange ? o.orderQty : '—';
  // Die / paint colour swatch from PMD_ProductDieColor, looked up by
  // the selected job's Part #. Planning.csv always carries
  // JobHead_PartNum, so the key comes from there directly. Upper-trim
  // both sides so any case / whitespace drift between PMD_ProductDieColor
  // and Planning.csv still resolves.
  const partKey = (o?.partNumber ?? '').trim().toUpperCase();
  const die = partKey ? S!.dieColors.get(partKey) : undefined;
  const swatch = die?.hex
    ? `<span class="m-die-swatch-inline" style="background:${die.hex}" title="${escapeHtml(die.name || die.hex)}"></span>`
    : '';
  // Physical die number from PMD_ProductDieColor.DieNumber, shown inline
  // next to the Product Description title so the floor knows which die
  // to fit before starting. ALWAYS rendered (em-dash when blank) so the
  // operator can tell at a glance whether the list has a value for this
  // part — silently hiding it made an empty cell indistinguishable from
  // a missing column.
  const dieNumber = die?.dieNumber || '';
  // The Die# pill deep-links into the Tool board's drilldown for this die so
  // the operator can read its SOC change log and add a note. A button only
  // when there's a die to open; a plain pill (em-dash) when the part has none.
  const dieNumberLabel = dieNumber
    ? ` <button type="button" class="m-die-num m-die-jump" data-die-jump="${escapeHtml(
        dieNumber,
      )}" title="Open die ${escapeHtml(
        dieNumber,
      )} in the Tool board — read its SOC notes or add one">Die# ${escapeHtml(dieNumber)}</button>`
    : ` <span class="m-die-num" title="Die # for this part (from PMD_ProductDieColor.DieNumber)">Die# —</span>`;
  // ⛓ Co-Run chips: jobs sharing this die that are both flagged CoRun=Yes in
  // PMD_ProductDieColor. They run simultaneously, so the floor needs to enter
  // each one's counts and sees their machine status mirrored. The chip is a
  // one-tap hop to the linked order (switching between co-runners is exempt
  // from the sign-off-before-leaving gate). Admin-set, not worker-picked: the
  // die is shared by colours that often run one-after-another, so only the
  // CoRun flag — not the die alone — marks a genuine simultaneous pair.
  const coRunLinkJobs = coRunLinks(S!.selJob);
  const coRunBadge = coRunLinkJobs.length
    ? `<span class="m-corun" title="Co-running on the same die — enter each order's counts; machine status is mirrored. Tap a linked job to switch.">⛓ Co-Run${coRunLinkJobs
        .map(
          (j) =>
            `<button type="button" class="corun-chip" data-corun-jump="${escapeHtml(j)}" title="Switch to co-running order ${escapeHtml(j)}">${escapeHtml(j)}</button>`,
        )
        .join('')}</span>`
    : '';
  // Job# sanity check: a live-shift Job# that isn't in Planning.csv is almost
  // always an item / part number typed into the wrong box. Warn (don't block —
  // a just-released order can lag the 15-min Epicor sync). Past shifts derive
  // their orders from PMD_Production, not planning, so the check is skipped.
  const jobWarn =
    S!.selJob && !isPastShift() && !jobInPlanning(S!.selJob)
      ? `<span class="m-job-warn" title="This Job# is not in the planning list (Planning.csv). Check you didn't type the item / part number instead of the Job#.">⚠ Not in planning — is this the Job# or an item number?</span>`
      : '';
  // Supervisor-only escape hatch for a job missing from the Epicor
  // extract (rush order / extract lag): add it by hand so the operator
  // can pick it. Hidden for everyone else.
  const addOrderBtn =
    isSupervisor() && dalRef.createManualOrder
      ? `<button type="button" class="m-add-order" data-add-order title="Add an order that's missing from the Epicor planning extract (supervisor only)">＋</button>`
      : '';
  return `<div class="op-meta">
    <label class="m-mc">Machine <select data-meta="machine">${machineOpts}</select></label>
    <label class="m-job">Job# ${jobField}${addOrderBtn}${coRunBadge}${jobWarn}</label>
    <label class="m-orderqty">Order Qty <input type="text" disabled value="${escapeHtml(String(orderQty))}"></label>
    <label class="m-part"><span class="m-part-title">Part# ${swatch}</span><input type="text" disabled value="${escapeHtml(o?.partNumber ?? '')}"></label>
    <label class="m-desc"><span class="m-desc-title">Product Description${dieNumberLabel}</span><input type="text" disabled value="${escapeHtml(o?.partDescription ?? '')}"></label>
    <label class="m-op">Operator ${opField}</label>
    <label class="m-sup">Supervisor ${supField}</label>
  </div>`;
}

/** Short two-letter initials for a "First Last" name, used as the
 *  compact label on QC sign-off cells. Falls back to the first two
 *  characters when the name doesn't have two whitespace-separated
 *  words (single-word handles, codes). Exported so the Trace view
 *  labels QC cells with the same initials. */
export function initials(name: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * Slots that require a supervisor QC sign-off rather than an operator
 * one. Production updated the cadence: instead of alternating
 * operator / supervisor every half-hour, supervisors check at three
 * fixed points per shift — start (slot 1 = ~07:30 on Day), middle
 * (slot 7 = ~10:30), and near end (slot 13 = ~13:30). The same indices
 * map onto Afternoon (15:30 / 18:30 / 21:30) and Night (23:30 / 02:30 /
 * 05:30) because every shift counts slots from 0 at its start.
 * Operators still do a QC every other slot.
 */

/** Whose turn is it to QC this slot — supervisor at the 3 cadence slots
 *  per shift, operator on every other slot. */
export function qcRoleFor(slot: number): 'operator' | 'supervisor' {
  return SUPERVISOR_QC_SLOTS.has(slot) ? 'supervisor' : 'operator';
}

/**
 * Shared QC-cell presentation — label / class / title — so the editable
 * operator grid and the read-only Trace card render the same content.
 * Both contexts compose this with their own wrapper element (operator: a
 * `<td>` with a tap-to-edit `<button>`; Trace: a `<div>` row above the
 * status timeline).
 */
export function qcCellPresentation(
  slot: number,
  name: string,
): { role: 'operator' | 'supervisor'; signed: boolean; label: string; title: string } {
  const role = qcRoleFor(slot);
  const roleLabel = role === 'operator' ? '👷 Operator' : '👔 Supervisor';
  const signed = !!name;
  const label = signed ? `✓ ${escapeHtml(initials(name))}` : '—';
  const title = signed
    ? `${roleLabel} sign-off · ${escapeHtml(name)} · tap to change`
    : `${roleLabel} sign-off required · tap to confirm`;
  return { role, signed, label, title };
}

function qcCellHtml(slot: number, name: string, isNow: boolean): string {
  const p = qcCellPresentation(slot, name);
  const cls = `qc-cell${isNow ? ' is-now-col' : ''}${p.signed ? ' is-signed' : ''} qc-${p.role}`;
  return `<td class="${cls}"><button type="button" class="qc-btn" data-qc-slot="${slot}" title="${p.title}">${p.label}</button></td>`;
}

function statusCellHtml(
  slot: number,
  code: StatusCode | '',
  bdIssue: string,
  isNow: boolean,
): string {
  // If THIS job hasn't claimed the slot, surface any other job that has
  // — operator-side guard so 15:00 can't end up running for two orders.
  const occ = code ? null : occupyingOtherJob(slot);
  const occDef = occ?.statusCode ? STATUS_MAP[occ.statusCode] : undefined;
  const effectiveDef = code ? STATUS_MAP[code] : occDef;
  const style = effectiveDef
    ? `background:${effectiveDef.color};color:${effectiveDef.text};border-color:${effectiveDef.border}`
    : '';
  let tip = '';
  if (code === 'B' && bdIssue) {
    const detail = S
      ? breakdownDetailFor(bdIssue, S.bdCodes)
      : breakdownDetailFor(bdIssue);
    tip = ` title="${escapeHtml(detail.code)} — ${escapeHtml(detail.cause)}\nCategory: ${escapeHtml(detail.category)}\nLikely owner: ${escapeHtml(detail.owner)}"`;
  } else if (occ) {
    tip = ` title="${escapeHtml(slotClock(sid(), slot))} · already used by ${escapeHtml(occ.jobNumber)} (${escapeHtml(occ.statusCode)})"`;
  }
  const tag =
    code === 'B' && bdIssue
      ? `<span class="bd-tag">${escapeHtml(bdIssue.split('-')[0])}</span>`
      : '';
  let cls = `status-cell${isNow ? ' is-now' : ''}`;
  // Still hatched for a supervisor — the slot IS another order's — but
  // tappable (sup-open), so they can correct it.
  if (occ) cls += isSupervisor() ? ' is-occupied sup-open' : ' is-occupied';
  if (S!.selSet.has(slot)) cls += ' multisel';
  // A signed-in supervisor can still pick an occupied slot to correct it.
  const btnAttrs = occ && !isSupervisor() ? ' disabled aria-disabled="true"' : '';
  // Unified status entry — single-tap selects this slot, hold-and-drag across
  // cells selects a range; the picker opens automatically on finger-up.
  // Occupied cells render the occupier's code but are not selectable.
  const cellChar = code || (occ?.statusCode ?? '·');
  return `<td class="${cls}"${tip}><button type="button" class="slot-cell" style="${style}" data-slot="${slot}" data-row="status"${btnAttrs}>${cellChar}</button>${tag}</td>`;
}

export function buildGrid(): string {
  const recs = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => slotRec(i));

  // §2 — highlight the slot that the live wall clock falls in (only when
  // viewing the active shift on today). The whole column (time header +
  // status + every reject row) is tinted so operators see which time to fill.
  const liveShiftId = currentShift(new Date()).shiftId;
  const nowSlot = liveShiftId === sid() ? currentSlotIndex(sid(), new Date()) : null;

  const headers = Array.from({ length: SLOTS_PER_SHIFT }, (_, i) => {
    // Just the slot's START time ("07:00-") — the end time was redundant
    // (it's the next slot's start) and forced a tiny font. Keeping only
    // the start lets the label be larger and readable on the iPad.
    const lbl = slotClock(sid(), i).split('–')[0] + '-';
    const now = nowSlot === i ? ' is-now-col' : '';
    return `<th class="slot-head${now}">${escapeHtml(lbl)}</th>`;
  }).join('');

  // Quality Checks row sits between the time-header and Machine Status.
  // Operator checks every half-hour; supervisor signs off at three
  // fixed cadence slots per shift (1 / 7 / 13 → ~07:30, ~10:30, ~13:30
  // for Day; same offsets for Afternoon / Night). Tap a cell to pick
  // the signing name. Signed cells show the initials of the picked
  // user so the supervisor can scan the row at a glance.
  const qcRow =
    `<tr class="row-qc"><th class="rh" title="Operator checks every 30 min; Supervisor checks at slots 1 / 7 / 13 per shift (Day: 07:30, 10:30, 13:30)">Quality Checks</th>` +
    recs
      .map((r, i) => qcCellHtml(i, r?.qcBy ?? '', nowSlot === i))
      .join('') +
    `</tr>`;

  const statusRow =
    `<tr class="row-status"><th class="rh">Machine Status</th>` +
    recs
      .map((r, i) =>
        statusCellHtml(i, r?.statusCode ?? '', r?.bdIssue ?? '', nowSlot === i),
      )
      .join('') +
    `</tr>`;

  // Reject cells are painted by the SAME predicate their change handler
  // runs (rejectEntryBlocked), so what looks editable is editable. They
  // used to be two separate expressions — the paint covered the sheet-wide
  // states only, which left the per-slot rules invisible and, worse, left
  // the cell looking identical whether it was open or not.
  const rejRows = S!.rejCats
    .map((cat) => {
      const cells = recs
        .map((r, i) => {
          const v = parseRejects(r)[cat.code] ?? 0;
          const now = nowSlot === i ? ' is-now-col' : '';
          const guard = rejectEntryBlocked(i, cat.code);
          // A half-hour that belongs to another order reuses the status
          // row's hatch, so the whole column reads as one "not yours" block
          // from the Machine Status cell down through every defect row.
          const occ = guard.blocked && occupyingOtherJob(i) ? ' is-occupied' : '';
          const tip = guard.blocked ? ` title="${escapeHtml(guard.reason)}"` : '';
          return `<td class="num-cell${now}${guard.blocked ? ' is-blocked' : ''}${occ}"${tip}><input type="text" inputmode="numeric" pattern="[0-9]*" class="rej-input" data-row="named" data-code="${escapeHtml(
            cat.code,
          )}" data-slot="${i}" value="${v || ''}"${guard.blocked ? ' disabled' : ''}></td>`;
        })
        .join('');
      return `<tr class="row-named"><th class="rh">${escapeHtml(cat.code)} ${escapeHtml(
        cat.label,
      )}</th>${cells}</tr>`;
    })
    .join('');

  return `<div class="op-grid-wrap" style="--slot-w:${SLOT_PX}px">
    <table class="op-grid">
      <thead>
        <tr><th class="rh corner">Timeline</th>${headers}</tr>
      </thead>
      <tbody>
        ${qcRow}
        ${statusRow}
        ${rejRows}
      </tbody>
    </table>
  </div>`;
}

/** One handover box: label + 🎤 dictation toggle + textarea. The mic is
 *  hidden while the box is read-only (locked shift / read-only device). */
function handoverBox(
  label: string,
  field: string,
  placeholder: string,
  value: string,
  rdo: string,
  rdoTitle: string,
): string {
  const mic = rdo
    ? ''
    : `<button type="button" class="mic-btn" data-mic="${field}" title="Dictate — speak and it types here. On iPad you can also use the 🎤 key on the keyboard.">🎤</button>`;
  return `<label><span>${label}${mic}</span><textarea data-meta="${field}" placeholder="${placeholder}" ${rdo}${rdoTitle}>${escapeHtml(value)}</textarea></label>`;
}

/**
 * The Cavities row — every press, because a multi-cavity die can be fitted
 * to any of them.
 *
 * It starts at PMD_DieMaster's count and can be lowered afterwards, at the
 * time or later: a damaged cavity is blocked off and the tool runs on the
 * rest, so a 4-cavity die can make 3 a cycle for a shift or a week. The
 * register stays the ceiling — a tool cannot run cavities it does not
 * have — and the sheet says how many are blocked, so a block left on after
 * the die was repaired is plain to see. The same lock as Count Start /
 * Count End applies: a signed-off shift needs a supervisor.
 *
 * The "?" marks a die that IS fitted but whose cavity count the register
 * cannot supply. A part with no die at all already says so on the Die#
 * pill above, so it gets the explanation without the flag.
 */
function cavityRow(rdo: string, rdoTitle: string): string {
  const src = cavitySource();
  const cav = cavities();
  const blocked = blockedCavities(cav, src);
  const base = S!.selJob ? cavityNote(src) : 'Pick an order — its die decides the cavity count.';
  const note = blocked > 0
    ? `${blocked} of ${src.count} cavities blocked — counting ${cav} per cycle. Set it back to ${src.count} once the die is repaired. ${base}`
    : `${base} Lower it when a cavity is blocked off.`;
  const flag = S!.selJob && !src.known && src.dieNumber
    ? ' <span class="cav-flag" aria-label="cavity count missing from the die register">?</span>'
    : '';
  const tag = blocked > 0
    ? ` <span class="cav-blocked" aria-label="${blocked} cavities blocked">${blocked} blocked</span>`
    : '';
  if (!S!.selJob) {
    return `<div class="sk sk-cavity"><label title="${escapeHtml(note)}">Cavities</label><b class="cav-val" data-cavities="${cav}" title="${escapeHtml(note)}">×${cav}</b></div>`;
  }
  const options = cavityChoices(cav, src)
    .map((n) => {
      const of = src.known && n < src.count ? ` of ${src.count}` : '';
      return `<option value="${n}"${n === cav ? ' selected' : ''}>×${n}${of}</option>`;
    })
    .join('');
  return `<div class="sk sk-cavity"><label title="${escapeHtml(note)}">Cavities${flag}${tag}</label><select class="cav-val${
    blocked > 0 ? ' cav-short' : ''
  }" data-meta="cavities" data-cavities="${cav}" aria-label="Cavities running" title="${escapeHtml(note)}" ${rdo}${rdoTitle}>${options}</select></div>`;
}

export function buildSide(): string {
  const c = canonical();
  const cs = c?.countStart ?? '';
  const ce = c?.countEnd ?? '';
  const cav = cavities();
  const gross = cavityGross(c?.countStart ?? null, c?.countEnd ?? null, cav);
  const totalReject = jobTotals();
  const good = Math.max(0, gross - totalReject);
  const o = selectedOrder();
  // §7 — Job Left = order total − Σ Good across ALL shifts, not just this
  // one. Shared core formula; see jobLeftPiecesFor for the base choice.
  const jobLeft = (o ? jobLeftPiecesFor(o, S!.jobTotalGood + good) : null) ?? '—';
  const purge = c?.purgeKg ?? '';
  const h = parseHandover(c);
  // When the (machine, shift, job) is signed off, every editable field
  // on the side panel is rendered read-only so the operator can't
  // accidentally type into a frozen shift — supervisor mode re-enables
  // them via the Unlock flow. Title tooltips explain what changed.
  const rdo = isJobLocked() || isReadOnlyDevice() || needsConfirm() ? 'disabled' : '';
  const rdoTitle = isReadOnlyDevice()
    ? ' title="Read only — sign in as supervisor to edit"'
    : isJobLocked()
      ? ' title="Signed off — sign in as supervisor and Unlock to edit"'
      : needsConfirm()
        ? ' title="Tap ✅ Confirm above to start logging this order on this press"'
        : '';
  // Shift Target: pieces the operator should aim for this shift. See
  // shiftTarget() for the rule — the hours left after earlier orders and
  // any changeover, at cycle time, capped by the job's remainder.
  const tgt = shiftTarget();
  const outputWarning = shiftOutputWarning(good);
  const targetDisplay = tgt == null ? '—' : String(tgt);
  const targetTitle = tgt == null
    ? 'No JobOper_ProdStandard on the planning row — Shift Target cannot be computed.'
    : `Shift Target = the smaller of Job Left and (8h − hours used by earlier orders this shift − changeover time) ÷ ${o!.qtyPerHr} h/piece.`;
  return `<aside class="op-side">
    <div class="side-title">Shift counters</div>
    <div class="sk"><label>Job left</label><b data-live="jobLeft">${jobLeft}</b><span class="jl-warn" data-live="jlWarn" title="${escapeHtml(jobLeftWarnTitle())}"${S!.unsignedEarlier.length ? '' : ' style="display:none"'}>⚠</span></div>
    <div class="sk"><label title="${escapeHtml(targetTitle)}">Shift Target</label><b title="${escapeHtml(targetTitle)}">${targetDisplay}</b></div>
    <div class="sk"><label>Count Start</label><input class="count-input${outputWarning ? ' count-invalid' : ''}" type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cstart" value="${cs}" aria-invalid="${outputWarning ? 'true' : 'false'}" ${rdo}${rdoTitle}></div>
    <div class="sk"><label>Count End</label><input class="count-input${outputWarning ? ' count-invalid' : ''}" type="text" inputmode="numeric" pattern="[0-9]*" data-meta="cend" value="${ce}" aria-invalid="${outputWarning ? 'true' : 'false'}" ${rdo}${rdoTitle}></div>
    ${cavityRow(rdo, rdoTitle)}
    <div class="sk"><label>Total Reject</label><b class="r" data-live="totalReject">${totalReject}</b></div>
    <div class="sk"><label${cav > 1 ? ` title="(Count End − Count Start) × ${cav} cavities − Reject"` : ''}>Total Good${cav > 1 ? ` <span class="cavity-tag">×${cav}</span>` : ''}</label><b class="g${outputWarning ? ' count-invalid' : ''}" data-live="totalGood">${good}</b></div>
    <div class="count-warning" data-live="outputWarn" role="alert"${outputWarning ? '' : ' hidden'}>${outputWarning ? escapeHtml(outputWarning.message) : ''}</div>
    <div class="sk"><label>Purge (kg)</label><input type="text" inputmode="numeric" pattern="[0-9]*" data-meta="purge" value="${purge}" ${rdo}${rdoTitle}></div>
    <div class="photos">
      <div class="photos-head">
        <div class="photos-title">📷 Photos</div>
        <a class="mango-btn" href="${MANGO_HOME_URL}" target="_blank" rel="noopener" title="Open Mango — raise or check a maintenance request">🥭 Mango</a>
      </div>
      <div class="photo-strip" data-photo-strip></div>
      <button type="button" class="photo-take" data-photo-take ${
        isReadOnlyDevice()
          ? 'disabled title="Read only — sign in as supervisor to add photos"'
          : needsConfirm()
            ? 'disabled title="Tap ✅ Confirm above to start logging this order on this press"'
            : ''
      }>📷 Take photo</button>
      <input type="file" accept="image/*" capture="environment" data-photo-file hidden>
    </div>
    <div class="handover">
      <div class="handover-title">Handover</div>
      <div class="handover-grid">
        ${handoverBox('🛠 Machine', 'hand-machine', 'Press state, robot, hot runner, breakdown follow-ups…', h.machine, rdo, rdoTitle)}
        ${handoverBox('🧩 Mold', 'hand-mold', 'Mould condition, slides, ejector, water lines, maintenance due…', h.mold, rdo, rdoTitle)}
        ${handoverBox('📦 Material', 'hand-material', 'Material lot, dryer, regrind, masterbatch…', h.material, rdo, rdoTitle)}
        ${handoverBox('📋 Method', 'hand-method', 'Cycle, settings, process changes, work instructions…', h.method, rdo, rdoTitle)}
      </div>
    </div>
  </aside>`;
}

export function buildLegend(): string {
  return `<div class="op-legend">${STATUSES.map(
    (s) =>
      `<span><i style="background:${s.color};border-color:${s.border}"></i>${s.code}: ${escapeHtml(s.label)}</span>`,
  ).join('')}</div>`;
}

export function applyShiftTheme(): void {
  // Day → blue (102,204,255); Afternoon → green (131,226,142); Night → yellow (255,255,0).
  // Drives CSS variables in styles.css, including the top bar.
  const cls = `shift-${S!.shiftCode.toLowerCase()}`;
  if (document.body.className !== cls) document.body.className = cls;
}
