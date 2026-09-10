import { bdLabelFor, bdOwnerFor } from './breakdown';
import { parseHandover } from './handover';
import { shiftBounds, SLOTS_PER_SHIFT, SLOT_MINUTES } from './shifts';

// Mango IMPW (Improvement Workflow) — the company's improvement / corrective
// action register. Mango is the system of record (same management decision
// as maintenance work orders, see ui/die.ts): PMD never becomes a second
// place improvement actions live. What PMD owns is the TRIGGER — it is the
// only system that knows a shift missed its yield, blew its reject
// allowance, or lost hours to a breakdown — so it drafts the ticket, fills
// every field it can prove, and hands the finished draft to Mango.
//
// This module is the whole contract in pure form: the rules that raise a
// finding, the body of POST /api/v4/improvement, and the validation of it.
// No DOM, no fetch — the UI owns the Yes / No and the handoff.
//
// The API half is transcribed from Mango's own v4 developer document; see
// docs/mango-api-v4.md, which is the authority for every field name, type
// and limit below. Nothing here is derived from the IMPW web form: the form
// asks for 26 things and the API accepts 10, and several of the form's
// starred fields cannot be posted at all.

const SHIFT_HOURS = (SLOTS_PER_SHIFT * SLOT_MINUTES) / 60; // 8

/** Which KPI rule a shift broke. A shift can break several. */
export type ImpwTrigger = 'breakdown' | 'yield' | 'reject';

/** Listed worst-consequence-first; the order a finding's triggers and its
 *  reason lines are reported in. */
export const IMPW_TRIGGER_ORDER: ImpwTrigger[] = ['breakdown', 'yield', 'reject'];

/**
 * One order that ran in the shift, with the material it was making.
 *
 * The part number is what a Mango reader can act on: "550T lost two hours"
 * says which press to look at, and "SF-1234-A Sofa Arm Left" says which
 * tool, which material and which customer order are affected. PMD already
 * carries both on every production row (JobHead_PartNum /
 * JobHead_PartDescription), so a ticket that omitted them was throwing away
 * the half of the story the investigator needs.
 */
export interface ImpwJob {
  jobNumber: string;
  /** Epicor Part # — the material number. '' when the row never carried one. */
  partNumber: string;
  partDescription: string;
}

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
  /** Display name of the press, for the ticket body. */
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
  /** Orders that ran in the slice, in the order encountered, each with its
   *  material. */
  jobs: ImpwJob[];
  /**
   * A Mango ticket already raised for this shift, read from the shift's own
   * Handover note ("IMPW: IMP 0123", written by appendImpwHandover).
   *
   * This is the ONLY record of a raised ticket that every device can see.
   * The Yes / No ledger is per browser, so without this the same shift is
   * offered again on the next iPad, on a PC, or after someone clears their
   * site data — and the meeting raises a second ticket for one event.
   */
  raisedTicket: string;
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
  /** The ticket this shift already carries, from its Handover note. Non-empty
   *  means the improvement exists in Mango and must not be raised again —
   *  whatever this browser's own ledger remembers. */
  raisedTicket: string;
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
      // A shift that already carries a ticket is still a finding — the
      // meeting wants to see it and follow it up — but it is a raised one,
      // and the UI must never offer to raise it a second time.
      raisedTicket: slice.raisedTicket ?? '',
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

/** The line PMD writes into a shift's Handover when Mango confirms a ticket:
 *  `IMPW: IMP 0123` (see appendImpwHandover in the DAL). Anchored to the
 *  start of a line so a ticket number mentioned inside a sentence is not
 *  mistaken for the record of one. */
const IMPW_HANDOVER_LINE = /(?:^|\n)[ \t]*IMPW[ \t]*[:：][ \t]*([^\n]+)/i;

/**
 * The Mango ticket already recorded against a shift, from its own Handover
 * note — '' when there is none.
 *
 * This is the cross-device answer to "has this already been raised?". The
 * Yes / No ledger lives in one browser's localStorage; the Handover lives in
 * SharePoint, so every iPad and PC reads the same answer, and a device that
 * has never seen the shift before still knows not to raise it twice.
 *
 * Every record of the shift is scanned because the note is stored per
 * (machine, shift, job) and the ticket lands on whichever rows the writeback
 * reached. All four 4M fields are read, not just Method: the line is written
 * to Method, but a note re-typed by hand should still count.
 */
export function impwTicketFromHandovers(
  notes: ReadonlyArray<string | undefined | null>,
): string {
  for (const note of notes) {
    if (!note) continue;
    const h = parseHandover(note);
    for (const field of [h.method, h.machine, h.mold, h.material]) {
      const ref = (IMPW_HANDOVER_LINE.exec(field)?.[1] ?? '').trim();
      // A reference, not a sentence: PMD writes the number it was given, and
      // anything long or digitless is somebody's prose about the ticket.
      if (ref && ref.length <= 40 && /\d/.test(ref)) return ref;
    }
  }
  return '';
}

