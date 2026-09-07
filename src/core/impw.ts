import { bdLabelFor, bdOwnerFor } from './breakdown';
import { SLOTS_PER_SHIFT, SLOT_MINUTES } from './shifts';

// Mango IMPW (Improvement Workflow) — the company's improvement / corrective
// action register. Mango is the system of record (same management decision
// as maintenance work orders, see ui/die.ts): PMD never becomes a second
// place improvement actions live. What PMD owns is the TRIGGER — it is the
// only system that knows a shift missed its yield, blew its reject
// allowance, or lost hours to a breakdown — so it drafts the ticket, fills
// every field it can prove, and hands the finished draft to Mango.
//
// This module is the whole contract in pure form: the rules that raise a
// finding, the IMPW field set, and the validation of it. No DOM, no fetch —
// the UI owns the Yes / No and the handoff.

const SHIFT_HOURS = (SLOTS_PER_SHIFT * SLOT_MINUTES) / 60; // 8

/** Which KPI rule a shift broke. A shift can break several. */
export type ImpwTrigger = 'breakdown' | 'yield' | 'reject';

/** Listed worst-consequence-first; the order a finding's triggers and its
 *  reason lines are reported in. */
export const IMPW_TRIGGER_ORDER: ImpwTrigger[] = ['breakdown', 'yield', 'reject'];

/** One breakdown cause inside a shift, folded from its B slots. */
export interface ImpwBreakdown {
  /** BD taxonomy code, e.g. 'MEC-02'. */
  code: string;
  /** Human cause from the taxonomy. */
  label: string;
  /** Who owns the fix (taxonomy 'owner' column) — seeds Department. */
  owner: string;
  hours: number;
  /**
   * What the operator wrote about this stoppage, when it says more than the
   * code does — PMD_Production.BDCause, or the OTH-99 free text on rows
   * written before that column existed (it went into MangoTicket, which
   * despite the name has never carried a Mango work-order number). Empty
   * when the operator only picked a code, so the ticket doesn't repeat the
   * taxonomy back at itself.
   */
  note: string;
}

/**
 * One (machine, shift) measured against the KPI rules. Built by the KPI
 * page from the same aggregate() the table renders, so a finding can never
 * disagree with the red number the meeting is looking at.
 */
export interface ImpwSlice {
  machineCode: string;
  /** Display name of the press, for Plant/Equipment. */
  machineName: string;
  shiftId: string;
  output: number;
  reject: number;
  /** Good ÷ (Good + Reject) × 100. */
  yieldPct: number;
  /**
   * Hours in B (Breakdown) slots — NOT the KPI table's "Down h", which is
   * the downtime *kind* and so also carries M (Smoko). Every shift takes a
   * smoko, so triggering on Down h would raise a ticket for every shift
   * ever worked. An unplanned stoppage is B and only B.
   */
  breakdownHrs: number;
  breakdowns: ImpwBreakdown[];
  /** Orders that ran in the slice, in the order encountered. */
  jobNumbers: string[];
}

/** The thresholds a finding is judged against — passed in rather than
 *  hardcoded so the ticket uses the supervisor's own tuned KPI colours and
 *  the reject allowance the table already prints. */
export interface ImpwRules {
  /** Yield below this % raises a finding (the KPI amber threshold — the
   *  point the table itself paints the cell red). */
  yieldTarget: number;
  /** Rejects allowed in one shift before the number goes red. */
  rejectPerShiftMax: number;
}

export interface ImpwFinding {
  /** Stable across recomputes — signed-off shifts are frozen, so the
   *  (machine, shift) pair identifies the finding for the Yes / No ledger. */
  key: string;
  machineCode: string;
  shiftId: string;
  /** Every rule this shift broke, in IMPW_TRIGGER_ORDER. */
  triggers: ImpwTrigger[];
  /** One human sentence per trigger, ready to show and to quote in the
   *  ticket body. */
  reasons: string[];
  /**
   * How much of the shift was lost, 0..1 — the rank, which is a different
   * question from the trigger. A rule decides whether to raise a ticket
   * (5 rejects is over the allowance however big the run was); severity
   * decides which ticket the meeting opens first, and for that the only
   * comparable currency is the fraction of the shift that went to waste:
   * breakdown = hours ÷ 8, quality = scrap ÷ pieces made.
   *
   * Overshoot ratios were the obvious first choice and are wrong: 100
   * rejects against a 5 allowance scores 19, while a whole shift lost to a
   * breakdown can never exceed 1, so every quality finding would outrank
   * every breakdown no matter how bad.
   */
  severity: number;
  slice: ImpwSlice;
}