function fmtHrs(h: number): string {
  return h.toFixed(1).replace(/\.0$/, '');
}

// ---------------------------------------------------------------------------
// The ticket — body of POST /api/v4/improvement
// ---------------------------------------------------------------------------

/**
 * One entry from a tenant's own option list, as GET /api/v4/improvement/new
 * returns it. Mango wants BOTH halves back on the POST, so both are carried
 * around together rather than PMD storing an id and looking the name up.
 */
export interface MangoOption {
  id: string;
  name: string;
}

export const EMPTY_OPTION: MangoOption = { id: '', name: '' };

/** Mango's own caps (docs/mango-api-v4.md). Enforced here so a ticket is
 *  rejected on the floor, where it can still be fixed, and not by a 422. */
export const IMPW_DESCRIPTION_MAX = 255;
export const IMPW_DETAILS_MAX = 4096;
export const IMPW_NAME_MAX = 255;
/** region / branch / department / other. */
export const IMPW_PLACEMENT_MAX = 255;

/**
 * The create body, field for field. Ten fields — the IMPW web form's other
 * sixteen (Source, Type, Email, Phone, the five checkboxes, Investigation
 * Details, Plant/Equipment, Risks, Related documents/files, Attachments…)
 * have no POST equivalent, so what PMD actually knows about the press, the
 * orders and the stoppage goes into `improvementDetails` instead of being
 * invented into fields Mango would ignore.
 */
export interface ImpwDraft {
  /** Web-form fields; retained in API details because v4 has no equivalents. */
  source?: string;
  type?: string;
  /** Who the plant is asking to investigate. Mango decides the real one — see
   *  IMPW_DEFAULT_INVESTIGATOR — so this is a request written into the body. */
  investigator?: string;
  /** "Brief Description" on the form — what the register lists. */
  description: string;
  /** Must be one of the tenant's own types, from /improvement/new. */
  typeOfImprovement: MangoOption;
  /** "Name" — who raised it. */
  originatorName: string;
  /** ISO 8601 UTC, e.g. 2026-08-26T11:00:00.000Z. NOT the form's dd/mm/yyyy. */
  improvementDate: string;
  /** "Details of Improvement and/or Proposed Action". */
  improvementDetails: string;
  /** The four placement fields. Optional to the API, but each must name
   *  something that already exists in the tenant — a typo is a 422, not a
   *  new branch. */
  region: string;
  branch: string;
  department: string;
  other: string;
  /** Must be one of the tenant's own coordinators, from /improvement/new. */
  coordinator: MangoOption;
}

interface ImpwFieldSpec {
  field: keyof ImpwDraft;
  label: string;
  maxLength?: number;
}

/** Required by the API — a draft missing one of these is a 400 or a 422, so
 *  PMD refuses to send it. Labelled the way Mango's own form labels them so
 *  the message means something to whoever is reading it. */
const IMPW_REQUIRED: ImpwFieldSpec[] = [
  { field: 'description', label: 'Brief Description', maxLength: IMPW_DESCRIPTION_MAX },
  { field: 'typeOfImprovement', label: 'Type of Improvement' },
  { field: 'originatorName', label: 'Name', maxLength: IMPW_NAME_MAX },
  { field: 'improvementDate', label: 'Date of occurrence' },
  {
    field: 'improvementDetails',
    label: 'Details of Improvement and/or Proposed Action',
    maxLength: IMPW_DETAILS_MAX,
  },
  { field: 'coordinator', label: 'Coordinator' },
];

/** Optional, but still capped. */
const IMPW_OPTIONAL: ImpwFieldSpec[] = [
  { field: 'region', label: 'Region', maxLength: IMPW_PLACEMENT_MAX },
  { field: 'branch', label: 'Branch', maxLength: IMPW_PLACEMENT_MAX },
  { field: 'department', label: 'Department', maxLength: IMPW_PLACEMENT_MAX },
  { field: 'other', label: 'Other', maxLength: IMPW_PLACEMENT_MAX },
];

/**
 * Where the draft is going, because the two paths have genuinely different
 * requirements: the API will only accept the {id, name} Mango itself issued
 * for Type of Improvement and Coordinator, while a person pasting into the
 * web form picks from its dropdowns and needs nothing but the name.
 */
export type ImpwTarget = 'api' | 'paste';