/** Good ÷ (Good + Reject) as a percentage; 100 for a slice with no pieces. */
export function yieldPctOf(output: number, reject: number): number {
  const pieces = output + reject;
  return pieces > 0 ? +((output / pieces) * 100).toFixed(1) : 100;
}

/**
 * Raise a finding for every (machine, shift) that broke a rule:
 *
 *   · breakdown — any downtime hours at all. An unplanned stoppage is the
 *     event IMPW exists for, so there is no "acceptable" amount.
 *   · yield     — below the KPI yield threshold. Judged on the same number
 *     and the same cut-off the table paints red, so the meeting and the
 *     ticket can never disagree.
 *   · reject    — above the per-shift allowance (rejectCell's rule at
 *     shifts = 1).
 *
 * ONE finding per (machine, shift), not one per rule. A shift whose
 * rejects also sank its yield is a single event on the floor; two tickets
 * for it would be two people investigating the same night. The triggers
 * ride along so the ticket can say everything that went wrong.
 *
 * A slice with no pieces and no downtime never raises anything — yieldPct
 * defaults to 100 for an empty shift and must not read as a real miss.
 */
export function detectImpwFindings(
  slices: ReadonlyArray<ImpwSlice>,
  rules: ImpwRules,
): ImpwFinding[] {
  const out: ImpwFinding[] = [];
  for (const slice of slices) {
    const triggers: ImpwTrigger[] = [];
    const reasons: string[] = [];
    let severity = 0;

    if (slice.breakdownHrs > 0) {
      triggers.push('breakdown');
      const causes = slice.breakdowns.length
        ? ` — ${slice.breakdowns.map((b) => `${b.code} ${b.label}`).join('; ')}`
        : '';
      reasons.push(`Breakdown ${fmtHrs(slice.breakdownHrs)} h lost${causes}`);
      severity = Math.max(severity, slice.breakdownHrs / SHIFT_HOURS);
    }

    const pieces = slice.output + slice.reject;
    // Share of everything the shift made that had to be thrown away — the
    // loss behind both quality rules, so they rank on one number.
    const scrapShare = pieces > 0 ? slice.reject / pieces : 0;

    if (pieces > 0 && slice.yieldPct < rules.yieldTarget) {
      triggers.push('yield');
      reasons.push(`Yield ${slice.yieldPct}% — below the ${rules.yieldTarget}% target`);
      severity = Math.max(severity, scrapShare);
    }

    const allowance = Math.max(0, rules.rejectPerShiftMax);
    if (slice.reject > allowance) {
      triggers.push('reject');
      reasons.push(`${slice.reject} rejects — above the ${allowance} per shift allowance`);
      severity = Math.max(severity, scrapShare);
    }

    if (!triggers.length) continue;
    out.push({
      key: impwFindingKey(slice.machineCode, slice.shiftId),
      machineCode: slice.machineCode,
      shiftId: slice.shiftId,
      triggers: IMPW_TRIGGER_ORDER.filter((t) => triggers.includes(t)),
      reasons,
      severity: +severity.toFixed(4),
      slice,
    });
  }
  // Worst first, then newest shift — a meeting works down the list and the
  // ranking has to survive a week-long window without burying a bad
  // Tuesday under a mildly-off Friday.
  return out.sort(
    (a, b) => b.severity - a.severity || b.shiftId.localeCompare(a.shiftId) ||
      a.machineCode.localeCompare(b.machineCode),
  );
}

export function impwFindingKey(machineCode: string, shiftId: string): string {
  return `${machineCode}|${shiftId}`;
}

function fmtHrs(h: number): string {
  return h.toFixed(1).replace(/\.0$/, '');
}

// ---------------------------------------------------------------------------
// The IMPW form
// ---------------------------------------------------------------------------

/**
 * Mango's Improvement Workflow form, field for field. Required fields are
 * the ones Mango marks with * — see IMPW_REQUIRED, which is what
 * impwDraftIssues() enforces before anything is handed over.
 */
export interface ImpwDraft {
  briefDescription: string;
  typeOfImprovement: string;
  source: string;
  email: string;
  phone: string;
  fax: string;
  sendCopyToCustomer: boolean;
  /** dd/mm/yyyy — Mango's date format on this form. */
  dateOfOccurrence: string;
  details: string;
  additionalInformation: string;
  authoritiesNotified: boolean;
  customerNotified: boolean;
  proceduresReviewed: boolean;
  processToBeChanged: boolean;
  trainingReviewed: boolean;
  investigationDetails: string;
  type: string;
  region: string;
  branch: string;
  department: string;
  other: string;
  plantEquipment: string;
  risks: string;
  relatedDocuments: string;
  relatedFiles: string;
  coordinator: string;
}

export interface ImpwFieldSpec {
  field: keyof ImpwDraft;
  label: string;
  /** Mango's own character cap, where the form states one. */
  maxLength?: number;
}

/** Every field Mango marks with * — a draft missing one cannot be saved
 *  there, so PMD refuses to hand it over. */
export const IMPW_REQUIRED: ImpwFieldSpec[] = [
  { field: 'briefDescription', label: 'Brief Description', maxLength: 256 },
  { field: 'typeOfImprovement', label: 'Type of Improvement' },
  { field: 'source', label: 'Source' },
  { field: 'dateOfOccurrence', label: 'Date of occurrence' },
  { field: 'details', label: 'Details of Improvement and/or Proposed Action' },
  { field: 'type', label: 'Type' },
  { field: 'region', label: 'Region' },
  { field: 'branch', label: 'Branch' },
  { field: 'department', label: 'Department' },
  { field: 'other', label: 'Other' },
  { field: 'coordinator', label: 'Coordinator' },
];

/** Optional fields that still carry one of Mango's 256-char caps. */
const IMPW_CAPPED: ImpwFieldSpec[] = [
  { field: 'email', label: 'Email', maxLength: 256 },
  { field: 'phone', label: 'Phone', maxLength: 256 },
  { field: 'fax', label: 'Fax', maxLength: 256 },
];

/** Blank required fields, by their Mango label. */
export function missingImpwFields(d: ImpwDraft): string[] {
  return IMPW_REQUIRED.filter((f) => !String(d[f.field] ?? '').trim()).map((f) => f.label);
}

/** Fields longer than the cap Mango's form enforces. */
export function overlongImpwFields(d: ImpwDraft): string[] {
  return [...IMPW_REQUIRED, ...IMPW_CAPPED]
    .filter((f) => f.maxLength != null && String(d[f.field] ?? '').length > f.maxLength)
    .map((f) => `${f.label} (max ${f.maxLength})`);
}

/** Everything that would stop Mango accepting this draft. Empty = ready. */
export function impwDraftIssues(d: ImpwDraft): string[] {
  const missing = missingImpwFields(d);
  return [
    ...(missing.length ? [`Required: ${missing.join(', ')}`] : []),
    ...overlongImpwFields(d).map((f) => `Too long: ${f}`),
  ];
}

/**
 * The plant's own answers to Mango's categorisation dropdowns. PMD cannot
 * know a tenant's option lists, so it never invents one: these start blank,
 * the coordinator picks them once on the first ticket, and the UI remembers
 * them. A blank one fails validation rather than being guessed — a ticket
 * filed under the wrong Branch is worse than one that asked.
 */
export interface ImpwSiteConfig {
  typeOfImprovement: string;
  source: string;
  type: string;
  region: string;
  branch: string;
  other: string;
  email: string;
  phone: string;
}

export const EMPTY_IMPW_SITE: ImpwSiteConfig = {
  typeOfImprovement: '',
  source: '',
  type: '',
  region: '',
  branch: '',
  other: '',
  email: '',
  phone: '',
};

/** Who is raising it — from the signed-in user (DAL whoAmI). */
export interface ImpwRaiser {
  name: string;
  email?: string;
}

/** '2026-08-26-Night' → '26/08/2026'. A Night shift's ShiftId carries its
 *  START date, which is the date the occurrence began. */
export function impwOccurrenceDate(shiftId: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})-/.exec(shiftId);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Shift code out of a ShiftId, for the human sentences. */
function shiftCodeOf(shiftId: string): string {
  const m = /-(Day|Afternoon|Night)$/.exec(shiftId);
  return m ? m[1] : '';
}