/** Labels of every required field the draft has not filled. */
export function missingImpwFields(d: ImpwDraft, target: ImpwTarget = 'api'): string[] {
  return IMPW_REQUIRED.filter((f) => !impwFieldFilled(d[f.field], target)).map((f) => f.label);
}

function impwFieldFilled(v: string | MangoOption | undefined, target: ImpwTarget): boolean {
  if (typeof v === 'string') return !!v.trim();
  if (!v) return false;
  return target === 'api' ? !!(v.id.trim() && v.name.trim()) : !!v.name.trim();
}

/** Fields past Mango's documented length limit. */
export function overlongImpwFields(d: ImpwDraft): string[] {
  return [...IMPW_REQUIRED, ...IMPW_OPTIONAL]
    .filter((f) => {
      const v = f.field === 'improvementDetails' ? impwApiDetails(d) : d[f.field];
      return f.maxLength != null && typeof v === 'string' && v.length > f.maxLength;
    })
    .map((f) => `${f.label} (max ${f.maxLength})`);
}

/** Everything that would stop Mango accepting this draft. Empty = ready. */
export function impwDraftIssues(d: ImpwDraft, target: ImpwTarget = 'api'): string[] {
  const missing = missingImpwFields(d, target);
  return [
    ...(missing.length ? [`Required: ${missing.join(', ')}`] : []),
    ...overlongImpwFields(d).map((f) => `Too long: ${f}`),
  ];
}

/**
 * The plant's own answers, remembered between tickets. Region / Branch /
 * Other are free text that has to match names already in Mango; Type of
 * Improvement and Coordinator are picked from the lists Mango returns.
 * Nothing here is guessed or seeded — the first ticket asks, and only the
 * first ticket.
 *
 * Department is deliberately NOT here: it comes from the breakdown's owner
 * and so is a per-finding answer, not a site-wide one.
 */
export interface ImpwSiteConfig {
  region: string;
  branch: string;
  other: string;
  typeOfImprovement: MangoOption;
  coordinator: MangoOption;
}

export const EMPTY_IMPW_SITE: ImpwSiteConfig = {
  region: '',
  branch: '',
  other: '',
  typeOfImprovement: { ...EMPTY_OPTION },
  coordinator: { ...EMPTY_OPTION },
};

/**
 * Type of Improvement — one value, by the plant's own decision.
 *
 * Every ticket PMD raises comes from the same place: a shift missed a KPI
 * because something about how the job ran was not good enough. That is a
 * process gap whether the cause was a breakdown or scrap, and letting the
 * meeting pick between three near-synonyms only produced a register that
 * could not be grouped. The narrower question — what KIND of gap — is what
 * `Type` below answers.
 *
 * Still a list, not a constant: `fillImpwOptions` matches Mango's own
 * {id, name} entries against it, so the tenant can add a second accepted
 * name here without any other change.
 */
export const IMPW_IMPROVEMENT_TYPES = ['Process Gap'];

/** The one PMD picks. Separate from the list so a rename cannot silently
 *  leave the draft pointing at a value the tenant no longer offers. */
export const IMPW_DEFAULT_IMPROVEMENT_TYPE = IMPW_IMPROVEMENT_TYPES[0];

// `Type` — the web form's own classification, kept in improvementDetails
// because the v4 create body has no field for it (docs/mango-api-v4.md).
// Named rather than indexed: suggestImpwClassification picks by meaning, and
// an index would quietly pick the wrong one the day this list is reordered.
const IMPW_TYPE_EQUIPMENT = 'Equipment';
const IMPW_TYPE_PROCESS = 'Process Improvement';
const IMPW_TYPE_QUALITY = 'Quality';
/** 'Design Defect' is deliberately never auto-picked: calling a part's design
 *  wrong is an engineering judgement, not something a KPI miss can prove. */
export const IMPW_TYPES = ['Design Defect', IMPW_TYPE_EQUIPMENT, IMPW_TYPE_PROCESS, IMPW_TYPE_QUALITY];

export const IMPW_OTHERS = ['Maitenance -AU', 'PMD - AU'];

/**
 * Who the plant expects to investigate an improvement raised from the KPI
 * review. NOT an API field — v4's create body has no investigator, and Mango
 * assigns one at its "Assign to Investigation" stage — so it rides in
 * improvementDetails as a request, and reads back from Mango as fact.
 * Editable on every ticket; this is the answer, not the rule.
 */
export const IMPW_DEFAULT_INVESTIGATOR = 'Avila Pushparaj';

/** Match tenant-issued IDs by name; never manufacture an API ID. */
export function matchImpwOption(list: MangoOption[], name: string): MangoOption | undefined {
  const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return list.find((o) => normalize(o.name) === normalize(name));
}