/**
 * One department name out of a taxonomy owner. The taxonomy writes an
 * escalation path ("Operator → Maintenance") or a shared job ("Maintenance
 * / Setter"); Mango's Department is a single pick from a list, so take the
 * end of an escalation (whoever it lands on) and the front of a shared job
 * (the primary owner).
 */
export function impwDepartmentOf(owner: string): string {
  const escalated = owner.split('→').pop() ?? '';
  return (escalated.split('/')[0] ?? '').trim();
}

/**
 * Department suggestion. A breakdown has a real answer — the taxonomy names
 * who owns each cause, and the biggest cause of the shift is the one to
 * route to. Quality-only findings go to the department that ran the press.
 */
export function suggestImpwDepartment(f: ImpwFinding): string {
  if (f.triggers.includes('breakdown') && f.slice.breakdowns.length) {
    const worst = [...f.slice.breakdowns].sort((a, b) => b.hours - a.hours)[0];
    const dept = impwDepartmentOf(worst.owner);
    if (dept) return dept;
  }
  return 'Production';
}

/**
 * Draft the whole ticket from one finding. Everything PMD can prove is
 * filled in; everything only the tenant knows comes from `site` and stays
 * editable. The body is written to stand on its own in Mango — someone
 * reading it there has no access to this dashboard.
 */
export function buildImpwDraft(
  f: ImpwFinding,
  raiser: ImpwRaiser,
  site: ImpwSiteConfig,
): ImpwDraft {
  const s = f.slice;
  const date = impwOccurrenceDate(f.shiftId);
  const shift = shiftCodeOf(f.shiftId);
  // Press first: Mango lists tickets by their Brief Description, and the
  // press is what a reader scans that list for.
  const where = `${s.machineCode}${shift ? ` ${shift} shift` : ''}${date ? ` ${date}` : ''}`;
  const headline = f.reasons[0] ?? 'KPI target missed';

  const lines: string[] = [
    `Machine: ${s.machineCode}${s.machineName && s.machineName !== s.machineCode ? ` (${s.machineName})` : ''}`,
    `Shift: ${shift || '—'} ${date} (ShiftId ${f.shiftId})`,
    `Orders run: ${s.jobNumbers.length ? s.jobNumbers.join(', ') : '—'}`,
    '',
    'Recorded on the shift:',
    `  Good output    ${s.output} pcs`,
    `  Rejects        ${s.reject} pcs`,
    `  Yield          ${s.yieldPct}%`,
    `  Breakdown (B)  ${fmtHrs(s.breakdownHrs)} h`,
  ];
  if (s.breakdowns.length) {
    lines.push('', 'Breakdown causes:');
    for (const b of [...s.breakdowns].sort((a, b2) => b2.hours - a.hours)) {
      lines.push(
        `  ${b.code} ${b.label} — ${fmtHrs(b.hours)} h${b.owner ? ` (${b.owner})` : ''}${
          b.note ? `\n      Operator: ${b.note}` : ''
        }`,
      );
    }
  }
  lines.push(
    '',
    'Why this was raised:',
    ...f.reasons.map((r) => `  · ${r}`),
    '',
    'Requested: investigate the cause and agree the corrective action with the',
    'department owner, then record the outcome against this ticket.',
  );

  return {
    briefDescription: clamp(`${where} — ${headline}`, 256),
    typeOfImprovement: site.typeOfImprovement,
    source: site.source,
    email: site.email || raiser.email || '',
    phone: site.phone,
    fax: '',
    sendCopyToCustomer: false,
    dateOfOccurrence: date,
    details: lines.join('\n'),
    additionalInformation: [
      `Raised from the PMD Dashboard KPI review by ${raiser.name || 'an unnamed user'}.`,
      `Source data: signed-off PMD_Production for ${f.shiftId} on ${s.machineCode}.`,
    ].join('\n'),
    authoritiesNotified: false,
    customerNotified: false,
    proceduresReviewed: false,
    processToBeChanged: false,
    trainingReviewed: false,
    investigationDetails: '',
    type: site.type,
    region: site.region,
    branch: site.branch,
    department: suggestImpwDepartment(f),
    other: site.other,
    plantEquipment: s.machineName && s.machineName !== s.machineCode
      ? `${s.machineCode} — ${s.machineName}`
      : s.machineCode,
    risks: impwRisks(f),
    relatedDocuments: `PMD Dashboard KPI — ${f.shiftId} — ${s.machineCode}`,
    relatedFiles: '',
    coordinator: raiser.name,
  };
}