export function suggestImpwClassification(f: ImpwFinding): { type: string; improvement: string; other: string } {
  const worst = [...f.slice.breakdowns].sort((a, b) => b.hours - a.hours)[0];
  const equipment = f.triggers.includes('breakdown') &&
    (!worst || /Maintenance|Toolroom/i.test(worst.owner));
  const quality = f.triggers.includes('yield') || f.triggers.includes('reject');
  return {
    type: equipment ? IMPW_TYPE_EQUIPMENT : quality ? IMPW_TYPE_QUALITY : IMPW_TYPE_PROCESS,
    improvement: IMPW_DEFAULT_IMPROVEMENT_TYPE,
    other: equipment ? IMPW_OTHERS[0] : IMPW_OTHERS[1],
  };
}

/** Who is raising it — from the signed-in user (DAL whoAmI). */
export interface ImpwRaiser {
  name: string;
  email?: string;
}

/**
 * When the occurrence began, as Mango wants it: ISO 8601 UTC.
 *
 * The shift's own start instant, not midnight — a Night shift's ShiftId
 * carries its START date, and dating it 00:00 would put a 23:00 Tuesday
 * stoppage on Tuesday morning. shiftBounds() already knows every shift's
 * wall-clock start, and Date#toISOString converts local → UTC, so a site in
 * NZDT files the same instant Mango would have recorded itself.
 */
export function impwOccurrenceIso(shiftId: string): string {
  return shiftBounds(shiftId)?.start.toISOString() ?? '';
}

/** '2026-08-26-Night' → '26/08/2026'. The form's own format, for the human
 *  paste-in path and for showing the date back on screen. */
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
 * / Setter"); Mango's Department is a single existing name, so take the end
 * of an escalation (whoever it lands on) and the front of a shared job (the
 * primary owner).
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

/** The distinct materials a shift ran, first appearance first. A job with no
 *  part number on any of its rows is dropped rather than listed as a blank. */
export function impwParts(jobs: ReadonlyArray<ImpwJob>): ImpwJob[] {
  const by = new Map<string, ImpwJob>();
  for (const j of jobs) {
    const num = j.partNumber.trim();
    if (!num) continue;
    const hit = by.get(num);
    // Keep the first description that is not blank — the per-status rows
    // carry '' and would otherwise wipe the canonical row's answer.
    if (hit) { if (!hit.partDescription && j.partDescription) hit.partDescription = j.partDescription; }
    else by.set(num, { ...j, partNumber: num });
  }
  return [...by.values()];
}

/**
 * The materials in one line, for the Brief Description — which is all the
 * Mango register shows and is capped at 255. One part gets its description
 * too; several get their numbers, because a list of full descriptions would
 * push the reason for the ticket off the end of the line.
 */
export function impwPartsSummary(jobs: ReadonlyArray<ImpwJob>): string {
  const parts = impwParts(jobs);
  if (!parts.length) return '';
  if (parts.length === 1) {
    const p = parts[0];
    return p.partDescription ? `${p.partNumber} ${p.partDescription}` : p.partNumber;
  }
  const head = parts.slice(0, 2).map((p) => p.partNumber).join(', ');
  return parts.length > 2 ? `${head} +${parts.length - 2} more` : head;
}

/**
 * Draft the whole ticket from one finding. Everything PMD can prove is
 * filled in; the two option fields and the placement names come from `site`
 * and stay editable. The body is written to stand on its own in Mango —
 * someone reading it there has no access to this dashboard.
 */
export function buildImpwDraft(
  f: ImpwFinding,
  raiser: ImpwRaiser,
  site: ImpwSiteConfig,
  now: Date = new Date(),
): ImpwDraft {
  const s = f.slice;
  const date = impwOccurrenceDate(f.shiftId);
  const shift = shiftCodeOf(f.shiftId);
  // Press first: Mango lists tickets by their Brief Description, and the
  // press is what a reader scans that list for.
  const where = `${s.machineCode}${shift ? ` ${shift} shift` : ''}${date ? ` ${date}` : ''}`;
  const headline = f.reasons.join('; ') || 'KPI target missed';
  const classification = suggestImpwClassification(f);
  const notes = s.breakdowns.filter((b) => b.note).map((b) => b.note).join('; ');

  // The material belongs in the one line Mango's register lists: a reader
  // scanning it needs the press AND the part to know whether this is their
  // problem, and the register shows nothing else.
  const part = impwPartsSummary(s.jobs);
  return {
    description: clamp(
      `${where}${part ? ` · ${part}` : ''} — ${headline}${notes ? `; ${notes}` : ''}`,
      IMPW_DESCRIPTION_MAX,
    ),
    typeOfImprovement: { ...(matchImpwOption([site.typeOfImprovement], classification.improvement)
      ?? { id: '', name: classification.improvement }) },
    source: 'Employee',
    type: classification.type,
    investigator: IMPW_DEFAULT_INVESTIGATOR,
    originatorName: clamp(raiser.name, IMPW_NAME_MAX),
    improvementDate: now.toISOString(),
    improvementDetails: clamp(`Investigate rootcause\n\n${impwDetailsBody(f, raiser)}`, IMPW_DETAILS_MAX - 80),
    region: 'Minto (AU)',
    branch: 'Resero - Minto',
    department: 'Manufacturing - AU',
    other: classification.other,
    coordinator: { ...(matchImpwOption([site.coordinator], 'Paul Fiddling (AU)')
      ?? { id: '', name: 'Paul Fiddling (AU)' }) },
  };
}