function impwRisks(f: ImpwFinding): string {
  const s = f.slice;
  const bits: string[] = [];
  if (f.triggers.includes('breakdown')) {
    bits.push(
      `Unplanned downtime — ${fmtHrs(s.breakdownHrs)} h of the shift lost on ${s.machineCode}.`,
    );
  }
  if (f.triggers.includes('yield') || f.triggers.includes('reject')) {
    bits.push(`Scrap cost and delivery risk — ${s.reject} pcs rejected this shift.`);
  }
  return bits.join(' ');
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

/** Every field, labelled the way Mango's form labels it — the block the
 *  coordinator pastes from. Required fields keep their * so nothing is
 *  skipped on the way across. */
export function impwPlainText(d: ImpwDraft): string {
  const req = new Set(IMPW_REQUIRED.map((f) => f.field));
  const row = (field: keyof ImpwDraft, label: string): string => {
    const v = d[field];
    const text = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '');
    const star = req.has(field) ? ' *' : '';
    return text.includes('\n')
      ? `${label}${star}:\n${text}\n`
      : `${label}${star}: ${text}`;
  };
  return [
    'IMPW — Improvement Workflow',
    '',
    row('briefDescription', 'Brief Description'),
    row('typeOfImprovement', 'Type of Improvement'),
    row('source', 'Source'),
    row('email', 'Email'),
    row('phone', 'Phone'),
    row('fax', 'Fax'),
    row('sendCopyToCustomer', 'Send copy to customer'),
    row('dateOfOccurrence', 'Date of occurrence'),
    row('details', 'Details of Improvement and/or Proposed Action'),
    row('additionalInformation', 'Additional information'),
    row('authoritiesNotified', 'Authorities have been notified'),
    row('customerNotified', 'Customer notified?'),
    row('proceduresReviewed', 'Procedures have been reviewed'),
    row('processToBeChanged', 'Process to be changed?'),
    row('trainingReviewed', 'Training reviewed?'),
    row('investigationDetails', 'Investigation Details'),
    row('type', 'Type'),
    row('region', 'Region'),
    row('branch', 'Branch'),
    row('department', 'Department'),
    row('other', 'Other'),
    row('plantEquipment', 'Plant/Equipment involved'),
    row('risks', 'Risks involved'),
    row('relatedDocuments', 'Related documents'),
    row('relatedFiles', 'Related files'),
    row('coordinator', 'Coordinator'),
  ].join('\n');
}

/**
 * Fold a shift's slots into one entry per breakdown cause.
 *
 * B AND ONLY B. The KPI table's "Down h" is the downtime *kind*, which also
 * counts M (Smoko) — every shift takes its break, so anything keyed off
 * that column would report a breakdown on every shift ever worked. This is
 * the one place the distinction is made, so no caller can get it wrong.
 */
export function foldBreakdowns(
  slots: ReadonlyArray<{
    statusCode: string;
    bdIssue: string;
    bdCause?: string;
    mangoTicket: string;
  }>,
  slotHours: number,
): ImpwBreakdown[] {
  const by = new Map<string, ImpwBreakdown>();
  for (const s of slots) {
    if (s.statusCode !== 'B') continue;
    // A breakdown the operator never coded is still a breakdown; park it on
    // the taxonomy's own "other" rather than dropping the hours.
    const code = (s.bdIssue || '').trim() || 'OTH-99';
    const label = bdLabelFor(code);
    // BDCause is pre-filled with the taxonomy text unless the operator
    // typed their own, so only keep it when it actually adds something.
    const written = (s.bdCause || s.mangoTicket || '').trim();
    const note = written && written !== label ? written : '';
    const hit = by.get(code);
    if (hit) {
      hit.hours = +(hit.hours + slotHours).toFixed(2);
      if (!hit.note && note) hit.note = note;
    } else {
      by.set(code, { code, label, owner: bdOwnerFor(code), hours: slotHours, note });
    }
  }
  return [...by.values()].sort((a, b) => b.hours - a.hours || a.code.localeCompare(b.code));
}