/**
 * The whole story in one field. The API has no Plant/Equipment, no Risks,
 * no Additional Information and no Investigation Details to spread this
 * across, and 4096 characters here is far more room than those would have
 * given — so the press, the orders, the measured numbers, every breakdown
 * cause with what the operator wrote, and the rule that fired all go in,
 * in an order that reads top-down.
 */
function impwDetailsBody(f: ImpwFinding, raiser: ImpwRaiser): string {
  const s = f.slice;
  const date = impwOccurrenceDate(f.shiftId);
  const shift = shiftCodeOf(f.shiftId);
  const press = s.machineName && s.machineName !== s.machineCode
    ? `${s.machineCode} (${s.machineName})`
    : s.machineCode;

  const parts = impwParts(s.jobs);
  const lines: string[] = [
    `Plant/Equipment: ${press}`,
    `Material: ${parts.length ? parts.map((p) => p.partNumber).join(', ') : '—'}`,
    `Shift: ${shift || '—'} ${date} (ShiftId ${f.shiftId})`,
  ];
  // One line per order, each naming what it was making — the investigator's
  // starting point is the part, not the job number.
  if (s.jobs.length) {
    lines.push('Orders run:');
    for (const j of s.jobs) {
      const material = [j.partNumber, j.partDescription].filter(Boolean).join(' · ');
      lines.push(`  ${j.jobNumber}${material ? ` — ${material}` : ''}`);
    }
  } else {
    lines.push('Orders run: —');
  }
  lines.push(
    '',
    'Recorded on the shift:',
    `  Good output    ${s.output} pcs`,
    `  Rejects        ${s.reject} pcs`,
    `  Yield          ${s.yieldPct}%`,
    `  Breakdown (B)  ${fmtHrs(s.breakdownHrs)} h`,
  );
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
    `Risk: ${impwRisks(f)}`,
    '',
    'Requested: investigate the cause and agree the corrective action with the',
    'department owner, then record the outcome against this ticket.',
    '',
    `Raised from the PMD Dashboard KPI review by ${raiser.name || 'an unnamed user'}.`,
    `Source data: signed-off PMD_Production for ${f.shiftId} on ${s.machineCode}.`,
  );
  return lines.join('\n');
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

/**
 * The draft as the API wants it (docs/mango-api-v4.md § Create an
 * improvement). The four placement fields are optional and are dropped when
 * blank — each has to match a name that already exists in the tenant, and
 * an empty string is not one of those.
 */
function impwApiDetails(d: ImpwDraft): string {
  // Source, Type and Investigator are form fields with no v4 equivalent, so
  // they lead the body rather than being dropped. Investigator is a REQUEST:
  // Mango assigns the real one, and the read-back dialog shows that answer.
  return [
    `Source: ${d.source || 'Employee'}`,
    `Type: ${d.type || IMPW_TYPE_PROCESS}`,
    `Investigator requested: ${d.investigator || IMPW_DEFAULT_INVESTIGATOR}`,
    '',
    d.improvementDetails,
  ].join('\n');
}

export function impwApiPayload(d: ImpwDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {
    description: d.description,
    typeOfImprovement: { id: d.typeOfImprovement.id, name: d.typeOfImprovement.name },
    originatorName: d.originatorName,
    improvementDate: d.improvementDate,
    improvementDetails: impwApiDetails(d),
    coordinator: { id: d.coordinator.id, name: d.coordinator.name },
  };
  for (const key of ['region', 'branch', 'department', 'other'] as const) {
    const v = d[key].trim();
    if (v) out[key] = v;
  }
  return out;
}

/** Every field, labelled the way Mango's own form labels it — the block
 *  someone pastes in by hand when this device has no API sign-in. */
export function impwPlainText(d: ImpwDraft): string {
  const row = (label: string, value: string, required = false): string => {
    const star = required ? ' *' : '';
    return value.includes('\n') ? `${label}${star}:\n${value}\n` : `${label}${star}: ${value}`;
  };
  return [
    'IMPW — Improvement Workflow',
    '',
    row('Brief Description', d.description, true),
    row('Type of Improvement', d.typeOfImprovement.name, true),
    row('Source', d.source || 'Employee', true),
    row('Type', d.type || IMPW_TYPE_PROCESS, true),
    row('Investigator', d.investigator || IMPW_DEFAULT_INVESTIGATOR),
    row('Name', d.originatorName, true),
    row('Date of occurrence', impwIsoToFormDate(d.improvementDate), true),
    row('Details of Improvement and/or Proposed Action', d.improvementDetails, true),
    row('Region', d.region),
    row('Branch', d.branch),
    row('Department', d.department),
    row('Other', d.other),
    row('Coordinator', d.coordinator.name, true),
  ].join('\n');
}

/** ISO 8601 → the form's dd/mm/yyyy, in the browser's own timezone so the
 *  pasted date matches the shift the ticket is about. */
export function impwIsoToFormDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Reading Mango back
// ---------------------------------------------------------------------------

/** What POST /api/v4/improvement returns. */
export interface ImpwCreated {
  id: string;
  formTitle: string;
  abbreviation: string;
  number: string;
}

export function parseImpwCreated(body: unknown): ImpwCreated {
  const rec = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string).trim() : '');
  return {
    id: str('id'),
    formTitle: str('formTitle'),
    abbreviation: str('abbreviation'),
    number: str('number'),
  };
}

/** 'IMP 0123' — what the floor calls the ticket. Falls back through the
 *  number alone and then the opaque id, so a 2xx always shows something. */
export function impwTicketRef(c: ImpwCreated): string {
  if (c.abbreviation && c.number) return `${c.abbreviation} ${c.number}`;
  return c.number || c.id || '';
}

/**
 * One improvement as Mango reads it BACK — the answer to "what happened to
 * the ticket we raised?", which is a different question from the ten fields
 * PMD is allowed to send. Mango owns everything here: the stage it has
 * reached, who is investigating it, when it is due. PMD writes none of it
 * and stores none of it as fact; it is shown, with the time it was read.
 *
 * Field names are the ones in the document's own RETURNS table for
 * GET /api/v4/improvement (docs/mango-api-v4.md § Reading a ticket back).
 * Only the useful subset is kept — the register also returns four root
 * causes, a cost, an item/product and the related-risk text, none of which
 * a KPI meeting is looking at.
 */
export interface ImpwRecord {
  id: string;
  number: string;
  briefDescription: string;
  typeOfImprovement: string;
  source: string;
  /** Originator — what PMD posted as `originatorName`. */
  name: string;
  coordinator: string;
  /** The three the meeting actually asks about. */
  currentStage: string;
  investigator: string;
  /** "To be completed by" on the form. */
  dueDate: string;
  dateCreated: string;
  dateClosed: string;
  dateOfOccurrence: string;
  region: string;
  branch: string;
  department: string;
  other: string;
  details: string;
  additionalInformation: string;
  correctiveAction: string;
  preventativeAction: string;
  improvementSummary: string;
  potentialSeverity: string;
}

const EMPTY_RECORD: ImpwRecord = {
  id: '', number: '', briefDescription: '', typeOfImprovement: '', source: '', name: '',
  coordinator: '', currentStage: '', investigator: '', dueDate: '', dateCreated: '',
  dateClosed: '', dateOfOccurrence: '', region: '', branch: '', department: '', other: '',
  details: '', additionalInformation: '', correctiveAction: '', preventativeAction: '',
  improvementSummary: '', potentialSeverity: '',
};

/**
 * Spellings to accept besides the field's own name. Mango's document
 * disagrees with itself: the RETURNS table says `briefDescription` and
 * `Investigator`, and the JSON sample printed beside it says
 * `briefDecription` and `investigator`. Rather than bet on which one the
 * server actually sends, take either — a misread field would silently show
 * a blank Stage, which reads as "nobody has touched it" and is the one
 * wrong answer this dialog must never give.
 */
const IMPW_RECORD_ALIASES: Partial<Record<keyof ImpwRecord, string[]>> = {
  briefDescription: ['briefdecription'],
  dueDate: ['tobecompletedby'],
  currentStage: ['stage'],
};

/** Where a read-back field belongs on screen. */
export type ImpwRecordGroup = 'progress' | 'ticket' | 'outcome';

export interface ImpwRecordRow {
  field: keyof ImpwRecord;
  /** Mango's own label for it, from the module data table. */
  label: string;
  group: ImpwRecordGroup;
  /** Reformat through impwMangoDate before showing. */
  date?: boolean;
  /** Free text that needs its own block, not a table row. */
  block?: boolean;
}

/** Every field worth showing, in reading order: where the ticket has got to
 *  first, because that is the question being asked. */
export const IMPW_RECORD_ROWS: ImpwRecordRow[] = [
  { field: 'currentStage', label: 'Current Stage', group: 'progress' },
  { field: 'investigator', label: 'Investigator', group: 'progress' },
  { field: 'dueDate', label: 'To be completed by', group: 'progress', date: true },
  { field: 'dateClosed', label: 'Close Date', group: 'progress', date: true },
  { field: 'coordinator', label: 'Coordinator', group: 'ticket' },
  { field: 'typeOfImprovement', label: 'Type of Improvement', group: 'ticket' },
  { field: 'source', label: 'Source', group: 'ticket' },
  { field: 'name', label: 'Name', group: 'ticket' },
  { field: 'dateOfOccurrence', label: 'Date of Occurrence', group: 'ticket', date: true },
  { field: 'dateCreated', label: 'Create Date', group: 'ticket', date: true },
  { field: 'region', label: 'Region', group: 'ticket' },
  { field: 'branch', label: 'Branch', group: 'ticket' },
  { field: 'department', label: 'Department', group: 'ticket' },
  { field: 'other', label: 'Other', group: 'ticket' },
  { field: 'potentialSeverity', label: 'Potential Severity', group: 'outcome' },
  { field: 'correctiveAction', label: 'Corrective Action Taken', group: 'outcome', block: true },
  { field: 'preventativeAction', label: 'Preventative Action Taken', group: 'outcome', block: true },
  { field: 'improvementSummary', label: 'Improvement Summary', group: 'outcome', block: true },
  { field: 'additionalInformation', label: 'Additional Information', group: 'outcome', block: true },
  { field: 'briefDescription', label: 'Brief Description', group: 'outcome', block: true },
  { field: 'details', label: 'Details of Improvement and/or Proposed Action', group: 'outcome', block: true },
];

/** One improvement out of whatever shape Mango sent. Keys are matched
 *  case-insensitively; anything absent stays '' rather than becoming
 *  'undefined' on screen. */
export function parseImpwRecord(body: unknown): ImpwRecord {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') byLower.set(k.toLowerCase(), v.trim());
    else if (typeof v === 'number' && Number.isFinite(v)) byLower.set(k.toLowerCase(), String(v));
  }
  const pick = (field: keyof ImpwRecord): string => {
    for (const name of [field.toLowerCase(), ...(IMPW_RECORD_ALIASES[field] ?? [])]) {
      const v = byLower.get(name);
      if (v) return v;
    }
    return '';
  };
  const out = { ...EMPTY_RECORD };
  for (const key of Object.keys(EMPTY_RECORD) as Array<keyof ImpwRecord>) out[key] = pick(key);
  return out;
}

/** The register, from GET /api/v4/improvement. */
export function parseImpwRecords(body: unknown): ImpwRecord[] {
  if (!Array.isArray(body)) return [];
  return body.map((item) => parseImpwRecord(item)).filter((r) => r.id || r.number);
}

/**
 * Did that response actually carry an improvement?
 *
 * The vendor document's GET /api/v4/improvement/{id} page is a copy-paste of
 * the Compliance one — its URL line says `/api/v4/compliance/{id}` and its
 * RETURNS table lists compliance fields — so what that endpoint really
 * answers with is not documented. PMD asks it anyway (one small call beats
 * pulling the whole register) and uses this to tell a real improvement from
 * the eight-field stub the document describes; a stub means fall back to the
 * register, which IS documented, rather than showing a ticket with every
 * field blank.
 */
export function impwRecordIsDetailed(r: ImpwRecord): boolean {
  return !!(
    r.briefDescription || r.details || r.currentStage || r.investigator ||
    r.dueDate || r.name || r.dateCreated
  );
}

/** Digits only, leading zeros dropped: 'IMP 0123' and '0123' are the same
 *  ticket, and the register has been seen to carry the abbreviation in the
 *  number column while the create response splits the two apart. */
function impwNumberKey(s: string): string {
  const digits = (s.match(/\d+/g) ?? []).join('');
  return digits.replace(/^0+/, '');
}

/** The raised ticket inside a register listing. The id is exact and wins;
 *  the number is the fallback for tickets PMD filed before it kept ids. */
export function findImpwRecord(
  records: ReadonlyArray<ImpwRecord>,
  ref: { id?: string; number?: string },
): ImpwRecord | null {
  const id = (ref.id ?? '').trim();
  if (id) {
    const hit = records.find((r) => r.id === id);
    if (hit) return hit;
  }
  const num = impwNumberKey(ref.number ?? '');
  if (num) {
    const hit = records.find((r) => impwNumberKey(r.number) === num);
    if (hit) return hit;
  }
  return null;
}

/**
 * A date Mango sent back, in the dd/mm/yyyy the rest of the site reads.
 *
 * The document types every returned date as "String" and shows two shapes —
 * the search filters use yyyy-mm-dd, the create body takes full ISO 8601 —
 * so both turn up. A bare yyyy-mm-dd is rewritten by hand rather than
 * through Date, because parsing one makes it UTC midnight and prints the day
 * before anywhere behind UTC. Anything that is not a date Mango's own words
 * are shown unchanged; inventing a date it never sent would be worse than
 * showing an odd one.
 */
export function impwMangoDate(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return impwIsoToFormDate(s) || s;
  return s;
}

/** The tenant's option lists from GET /api/v4/improvement/new. Anything that
 *  isn't a well-formed {id,name} is skipped rather than offered as a broken
 *  choice — a pick with no id fails Mango's validation anyway. */
export function parseImpwOptions(body: unknown, key: string): MangoOption[] {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const list = Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [];
  const out: MangoOption[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (id && name) out.push({ id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Failures, in words the floor can act on
// ---------------------------------------------------------------------------

/** Join a base URL and an API path without doubling or dropping the '/'.
 *  Mango's paths must not end in a slash or whitespace, so both ends are
 *  trimmed. */
export function impwEndpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function quoteMango(s: string, body: string): string {
  const detail = body.trim().slice(0, 300);
  return detail ? `${s} — Mango said: ${detail}` : s;
}

const OFFLINE =
  'Could not reach Mango from this browser — check the network, or ask IT whether api.mangolive.com allows requests from this site (CORS).';

/**
 * Sign-in failures. Mango answers a wrong username or password with 400 and
 * a message, so 400 here means the credentials, not the ticket.
 */
export function describeMangoAuthFailure(status: number, body: string): string {
  if (status === 0) return OFFLINE;
  if (status === 400 || status === 401) {
    return quoteMango(
      'Mango would not sign in. Check the username and password under ⚙ Mango connection — and that this account has API access switched on inside Mango.',
      body,
    );
  }
  if (status === 404) {
    return quoteMango('No Mango API at that address — check the API address in ⚙ Mango connection.', body);
  }
  if (status >= 500) {
    return quoteMango(`Mango returned a server error (${status}) while signing in. Try again shortly.`, body);
  }
  return quoteMango(`Mango returned ${status} while signing in.`, body);
}

/**
 * Turn a failed ticket call into a sentence that says what to DO. The floor
 * cannot read an HTTP status, and "it didn't work" wastes the trip to the
 * office.
 */
export function describeImpwApiFailure(status: number, body: string): string {
  if (status === 0) return OFFLINE;
  if (status === 401 || status === 403) {
    return quoteMango(
      'Mango rejected the sign-in. Re-enter the username and password under ⚙ Mango connection. (A Mango token is tied to the network it was issued on, so this can also mean the device changed network.)',
      body,
    );
  }
  if (status === 404) {
    return quoteMango('No Mango API at that address — check the API address in ⚙ Mango connection.', body);
  }
  if (status === 422) {
    return quoteMango(
      'Mango rejected one of the fields. Region, Branch, Department and Other must each match a name that already exists in Mango — check their spelling.',
      body,
    );
  }
  if (status === 400) {
    return quoteMango('Mango would not accept the ticket contents.', body);
  }
  if (status >= 500) {
    return quoteMango(`Mango returned a server error (${status}). It is not the ticket — try again shortly.`, body);
  }
  return quoteMango(`Mango returned ${status}.`, body);
}

/**
 * Reading a ticket back is a different failure from filing one, and must not
 * borrow its words: nothing is being written, so nothing can be lost, and a
 * 404 here means the ticket, not the address.
 */
export function describeImpwLookupFailure(status: number, body: string): string {
  if (status === 0) return OFFLINE;
  if (status === 401 || status === 403) {
    return quoteMango(
      'Mango would not accept the sign-in for this lookup. Re-enter it under ⚙ Mango connection. (A token is tied to the network it was issued on, so this can also mean the device changed network.)',
      body,
    );
  }
  if (status === 400 || status === 404) {
    return quoteMango(
      'Mango has no improvement with that reference. It may have been archived, or this account may not be allowed to see it.',
      body,
    );
  }
  if (status >= 500) {
    return quoteMango(`Mango returned a server error (${status}) while looking the ticket up. Try again shortly.`, body);
  }
  return quoteMango(`Mango returned ${status} while looking the ticket up.`, body);
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
