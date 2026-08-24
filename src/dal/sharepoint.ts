Warning: truncated output (original token count: 60597)
Total output lines: 5561

import type {
  BdCode,
  DieChangeLog,
  DieComponentCondition,
  DieMaintenanceRequest,
  DieMaster,
  Machine,
  MaintPriority,
  MaintStatus,
  MaintType,
  Operator,
  ParetoFilter,
  ParetoSlice,
  PlanningFilter,
  PlanningOrder,
  ProductDieColor,
  ProductionCounterRecord,
  ProductionFilter,
  ProductionRecord,
  RejectCategory,
  ShiftCode,
  StatusCode,
  Supervisor,
  UserContext,
} from '../types';
import type { PmdDataLayer } from './types';
import { bdCategoryOf, bdLabelFor, BD_TAXONOMY } from '../core/breakdown';
import { shiftBounds, slotClock } from '../core/shifts';
import { hoursUnavailableFor, shiftTargetFor } from '../core/targets';
import { retroJobLeftFixes, sumGoodStartedBefore } from '../core/jobgood';
import {
  DIE_COMPONENTS,
  DIE_CONDITION_META,
  dieChangeEventKey,
  parseDieCondition,
  parseToolStatus,
  TOOL_STATUS_META,
} from '../core/die';

// =====================================================================
// SharePointDataLayer — Resero Operations AU site.
//
// Talks to the 11 lists shown in the screenshot, with three save-time
// outputs (PMD_Production header + PMD_BreakDown status-hour analytic +
// PMD_Rejects per-event log) instead of the per-slot row model the
// MemoryDataLayer uses.
//
// Live editing (operator filling out the sheet) is cached in memory by
// this adapter; the cache is flushed to the three lists on `lockShift`
// (= Sign off & Save). Past shifts are hydrated back from the header
// table on demand so the trace view works.
// =====================================================================

const LISTS = {
  machine: 'PMD_Machine',
  operator: 'PMD_Operator',
  supervisor: 'PMD_Supervisor',
  planning: 'PMD_Planning',
  /** Supervisor-added orders missing from the Epicor extract. Title =
   *  JobNumber; auto-provisioned on first add (see createManualOrder). */
  manualOrders: 'PMD_ManualOrders',
  production: 'PMD_Production',
  /** Transient "in-progress" mirror of PMD_Production. pushLiveSnapshot
   *  writes here every poll tick; Sign Off & Save copies the row into
   *  PMD_Production and deletes it from here. Same column schema as
   *  PMD_Production by design — see the production field map. */
  liveStatus: 'PMD_LiveStatus',
  rejects: 'PMD_Rejects',
  breakdown: 'PMD_BreakDownlog',
  rejectCategories: 'PMD_RejectCategories',
  breakdownMaster: 'PMD_BreakdownMaster',
  productDieColor: 'PMD_ProductDieColor',
  /** Die maintenance work requests (Trace → 🛠 Die Management). Created
   *  automatically by ensureDieMaintenanceList() on the first write if
   *  the tenant doesn't have it yet — see that method for the schema. */
  dieMaintenance: 'PMD_DieMaintenance',
  /** Die asset register (one row per physical tool) — created by hand on
   *  the site (2026-07). Read-only from the app; the toolroom maintains
   *  ToolStatus / cavities / changeover facts directly in SharePoint. */
  dieMaster: 'PMD_DieMaster',
  /** Die-change condition reports (created by hand 2026-07 — internal
   *  names verified against the list schema export). The operator sheet
   *  writes here when a Die/Insert Change is first marked. */
  dieChangeLog: 'PMD_DieChangeLog',
  rdoRoster: 'RDO Roster 2026-2030',
} as const;

// SharePoint's internal column names are baked in at creation time. These
// are my best guess based on the column titles in the screenshot —
// spaces become `_x0020_`, slashes become `_x002f_`. If your actual
// internal names differ, override per-list via `SharePointOptions.fieldMap`
// at construction time (printed by `diagnoseFields()` for confirmation).
// Field map calibrated against the diagnoseFields() output on
// reseroglobal.sharepoint.com/sites/ReseroOperationsAU (2026-05-26).
// Pattern note: Many lists were imported from Excel/external sources,
// which left the primary column in `Title` (machine code, part number,
// reject code, etc.) and gave the other columns auto-generated names
// like `field_1`. Don't try to "fix" by hand — match what's there.
const DEFAULT_FIELDS = {
  machine: {
    code: 'Title', // machine code (e.g. "1600T") lives in Title
    active: 'IsActive_x003a_Yes_x002f_No', // display is literally "IsActive: Yes/No"
    displayOrder: 'DisplayOrder',
  },
  operator: {
    // Title = operator name; `Supervisor` (internal) displays as
    // "Supervisor_1", and `Supervisor0` (internal) is the Lookup column.
    shift: 'Shift',
    name: 'Title',
    position: 'Position',
    supervisor1: 'Supervisor',
    supervisor: 'Supervisor0',
  },
  supervisor: {
    // Title = role title (e.g. "Day shift Supervisor"); Name = person name.
    title: 'Title',
    name: 'Name',
  },
  planning: {
    // Source of truth is now Epicor REST — scripts/sync-epicor-to-sp.ps1
    // (running on the always-on on-prem PC, every 15 min) pulls the BAQ
    // and upserts here. Epicor has no machine assignment for PMD orders,
    // so Title is filled with JobNum (acts as natural key) and the app
    // never reads it back — machineCode below is sourced as empty and
    // the operator dropdown lists all PMD-released orders.
    machine: '', // skip read/write — no machine in Epicor source
    startDateTime: 'StartDateTime',
    qtyHour: 'QTYperHour',
    dueDate: 'Due_Date',
    jobNum: 'JobHead_JobNum',
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    // Total order quantity from Epicor — feeds "Order Qty".
    prodQty: 'JobHead_ProdQty',
    // Remaining quantity from Epicor — feeds "Job left".
    remaining: 'Calculated_RemainingQty',
    duration: 'Duration',
    dieNumber: '', // no source
    dc: '', // no source
  },
  production: {
    machine: 'Title',
    // The `MachineCode` column on this tenant has been repurposed to hold
    // the 16-char status timeline string — same value as PMD_BreakDownlog.
    // StatusTimeline — so the SP list is self-readable without joining.
    // `machineCodeAlt` is therefore a misnomer kept for backwards-compat
    // of the field map; see upsertProductionHeader for what actually gets
    // written here.
    machineCodeAlt: 'MachineCode',
    date: 'SlotStart_x003a_', // display "Date", actually the DateTime "SlotStart:"
    shift: 'ShiftId',
    // The dedicated StatusTimeline column was never re-added to
    // PMD_Production — the timeline lives in MachineCode (see above) and
    // PMD_BreakDownlog.StatusTimeline. Leave blank so the writer skips it.
    timeline: '',
    jobNumber: 'JobNumber',
    // Cached so the SP list is readable without joining to PMD_Planning —
    // requested by the supervisor reviewing signed-off shifts. Part # is
    // also denormalised so KPIs can resolve PMD_ProductDieColor by
    // record.partNumber directly.
    partNum: 'JobHead_PartNum',
    partDesc: 'JobHead_PartDescription',
    /** Total job quantity at sign-off time, denormalised so the
     *  operator UI can render Order Qty after Epicor drops a
     *  completed order from PMD_Planning. Optional column on the
     *  tenant; strip-rejected-fields tolerates absence. */
    jobRequired: 'JobRequired',
    /** Cycle time (hours/piece) denormalised at sign-off so a past shift
     *  can recompute Shift Target after Epicor drops the order. Optional
     *  column; stripRejectedFields tolerates absence. */
    cycleTime: 'CycleTime',
    /** Shift Target snapshot written at sign-off for the SP list / Power
     *  BI. The app recomputes the authoritative value from CycleTime, so
     *  this is a denormalised convenience, not a read dependency. */
    shiftTarget: 'ShiftTarget',
    countStart: 'CountStart',
    countEnd: 'CountEnd',
    /** Identical cavities on the die (pieces per press cycle). Actual
     *  pieces = (CountEnd − CountStart) × Cavities. Canonical on slot 0.
     *  Optional column; stripRejectedFields tolerates absence (defaults
     *  to 1). */
    cavities: 'Cavities',
    reject: 'Reject',
    operator: 'Operator',
    supervisor: 'Supervisor',
    runTime: 'RunTime',
    downTime: 'Downtime',
    handover: 'Handover',
    totalGood: 'TotalGood',
    // Per-slot QC sign-off, stored as JSON {"<slotIndex>":"<name>"}.
    // Column added to PMD_Production / PMD_LiveStatus to record
    // alternating operator / supervisor quality checks across the
    // shift's 16 half-hour slots.
    qcChecks: 'QualityChecks',
    // Per-slot per-code reject map, JSON {"<slotIndex>":{"<code>":qty}}.
    // PMD_Rejects (event list) is only populated on sign-off, so live
    // shifts on PMD_LiveStatus had no path for reject breakdowns to
    // reach other iPads — Machine Status / QC / Count Start / Count
    // End round-tripped via dedicated columns; rejects didn't. This
    // column closes that gap. The read path prefers PMD_Rejects events
    // when present, falling back to this JSON for live (unsigned) rows.
    rejectsBySlot: 'RejectsBySlot',
    /** PMD_LiveStatus only: the device id that last touched this
     *  (machine, shift, job) live row. Diagnostics-only — the write
     *  rule is device-CLASS (iPad vs not) via SharePointOptions.canWrite,
     *  not per-device-id arbitration (the old claim model caused fights
     *  between iPads in practice). Absent on PMD_Production; strip-
     *  rejected-fields tolerates the column not existing on a tenant. */
    ownerDevice: 'OwnerDevice',
    /** Wall-clock timestamp (date+time) of when the (machine, shift, job)
     *  was signed off, written on lockShift. The signed-off banner reads
     *  this so it shows when sign-off ACTUALLY happened, not the viewing
     *  device's current clock. DateTime column; stripRejectedFields
     *  tolerates absence (older tenants fall back to the render-time
     *  stamp). */
    signOff: 'Signoff',
    /** Job Left at sign-off time — the same value the operator sees on
     *  the Operator side panel (JobRequired − sum-of-Good across every
     *  shift of this job, including the one being signed off). Persisted
     *  so a supervisor reviewing a past shift in SharePoint / Power BI
     *  can read what the floor saw without re-deriving from production
     *  rows. Number column; stripRejectedFields tolerates absence. */
    jobLeft: 'JobLeft',
    /** PMD_Production only — Yes/No flag a supervisor sets when re-opening a
     *  signed-off order for correction. Yes = reopened (editable again, all
     *  devices agree); No / absent = locked. Cleared to No on re-sign-off.
     *  Optional column; stripRejectedFields tolerates absence (then a
     *  reopened order falls back to the old device-local behaviour). */
    reopened: 'Reopened',
    /** Planned start of the order (JobHead_StartDate with its time from the
     *  planning CSV, local ISO '2026-07-01T18:40:00'), denormalised onto
     *  PMD_Production at sign-off — same pattern as PartNum/JobRequired.
     *  Epicor drops completed orders from planning, so without this the
     *  historical operator views retain the original start for jobs that
     *  finished. Text column (avoids the site-timezone shifting we
     *  hit on Signoff); stripRejectedFields tolerates absence. */
    plannedStart: 'PlannedStart',
  },
  rejects: {
    // Title = Machine; Date is a DateTime (not date-only).
    machine: 'Title',
    shift: 'Shift',
    date: 'Date',
    timeline: 'Timeline',
    jobNum: 'JobHead_JobNum',
    rejectCode: 'RejectCode',
    rejectCategory: 'RejectCategory',
    rejectNumber: 'RejectNumber',
  },
  breakdown: {
    // Confirmed against diagnoseFields on PMD_BreakDownlog (renamed from
    // PMD_BreakDown). Adds a new BDCode column for the dominant breakdown
    // code on the shift (picked from the slots that had B status).
    date: 'Date',
    machine: 'Title',
    jobNum: 'JobHead_JobNum',
    partNum: 'JobHead_PartNum',
    shift: 'Shift',
    statusTimeline: 'StatusTimeline',
    bdCode: 'BDCode',
    r: 'R_Runtime',
    b: 'B_BreakDown',
    c: 'C_ColorChange',
    d: 'D_DieChange',
    i: 'I_InsertChange',
    m: 'M_Maintainance',
    o: 'O_NoWork',
    p: 'P_Purge',
    s: 'S_StartUpShutdown',
  },
  rejectCategories: {
    // Title = Code (P11, P12, ...); Description = the human label.
    code: 'Title',
    description: 'Description',
  },
  breakdownMaster: {
    // Title = Cause (the longest descriptive field); Code/Category/
    // LikelyOwner are explicit columns.
    code: 'Code',
    category: 'Category',
    cause: 'Title',
    likelyOwner: 'LikelyOwner',
  },
  productDieColor: {
    // Per-Part # die / paint colour. PartNum is the natural key, matching
    // Planning.csv's JobHead_PartNum (= PlanningOrder.partNumber).
    // ColorHex stores "#RRGGBB"; ActualColor is the friendly label
    // (e.g. "Grey Green") used for the swatch tooltip and the KPIs Color
    // column label.
    partNum: 'PartNum',
    hex: 'ColorHex',
    name: 'ActualColor',
    // Product category (e.g. "Battens") — groups the KPI TOTAL row
    // into per-category subtotals.
    category: 'Category',
    /** Physical die number — shown next to Product Description on the
     *  operator sheet so the floor knows which die to fit. Optional
     *  column; stripRejectedFields tolerates absence. */
    dieNumber: 'DieNumber',
    /** Die description (the `Die` column — the tool's human name).
     *  Optional column; read resolves common naming variants. */
    die: 'Die',
    /** Yes/No flag marking a part as a co-runner: parts that share a die
     *  AND both carry CoRun = Yes are run simultaneously on one press, so
     *  the operator sheet mirrors the machine status across them. Same
     *  die without the flag (or only one side flagged) means they run
     *  one-after-another and stay independent. Optional column. */
    coRun: 'CoRun',
  },
  dieMaster: {
    // Column names as created on the site (single-word display names, so
    // internal names match). DieNumber may live in Title instead when the
    // list was made by renaming the default column — listDieMaster probes
    // both. All cells are hand-edited; reads coerce defensively.
    dieNumber: 'DieNumber',
    description: 'DieDescription',
    cavities: 'Cavities',
    cycleTime: 'CycleTime',
    dieWeightKg: 'DieWeightKG',
    leanReady: 'LeanReady',
    toolInjectorPlate: 'ToolInjectorPlate',
    changeOverIn: 'ChangeOverIn',
    changeOverOut: 'ChangeOverOut',
    // Observed median die-change hours, written by the KPI import. Number
    // column, auto-provisioned on first write like MaintenanceLevel/Notes.
    changeOverMedian: 'ChangeOverMedian',
    lifeCycle: 'LifeCycle',
    dateStamp: 'DateStamp',
    lastServiceDate: 'LastServiceDate',
    availableDate: 'Available',
    toolStatus: 'ToolStatus',
    // Multi-line text: the die's customised multi-level PM plan
    // (`L2 | 10,000 shots | task; task` per line). Empty = default plan.
    maintenanceLevel: 'MaintenanceLevel',
    // Multi-line text: the running SOC change log, one note per line
    // (`Date/Shift/Machine/Operator: body`). Empty = no notes yet.
    notes: 'Notes',
  },
  dieChangeLog: {
    // Internal names straight from the list schema export (2026-07).
    // Date is DateOnly; DieNumberOut/In are Number columns; ChangeOver is
    // MultiChoice (Die / Insert / Space In / SpaceOut); the 13 component
    // columns are Choice with the three "1./2./3." condition strings.
    date: 'Date',
    shift: 'Shift',
    dieSetter: 'DieSetter',
    machine: 'Machine',
    changeOver: 'ChangeOver',
    jobNumber: 'JobNumber',
    dieNumberOut: 'DieNumberOut',
    dieDescriptionOut: 'DieDescriptionOut',
    dieNumberIn: 'DieNumberIn',
    dieDescriptionIn: 'DieDescriptionIn',
    problemDescription: 'ProblemDescription',
    /** Added by ensureDieChangeLogSchema. EventKey is indexed + unique so
     *  two iPads cannot create two rows for the same continuous D/I block. */
    eventKey: 'EventKey',
    eventStartSlot: 'EventStartSlot',
    eventEndSlot: 'EventEndSlot',
    /** The existing 13 Choice columns remain the OUT inspection. The IN
     *  inspection is JSON because duplicating 13 more Choice fields makes
     *  the list brittle and hard to provision consistently. */
    componentsInJson: 'ComponentsInJson',
    problemDescriptionIn: 'ProblemDescriptionIn',
  },
  dieMaintenance: {
    // Title = DieNumber (natural key into PMD_ProductDieColor.DieNumber).
    // All other columns are plain Text/Note so auto-provisioning stays
    // simple and nothing fights SharePoint's choice-column validation.
    // ClosedAt is TEXT ISO on purpose — DateTime columns get shifted by
    // the site timezone (same lesson as PMD_Production.PlannedStart).
    dieNumber: 'Title',
    status: 'Status',
    maintType: 'MaintType',
    priority: 'Priority',
    description: 'Description',
    contact: 'Contact',
    requestedBy: 'RequestedBy',
    machine: 'Machine',
    jobNumber: 'JobNumber',
    mangoTicket: 'MangoTicket',
    closedAt: 'ClosedAt',
    dueDate: 'DueDate',
  },
} as const;

export type SharePointFieldMap = typeof DEFAULT_FIELDS;
export type PartialFieldMap = {
  [K in keyof SharePointFieldMap]?: Partial<SharePointFieldMap[K]>;
};

export interface SharePointOptions {
  siteUrl: string;
  /**
   * Server-relative path to a CSV holding planning data (preferred over
   * reading PMD_Planning list when set). Example:
   *   "/sites/PMD/Shared Documents/PMD/Planning.csv"
   * Produced by scripts/sync-epicor-to-sp.ps1 + OneDrive sync.
   */
  planningCsvPath?: string;
  /**
   * Server-relative path to the Mango plant-equipment work-order report
   * (CSV). When set, the Die Management tab's work-order list mirrors
   * this file INSTEAD of the PMD_DieMaintenance list — Mango is the
   * system of record; the file is refreshed by scripts/sync-mango-csv.mjs
   * (Playwright download on the on-prem PC) + OneDrive sync, same
   * pipeline as Planning.csv. Example:
   *   "/sites/PMD/Shared Documents/PMD/MangoWorkOrders.csv"
   */
  mangoCsvPath?: string;
  /** Override any list/field internal name without editing this file. */
  fieldMap?: PartialFieldMap;
  /**
   * Whether THIS browser is allowed to mutate the SharePoint lists.
   * The DAL itself is UA-agnostic — the UI injects this hook (typically
   * `isIpadDevice() || isSupervisor()`) so cache-merge and live-snapshot
   * paths can tell whether to treat the local editCache as authoritative
   * (writable: per-slot merge wins) or stale (read-only: server snapshot
   * wins wholesale). Defaults to `() => true` for backwards-compatibility
   * and for tests / scripts that need to write unconditionally.
   */
  canWrite?: () => boolean;
}

type RollbackAction = () => Promise<void>;

export class SharePointDataLayer implements PmdDataLayer {
  private digest: { value: string; expires: number } | null = null;
  private readonly siteUrl: string;
  private readonly planningCsvPath?: string;
  private readonly mangoCsvPath?: string;
  private readonly canWriteHook: () => boolean;
  /** Live-mirror gate (setLiveGate) — pushLiveSnapshot skips any tuple
   *  the hook rejects. null = no gate (mirror everything dirty). */
  private liveGate: ((machineCode: string, shiftId: string, jobNumber: string) => boolean) | null =
    null;
  private readonly F: SharePointFieldMap;

  /**
   * Cache of unsaved slot records for shifts the operator is currently
   * editing. Key = `${machineCode}|${shiftId}|${jobNumber}`. Flushed to
   * the three production lists on lockShift. Mirrored to localStorage on
   * every change so that an accidental nav (back/forward, top-nav tap)
   * or a page refresh does not wipe a half-filled shift — the operator's
   * data is preserved until sign-off explicitly clears it.
   */
  private editCache = new Map<string, ProductionRecord[]>();
  private static readonly EDIT_CACHE_KEY = 'pmd_edit_cache_v1';
  /**
   * Tuples (`machine|shiftId|jobNumber`) that the supervisor has just
   * unlocked from a signed-off state. While a tuple is in this set,
   * the listProduction self-heal will NOT purge its editCache entry
   * even though PMD_Production still carries the (locked) header —
   * those slots are the active editable copy. Cleared when lockShift
   * commits the edits back. Persisted alongside editCache so a page
   * reload mid-edit doesn't strand the operator with a "locked" UI
   * over their freshly-unlocked cache.
   */
  private unlockedTuples = new Set<string>();
  private static readonly UNLOCKED_TUPLES_KEY = 'pmd_unlocked_tuples_v1';
  /**
   * Tuples whose editCache rows THIS DEVICE authored (an operator or
   * supervisor actually typed/tapped into them here), as opposed to
   * copies backfilled from PMD_LiveStatus purely for VIEWING another
   * press's shift. The distinction is load-bearing twice over:
   *
   *   - pushLiveSnapshot mirrors ONLY dirty tuples. Broadcasting every
   *     cached tuple made a device that merely glanced at another
   *     machine re-publish its stale copy every 60 s, overwriting the
   *     editing iPad's fresh mirror — the "full timeline collapsed
   *     back to one slot" / "iPad1 shows wrong Batt2 data" echo loop.
   *   - the live backfill REPLACES a non-dirty tuple wholesale, so a
   *     viewer always shows the mirror's current picture. (The old
   *     merge-by-absence kept the viewer's first-seen copy forever.)
   *
   * Persisted alongside editCache; pruned to the cache's keys on every
   * persist so it cannot grow unbounded.
   */
  private dirtyTuples = new Set<string>();
  private static readonly DIRTY_TUPLES_KEY = 'pmd_dirty_tuples_v1';
  /**
   * Cache of `ListItemEntityTypeFullName` per list title. Encoding a list
   * title to that string by hand (`SP.Data.${encoded}ListItem`) is unreliable
   * — when a list has been renamed since creation, the entity type still
   * reflects the original title and SP rejects POSTs with "type … could not
   * be resolved by the model". One round-trip to read it cures that.
   */
  private entityTypeCache = new Map<string, string>();
  /**
   * Module-lived cache of PMD_ProductDieColor — the list is small (a
   * few thousand rows) and effectively read-only at runtime, but every
   * view (Operator / KPI / Trace) was re-fetching it on first render,
   * which is a 2-3 s round trip against the live tenant. Cache once,
   * reuse forever; the user can hard-refresh to repopulate.
   */
  private dieColorCache: ProductDieColor[] | null = null;
  private dieMasterCache: DieMaster[] | null = null;
  /** Small, read-only RejectCode → description catalogue. Keep the in-flight
   *  promise too: KPI loads floor + every machine Pareto concurrently, and
   *  all of them should share one PMD_RejectCategories request. A failed
   *  request clears the cache so the next refresh can retry. */
  private rejectCategoryCache: Promise<RejectCategory[]> | null = null;
  /** Resolved PMD_DieMaster internal names + item id per die number,
   *  captured by listDieMaster so updateDieMaster can write directly. */
  private dieMasterMeta: {
    keys: Record<string, string>;
    idByDie: Map<string, number>;
    maintenanceLevelExists: boolean;
    notesExists: boolean;
    changeOverMedianExists: boolean;
  } | null = null;
  private dieMasterMaintenanceLevelReady: Promise<void> | null = null;
  private dieMasterNotesReady: Promise<void> | null = null;
  private dieMasterChangeOverMedianReady: Promise<void> | null = null;
  /**
   * Short-TTL `jobNumber → partNumber` map used by pushLiveSnapshot to
   * stamp PartNum onto every PMD_LiveStatus mirror. Without the cache,
   * every 60 s poll tick re-downloaded the full Planning CSV from SP
   * (cache-busted with `_t`) just to fill this one Map — on flaky iPad
   * Wi-Fi the recurring multi-second fetch piled up onto the next tick
   * and froze the page. Planning changes slowly (15-min Epicor sync),
   * so a 5-minute TTL is plenty fresh for the live mirror. User-facing
   * Planning reads still go through listPlanning() directly and stay
   * cache-bust-fresh.
   */
  private partNumByJobCache: { value: Map<string, string>; expires: number } | null = null;
  private static readonly PART_NUM_CACHE_TTL_MS = 5 * 60_000;
  /**
   * Reentrancy guard for pushLiveSnapshot. operatorPollTick is
   * fire-and-forget on a 60 s setInterval, so if a snapshot's network
   * work takes longer than 60 s (slow Wi-Fi + N upserts × 3 round
   * trips) the next tick used to start a SECOND snapshot in parallel,
   * which stacked onto the third, fourth, … until Safari's 6-
   * concurrent-connections cap was saturated and the tab locked up.
   * One-in-flight at a time is the correct policy — a missed tick just
   * pushes one minute later.
   *
   * Timestamp, not boolean: iPad Safari can leave a fetch pending FOREVER
   * (Wi-Fi drop / network switch mid-request settles neither way), which
   * kept the old boolean stuck true and silently killed the mirror until
   * someone reloaded the page — the floor iPad had fresh data for hours
   * while PMD_LiveStatus / Trace never saw it. A guard older than
   * SNAPSHOT_STUCK_MS is presumed hung and a new snapshot may start.
   */
  private snapshotInFlightSince: number | null = null;
  private static readonly SNAPSHOT_STUCK_MS = 5 * 60_000;
  /**
   * Live-mirror health, surfaced by mirrorHealth() for the on-screen
   * badge. "One iPad never gets its data onto SharePoint" was pure
   * guesswork on the floor — the badge turns it into a glanceable fact:
   * when did THIS device last push its mirror successfully, and if it's
   * failing, with what error.
   */
  private lastMirrorOkAt: number | null = null;
  private lastMirrorFailAt: number | null = null;
  private lastMirrorError = '';
  /**
   * Stable per-device identity, persisted in localStorage. Written to
   * PMD_LiveStatus.OwnerDevice on every snapshot push so we can see
   * after the fact which iPad last touched a press, but no longer used
   * to gate writes — the write rule is device-CLASS (iPad vs not) via
   * SharePointOptions.canWrite, not per-device-id arbitration. The
   * old per-device claim caused fights between iPads in practice (one
   * iPad "owned" the press and locked the others out for no good
   * floor-operations reason).
   */
  private deviceId = '';
  private static readonly DEVICE_ID_KEY = 'pmd.deviceId';

  constructor(opts: SharePointOptions | string) {
    const o = typeof opts === 'string' ? { siteUrl: opts } : opts;
    this.siteUrl = o.siteUrl.replace(/\/$/, '');
    this.planningCsvPath = o.planningCsvPath;
    this.mangoCsvPath = o.mangoCsvPath;
    this.canWriteHook = o.canWrite ?? ((): boolean => true);
    // Merge user overrides into the defaults.
    this.F = mergeFieldMap(DEFAULT_FIELDS, o.fieldMap);
    this.deviceId = this.resolveDeviceId();
    this.rehydrateEditCache();
    this.rehydrateUnlockedTuples();
    this.rehydrateDirtyTuples();
  }

  /** Read (or mint + persist) this device's stable id. */
  private resolveDeviceId(): string {
    if (typeof localStorage === 'undefined') {
      // Non-browser (tests / SSR): a per-instance id is fine — there's
      // no second device to arbitrate against.
      return `mem-${Math.random().toString(36).slice(2, 10)}`;
    }
    try {
      let id = localStorage.getItem(SharePointDataLayer.DEVICE_ID_KEY);
      if (!id) {
        id =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(SharePointDataLayer.DEVICE_ID_KEY, id);
      }
      return id;
    } catch {
      return `dev-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  /** This iPad's stable device id. Still stamped onto PMD_LiveStatus's
   *  OwnerDevice column for after-the-fact diagnostics ("which iPad
   *  last touched this press?"), but the write/read rule is now purely
   *  device-class based — see SharePointOptions.canWrite. */
  getDeviceId(): string {
    return this.deviceId;
  }

  private rehydrateEditCache(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointDataLayer.EDIT_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<[string, ProductionRecord[]]>;
      for (const [k, v] of parsed) this.editCache.set(k, v);
    } catch (e) {
      console.warn('[pmd] could not rehydrate edit cache:', e);
    }
  }

  private rehydrateUnlockedTuples(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SharePointDataLayer.UNLOCKED_TUPLES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as string[];
      for (const k of parsed) this.unlockedTuples.add(k);
    } catch (e) {
      console.warn('[pmd] could not rehydrate unlocked tuples:', e);
    }
  }

  private persistUnlockedTuples(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        SharePointDataLayer.UNLOCKED_TUPLES_KEY,
        JSON.stringify(Array.from(this.unlockedTuples)),
      );
    } catch (e) {
      console.warn('[pmd] could not persist unlocked tuples:', e);
    }
  }

  private rehydrateDirtyTuples(): void {
    if (typeof localStorage === 'undefined') {
      // Node test env: no persistence, no migration needed.
      return;
    }
    try {
      const raw = localStorage.getItem(SharePointDataLayer.DIRTY_TUPLES_KEY);
      if (raw != null) {
        for (const k of JSON.parse(raw) as string[]) this.dirtyTuples.add(k);
        return;
      }
      // Migration: a cache persisted by a build that predates dirty
      // tracking can't tell authored tuples from viewed copies. Treat
      // everything present as authored (the old behaviour) so a real
      // half-filled shift is never clobbered by the first backfill;
      // precision starts with the next fresh tuple.
      for (const k of this.editCache.keys()) this.dirtyTuples.add(k);
    } catch (e) {
      console.warn('[pmd] could not rehydrate dirty tuples:', e);
    }
  }

  /**
   * Mark the cache dirty and write it to localStorage in the next
   * microtask. Callers can fire this on every keystroke / per-slot
   * upsert without paying for 10× full-cache stringifies during a
   * drag-fill — the coalesced write happens once per event-loop turn.
   */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistEditCache(): void {
    if (typeof localStorage === 'undefined') return;
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        // Dirty set rides along with the cache: prune keys whose cache
        // entry is gone (signed off / swept) so it tracks live tuples only.
        for (const k of this.dirtyTuples) {
          if (!this.editCache.has(k)) this.dirtyTuples.delete(k);
        }
        const payload = JSON.stringify(Array.from(this.editCache.entries()));
        localStorage.setItem(SharePointDataLayer.EDIT_CACHE_KEY, payload);
        localStorage.setItem(
          SharePointDataLayer.DIRTY_TUPLES_KEY,
          JSON.stringify(Array.from(this.dirtyTuples)),
        );
      } catch (e) {
        // Quota exceeded or private mode — caller will still get an
        // in-memory copy, we just won't survive a refresh.
        console.warn('[pmd] could not persist edit cache:', e);
      }
    }, 0);
  }

  // ---- low-level helpers ----------------------------------------------

  private listUrl(title: string): string {
    return `${this.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(title)}')`;
  }

  private async getDigest(): Promise<string> {
    if (this.digest && this.digest.expires > Date.now() + 5_000) return this.digest.value;
    const res = await fetch(`${this.siteUrl}/_api/contextinfo`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose' },
    });
    if (!res.ok) throw new Error(`Digest failed: ${res.status}`);
    const j = (await res.json()) as {
      d: { GetContextWebInformation: { FormDigestValue: string; FormDigestTimeoutSeconds: number } };
    };
    const info = j.d.GetContextWebInformation;
    this.digest = {
      value: info.FormDigestValue,
      expires: Date.now() + (info.FormDigestTimeoutSeconds - 300) * 1000,
    };
    return this.digest.value;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose' },
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return (await res.json()) as T;
  }

  private async getAllItems<T = Record<string, unknown>>(list: string, qs = ''): Promise<T[]> {
    const out: T[] = [];
    let url = `${this.listUrl(list)}/items?$top=5000${qs ? '&' + qs : ''}`;
    while (url) {
      const env = await this.getJson<{ d: { results: T[]; __next?: string } }>(url);
      out.push(...env.d.results);
      url = env.d.__next ?? '';
    }
    return out;
  }

  private async post(url: string, body: unknown, ifMatch?: string): Promise<Response> {
    const digest = await this.getDigest();
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json;odata=verbose',
        'Content-Type': 'application/json;odata=verbose',
        'X-RequestDigest': digest,
        ...(ifMatch ? { 'IF-MATCH': ifMatch, 'X-HTTP-Method': 'MERGE' } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const respBody = await res.text();
      // Try to surface SharePoint's actual "this column doesn't exist" /
      // "wrong type" message — the verbose envelope is hard to read raw.
      let msg = respBody;
      try {
        const j = JSON.parse(respBody) as {
          error?: { message?: string | { value?: string }; code?: string };
        };
        const m = j.error?.message;
        if (typeof m === 'string') msg = m;
        else if (m && typeof m.value === 'string') msg = m.value;
        if (j.error?.code) msg = `${msg} [${j.error.code}]`;
      } catch {
        /* not JSON, keep raw body */
      }
      // Dump everything to console — request body included — so a 400 tells
      // us which field's value/type SP didn't like, not just the message.
      console.error('[sp] POST failed', {
        url,
        status: res.status,
        sent: body,
        sentTypes: Object.fromEntries(
          Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, typeof v]),
        ),
        respBody,
      });
      throw new Error(`POST ${res.status} ${msg}`);
    }
    return res;
  }

  private async del(url: string): Promise<void> {
    const digest = await this.getDigest();
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-RequestDigest': digest, 'IF-MATCH': '*', 'X-HTTP-Method': 'DELETE' },
    });
    if (!res.ok) throw new Error(`DELETE ${url} → ${res.status}`);
  }

  /** Item ID of the tuple's PMD_Production header row, or null when the
   *  tuple hasn't been signed off yet. Same composite-key lookup as
   *  upsertHeaderInto: ±1d window for legacy-timestamp tolerance, then
   *  narrowed to the exact calendar date. */
  private async findProductionRowId(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<number | null> {
    const F = this.F.production;
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${odataString(machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(shift)}' and ${F.jobNumber} eq '${odataString(jobNumber)}'`,
      );
    const rows = await this.getAllItems<Record<string, unknown>>(LISTS.production, qs);
    const exact = rows.find((r) => dateOnly(r[F.date]) === date) as
      | { ID?: number; Id?: number }
      | undefined;
    return exact?.ID ?? exact?.Id ?? null;
  }

  async attachProductionPhoto(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    fileName: string,
    data: Blob,
  ): Promise<boolean> {
    const id = await this.findProductionRowId(machineCode, shiftId, jobNumber);
    if (id == null) return false; // not signed off yet — caller keeps it queued
    const digest = await this.getDigest();
    // Attachment upload is raw binary, NOT the JSON post() path — SP
    // stores the request body verbatim as the file.
    const url = `${this.listUrl(LISTS.production)}/items(${id})/AttachmentFiles/add(FileName='${encodeURIComponent(odataString(fileName))}')`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json;odata=verbose', 'X-RequestDigest': digest },
      body: data,
    });
    if (!res.ok) {
      const text = await res.text();
      // Duplicate filename = this exact photo already landed (retry after
      // a dropped response) — done, don't re-queue forever.
      if (/already exists/i.test(text)) return true;
      throw new Error(`Attachment upload ${res.status}: ${text.slice(0, 200)}`);
    }
    return true;
  }

  async listProductionPhotos(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<Array<{ name: string; url: string }>> {
    const id = await this.findProductionRowId(machineCode, shiftId, jobNumber);
    if (id == null) return [];
    const env = await this.getJson<{
      d: { results: Array<{ FileName: string; ServerRelativeUrl: string }> };
    }>(`${this.listUrl(LISTS.production)}/items(${id})/AttachmentFiles`);
    return env.d.results.map((a) => ({ name: a.FileName, url: a.ServerRelativeUrl }));
  }

  /**
   * Look up the real ListItemEntityTypeFullName from SP and cache it. Cheap
   * (one extra GET on the first POST per list per page load) and resilient
   * to list renames / unusual title characters.
   */
  private async itemType(list: string): Promise<string> {
    const cached = this.entityTypeCache.get(list);
    if (cached) return cached;
    try {
      const res = await this.getJson<{ d: { ListItemEntityTypeFullName: string } }>(
        `${this.listUrl(list)}?$select=ListItemEntityTypeFullName`,
      );
      const name = res.d?.ListItemEntityTypeFullName;
      if (name) {
        this.entityTypeCache.set(list, name);
        return name;
      }
    } catch {
      /* fall through to the encoded guess */
    }
    // Fallback: encode underscores/non-alphanumerics ourselves. Works for
    // lists whose title hasn't drifted from creation.
    const safe = list.replace(/[^A-Za-z0-9]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`);
    const guess = `SP.Data.${safe}ListItem`;
    this.entityTypeCache.set(list, guess);
    return guess;
  }

  // ---- reference lists ------------------------------------------------

  async listMachines(): Promise<Machine[]> {
    const F = this.F.machine;
    const rows = await this.getAllItems(LISTS.machine);
    return rows.map((r, i) => ({
      id: getId(r),
      machineCode: str(r[F.code]),
      displayName: str(r[F.code]),
      sequence: num(r[F.displayOrder]) || i + 1,
      active: bool(r[F.active]) ?? true,
    }));
  }

  async listOperators(): Promise<Operator[]> {
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    return rows.map((r) => ({
      id: getId(r),
      operatorName: str(r[F.name]),
      active: true,
      shift: str(r[F.shift]).trim(),
    }));
  }

  async listSupervisors(): Promise<Supervisor[]> {
    // Supervisors are now derived from the distinct Supervisor_1 column
    // on PMD_Operator (a free-text field on each operator's row), not
    // from the separate PMD_Supervisor list. Drops the Lookup column
    // and the second REST round-trip on every boot — listOperators
    // already brings these rows back, so in practice this is free.
    // A supervisor named on operator rows of more than one shift is
    // emitted once per (name, shift) so the operator sheet's roster
    // filter can surface them on each shift they cover.
    const F = this.F.operator;
    const rows = await this.getAllItems(LISTS.operator);
    const seen = new Set<string>();
    const out: Supervisor[] = [];
    for (const r of rows) {
      const name = str(r[F.supervisor1]).trim();
      if (!name) continue;
      const shift = str(r[F.shift]).trim();
      const key = `${name}|${shift}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: out.length + 1, operatorName: name, active: true, shift });
    }
    return out;
  }

  async listRejectCategories(): Promise<RejectCategory[]> {
    if (!this.rejectCategoryCache) {
      const F = this.F.rejectCategories;
      this.rejectCategoryCache = this.getAllItems(LISTS.rejectCategories)
        .then((rows) =>
          rows
            .map((r, i) => ({
              code: str(r[F.code]).trim().toUpperCase(),
              label: str(r[F.description]).trim(),
              sequence: i + 1,
            }))
            .filter((r) => r.code),
        )
        .catch((e) => {
          this.rejectCategoryCache = null;
          throw e;
        });
    }
    return this.rejectCategoryCache;
  }

  async listBdCodes(): Promise<BdCode[]> {
    const F = this.F.breakdownMaster;
    try {
      const rows = await this.getAllItems(LISTS.breakdownMaster);
      if (rows.length === 0) return bdFallback();
      return rows.map((r, i) => ({
        code: str(r[F.code]),
        label: str(r[F.cause]),
        subCategory: str(r[F.category]),
        sequence: i + 1,
        owner: str(r[F.likelyOwner]),
      }));
    } catch {
      // If the list is empty / unreadable, fall back to the hard-coded
      // taxonomy so the cascade UI keeps working.
      return bdFallback();
    }
  }

  async listProductDieColors(): Promise<ProductDieColor[]> {
    // Cached after the first successful read — the list is small and
    // read-only at runtime; refetching it on every nav was a 2-3 s
    // round-trip per view. Operators hard-reload the page to pick up
    // colour list edits, which is the established workflow anyway.
    if (this.dieColorCache) return this.dieColorCache;
    const F = this.F.productDieColor;
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.productDieColor);
      if (rows.length === 0) {
        this.dieColorCache = [];
        return this.dieColorCache;
      }
      // Resolve the DieNumber column once against the first row. SP often
      // mangles display names with spaces into _x0020_ internal names,
      // and operators add the column with a few different conventions
      // ("DieNumber", "Die Number", "DieNum", "DieNo"), so probe the
      // common variants instead of giving up when the configured name
      // doesn't match. Logged so a missing column is obvious in F12.
      const dieKey = resolveDieNumberKey(rows[0], F.dieNumber);
      // The `Die` (description) column, same naming-variant tolerance.
      const dieDescKey = resolveDieDescKey(rows[0], F.die);
      if (!dieKey) {
        console.warn(
          '[pmd] PMD_ProductDieColor: no DieNumber column matched. Keys present on row[0]:',
          Object.keys(rows[0]),
        );
      } else if (dieKey !== F.dieNumber) {
        console.info(
          '[pmd] PMD_ProductDieColor: resolved DieNumber as internal name',
          dieKey,
          '(field map default was',
          F.dieNumber + ')',
        );
      }
      // Direct field reads against the PartNum / ColorHex / ActualColor /
      // Category columns. Keep rows that carry a category even when the
      // hex is missing / invalid: they can't drive a swatch but still
      // bucket their part into the right KPI category subtotal.
      const direct = rows
        .map((r) => ({
          partNumber: str(r[F.partNum]).trim(),
          hex: normaliseHex(str(r[F.hex])),
          name: str(r[F.name]).trim(),
          category: str(r[F.category]).trim(),
          dieNumber: dieKey ? str(r[dieKey]).trim() : '',
          die: dieDescKey ? str(r[dieDescKey]).trim() : '',
          // CoRun Yes/No — true only on an explicit yes. SP Yes/No comes
          // back as a real boolean; a choice/text column as "Yes". Absent
          // column ⇒ undefined ⇒ false (parts default to NOT co-running).
          coRun: F.coRun ? bool(r[F.coRun]) === true : false,
        }))
        .filter((c) => c.partNumber && (c.hex || c.category || c.dieNumber || c.coRun));
      const withDie = direct.filter((c) => c.dieNumber).length;
      const withCoRun = direct.filter((c) => c.coRun).length;
      console.info(
        '[pmd] PMD_ProductDieColor cached:', direct.length, 'of', rows.length, 'rows ·',
        withDie, 'carry DieNumber ·', withCoRun, 'flagged CoRun=Yes',
      );
      this.dieColorCache = direct;
      return this.dieColorCache;
    } catch (e) {
      // Tenant without PMD_ProductDieColor → no swatch is fine; the
      // existing keyword-derived colour on KPIs takes over.
      // Do NOT cache the failure — the next call retries.
      console.warn('[pmd] PMD_ProductDieColor unavailable, swatches disabled:', e);
      throw e;
    }
  }

  // ---- die master (PMD_DieMaster) -------------------------------------

  async listDieMaster(): Promise<DieMaster[]> {
    // Same cache policy as PMD_ProductDieColor: small, hand-maintained,
    // read-only at runtime — a hard reload picks up toolroom edits.
    if (this.dieMasterCache) return this.dieMasterCache;
    const F = this.F.dieMaster;
    try {
      // The list was created by hand in the modern UI, where a column's
      // INTERNAL name routinely diverges from the header you see (a
      // renamed Title column, field_2 from grid-view adds, Name0 after a
      // collision…). Guessing display names against row keys is what made
      // every Status render "—" — so resolve deterministically instead:
      // pull the list's field map (display Title → InternalName) and look
      // each configured name up. Exact InternalName match wins; display-
      // Title match (case/space-insensitive) second; configured name last.
      const fieldsEnv = await this.getJson<{
        d: { results: Array<{ Title: string; InternalName: string }> };
      }>(
        `${this.listUrl(LISTS.dieMaster)}/fields?$filter=Hidden eq false&$select=Title,InternalName`,
      );
      const fields = fieldsEnv.d.results;
      const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const internals = new Set(fields.map((f) => f.InternalName));
      const byTitle = new Map<string, string>();
      for (const f of fields) {
        const key = normName(f.Title);
        if (!byTitle.has(key)) byTitle.set(key, f.InternalName);
      }
      const resolve = (configured: string): string =>
        internals.has(configured) ? configured : byTitle.get(normName(configured)) ?? configured;
      const K = {
        dieNumber: resolve(F.dieNumber),
        description: resolve(F.description),
        cavities: resolve(F.cavities),
        cycleTime: resolve(F.cycleTime),
        dieWeightKg: resolve(F.dieWeightKg),
        leanReady: resolve(F.leanReady),
        toolInjectorPlate: resolve(F.toolInjectorPlate),
        changeOverIn: resolve(F.changeOverIn),
        changeOverOut: resolve(F.changeOverOut),
        changeOverMedian: resolve(F.changeOverMedian),
        lifeCycle: resolve(F.lifeCycle),
        dateStamp: resolve(F.dateStamp),
        lastServiceDate: resolve(F.lastServiceDate),
        availableDate: resolve(F.availableDate),
        toolStatus: resolve(F.toolStatus),
        maintenanceLevel: resolve(F.maintenanceLevel),
        notes: resolve(F.notes),
      };
      console.info('[pmd] PMD_DieMaster field resolution:', K);
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.dieMaster);
      if (rows.length === 0) {
        this.dieMasterCache = [];
        return this.dieMasterCache;
      }
      // DieNumber additionally falls back to Title when the resolved
      // column is empty on every row (list made by renaming Title but a
      // separate DieNumber column also exists, unfilled).
      const dieKey = rows.some((r) => str(r[K.dieNumber]).trim()) ? K.dieNumber : 'Title';
      // Remember resolved keys + item ids so updateDieMaster can write
      // without re-resolving (idByDie keyed by normalised die number).
      this.dieMasterMeta = {
        keys: K,
        idByDie: new Map(
          rows
            .map((r) => [str(r[dieKey]).trim().toUpperCase(), getId(r)] as const)
            .filter(([die, id]) => die && id > 0),
        ),
        maintenanceLevelExists:
          internals.has(F.maintenanceLevel) || byTitle.has(normName(F.maintenanceLevel)),
        notesExists: internals.has(F.notes) || byTitle.has(normName(F.notes)),
        changeOverMedianExists:
          internals.has(F.changeOverMedian) || byTitle.has(normName(F.changeOverMedian)),
      };
      const out = rows
        .map((r) => ({
          dieNumber: str(r[dieKey]).trim(),
          description: str(r[K.description]).trim(),
          cavities: nullOrNum(r[K.cavities]),
          cycleTime: nullOrNum(r[K.cycleTime]),
          dieWeightKg: nullOrNum(r[K.dieWeightKg]),
          leanReady: bool(r[K.leanReady]) ?? null,
          toolInjectorPlate: str(r[K.toolInjectorPlate]).trim(),
          changeOverIn: nullOrNum(r[K.changeOverIn]),
          changeOverOut: nullOrNum(r[K.changeOverOut]),
          changeOverMedian: nullOrNum(r[K.changeOverMedian]),
          lifeCycle: nullOrNum(r[K.lifeCycle]),
          dateStamp: str(r[K.dateStamp]),
          lastServiceDate: str(r[K.lastServiceDate]),
          availableDate: str(r[K.availableDate]),
          toolStatus: parseToolStatus(str(r[K.toolStatus])),
          maintenanceLevel: str(r[K.maintenanceLevel]),
          notes: str(r[K.notes]),
        }))
        .filter((m) => m.dieNumber);
      const withStatus = out.filter((m) => m.toolStatus).length;
      console.info(
        '[pmd] PMD_DieMaster cached:', out.length, 'of', rows.length, 'rows ·',
        withStatus, 'carry a recognised ToolStatus',
      );
      if (out.length > 0 && withStatus === 0) {
        console.warn(
          '[pmd] PMD_DieMaster: no row has a recognised ToolStatus — check the resolved key',
          K.toolStatus, 'and the cell values. Keys on row[0]:', Object.keys(rows[0]),
        );
      }
      this.dieMasterCache = out;
      return this.dieMasterCache;
    } catch (e) {
      // List unreachable — the Status column just shows "—". Not cached
      // so the next call retries. The classic trap: creating the list in
      // the Lists app saves it under "My lists" (the user's PERSONAL
      // space) unless a site is picked — this site's REST then 404s even
      // though the list looks fine to its owner.
      console.warn(
        `[pmd] PMD_DieMaster unreachable on ${this.siteUrl} — ToolStatus column disabled.`,
        `If the list shows under "My lists" in the Lists app, it lives in the owner's personal`,
        `space: recreate it on this site (Site contents → New → List → From existing list).`,
        e,
      );
      throw e;
    }
  }

  /** MaintenanceLevel was introduced after the hand-built DieMaster
   *  list. Create the multi-line text field on the first Supervisor save
   *  so existing deployments upgrade in place; if Manage Lists is blocked,
   *  surface an actionable error instead of pretending the plan stuck. */
  private async ensureDieMasterMaintenanceLevelField(): Promise<void> {
    if (this.dieMasterMeta?.maintenanceLevelExists) return;
    if (this.dieMasterMaintenanceLevelReady) return this.dieMasterMaintenanceLevelReady;
    this.dieMasterMaintenanceLevelReady = (async () => {
      const meta = this.dieMasterMeta;
      if (!meta) throw new Error('PMD_DieMaster metadata is not loaded');
      const wanted = this.F.dieMaster.maintenanceLevel;
      const fieldsUrl = `${this.listUrl(LISTS.dieMaster)}/fields`;
      const read = async (): Promise<Array<{ Title: string; InternalName: string }>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return env.d.results;
      };
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const resolve = (fields: Array<{ Title: string; InternalName: string }>): string | null =>
        fields.find((f) => f.InternalName === wanted)?.InternalName ??
        fields.find((f) => norm(f.Title) === norm(wanted))?.InternalName ??
        null;
      let internal = resolve(await read());
      if (!internal) {
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: wanted,
            FieldTypeKind: 3, // Note (multi-line text): one PM level per line
          });
        } catch (e) {
          // Another session may have created it between GET and POST.
          internal = resolve(await read());
          if (!internal) {
            throw new Error(
              `PMD_DieMaster needs a multi-line text '${wanted}' column (${(e as Error).message}). ` +
                'Add it in List settings or grant Manage Lists once.',
            );
          }
        }
        internal ??= resolve(await read());
      }
      if (!internal) throw new Error(`PMD_DieMaster column '${wanted}' could not be resolved`);
      meta.keys.maintenanceLevel = internal;
      meta.maintenanceLevelExists = true;
      console.info(`[pmd] PMD_DieMaster '${wanted}' column ready as ${internal}`);
    })().catch((e) => {
      this.dieMasterMaintenanceLevelReady = null;
      throw e;
    });
    return this.dieMasterMaintenanceLevelReady;
  }

  /** Notes (the SOC change log) is also newer than the hand-built list.
   *  Create the multi-line text column on the first note save so existing
   *  deployments upgrade in place — same self-provisioning pattern as
   *  MaintenanceLevel above. */
  private async ensureDieMasterNotesField(): Promise<void> {
    if (this.dieMasterMeta?.notesExists) return;
    if (this.dieMasterNotesReady) return this.dieMasterNotesReady;
    this.dieMasterNotesReady = (async () => {
      const meta = this.dieMasterMeta;
      if (!meta) throw new Error('PMD_DieMaster metadata is not loaded');
      const wanted = this.F.dieMaster.notes;
      const fieldsUrl = `${this.listUrl(LISTS.dieMaster)}/fields`;
      const read = async (): Promise<Array<{ Title: string; InternalName: string }>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return env.d.results;
      };
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const resolve = (fields: Array<{ Title: string; InternalName: string }>): string | null =>
        fields.find((f) => f.InternalName === wanted)?.InternalName ??
        fields.find((f) => norm(f.Title) === norm(wanted))?.InternalName ??
        null;
      let internal = resolve(await read());
      if (!internal) {
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: wanted,
            FieldTypeKind: 3, // Note (multi-line text): one SOC note per line
          });
        } catch (e) {
          // Another session may have created it between GET and POST.
          internal = resolve(await read());
          if (!internal) {
            throw new Error(
              `PMD_DieMaster needs a multi-line text '${wanted}' column (${(e as Error).message}). ` +
                'Add it in List settings or grant Manage Lists once.',
            );
          }
        }
        internal ??= resolve(await read());
      }
      if (!internal) throw new Error(`PMD_DieMaster column '${wanted}' could not be resolved`);
      meta.keys.notes = internal;
      meta.notesExists = true;
      console.info(`[pmd] PMD_DieMaster '${wanted}' column ready as ${internal}`);
    })().catch((e) => {
      this.dieMasterNotesReady = null;
      throw e;
    });
    return this.dieMasterNotesReady;
  }

  /** Provision PMD_DieMaster.ChangeOverMedian (Number) on first import.
   *  Same shape as the MaintenanceLevel / Notes provisioning: the column
   *  is new, and a tenant shouldn't have to hand-create it before the KPI
   *  page can write the observed medians. */
  private async ensureDieMasterChangeOverMedianField(): Promise<void> {
    if (this.dieMasterMeta?.changeOverMedianExists) return;
    if (this.dieMasterChangeOverMedianReady) return this.dieMasterChangeOverMedianReady;
    this.dieMasterChangeOverMedianReady = (async () => {
      const meta = this.dieMasterMeta;
      if (!meta) throw new Error('PMD_DieMaster metadata is not loaded');
      const wanted = this.F.dieMaster.changeOverMedian;
      const fieldsUrl = `${this.listUrl(LISTS.dieMaster)}/fields`;
      const read = async (): Promise<Array<{ Title: string; InternalName: string }>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return env.d.results;
      };
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const resolve = (fields: Array<{ Title: string; InternalName: string }>): string | null =>
        fields.find((f) => f.InternalName === wanted)?.InternalName ??
        fields.find((f) => norm(f.Title) === norm(wanted))?.InternalName ??
        null;
      let internal = resolve(await read());
      if (!internal) {
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: wanted,
            FieldTypeKind: 9, // Number — hours, to 2 dp
          });
        } catch (e) {
          // Another session may have created it between GET and POST.
          internal = resolve(await read());
          if (!internal) {
            throw new Error(
              `PMD_DieMaster needs a number '${wanted}' column (${(e as Error).message}). ` +
                'Add it in List settings or grant Manage Lists once.',
            );
          }
        }
        internal ??= resolve(await read());
      }
      if (!internal) throw new Error(`PMD_DieMaster column '${wanted}' could not be resolved`);
      meta.keys.changeOverMedian = internal;
      meta.changeOverMedianExists = true;
      console.info(`[pmd] PMD_DieMaster '${wanted}' column ready as ${internal}`);
    })().catch((e) => {
      this.dieMasterChangeOverMedianReady = null;
      throw e;
    });
    return this.dieMasterChangeOverMedianReady;
  }

  async updateDieMaster(
    dieNumber: string,
    patch: Partial<
      Pick<
        DieMaster,
        | 'toolStatus'
        | 'dateStamp'
        | 'lastServiceDate'
        | 'availableDate'
        | 'maintenanceLevel'
        | 'notes'
        | 'changeOverMedian'
      >
    >,
  ): Promise<void> {
    // listDieMaster resolves the internal names + item ids; make sure it
    // has run (it caches, so this is a no-op after the first call).
    if (!this.dieMasterMeta) await this.listDieMaster();
    const meta = this.dieMasterMeta;
    const key = dieNumber.trim().toUpperCase();
    const id = meta?.idByDie.get(key);
    if (!meta || !id) throw new Error(`No PMD_DieMaster row for die ${dieNumber}`);
    if (patch.maintenanceLevel !== undefined && !meta.maintenanceLevelExists) {
      await this.ensureDieMasterMaintenanceLevelField();
    }
    if (patch.notes !== undefined && !meta.notesExists) {
      await this.ensureDieMasterNotesField();
    }
    if (patch.changeOverMedian !== undefined && !meta.changeOverMedianExists) {
      await this.ensureDieMasterChangeOverMedianField();
    }
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.dieMaster) },
    };
    // Write the human label ("To be Serviced"), not the union slug —
    // the toolroom reads this list directly in SharePoint, and
    // parseToolStatus round-trips it on the way back in.
    if (patch.toolStatus !== undefined)
      body[meta.keys.toolStatus] = patch.toolStatus ? TOOL_STATUS_META[patch.toolStatus].label : '';
    if (patch.dateStamp !== undefined) body[meta.keys.dateStamp] = patch.dateStamp;
    if (patch.lastServiceDate !== undefined)
      body[meta.keys.lastServiceDate] = patch.lastServiceDate;
    if (patch.availableDate !== undefined) body[meta.keys.availableDate] = patch.availableDate;
    if (patch.maintenanceLevel !== undefined)
      body[meta.keys.maintenanceLevel] = patch.maintenanceLevel;
    if (patch.notes !== undefined) body[meta.keys.notes] = patch.notes;
    if (patch.changeOverMedian !== undefined)
      body[meta.keys.changeOverMedian] = patch.changeOverMedian;
    await this.post(`${this.listUrl(LISTS.dieMaster)}/items(${id})`, body, '*');
    // Keep the read cache coherent so a re-mount shows the new state
    // without a hard reload.
    if (this.dieMasterCache) {
      const row = this.dieMasterCache.find((m) => m.dieNumber.trim().toUpperCase() === key);
      if (row) {
        if (patch.toolStatus !== undefined) row.toolStatus = patch.toolStatus;
        if (patch.dateStamp !== undefined) row.dateStamp = patch.dateStamp;
        if (patch.lastServiceDate !== undefined) row.lastServiceDate = patch.lastServiceDate;
        if (patch.availableDate !== undefined) row.availableDate = patch.availableDate;
        if (patch.maintenanceLevel !== undefined) row.maintenanceLevel = patch.maintenanceLevel;
        if (patch.notes !== undefined) row.notes = patch.notes;
        if (patch.changeOverMedian !== undefined) row.changeOverMedian = patch.changeOverMedian;
      }
    }
  }

  // ---- die change log (PMD_DieChangeLog) -------------------------------

  private dieChangeSchemaReady: Promise<void> | null = null;

  /** Add the four event-level columns introduced by the one-row-per-D/I
   *  model. EventKey is indexed and unique: this is the server-side guard
   *  that makes two iPads saving the same popup converge on one row. */
  private async ensureDieChangeLogSchema(): Promise<void> {
    if (this.dieChangeSchemaReady) return this.dieChangeSchemaReady;
    this.dieChangeSchemaReady = (async () => {
      const F = this.F.dieChangeLog;
      const fieldsUrl = `${this.listUrl(LISTS.dieChangeLog)}/fields`;
      const readFields = async (): Promise<Set<string>> => {
        const env = await this.getJson<{
          d: { results: Array<{ Title: string; InternalName: string }> };
        }>(`${fieldsUrl}?$filter=Hidden eq false&$select=Title,InternalName`);
        return new Set(env.d.results.flatMap((f) => [f.Title, f.InternalName]));
      };
      let present = await readFields();
      const required: Array<{
        name: string;
        kind: number;
        unique?: boolean;
      }> = [
        { name: F.eventKey, kind: 2, unique: true },
        { name: F.eventStartSlot, kind: 9 },
        { name: F.eventEndSlot, kind: 9 },
        { name: F.componentsInJson, kind: 3 },
        { name: F.problemDescriptionIn, kind: 3 },
      ];
      for (const field of required) {
        if (present.has(field.name)) continue;
        try {
          await this.post(fieldsUrl, {
            __metadata: { type: 'SP.Field' },
            Title: field.name,
            FieldTypeKind: field.kind,
            ...(field.unique ? { Indexed: true, EnforceUniqueValues: true } : {}),
          });
        } catch (e) {
          // Another device/deploy may have created it between our read and
          // POST. Re-read once; only fail when it is genuinely still absent.
          present = await readFields();
          if (!present.has(field.name)) {
            throw new Error(
              `PMD_DieChangeLog needs column '${field.name}' (${(e as Error).message}). ` +
                'Add the columns documented in docs/DEPLOYMENT.md or grant Manage Lists once.',
            );
          }
        }
        present.add(field.name);
      }
    })().catch((e) => {
      this.dieChangeSchemaReady = null;
      throw e;
    });
    return this.dieChangeSchemaReady;
  }

  async listDieChangeLog(): Promise<DieChangeLog[]> {
    const F = this.F.dieChangeLog;
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.dieChangeLog);
      return rows
        .map((r) => ({
          id: getId(r),
          eventKey:
            str(r[F.eventKey]).trim() ||
            dieChangeEventKey(
              str(r[F.machine]),
              dateOnly(r[F.date]),
              str(r[F.shift]),
              str(r[F.jobNumber]),
              num(r[F.eventStartSlot]) || 0,
            ),
          eventStartSlot: Math.max(0, num(r[F.eventStartSlot]) || 0),
          eventEndSlot: Math.max(
            num(r[F.eventStartSlot]) || 0,
            num(r[F.eventEndSlot]) || num(r[F.eventStartSlot]) || 0,
          ),
          date: dateOnly(r[F.date]),
          shift: str(r[F.shift]).trim(),
          dieSetter: str(r[F.dieSetter]).trim(),
          machineCode: str(r[F.machine]).trim(),
          changeOver: multiChoice(r[F.changeOver]),
          jobNumber: str(r[F.jobNumber]).trim(),
          dieNumberOut: str(r[F.dieNumberOut]).trim(),
          dieDescriptionOut: str(r[F.dieDescriptionOut]).trim(),
          dieNumberIn: str(r[F.dieNumberIn]).trim(),
          dieDescriptionIn: str(r[F.dieDescriptionIn]).trim(),
          components: Object.fromEntries(
            DIE_COMPONENTS.map((c) => [c.key, parseDieCondition(str(r[c.key]))]),
          ),
          componentsIn: parseDieComponentsJson(str(r[F.componentsInJson])),
          problemDescription: str(r[F.problemDescription]),
          problemDescriptionIn: str(r[F.problemDescriptionIn]),
          createdAt: str(r['Created']),
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch (e) {
      console.warn('[pmd] PMD_DieChangeLog unavailable:', e);
      // A caller about to CREATE must be able to distinguish "no rows" from
      // "the read failed". Returning [] here made transient GET failures
      // manufacture duplicate rows on the following POST.
      throw e;
    }
  }

  async createDieChangeLog(log: Omit<DieChangeLog, 'id' | 'createdAt'>): Promise<DieChangeLog> {
    await this.ensureDieChangeLogSchema();
    const F = this.F.dieChangeLog;
    const eventKey = dieChangeEventKey(
      log.machineCode,
      log.date,
      log.shift,
      log.jobNumber,
      log.eventStartSlot,
    );
    const clean = {
      ...log,
      eventKey,
      eventStartSlot: Math.max(0, Math.floor(log.eventStartSlot)),
      eventEndSlot: Math.max(log.eventStartSlot, Math.floor(log.eventEndSlot)),
    };
    const findExisting = async (): Promise<DieChangeLog | undefined> =>
      (await this.listDieChangeLog()).find((r) => r.eventKey === eventKey);
    let existing = await findExisting();
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.dieChangeLog) },
      Title: `${clean.machineCode} ${clean.date} · Die ${clean.dieNumberOut || '?'} → ${clean.dieNumberIn || '?'}`,
      [F.eventKey]: eventKey,
      [F.eventStartSlot]: clean.eventStartSlot,
      [F.eventEndSlot]: clean.eventEndSlot,
      // DateOnly column: midnight UTC keeps the calendar date stable in
      // every positive-offset regional setting (same rule as
      // shiftDateMarker — see that comment).
      [F.date]: clean.date ? `${clean.date}T00:00:00.000Z` : null,
      [F.shift]: clean.shift,
      [F.dieSetter]: clean.dieSetter,
      [F.machine]: clean.machineCode,
      [F.changeOver]: { __metadata: { type: 'Collection(Edm.String)' }, results: clean.changeOver },
      [F.jobNumber]: clean.jobNumber,
      // Number columns — null when the die number isn't numeric/known.
      [F.dieNumberOut]: numOrNull(clean.dieNumberOut),
      [F.dieDescriptionOut]: clean.dieDescriptionOut,
      [F.dieNumberIn]: numOrNull(clean.dieNumberIn),
      [F.dieDescriptionIn]: clean.dieDescriptionIn,
      [F.problemDescription]: clean.problemDescription,
      [F.componentsInJson]: JSON.stringify(clean.componentsIn ?? {}),
      [F.problemDescriptionIn]: clean.problemDescriptionIn,
    };
    for (const c of DIE_COMPONENTS) {
      const cond = clean.components[c.key];
      // On update, always write the component (clearing a downgraded flag);
      // on insert, only send a value when set. body[c.key] otherwise stays
      // absent so SharePoint keeps its default.
      if (cond) body[c.key] = DIE_CONDITION_META[cond].label;
      else if (existing) body[c.key] = null;
    }
    if (existing) {
      // MERGE the existing row (IF-MATCH '*') — no duplicate created.
      await this.post(`${this.listUrl(LISTS.dieChangeLog)}/items(${existing.id})`, body, '*');
      return { ...clean, id: existing.id, createdAt: existing.createdAt };
    }
    let res: Response;
    try {
      res = await this.post(`${this.listUrl(LISTS.dieChangeLog)}/items`, body);
    } catch (e) {
      // EventKey's unique index turns a concurrent create into 409/duplicate.
      // Re-read and MERGE that winner so both devices report success without
      // ever leaving two rows behind.
      existing = await findExisting();
      if (!existing) throw e;
      await this.post(`${this.listUrl(LISTS.dieChangeLog)}/items(${existing.id})`, body, '*');
      return { ...clean, id: existing.id, createdAt: existing.createdAt };
    }
    const createdId = await responseItemId(res);
    if (createdId == null) {
      // Some SharePoint proxies strip the verbose create body. Resolve the
      // server row by its unique key instead of reporting a false failure
      // after the item has already been committed.
      existing = await findExisting();
      if (existing) return { ...clean, id: existing.id, createdAt: existing.createdAt };
      throw new Error('PMD_DieChangeLog create returned no item ID and the saved row could not be re-read');
    }
    return {
      ...clean,
      id: createdId,
      createdAt: new Date().toISOString(),
    };
  }

  // ---- planning -------------------------------------------------------

  // ---- die maintenance (PMD_DieMaintenance) ---------------------------

  /** Set true once the list is known to exist so the ensure probe runs at
   *  most once per page load. */
  private dieMaintEnsured = false;
  /** Which source the last listDieMaintenance() served (diagnostics). */
  private woSource: 'mango-csv' | 'list' | null = null;

  workOrderSource(): 'mango-csv' | 'list' | null {
    return this.woSource;
  }

  /**
   * Make sure PMD_DieMaintenance exists, creating it (plus its columns)
   * when it doesn't. Auto-provisioning keeps the Die Management tab
   * usable without an IT round-trip: the first person to raise a request
   * creates the list under their own permissions (site members can add
   * lists on this site). Schema — Title holds the DieNumber; Status /
   * MaintType / Priority / Contact / RequestedBy / Machine / JobNumber /
   * MangoTicket / ClosedAt are single-line text; Description is a note.
   * If creation is denied (read-only visitor), the caller's write fails
   * with SharePoint's own message, which the UI surfaces in a toast.
   */
  private async ensureDieMaintenanceList(): Promise<void> {
    if (this.dieMaintEnsured) return;
    try {
      await this.getJson(`${this.listUrl(LISTS.dieMaintenance)}?$select=Title`);
      this.dieMaintEnsured = true;
      return;
    } catch {
      /* not there — create it */
    }
    await this.post(`${this.siteUrl}/_api/web/lists`, {
      __metadata: { type: 'SP.List' },
      Title: LISTS.dieMaintenance,
      BaseTemplate: 100, // generic list
      Description:
        'Die / tool maintenance work requests raised from the PMD Operator Sheet (Trace → Die Management). MangoTicket links to the Mango system.',
    });
    const F = this.F.dieMaintenance;
    const textFields = [
      F.status,
      F.maintType,
      F.priority,
      F.contact,
      F.requestedBy,
      F.machine,
      F.jobNumber,
      F.mangoTicket,
      F.closedAt,
    ];
    const fieldsUrl = `${this.listUrl(LISTS.dieMaintenance)}/fields`;
    for (const title of textFields) {
      await this.post(fieldsUrl, {
        __metadata: { type: 'SP.Field' },
        Title: title,
        FieldTypeKind: 2, // single-line text
      });
    }
    await this.post(fieldsUrl, {
      __metadata: { type: 'SP.Field' },
      Title: F.description,
      FieldTypeKind: 3, // multi-line note
    });
    console.info('[pmd] PMD_DieMaintenance list created (auto-provisioned)');
    this.dieMaintEnsured = true;
  }

  async listDieMaintenance(): Promise<DieMaintenanceRequest[]> {
    // Mango CSV report (preferred when configured): Mango is the system
    // of record for work orders; scripts/sync-mango-csv.mjs downloads its
    // report into the OneDrive-synced folder and this reads the mirror.
    // Falls back to the PMD_DieMaintenance list if the file isn't there
    // (sync not set up yet / first run pending).
    if (this.mangoCsvPath) {
      try {
        const [text, dieColors] = await Promise.all([
          this.fetchSiteFile(this.mangoCsvPath, 'Mango work-order CSV'),
          this.listProductDieColors(),
        ]);
        const known = new Set(
          dieColors.map((d) => d.dieNumber.trim().toUpperCase()).filter(Boolean),
        );
        const orders = parseMangoWorkOrdersCsv(text);
        const matched = orders.filter((o) => known.has(o.dieNumber.toUpperCase())).length;
        const withDue = orders.filter((o) => o.dueDate).length;
        console.info(
          '[pmd] Mango work-order CSV:', orders.length, 'orders ·',
          matched, 'matched to a die number ·', withDue, "with a 'To be completed by' date",
        );
        if (orders.length > 0 && withDue === 0) {
          console.warn(
            "[pmd] Mango CSV: NO order has a 'To be completed by' date — the Maint",
            'traffic-light needs it. Check that column is present + filled in the export.',
            'Sample row dueDate:', JSON.stringify(orders[0]?.dueDate),
          );
        }
        this.woSource = 'mango-csv';
        return orders;
      } catch (e) {
        console.warn(
          '[pmd] Mango work-order CSV unavailable — falling back to PMD_DieMaintenance:', e,
        );
      }
    }
    this.woSource = 'list';
    const F = this.F.dieMaintenance;
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.dieMaintenance);
      this.dieMaintEnsured = true;
      return rows
        .map((r) => ({
          id: getId(r),
          dieNumber: str(r[F.dieNumber]).trim(),
          status: normaliseMaintStatus(str(r[F.status])),
          maintType: normaliseMaintType(str(r[F.maintType])),
          priority: normaliseMaintPriority(str(r[F.priority])),
          description: str(r[F.description]),
          contact: str(r[F.contact]),
          requestedBy: str(r[F.requestedBy]),
          machineCode: str(r[F.machine]),
          jobNumber: str(r[F.jobNumber]),
          mangoTicket: str(r[F.mangoTicket]),
          createdAt: str(r['Created']),
          closedAt: str(r[F.closedAt]),
          dueDate: isoDate(r[F.dueDate]) || undefined,
        }))
        .filter((r) => r.dieNumber)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch (e) {
      // Tenant without the list yet — an empty request book is the honest
      // answer; the list gets created on the first write.
      console.warn('[pmd] PMD_DieMaintenance unavailable (created on first request):', e);
      return [];
    }
  }

  async listMachineMaintenance(): Promise<DieMaintenanceRequest[]> {
    // The machine/plant half of the same Mango report the Die board reads
    // for dies. Only available from the CSV mirror — the legacy
    // PMD_DieMaintenance list is die-scoped, so there's nothing to fall
    // back to. Returns [] when the CSV isn't configured / can't be read.
    if (!this.mangoCsvPath) return [];
    try {
      const text = await this.fetchSiteFile(this.mangoCsvPath, 'Mango work-order CSV');
      const orders = parseMangoMachineWorkOrdersCsv(text);
      const open = orders.filter((o) => o.status !== 'done').length;
      // Distinct assets — the Die board matches these to a press by code, so
      // surfacing them here makes a naming mismatch diagnosable from F12.
      const sampleAssets = Array.from(
        new Set(orders.map((o) => o.asset ?? '').filter(Boolean)),
      ).slice(0, 12);
      console.info(
        '[pmd] Mango machine work orders:', orders.length, 'plant/equipment orders ·', open, 'open ·',
        'sample assets:', sampleAssets,
      );
      return orders;
    } catch (e) {
      console.warn('[pmd] Mango machine work orders unavailable:', e);
      return [];
    }
  }

  async createDieMaintenance(
    req: Omit<DieMaintenanceRequest, 'id' | 'createdAt' | 'closedAt'>,
  ): Promise<DieMaintenanceRequest> {
    await this.ensureDieMaintenanceList();
    const F = this.F.dieMaintenance;
    const res = await this.post(`${this.listUrl(LISTS.dieMaintenance)}/items`, {
      __metadata: { type: await this.itemType(LISTS.dieMaintenance) },
      [F.dieNumber]: req.dieNumber,
      [F.status]: req.status,
      [F.maintType]: req.maintType,
      [F.priority]: req.priority,
      [F.description]: req.description,
      [F.contact]: req.contact,
      [F.requestedBy]: req.requestedBy,
      [F.machine]: req.machineCode,
      [F.jobNumber]: req.jobNumber,
      [F.mangoTicket]: req.mangoTicket,
      [F.closedAt]: '',
    });
    const j = (await res.json()) as { d?: { ID?: number; Id?: number; Created?: string } };
    return {
      ...req,
      id: j.d?.ID ?? j.d?.Id ?? 0,
      createdAt: j.d?.Created ?? new Date().toISOString(),
      closedAt: '',
    };
  }

  async updateDieMaintenance(
    id: number,
    patch: Partial<Pick<DieMaintenanceRequest, 'status' | 'mangoTicket' | 'closedAt'>>,
  ): Promise<void> {
    const F = this.F.dieMaintenance;
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(LISTS.dieMaintenance) },
    };
    if (patch.status) body[F.status] = patch.status;
    if (patch.mangoTicket !== undefined) body[F.mangoTicket] = patch.mangoTicket;
    if (patch.closedAt !== undefined) body[F.closedAt] = patch.closedAt;
    await this.post(`${this.listUrl(LISTS.dieMaintenance)}/items(${id})`, body, '*');
  }

  async listPlanning(_filter: PlanningFilter): Promise<PlanningOrder[]> {
    // ERP orders + supervisor-added manual orders, ERP winning on a job
    // number collision (once Epicor picks the job up, its row takes over).
    const [erp, manual] = await Promise.all([
      this.listErpPlanning(),
      this.listManualOrders(),
    ]);
    if (manual.length === 0) return erp;
    const known = new Set(erp.map((o) => o.jobNumber.trim().toUpperCase()));
    return [...erp, ...manual.filter((m) => !known.has(m.jobNumber.trim().toUpperCase()))];
  }

  private async listErpPlanning(): Promise<PlanningOrder[]> {
    // Two sources, picked by config:
    //  1. CSV file in a doc library (PREFERRED) — written by PowerShell on
    //     the shop-floor PC and uploaded via OneDrive sync. No SP write
    //     credentials needed anywhere; the script just touches the local
    //     synced folder. App reads via SP file REST.
    //  2. PMD_Planning list (legacy) — kept for tenants that haven't moved
    //     to the CSV pipeline yet.
    if (this.planningCsvPath) {
      return this.loadPlanningCsv(this.planningCsvPath);
    }
    const F = this.F.planning;
    const rows = await this.getAllItems(LISTS.planning, '');
    return rows.map((r) => {
      const start = isoDate(r[F.startDateTime]);
      const due = isoDate(r[F.dueDate]);
      const dur = num(r[F.duration]) || 0;
      const end = dur > 0 ? new Date(new Date(start).getTime() + dur * 3600_000).toISOString() : due;
      return {
        id: getId(r),
        jobNumber: str(r[F.jobNum]),
        machineCode: '',
        originalMachine: '',
        partNumber: str(r[F.partNum]),
        partDescription: str(r[F.partDesc]),
        plannedStart: start,
        plannedEnd: end,
        // Order Qty = total ProdQty; fall back to the remaining qty so the
        // field is never blank on a tenant that hasn't surfaced ProdQty yet.
        orderQty: num(r[F.prodQty]) || num(r[F.remaining]) || 0,
        jobRequired: num(r[F.remaining]) || 0,
        qtyPerHr: num(r[F.qtyHour]) || 0,
        duration: dur,
        released: true,
        isDieChange: false,
        manuallyAdded: false,
        source: 'ERP',
      };
    });
  }

  /** Fetch a doc-library file's raw text. Accepts a full https://… URL
   *  or a server-relative path with or without percent-encoded spaces —
   *  normalise once, encode per segment so '/' separators survive,
   *  double single quotes for OData. Cache-busts per request so OneDrive
   *  uploads show up immediately. */
  private async fetchSiteFile(rawPath: string, what: string): Promise<string> {
    const serverRelative = toServerRelativePath(rawPath);
    const encodedPath = serverRelative
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
      .replace(/'/g, "''");
    const url = `${this.siteUrl}/_api/web/getFileByServerRelativeUrl('${encodedPath}')/$value?_t=${Date.now()}`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!res.ok) {
      throw new Error(`${what} fetch failed (${res.status}) for ${serverRelative}`);
    }
    return res.text();
  }

  private async loadPlanningCsv(rawPath: string): Promise<PlanningOrder[]> {
    return parsePlanningCsv(await this.fetchSiteFile(rawPath, 'Planning CSV'));
  }

  // ---- manual orders (PMD_ManualOrders) --------------------------------

  /** Set true once the list is known to exist so the ensure probe runs
   *  at most once per page load (same pattern as PMD_DieMaintenance). */
  private manualOrdersEnsured = false;

  private static manualPlanningOrder(o: {
    id: number;
    jobNumber: string;
    partNumber: string;
    partDescription: string;
    orderQty: number;
  }): PlanningOrder {
    return {
      id: o.id,
      jobNumber: o.jobNumber,
      machineCode: '',
      originalMachine: '',
      partNumber: o.partNumber,
      partDescription: o.partDescription,
      plannedStart: '',
      plannedEnd: '',
      orderQty: o.orderQty,
      jobRequired: o.orderQty,
      qtyPerHr: 0,
      duration: 0,
      released: true,
      isDieChange: false,
      manuallyAdded: true,
      source: 'Manual',
    };
  }

  /** Supervisor-added orders as PlanningOrder rows; [] when the list
   *  hasn't been created yet (nothing manual to merge). */
  private async listManualOrders(): Promise<PlanningOrder[]> {
    try {
      const rows = await this.getAllItems<Record<string, unknown>>(LISTS.manualOrders);
      this.manualOrdersEnsured = true;
      return rows
        .map((r) =>
          SharePointDataLayer.manualPlanningOrder({
            id: getId(r),
            jobNumber: str(r['Title']).trim(),
            partNumber: str(r['PartNumber']).trim(),
            partDescription: str(r['PartDescription']).trim(),
            orderQty: num(r['OrderQty']) || 0,
          }),
        )
        .filter((o) => o.jobNumber);
    } catch {
      return []; // no list yet — created on the first add
    }
  }

  private async ensureManualOrdersList(): Promise<void> {
    if (this.manualOrdersEnsured) return;
    try {
      await this.getJson(`${this.listUrl(LISTS.manualOrders)}?$select=Title`);
      this.manualOrdersEnsured = true;
      return;
    } catch {
      /* not there — create it */
    }
    await this.post(`${this.siteUrl}/_api/web/lists`, {
      __metadata: { type: 'SP.List' },
      Title: LISTS.manualOrders,
      BaseTemplate: 100, // generic list
      Description:
        'Orders added by a supervisor on the PMD Operator Sheet when a job is missing from the Epicor planning extract. Title holds the JobNumber.',
    });
    const fieldsUrl = `${this.listUrl(LISTS.manualOrders)}/fields`;
    for (const title of ['PartNumber', 'PartDescription']) {
      await this.post(fieldsUrl, {
        __metadata: { type: 'SP.Field' },
        Title: title,
        FieldTypeKind: 2, // single-line text
      });
    }
    await this.post(fieldsUrl, {
      __metadata: { type: 'SP.Field' },
      Title: 'OrderQty',
      FieldTypeKind: 9, // number
    });
    console.info('[pmd] PMD_ManualOrders list created (auto-provisioned)');
    this.manualOrdersEnsured = true;
  }

  async createManualOrder(o: {
    jobNumber: string;
    partNumber: string;
    partDescription: string;
    orderQty: number;
  }): Promise<PlanningOrder> {
    await this.ensureManualOrdersList();
    const res = await this.post(`${this.listUrl(LISTS.manualOrders)}/items`, {
      __metadata: { type: await this.itemType(LISTS.manualOrders) },
      Title: o.jobNumber,
      PartNumber: o.partNumber,
      PartDescription: o.partDescription,
      OrderQty: o.orderQty,
    });
    const j = (await res.json()) as { d?: { ID?: number; Id?: number } };
    return SharePointDataLayer.manualPlanningOrder({ id: j.d?.ID ?? j.d?.Id ?? 0, ...o });
  }

  // ---- management Pareto aggregations --------------------------------

  /**
   * Reject Pareto counts straight from PMD_Rejects — no production-record
   * JSON round-trip. RejectCategory on that event list is intentionally the
   * slot's MachineStatus (R/S/D/…), NOT a defect description, so labels are
   * resolved by RejectCode from PMD_RejectCategories instead. Server-side
   * lower-bounds the DateTime so the fetch stays small, then filters the
   * exact [from, to] day window client-side.
   */
  async listRejectPareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const F = this.F.rejects;
    const parts: string[] = [this.dateLowerBound(F.date, filter.from)];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    const qs = '$filter=' + encodeURIComponent(parts.join(' and '));
    // Start the shared catalogue read alongside the event read. If the
    // catalogue is temporarily unavailable the Pareto still shows the real
    // PMD_Rejects counts, labelled by code rather than by a false R/S status.
    const categoriesPromise = this.listRejectCategories().catch((e) => {
      console.warn('[pmd] listRejectPareto: PMD_RejectCategories read failed', e);
      return [] as RejectCategory[];
    });
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.getAllItems(LISTS.rejects, qs);
    } catch (e) {
      console.warn('[pmd] listRejectPareto: PMD_Rejects read failed', e);
      throw e;
    }
    const categories = await categoriesPromise;
    const labelByCode = new Map(categories.map((c) => [c.code, c.label || c.code]));
    const qty = new Map<string, number>();
    // Per-code Day/Afternoon/Night split so the KPI chart can stack the
    // bars by shift. PMD_Rejects.Shift is written from the shiftId at
    // sign-off, so it's always one of the three codes; an unexpected
    // value is simply not attributed to a shift (the bar would then be
    // shorter than `value`, but that doesn't happen with real data).
    const shiftTally = new Map<string, Record<ShiftCode, number>>();
    const statusTally = new Map<
      string,
      Partial<Record<StatusCode | 'Unknown', number>>
    >();
    for (const r of rows) {
      const day = dateOnly(r[F.date]);
      if (day < filter.from || day > filter.to) continue;
      const code = str(r[F.rejectCode]).trim().toUpperCase();
      if (!code) continue;
      const n = num(r[F.rejectNumber]);
      if (n <= 0) continue;
      qty.set(code, (qty.get(code) ?? 0) + n);
      // RejectCategory is the status snapshot by design. Keep it as an
      // independent analytical dimension: R rejects happened during normal
      // production, while S/C/D/I/P etc provide startup/changeover context.
      const status = rejectMachineStatus(str(r[F.rejectCategory]));
      const statuses = statusTally.get(code) ?? {};
      statuses[status] = (statuses[status] ?? 0) + n;
      statusTally.set(code, statuses);
      const shift = str(r[F.shift]).trim();
      if (shift === 'Day' || shift === 'Afternoon' || shift === 'Night') {
        const st = shiftTally.get(code) ?? { Day: 0, Afternoon: 0, Night: 0 };
        st[shift] += n;
        shiftTally.set(code, st);
      }
    }
    return paretoFrom(
      qty,
      (code) => labelByCode.get(code) || code,
      (code) => shiftTally.get(code),
      (code) => statusTally.get(code),
    );
  }

  /**
   * Downtime Pareto from PMD_BreakDownlog — sums the B_BreakDown hours per
   * BDCode (the clearest single attribution the log carries). Label is the
   * breakdown cause from the taxonomy. Rows with a blank BDCode or zero
   * breakdown hours contribute nothing.
   */
  async listDowntimePareto(filter: ParetoFilter): Promise<ParetoSlice[]> {
    const F = this.F.breakdown;
    const parts: string[] = [this.dateLowerBound(F.date, filter.from)];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    const qs = '$filter=' + encodeURIComponent(parts.join(' and '));
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await this.getAllItems(LISTS.breakdown, qs);
    } catch (e) {
      console.warn('[pmd] listDowntimePareto: PMD_BreakDownlog read failed', e);
      throw e;
    }
    const hrs = new Map<string, number>();
    for (const r of rows) {
      const day = dateOnly(r[F.date]);
      if (day < filter.from || day > filter.to) continue;
      const code = str(r[F.bdCode]).trim();
      if (!code) continue;
      const h = num(r[F.b]);
      if (h <= 0) continue;
      hrs.set(code, (hrs.get(code) ?? 0) + h);
    }
    return paretoFrom(hrs, (code) => bdLabelFor(code) || code);
  }

  /** Lower-bound clause on a DateTime column, one calendar day before
   *  `fromDate` to cushion the noon-UTC marker / legacy local-start rows.
   *  The exact day window is then enforced client-side via dateOnly. */
  private dateLowerBound(field: string, fromDate: string): string {
    const d = new Date(`${fromDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return `${field} ge datetime'${d.toISOString()}'`;
  }

  // ---- production (header / events) ----------------------------------
  //
  // PmdDataLayer is per-slot, but PMD_Production is per-(machine,shift,job).
  // We keep an in-memory cache of slot edits while a shift is being filled
  // and flush to the three lists on lockShift.

  private cacheKey(mc: string, sid: string, job: string): string {
    return `${mc}|${sid}|${job}`;
  }

  /** Lightweight production-header read for the mould service planner.
   *  It applies the same signed-over-live precedence as listProduction,
   *  but intentionally skips PMD_Rejects, breakdown timelines and the
   *  16-slot expansion. That makes a 400-day shot ledger practical. */
  async listProductionCounters(filter: ProductionFilter): Promise<ProductionCounterRecord[]> {
    const [prodHeaders, liveHeaders] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchHeaders(LISTS.liveStatus, filter).catch((e) => {
        console.warn('[pmd] service counters: PMD_LiveStatus read failed:', e);
        return [] as HeaderRow[];
      }),
    ]);
    const matches = (h: HeaderRow): boolean => {
      const sid = `${h.date}-${h.shift}`;
      if (filter.shiftId && sid !== filter.shiftId) return false;
      if (filter.shiftIdFrom && sid < filter.shiftIdFrom) return false;
      if (filter.shiftIdTo && sid > filter.shiftIdTo) return false;
      if (filter.machineCode && h.machineCode !== filter.machineCode) return false;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) return false;
      return true;
    };
    const signed = new Map<string, HeaderRow>();
    const chosen = new Map<string, HeaderRow>();
    for (const h of prodHeaders) {
      if (!matches(h)) continue;
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      signed.set(key, h);
      chosen.set(key, h);
    }
    const now = new Date();
    for (const h of liveHeaders) {
      if (!matches(h)) continue;
      const sid = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, sid, h.jobNumber);
      if (
        !this.unlockedTuples.has(key) &&
        (shiftEndedLongAgo(sid, now, LIVE_HARD_CAP_MS) || isStaleLiveHeader(h, now))
      )
        continue;
      const prod = signed.get(key);
      if (!prod) {
        chosen.set(key, h);
        continue;
      }
      // A fresh live correction may replace its Reopened signed header;
      // an ordinary live shadow never double-counts a signed tuple.
      const pmod = prod.modified ? Date.parse(prod.modified) : NaN;
      const lmod = h.modified ? Date.parse(h.modified) : NaN;
      if (prod.reopened && !Number.isNaN(lmod) && (Number.isNaN(pmod) || lmod > pmod))
        chosen.set(key, h);
    }
    const counters = new Map<string, ProductionCounterRecord>();
    for (const [key, h] of chosen) {
      counters.set(key, {
        machineCode: h.machineCode,
        shiftId: `${h.date}-${h.shift}`,
        jobNumber: h.jobNumber,
        partNumber: h.partNumber,
        countStart: h.countStart,
        countEnd: h.countEnd,
        cavities: h.cavities,
      });
    }
    // Counts being edited on this device can be newer than the 60-second
    // live mirror. Only locally-authored/unlocked tuples may override;
    // spectator cache copies are deliberately ignored.
    for (const rows of this.editCache.values()) {
      const r = rows.find((x) => x.slotIndex === 0);
      if (!r || !productionMatches(r, filter)) continue;
      const key = this.cacheKey(r.machineCode, r.shiftId, r.jobNumber);
      if (!this.dirtyTuples.has(key) && !this.unlockedTuples.has(key)) continue;
      if (signed.has(key) && !this.unlockedTuples.has(key)) continue;
      counters.set(key, {
        machineCode: r.machineCode,
        shiftId: r.shiftId,
        jobNumber: r.jobNumber,
        partNumber: r.partNumber,
        countStart: r.countStart,
        countEnd: r.countEnd,
        cavities: r.cavities,
      });
    }
    return [...counters.values()];
  }

  async listProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    // Hydrate header rows from PMD_Production (signed-off) AND
    // PMD_LiveStatus (in-progress mirror) first — precedence is
    //   signed-off  >  local editCache  >  live mirror.
    // Signed-off is the immutable record of truth: once a (machine,
    // shift, job) has a PMD_Production header, any editCache rows for
    // the same tuple are stale by definition (taps that slipped in
    // around sign-off, or another iPad's pre-sign-off localStorage)
    // and must not shadow it — that's how a signed-off order with 53
    // goods rendered as an empty, editable timeline. Purge them.
    const [prodHeaders, liveHeaders, rejectsByKey, timelinesByKey] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchHeaders(LISTS.liveStatus, filter).catch((e) => {
        // The live list may not exist yet on a fresh tenant — fall
        // back to "no live rows" so the rest of the page still loads.
        console.warn('[pmd] PMD_LiveStatus read failed (treating as empty):', e);
        return [] as HeaderRow[];
      }),
      this.fetchRejectsByKey(filter),
      this.fetchBreakdownTimelines(filter),
    ]);

    const matchesFilter = (h: HeaderRow): boolean => {
      // Defensive re-filter. shiftDateRange is intentionally loose
      // (±1 d) to catch legacy noon-UTC / local-start timestamps; with
      // the F.shift clause it also catches the same shift code on
      // adjacent calendar dates — yesterday's Day shift would leak
      // into a "today's Day shift" query.
      const hShiftId = `${h.date}-${h.shift}`;
      if (filter.shiftId && hShiftId !== filter.shiftId) return false;
      if (filter.shiftIdFrom && hShiftId < filter.shiftIdFrom) return false;
      if (filter.shiftIdTo && hShiftId > filter.shiftIdTo) return false;
      if (filter.machineCode && h.machineCode !== filter.machineCode) return false;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) return false;
      return true;
    };

    // Self-heal: drop editCache entries whose tuple is already signed
    // off. lockShift deletes the cache on the device that signed off,
    // but other iPads (or a tap that raced the sign-off) can still
    // hold stale rows in localStorage.
    const signedKeys = new Set(
      prodHeaders
        .filter(matchesFilter)
        .map((h) => this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber)),
    );
    // Last-commit time of each signed PMD_Production tuple (SP Modified,
    // server clock). lockShift is the only writer of that row, so its
    // Modified == the sign-off time.
    const prodModMsByKey = new Map<string, number>();
    // Tuples whose signed row carries Reopened=Yes — the server-authoritative
    // "a supervisor re-opened this for correction" flag. Only these may be
    // shadowed by a fresher live mirror (see reEditedKeys below).
    const prodReopenedKeys = new Set<string>();
    for (const h of prodHeaders) {
      if (!matchesFilter(h)) continue;
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      const t = h.modified ? Date.parse(h.modified) : NaN;
      prodModMsByKey.set(key, isNaN(t) ? 0 : t);
      if (h.reopened) prodReopenedKeys.add(key);
    }
    let purged = false;
    for (const k of Array.from(this.editCache.keys())) {
      if (!signedKeys.has(k)) continue;
      // Active "unlock & edit": the supervisor unlocked this tuple
      // and the editCache holds the rehydrated rows that the operator
      // is currently editing. PMD_Production still carries the
      // (locked) row because the new unlock design does NOT delete
      // it on the SP side — that's the whole point of the redesign.
      // Self-heal would otherwise wipe the operator's edits the next
      // time anything reads the production list.
      if (this.unlockedTuples.has(k)) continue;
      this.editCache.delete(k);
      purged = true;
    }

    // Drop "junk" PMD_LiveStatus rows: shift ended > 8 h ago AND no
    // MachineStatus letter on any slot. These accumulate when an
    // operator taps a machine, picks a wrong job (or just lands on
    // the wrong shift / date), maybe types a Count Start, and walks
    // away — pushLiveSnapshot had already mirrored the partial cache
    // and there was no path to clean it up. Without this filter, the
    // backfill loop below absorbs them into editCache and shadows
    // the legitimate PMD_Production row when an operator scrolls
    // back to review a past shift. Also fire-and-forget delete the
    // junk from PMD_LiveStatus so the SP list itself stays tidy.
    const liveNow = new Date();
    const liveFresh: HeaderRow[] = [];
    for (const h of liveHeaders) {
      const hSid = `${h.date}-${h.shift}`;
      // Hard 24 h cap (Task: never-signed-off rows lingering forever):
      // sweep ANY live row whose shift ended > 24 h ago, status or not.
      // This is the only path that removes an OLD row that DOES carry
      // status — isStaleLiveHeader deliberately leaves those alone. A
      // tuple actively unlocked for correction is exempt (its live mirror
      // is the supervisor's in-progress re-edit).
      if (
        shiftEndedLongAgo(hSid, liveNow, LIVE_HARD_CAP_MS) &&
        !this.unlockedTuples.has(this.cacheKey(h.machineCode, hSid, h.jobNumber))
      ) {
        void this.deleteLiveRow(h.machineCode, hSid, h.jobNumber);
        continue;
      }
      if (isStaleLiveHeader(h, liveNow)) {
        void this.deleteLiveRow(h.machineCode, hSid, h.jobNumber);
      } else {
        liveFresh.push(h);
      }
    }

    // Detect signed-off tuples that have since been UNLOCKED and are being
    // RE-EDITED — the source-conflict that made a PC's Trace keep showing
    // the morning's signed data while the floor iPad corrected it. unlock
    // is a client-side flag (device-local), so another device only sees
    // the still-locked PMD_Production row plus a fresh PMD_LiveStatus row.
    // A live row for a signed tuple wins ONLY when the signed row is flagged
    // Reopened=Yes (server-authoritative unlock) AND the live mirror is
    // fresher than the prod row's last commit — that's a supervisor's
    // in-progress correction and must show on every device. A fresher live
    // row on a NOT-reopened tuple is junk by definition (e.g. another iPad's
    // leftover editCache re-mirrored AFTER a different device signed off —
    // the SFM507147 case that hid a signed order from the KPIs): the signed
    // row stays canonical and the shadow is deleted on sight. Timestamp alone
    // used to decide this, which let that junk shadow win.
    const reEditedKeys = new Set<string>();
    for (const h of liveFresh) {
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      const pmod = prodModMsByKey.get(key);
      if (pmod == null || pmod === 0) continue; // not signed, or no timestamp
      const lmod = h.modified ? Date.parse(h.modified) : NaN;
      const fresher = !isNaN(lmod) && lmod > pmod;
      if (!fresher) continue;
      if (prodReopenedKeys.has(key)) {
        reEditedKeys.add(key);
        continue;
      }
      // Fresher shadow on a signed, not-reopened tuple. Clean it up unless
      // THIS device just unlocked it locally (tenant without the Reopened
      // column falls back to the device-local flag — don't eat its edits).
      if (!this.unlockedTuples.has(key)) {
        void this.deleteLiveRow(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      }
    }
    // GC editCache: drop any status-empty tuple whose shift ended > 8 h
    // ago. UNCONDITIONAL — this must run even when there are no stale
    // server rows left to react to (e.g. the supervisor already deleted
    // the junk from PMD_LiveStatus by hand). Gating it on "saw a stale
    // server row" was the bug that let pushLiveSnapshot keep re-mirroring
    // the local copy straight back onto the list. Status-empty only here
    // so we never drop real local work; OLD rows that carry status are
    // left in the cache but pushLiveSnapshot refuses to re-broadcast them.
    for (const k of Array.from(this.editCache.keys())) {
      const slots = this.editCache.get(k) ?? [];
      const sid = k.split('|')[1];
      if (!sid) continue;
      // A tuple a supervisor has just UNLOCKED for correction is exempt
      // from every age sweep — it may legitimately target a months-old
      // shift, and dropping it mid-edit would lose the correction before
      // re-sign-off commits it.
      if (this.unlockedTuples.has(k)) continue;
      // Hard 24 h cap mirrors the live-row sweep above so an abandoned
      // in-progress job (status set, never signed off) doesn't get
      // re-broadcast from this device's localStorage indefinitely.
      if (shiftEndedLongAgo(sid, liveNow, LIVE_HARD_CAP_MS)) {
        this.editCache.delete(k);
        purged = true;
        continue;
      }
      // Status-empty mis-taps: drop after the shorter 8 h grace.
      if (slots.some((s) => s.statusCode)) continue;
      if (shiftEndedLongAgo(sid, liveNow)) {
        this.editCache.delete(k);
        purged = true;
      }
    }
    if (purged) this.persistEditCache();

    // Backfill editCache from PMD_LiveStatus per slot. PMD_LiveStatus
    // is pushed every 60 s from whichever iPad is editing, and is the
    // only durable source for in-progress slots — if localStorage is
    // stale (page reload between snapshot pushes, fresh device, cleared
    // cache, asset redeploy that forced a refresh) the local cache can
    // be missing slots the broker actually has. Without this merge a
    // subsequent Sign Off & Save aggregates only the local cache and
    // burns a partial timeline into PMD_Production — exactly the
    // SFM507068 14:23 incident.
    //
    // editCache wins per slot — but ONLY for tuples this device actually
    // AUTHORED (dirtyTuples). A copy that landed here purely for viewing
    // (a spectator PC, or an iPad glancing at another press's shift) is
    // stale by definition and must be REPLACED by the mirror's current
    // picture wholesale: the old merge-by-absence kept whatever the
    // viewer first saw forever — PC poll fetches reject=23 from
    // PMD_LiveStatus but its own editCache slot 0 (from an earlier
    // glance at the job) still says reject=1, and the "add only what we
    // lack" merge silently keeps the stale 1. Same bug masked half the
    // QC sign-offs on remote viewers and froze iPad1's view of Batt2 at
    // whatever it backfilled first.
    //
    // Rules:
    //   - tuple signed off → skip; PMD_Production is canonical.
    //   - tuple not authored here (read-only device, or a writable
    //     device that only viewed it) → REPLACE editCache with the live
    //     expansion. We're a spectator for this tuple.
    //   - tuple authored here → merge-by-absence so locally-edited
    //     slots not yet pushed survive.
    const writable = this.canWriteHook();
    let backfilled = false;
    for (const h of liveFresh) {
      if (!matchesFilter(h)) continue;
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      // Signed tuples normally skip the live backfill (PMD_Production is
      // canonical). EXCEPT a tuple being re-edited after unlock: its live
      // mirror is fresher than the signed row, so let it backfill and win.
      if (signedKeys.has(key) && !reEditedKeys.has(key)) continue;
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: timelinesByKey.get(key) ?? '' };
      const liveSlots = this.expandHeaderToSlots(
        hWithTimeline,
        rejectsByKey.get(key) ?? [],
        false,
      );
      if (!writable || !this.dirtyTuples.has(key)) {
        this.editCache.set(key, liveSlots);
        backfilled = true;
        continue;
      }
      const existing = this.editCache.get(key) ?? [];
      const haveSlot = new Set(existing.map((s) => s.slotIndex));
      let added = false;
      for (const ls of liveSlots) {
        if (haveSlot.has(ls.slotIndex)) continue;
        existing.push(ls);
        added = true;
      }
      if (added) {
        this.editCache.set(key, existing);
        backfilled = true;
      }
    }
    if (backfilled) this.persistEditCache();

    // Local edits for tuples that are NOT signed off.
    const cached: ProductionRecord[] = [];
    for (const list of this.editCache.values()) {
      for (const r of list) if (productionMatches(r, filter)) cached.push(r);
    }
    const seen = new Set(cached.map((r) => this.cacheKey(r.machineCode, r.shiftId, r.jobNumber)));

    const ingest = (h: HeaderRow, isSignedOff: boolean): void => {
      if (!matchesFilter(h)) return;
      const hShiftId = `${h.date}-${h.shift}`;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      if (seen.has(key)) return;
      seen.add(key);
      // Splice the breakdown-side timeline onto the header so
      // expandHeaderToSlots can decode it. Without this, every
      // signed-off shift comes back with an empty timeline → no
      // Machine Status row, and every reject collapses into the
      // canonical slot 0 (07:00–07:30 for Day shift).
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: timelinesByKey.get(key) ?? '' };
      cached.push(
        ...this.expandHeaderToSlots(hWithTimeline, rejectsByKey.get(key) ?? [], isSignedOff),
      );
    };

    // Signed-off first so it wins any (rare) overlap with a not-yet-
    // deleted live row — EXCEPT a re-edited tuple, whose stale signed row
    // must not shadow the fresh live data the backfill just emitted.
    for (const h of prodHeaders) {
      const key = this.cacheKey(h.machineCode, `${h.date}-${h.shift}`, h.jobNumber);
      if (reEditedKeys.has(key)) continue;
      ingest(h, true);
    }
    // Live rows already merged into editCache above; the ingest pass
    // still runs them to cover tuples that fall outside the editCache
    // filter (e.g. cross-machine Live Status board reads) — the
    // seen-set dedups any already-emitted tuple.
    for (const h of liveFresh) ingest(h, false);
    return cached;
  }

  /**
   * Signed-off history only: reads PMD_Production exclusively — no
   * PMD_LiveStatus mirror, no local editCache. The Trace "Job Number
   * Search" uses this so a historical lookup reflects the canonical
   * source of truth (the signed-off record) and never blends in
   * in-progress / mis-typed live data that hasn't been reviewed. Rejects
   * and breakdown timelines are still joined so each row expands to the
   * correct per-slot status + reject breakdown.
   */
  async listSignedOffProduction(filter: ProductionFilter): Promise<ProductionRecord[]> {
    const [prodHeaders, rejectsByKey, timelinesByKey] = await Promise.all([
      this.fetchHeaders(LISTS.production, filter),
      this.fetchRejectsByKey(filter),
      this.fetchBreakdownTimelines(filter),
    ]);
    const out: ProductionRecord[] = [];
    for (const h of prodHeaders) {
      // shiftDateRange is intentionally loose (±1 d) — re-filter exactly
      // against the requested predicates so adjacent-day rows that share
      // the shift code don't leak in.
      const hShiftId = `${h.date}-${h.shift}`;
      if (filter.shiftId && hShiftId !== filter.shiftId) continue;
      if (filter.shiftIdFrom && hShiftId < filter.shiftIdFrom) continue;
      if (filter.shiftIdTo && hShiftId > filter.shiftIdTo) continue;
      if (filter.machineCode && h.machineCode !== filter.machineCode) continue;
      if (filter.jobNumber && h.jobNumber !== filter.jobNumber) continue;
      const key = this.cacheKey(h.machineCode, hShiftId, h.jobNumber);
      const hWithTimeline: HeaderRow = h.timeline
        ? h
        : { ...h, timeline: timelinesByKey.get(key) ?? '' };
      out.push(
        ...this.expandHeaderToSlots(hWithTimeline, rejectsByKey.get(key) ?? [], true),
      );
    }
    return out;
  }

  /**
   * Read header rows from PMD_Production OR PMD_LiveStatus. Both
   * share the production field map by design — PMD_LiveStatus is a
   * column-for-column mirror of PMD_Production, holding the same
   * tuple until Sign Off & Save copies it across and deletes it
   * here.
   */
  private async fetchHeaders(list: string, filter: ProductionFilter): Promise<HeaderRow[]> {
    const F = this.F.production;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    if (filter.jobNumber) parts.push(`${F.jobNumber} eq '${odataString(filter.jobNumber)}'`);
    // F.date points at SlotStart_x003a_ (DateTime). Filter with datetime'...'
    // and combine with ShiftId for an exact-shift match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${odataString(shift)}'`);
    }
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems(list, qs);
    return rows.map((r) => ({
      id: getId(r),
      machineCode: str(r[F.machine]),
      date: dateOnly(r[F.date]),
      shift: str(r[F.shift]),
      jobNumber: str(r[F.jobNumber]),
      partNumber: F.partNum ? str(r[F.partNum]).trim() : '',
      partDescription: F.partDesc ? str(r[F.partDesc]) : '',
      jobRequired: F.jobRequired ? num(r[F.jobRequired]) : 0,
      cycleTime: F.cycleTime ? num(r[F.cycleTime]) : 0,
      // Cavities defaults to 1 when the column is absent / empty (a 0 from
      // a blank cell must not zero the multiplier — that would wipe Good).
      cavities: F.cavities && num(r[F.cavities]) > 0 ? num(r[F.cavities]) : 1,
      // The 16-char status timeline lives in the MachineCode column on
      // this tenant; prefer it over the (empty / fallback) F.timeline
      // entry so listProduction can rebuild per-slot status without a
      // round-trip to PMD_BreakDownlog.
      timeline:
        (F.machineCodeAlt && str(r[F.machineCodeAlt])) ||
        (F.timeline && str(r[F.timeline])) ||
        '',
      countStart: nullOrNum(r[F.countStart]),
      countEnd: nullOrNum(r[F.countEnd]),
      reject: num(r[F.reject]),
      operator: str(r[F.operator]),
      supervisor: str(r[F.supervisor]),
      runTime: F.runTime ? num(r[F.runTime]) : 0,
      downTime: num(r[F.downTime]),
      // Handover is the JSON {machine,mold,material,method} blob (the
      // "4M"), stored when the shift was signed off. Used by the
      // operator side-panel textareas and the KPI Handover column.
      handover: F.handover ? str(r[F.handover]) : '',
      qcChecks: F.qcChecks ? str(r[F.qcChecks]) : '',
      rejectsBySlot: F.rejectsBySlot ? str(r[F.rejectsBySlot]) : '',
      ownerDevice: F.ownerDevice ? str(r[F.ownerDevice]) : '',
      signOff: F.signOff ? str(r[F.signOff]) : '',
      // Strict native-boolean check, NOT bool(): a Yes/No column returns true/
      // false in verbose OData. If the column was provisioned as text/Choice
      // by mistake, a string like "Yes" must NOT read as reopened — that would
      // unlock the row everywhere and hide it from the KPIs (locked-only view)
      // with no way to clear it (boolean writes 400 on a text column).
      reopened: F.reopened ? r[F.reopened] === true : false,
      jobLeft: F.jobLeft && r[F.jobLeft] != null ? num(r[F.jobLeft]) : -1,
      shiftTarget: F.shiftTarget && r[F.shiftTarget] != null ? num(r[F.shiftTarget]) : -1,
      plannedStart: F.plannedStart ? str(r[F.plannedStart]) : '',
      // Built-in SP column, always present in the verbose payload.
      modified: str(r['Modified']),
    }));
  }

  /**
   * Pull StatusTimeline strings keyed by (machine|shiftId|jobNumber) from
   * PMD_BreakDownlog so listProduction can splice them onto the header
   * rows that come back from PMD_Production. PMD_Production no longer
   * carries the timeline directly (Status column was deleted from the
   * tenant) — without this fetch, every signed-off shift would come back
   * with no Machine Status row and rejects collapsed to slot 0.
   */
  private async fetchBreakdownTimelines(
    filter: ProductionFilter,
  ): Promise<Map<string, string>> {
    const F = this.F.breakdown;
    if (!F.statusTimeline) return new Map();
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${odataString(filter.jobNumber)}'`);
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${odataString(shift)}'`);
    }
    const fromTo = shiftDateRangeFromTo(filter.shiftIdFrom, filter.shiftIdTo, F.date);
    if (fromTo) parts.push(fromTo);
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems<Record<string, unknown>>(LISTS.breakdown, qs);
    const out = new Map<string, string>();
    for (const r of rows) {
      const mc = str(r[F.machine]);
      const date = dateOnly(r[F.date]);
      const shift = str(r[F.shift]);
      const job = str(r[F.jobNum]);
      const sid = `${date}-${shift}`;
      const key = this.cacheKey(mc, sid, job);
      const tl = str(r[F.statusTimeline]);
      if (tl) out.set(key, tl);
    }
    return out;
  }

  private async fetchRejectsByKey(
    filter: ProductionFilter,
  ): Promise<Map<string, RejectRow[]>> {
    const F = this.F.rejects;
    const parts: string[] = [];
    if (filter.machineCode) parts.push(`${F.machine} eq '${odataString(filter.machineCode)}'`);
    if (filter.jobNumber) parts.push(`${F.jobNum} eq '${odataString(filter.jobNumber)}'`);
    // PMD_Rejects.Date is DateTime — use a ±1d window around the shift's
    // date so both new (noon-UTC marker) and legacy (local-start) rows match.
    if (filter.shiftId) {
      const { shift } = parseShiftIdLoose(filter.shiftId);
      parts.push(`(${shiftDateRange(filter.shiftId, F.date)})`);
      if (shift) parts.push(`${F.shift} eq '${odataString(shift)}'`);
    }
    const qs = parts.length ? '$filter=' + encodeURIComponent(parts.join(' and ')) : '';
    const rows = await this.getAllItems<Record<string, unknown>>(LISTS.rejects, qs);
    const out = new Map<string, RejectRow[]>();
    for (const r of rows) {
      const mc = str(r[F.machine]);
      const date = dateOnly(r[F.date]);
      const shift = str(r[F.shift]);
      const job = str(r[F.jobNum]);
      const sid = `${date}-${shift}`;
      const key = this.cacheKey(mc, sid, job);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push({
        id: getId(r),
        timeline: str(r[F.timeline]),
        code: str(r[F.rejectCode]),
        category: str(r[F.rejectCategory]),
        qty: num(r[F.rejectNumber]),
      });
    }
    return out;
  }

  private expandHeaderToSlots(
    h: HeaderRow,
    rejects: RejectRow[],
    /** True for rows from PMD_Production (signed off); false for rows
     *  from PMD_LiveStatus (in progress). The caller knows which list
     *  the header came from — no need to infer from supervisor. */
    isSignedOff: boolean,
  ): ProductionRecord[] {
    const shiftId = `${h.date}-${h.shift}`;
    const slots: ProductionRecord[] = [];
    const timeline = (h.timeline || '').padEnd(16, '·').slice(0, 16);
    const stamp = new Date().toISOString();
    // lockedAt drives the "Signed off … at <time>" banner. Prefer the
    // persisted PMD_Production.Signoff timestamp so the banner shows when
    // sign-off ACTUALLY happened, not this device's current clock. Falls
    // back to the render stamp for legacy rows signed before the column
    // existed (and for live rows, where lockedAt is unused).
    const signedAt = isSignedOff && h.signOff ? h.signOff : stamp;
    // QualityChecks JSON {"<slotIndex>":"<name>"} → per-slot qcBy.
    // Bare-string fallback so a column that pre-dates the JSON format
    // (or has been mis-edited in SP directly) still surfaces something
    // useful instead of swallowing the value.
    let qcMap: Record<string, string> = {};
    if (h.qcChecks) {
      try {
        const parsed = JSON.parse(h.qcChecks);
        if (parsed && typeof parsed === 'object') {
          qcMap =…597 tokens truncated…ect column total
        // with the event total (the 20-vs-28 drift). Only fall back to
        // the column when there are NO events at all (legacy rows signed
        // off before PMD_Rejects existed, or live rows pre-sign-off).
        rejectCount: rejects.length ? 0 : h.reject,
        rejects: '{}',
        purgeKg: null,
        operator: h.operator,
        supervisor: h.supervisor,
        bdIssue: '',
        mangoTicket: '',
        handoverNote: h.handover,
        qcBy: qcMap['0'] ?? '',
        locked: isSignedOff && !h.reopened,
        reopened: isSignedOff && h.reopened,
        lockedBy: h.supervisor,
        lockedAt: signedAt,
        createdAt: stamp,
        updatedAt: stamp,
      });
    } else {
      // slots[0] already exists from the timeline loop — patch its
      // handover note in place so the canonical slot carries it.
      slots[0].handoverNote = h.handover;
      // Same for jobRequired — the per-status slot was created
      // first with jobRequired left blank, but the canonical totals
      // live on slot 0 by convention.
      slots[0].jobRequired = h.jobRequired;
      // CycleTime rides along on the canonical slot so a past-shift
      // review (synthetic order) can recompute Shift Target.
      slots[0].cycleTime = h.cycleTime;
      // And the reject total: the per-status loop initialises
      // rejectCount to 0. Only stamp the column total when there are NO
      // PMD_Rejects events — when events exist they are the source of
      // truth and populate per-slot rejectCount below (see slot-0 seed
      // comment above). This is what stops a stale Reject column from
      // shadowing the real event total on read.
      if (rejects.length === 0) slots[0].rejectCount = h.reject;
    }
    // Cavities MUST reach the canonical slot whichever way it was created:
    // every Good figure multiplies the tuple's gross by it (cavityGross),
    // so losing it silently halves a 2-cavity order. It used to be set only
    // in the branch above — the one that runs when the timeline already
    // filled slot 0 — so an order that started later in the shift (blank
    // 07:00, nothing to materialise slot 0) came back with cavities
    // undefined: 507381 on 550T 29/07 ran 10:00-12:00 with 2 cavities,
    // stored Good 212 in PMD_Production, and read back as 106 everywhere.
    slots[0].cavities = h.cavities;
    // Frozen-at-start Job Left / Shift Target ride on the canonical slot
    // so Trace can read demand-at-start per row. -1 sentinel = column
    // absent / never written (legacy or live-without-freeze rows); 0 is a
    // valid value ("job complete") so guard on >= 0, not truthiness.
    if (h.jobLeft >= 0) slots[0].jobLeft = h.jobLeft;
    if (h.shiftTarget >= 0) slots[0].shiftTarget = h.shiftTarget;
    // Planned start denormalised at sign-off: ride the canonical slot so
    // KPI Schedule Adherence and a re-sign-off (cache-first) can read it
    // after Epicor drops the order from planning.
    if (h.plannedStart) slots[0].plannedStart = h.plannedStart;
    // PMD_Rejects events take precedence (signed-off shifts), but for
    // live (unsigned) rows the events list is empty — fall back to the
    // RejectsBySlot JSON column on PMD_LiveStatus so other iPads see
    // the per-slot per-code breakdown without waiting for sign-off.
    if (rejects.length === 0 && h.rejectsBySlot) {
      let rbsMap: Record<string, Record<string, number>> = {};
      try {
        const parsed = JSON.parse(h.rejectsBySlot);
        if (parsed && typeof parsed === 'object') {
          rbsMap = parsed as Record<string, Record<string, number>>;
        }
      } catch {
        /* not JSON — ignore */
      }
      for (const [slotKey, codes] of Object.entries(rbsMap)) {
        const slotIdx = Number(slotKey);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= 16) continue;
        let target = slots.find((s) => s.slotIndex === slotIdx);
        if (!target) {
          // Reject logged on a slot that has no status set yet — give it
          // a placeholder row so the operator grid can render the count.
          target = {
            id: 0,
            machineCode: h.machineCode,
            shiftId,
            jobNumber: h.jobNumber,
            partNumber: h.partNumber,
            partDescription: h.partDescription,
            slotIndex: slotIdx,
            statusCode: '',
            countStart: null,
            countEnd: null,
            rejectCount: 0,
            rejects: '{}',
            purgeKg: null,
            operator: '',
            supervisor: '',
            bdIssue: '',
            mangoTicket: '',
            handoverNote: '',
            qcBy: '',
            locked: isSignedOff,
            lockedBy: h.supervisor,
            lockedAt: signedAt,
            createdAt: stamp,
            updatedAt: stamp,
          };
          slots.push(target);
        }
        let obj: Record<string, number> = {};
        try {
          obj = JSON.parse(target.rejects || '{}') as Record<string, number>;
        } catch {
          /* keep {} */
        }
        for (const [code, qty] of Object.entries(codes)) {
          const n = Number(qty);
          if (!n) continue;
          obj[code] = (obj[code] || 0) + n;
        }
        target.rejects = JSON.stringify(obj);
        target.rejectCount = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
      }
    }
    // Merge rejects into the canonical slot 0's `rejects` JSON, and per-slot
    // events into slot records when the Timeline cell matches.
    for (const ev of rejects) {
      const slotIdx = timelineToSlot(ev.timeline);
      const target = slots.find((s) => s.slotIndex === slotIdx) ?? slots[0];
      let obj: Record<string, number> = {};
      try {
        obj = JSON.parse(target.rejects || '{}') as Record<string, number>;
      } catch {
        /* keep {} */
      }
      obj[ev.code] = (obj[ev.code] || 0) + ev.qty;
      target.rejects = JSON.stringify(obj);
      target.rejectCount = Object.values(obj).reduce((a, v) => a + (Number(v) || 0), 0);
    }
    return slots;
  }

  async upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord> {
    // Cache live edit; do not write to SharePoint until sign-off.
    const key = this.cacheKey(record.machineCode, record.shiftId, record.jobNumber);
    const list = this.editCache.get(key) ?? [];
    const idx = list.findIndex((r) => r.slotIndex === record.slotIndex);
    const stored = { ...record, id: idx >= 0 ? list[idx].id || -1 : -(list.length + 1) };
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    this.editCache.set(key, list);
    // A local write makes this device an AUTHOR of the tuple: it may
    // mirror it outward and its copy wins the per-slot backfill merge.
    this.dirtyTuples.add(key);
    this.persistEditCache();
    return stored;
  }

  async deleteProductionRecord(id: number): Promise<void> {
    // Remove from cache. Persisted rows are deleted only via shift unlock.
    let mutated = false;
    for (const [key, list] of this.editCache) {
      const filtered = list.filter((r) => r.id !== id);
      if (filtered.length !== list.length) {
        this.editCache.set(key, filtered);
        mutated = true;
      }
    }
    if (mutated) this.persistEditCache();
  }

  /**
   * Sign off & Save (§5): flush every cached (machine, shiftId, job) tuple
   * to PMD_Production header + PMD_BreakDown analytic + PMD_Rejects events.
   */
  async lockShift(
    machineCode: string,
    shiftId: string,
    supervisor: string,
    operator: string,
    jobNumber?: string,
    /** Job Left as the operator UI computed it. FALLBACK ONLY: the JobLeft
     *  column is normally recomputed here from the production list itself
     *  (see the jobLeftSnap block); this value is used when that read
     *  fails and no frozen canonical value exists. */
    jobLeft?: number | null,
  ): Promise<void> {
    const date = shiftId.slice(0, 10);
    const shift = shiftId.slice(11);
    const ownKey = (job: string): string => this.cacheKey(machineCode, shiftId, job);
    const myTuples: ProductionRecord[][] = [];
    for (const [key, list] of this.editCache) {
      if (!key.startsWith(`${machineCode}|${shiftId}|`)) continue;
      // Sign-off is per (machine, shift, JOB): when the supervisor is
      // signing off SFM507006, an operator's in-progress SFM507057 on
      // the same press/shift must NOT be swept up and locked with it —
      // they're still filling the remaining timeline slots.
      if (jobNumber && key !== ownKey(jobNumber)) continue;
      myTuples.push(list);
    }
    if (myTuples.length === 0) {
      // Nothing in editCache for this (machine, shift[, job]) — there
      // is literally nothing to write. Crucially, do NOT push a
      // placeholder header here: upsertHeaderInto's MERGE-if-exists
      // path would PATCH a real PMD_Production row with all-blank
      // values, which is exactly the SFM507068 data-loss path we just
      // redesigned away. If the supervisor pressed Sign Off without
      // any local edits (e.g. on a freshly unlocked shift to confirm
      // "yes, the existing numbers are fine"), the existing row stays
      // as-is and the unlock flag clears below.
      this.unlockedTuples.delete(ownKey(jobNumber ?? ''));
      this.persistUnlockedTuples();
      return;
    }
    // Single planning lookup (per machine) for FALLBACK only. The
    // rehydrated editCache slots already carry the canonical
    // partNumber / partDescription that came back from the existing
    // signed-off row — those are the truth. Planning is consulted
    // only when the cache lacks them (fresh in-progress order).
    // Without this, a re-sign-off after unlock would overwrite the
    // header with whatever the CURRENT planning CSV says, and Epicor
    // drops completed orders from planning — blanking the
    // PartNum / Description columns on the existing row.
    const orders = await this.listPlanning({ machineCode });
    const partNumOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.partNumber)?.partNumber;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.partNumber ?? '';
    };
    const partDescOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.partDescription)?.partDescription;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.partDescription ?? '';
    };
    // The denormalised PMD_Production "JobRequired" column carries the order
    // total (Order Qty / JobHead_ProdQty), not the remaining qty — it exists
    // so the UI can show Order Qty after Epicor drops a completed order.
    const jobRequiredOf = (job: string, slots: ProductionRecord[]): number => {
      const fromCache = slots.find((s) => s.jobRequired && s.jobRequired > 0)?.jobRequired;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.orderQty ?? 0;
    };
    // Cycle time (hours/piece) — same cache-first, planning-fallback rule
    // as jobRequiredOf. Persisting it lets a past-shift review recompute
    // Shift Target after Epicor has dropped the order from planning.
    const cycleTimeOf = (job: string, slots: ProductionRecord[]): number => {
      const fromCache = slots.find((s) => s.cycleTime && s.cycleTime > 0)?.cycleTime;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.qtyPerHr ?? 0;
    };
    // Cavities frozen on the canonical slot by the operator UI; 1 when
    // absent. Multiplies the tuple's gross when computing Good / Job Left.
    const cavitiesOf = (slots: ProductionRecord[]): number => {
      const v = slots.find((s) => s.slotIndex === 0)?.cavities;
      return v && v > 0 ? v : 1;
    };
    // Planned start (JobHead_StartDate + StartHour) — same cache-first,
    // planning-fallback rule as jobRequiredOf. Persisting it is what lets
    // KPI Schedule Adherence see when a job was SCHEDULED after Epicor
    // drops the completed order from planning.
    const plannedStartOf = (job: string, slots: ProductionRecord[]): string => {
      const fromCache = slots.find((s) => s.plannedStart)?.plannedStart;
      if (fromCache) return fromCache;
      return orders.find((o) => o.jobNumber === job)?.plannedStart ?? '';
    };
    // Every job's slots on this (machine, shift) — the Shift Target
    // deduction needs the WHOLE press picture (a previous order's
    // footprint, a die-change pseudo-order's D block), not just the
    // tuple being signed. Blended read = the same signed+live+cache view
    // the operator side panel computed its target from, so the stamped
    // column matches what the sheet showed. On a read failure fall back
    // to this device's cached tuples for the shift rather than aborting
    // the sign-off.
    let shiftRows: ProductionRecord[];
    try {
      shiftRows = await this.listProduction({ machineCode, shiftId });
    } catch (e) {
      console.warn('[pmd] shift-wide read for Shift Target failed, using cache:', e);
      shiftRows = [];
      for (const [key, list] of this.editCache) {
        if (key.startsWith(`${machineCode}|${shiftId}|`)) shiftRows.push(...list);
      }
    }
    for (const slots of myTuples) {
      const job = slots[0]?.jobNumber ?? jobNumber ?? '';
      const agg = aggregateSlots(slots);
      const tag = `${machineCode}|${shiftId}|${job}`;
      const partNum = partNumOf(job, slots);
      const partDesc = partDescOf(job, slots);
      const required = jobRequiredOf(job, slots);
      // PMD_Rejects is the source of truth. agg.reject is by construction
      // Σ agg.rejectEvents (same loop), and those events are what
      // replaceRejectEvents writes below — so whenever per-slot detail
      // exists, the Reject column, RejectsBySlot and TotalGood all derive
      // from the SAME event set and cannot drift. The drift we hit on
      // SFM507067 (column 20 vs events 28) came from the READ path
      // blending a stale column total into slot 0; that is fixed in
      // expandHeaderToSlots, so a rehydrated re-sign-off now re-aggregates
      // the real events and self-heals the column.
      //
      // The `|| canon.rejectCount` fallback ONLY fires for a legacy row
      // that has a Reject column total but no PMD_Rejects events at all
      // (per-code detail destroyed by an old broken-unlock incident).
      // There is nothing to re-derive from, so preserving the surviving
      // total beats zeroing it — and since there are no events, the
      // column is still the only record, so this introduces no drift.
      const canon = slots.find((s) => s.slotIndex === 0);
      const reject = agg.reject || (canon?.rejectCount ?? 0);
      const cycleTime = cycleTimeOf(job, slots);
      const cavities = cavitiesOf(slots);
      // This tuple's own net Good — last-resort Job Left estimate below.
      const tupleGood = Math.max(
        0,
        ((agg.countEnd ?? 0) - (agg.countStart ?? 0)) * cavities - reject,
      );
      // Job Left column = pieces still needed when this shift BEGAN,
      // recomputed from SIGNED PMD_Production rows only — the one
      // source every device sees identically (JobRequired − Σ TotalGood
      // of earlier-started signed shifts, exactly reproducible from the
      // list itself). Client-side snapshots proved untrustable twice:
      // the frozen-at-start value inherits whatever junk the freezing
      // device could see (a stale PMD_LiveStatus shadow burned Job Left
      // 574/397 into SFM507147), and the old tuple-only fallback
      // ignored every other shift (the 1380 row). Live/editCache tuples
      // are deliberately EXCLUDED: an unsigned earlier shift simply
      // isn't counted until it signs off, and a re-sign-off after
      // unlock refreshes the column — corrections self-heal. Frozen
      // value → UI param → tuple-only estimate remain as fallbacks when
      // the list read itself fails.
      let jobLeftSnap: number | null = null;
      if (required > 0) {
        try {
          const allJob = await this.listSignedOffProduction({ jobNumber: job });
          const before = sumGoodStartedBefore(allJob, machineCode, shiftId);
          if (before != null) jobLeftSnap = Math.max(0, required - before);
        } catch (e) {
          console.warn('[pmd] JobLeft recompute failed, using frozen fallback:', e);
        }
      }
      if (jobLeftSnap == null) {
        jobLeftSnap =
          canon?.jobLeft != null
            ? Math.max(0, canon.jobLeft)
            : jobLeft != null
              ? Math.max(0, jobLeft)
              : Math.max(0, required - tupleGood);
      }
      // Shift Target column: recompute from the at-start Job Left (same
      // signed-rows source as jobLeftSnap) over the hours actually left
      // to this job — 8h minus other orders' recorded footprint on this
      // press/shift minus this job's own changeover slots (see
      // hoursUnavailableFor). A value stamped on the canonical slot is
      // legacy client-frozen data — contaminated by whatever that device
      // saw at freeze time — and is only used when the recompute
      // produced nothing.
      const shiftTargetSnap =
        shiftTargetFor(
          { qtyPerHr: cycleTime },
          jobLeftSnap,
          hoursUnavailableFor(shiftRows, job),
        ) ?? canon?.shiftTarget ?? null;
      // SharePoint has no multi-list transaction. Stage both child-list
      // replacements first and write the signed PMD_Production header LAST.
      // Each replacement returns a compensating rollback, so a later failure
      // restores the exact pre-sign-off rows instead of leaving a signed
      // header with missing/half-written analytic detail.
      let undoBreakdown: RollbackAction = async () => {};
      try {
        undoBreakdown =
          (await this.replaceBreakdownEvents(
          {
            machineCode,
            date,
            shift,
            jobNumber: job,
            partNumber: partNum,
            timeline: agg.timeline,
          },
          slots,
          )) ?? undoBreakdown;
      } catch (e) {
        throw new Error(`PMD_BreakDownlog write failed (${tag}): ${(e as Error).message}`);
      }
      let undoRejects: RollbackAction = async () => {};
      try {
        undoRejects =
          (await this.replaceRejectEvents(
            { machineCode, date, shift, jobNumber: job },
            agg.rejectEvents,
          )) ?? undoRejects;
      } catch (e) {
        const rollbackError = await runRollback(undoBreakdown);
        const suffix = rollbackError ? `; breakdown rollback also failed: ${rollbackError}` : '';
        throw new Error(`PMD_Rejects write failed (${tag}): ${(e as Error).message}${suffix}`);
      }
      try {
        await this.upsertProductionHeader({
          signOff: new Date().toISOString(),
          jobLeft: jobLeftSnap,
          // Re-lock: a fresh sign-off always clears any prior reopened flag.
          reopened: false,
          machineCode,
          date,
          shift,
          jobNumber: job,
          partNumber: partNum,
          partDescription: partDesc,
          jobRequired: required,
          cycleTime,
          cavities,
          plannedStart: plannedStartOf(job, slots),
          shiftTarget: shiftTargetSnap,
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject,
          operator: operator || agg.operator,
          supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
          qcChecks: agg.qcChecks,
          rejectsBySlot: agg.rejectsBySlot,
        });
      } catch (e) {
        const rejectRollbackError = await runRollback(undoRejects);
        const breakdownRollbackError = await runRollback(undoBreakdown);
        const rollbackErrors = [rejectRollbackError, breakdownRollbackError].filter(Boolean);
        const suffix = rollbackErrors.length
          ? `; detail rollback also failed: ${rollbackErrors.join('; ')}`
          : '';
        throw new Error(`PMD_Production write failed (${tag}): ${(e as Error).message}${suffix}`);
      }
      // Sweep the in-progress mirror so other iPads' Live Status drops
      // this row in favour of the new signed-off Production record on
      // their next poll. Best-effort — pushLiveSnapshot won't re-create
      // the row because lockShift also clears editCache below.
      await this.deleteLiveRow(machineCode, shiftId, job);
      // Late sign-off heal: if LATER shifts of this job signed first,
      // their JobLeft columns were computed without this shift's output
      // — bring the per-shift ledger back to exact. Best-effort: the
      // sign-off itself already succeeded, and the next sign-off of the
      // job retries any heal that fails here.
      await this.healLaterJobLeft(machineCode, shiftId, job, required).catch((e) => {
        console.warn('[pmd] JobLeft heal failed (next sign-off retries):', e);
      });
      const tupleKey = ownKey(job);
      this.editCache.delete(tupleKey);
      this.unlockedTuples.delete(tupleKey);
    }
    this.persistEditCache();
    this.persistUnlockedTuples();
  }

  /**
   * Push every unsigned editCache entry to **PMD_LiveStatus** as an
   * in-progress snapshot. Other iPads' Live Status reads PMD_LiveStatus
   * (alongside PMD_Production for signed-off rows) so the floor view
   * shows what's happening on every press without waiting for Sign
   * Off & Save.
   *
   * PMD_LiveStatus mirrors PMD_Production's column schema; lockShift
   * copies the row across and deletes it from here, so the two lists
   * never hold the same tuple simultaneously beyond a brief window.
   *
   * Called from the operator poll tick (every 60 s) and right after
   * multiFillApply so the new status pattern shows up immediately.
   * Fire-and-forget; a failure just means the live view is up-to-60-s
   * stale until the next tick succeeds.
   */
  /** Live-mirror health for the on-screen badge: is this device allowed
   *  to push, when did its last snapshot fully succeed, and what did the
   *  last failure say. */
  mirrorHealth(): { writable: boolean; okAt: number | null; failAt: number | null; error: string } {
    return {
      writable: this.canWriteHook(),
      okAt: this.lastMirrorOkAt,
      failAt: this.lastMirrorFailAt,
      error: this.lastMirrorError,
    };
  }

  setLiveGate(gate: (machineCode: string, shiftId: string, jobNumber: string) => boolean): void {
    this.liveGate = gate;
  }

  /**
   * Forget a tuple the worker never confirmed: drop its editCache entry +
   * authorship mark so the 60 s mirror can't re-broadcast it, and
   * best-effort delete any PMD_LiveStatus row an earlier tick already
   * pushed. This is the "unconfirmed cache is cleared" half of the
   * confirm flow — signed-off PMD_Production rows are never touched.
   */
  async discardUnconfirmedTuple(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<void> {
    const key = this.cacheKey(machineCode, shiftId, jobNumber);
    // An unlock-edit window holds REAL signed data rehydrated for
    // correction — never discard that, whatever the confirm registry says.
    if (this.unlockedTuples.has(key)) return;
    if (this.editCache.delete(key)) {
      this.dirtyTuples.delete(key);
      this.persistEditCache();
    }
    await this.deleteLiveRow(machineCode, shiftId, jobNumber);
  }

  async pushLiveSnapshot(): Promise<void> {
    if (this.editCache.size === 0) {
      // Nothing to push is a healthy state — the mirror loop ran.
      this.lastMirrorOkAt = Date.now();
      return;
    }
    // Reentrancy guard — see snapshotInFlightSince field comment. The
    // poll tick is fire-and-forget; without this, a slow tick stacks
    // onto the next one and saturates Safari's connection pool → freeze.
    const now = Date.now();
    if (this.snapshotInFlightSince != null) {
      if (now - this.snapshotInFlightSince < SharePointDataLayer.SNAPSHOT_STUCK_MS) return;
      console.warn('[pmd] live snapshot stuck for 5+ min (hung fetch?) — starting a fresh one');
    }
    this.snapshotInFlightSince = now;
    try {
      await this.pushLiveSnapshotInner();
    } finally {
      // Only clear our own claim: if the watchdog already let a newer
      // snapshot start, a late-settling hung run must not unlock it.
      if (this.snapshotInFlightSince === now) this.snapshotInFlightSince = null;
    }
  }

  private async pushLiveSnapshotInner(): Promise<void> {
    // PartNum lookup for the live mirror. Cached for 5 min so we don't
    // re-download the whole Planning CSV every 60 s — see
    // partNumByJobCache field comment.
    const partNumByJob = await this.getPartNumByJob();
    const now = new Date();
    let failures = 0;
    const tasks: Array<() => Promise<void>> = [];
    for (const [key, slots] of this.editCache) {
      if (slots.length === 0) continue;
      // ONLY tuples this device authored. A cache entry backfilled from
      // PMD_LiveStatus for viewing another press must never be
      // re-broadcast: a device that glanced at a shift once would
      // otherwise republish that stale copy every 60 s, overwriting the
      // editing iPad's fresh mirror (the Batt2 "full timeline collapsed
      // to one slot" echo loop).
      if (!this.dirtyTuples.has(key)) continue;
      // Skip cache entries that hold nothing but a freshly-picked
      // operator / supervisor name with no actual production data —
      // see hasMeaningfulProgress(). Avoids littering the broker with
      // empty rows every time someone picked the wrong job and
      // switched.
      if (!hasMeaningfulProgress(slots)) continue;
      const canon = slots.find((s) => s.slotIndex === 0) ?? slots[0];
      if (!canon) continue;
      const [machineCode, shiftId, jobNumber] = key.split('|');
      if (!machineCode || !shiftId || !jobNumber) continue;
      // Confirm gate: only a tuple the worker explicitly confirmed
      // ("this order really runs on this press, by these people") is
      // broadcast. Browse artefacts stay local until discarded.
      if (this.liveGate && !this.liveGate(machineCode, shiftId, jobNumber)) continue;
      // Never mirror a shift that is well over. PMD_LiveStatus is an
      // IN-PROGRESS board; an old un-signed-off tuple that is still
      // sitting in THIS device's localStorage editCache (e.g. an
      // abandoned 03/06 experiment, or a mis-tap from days ago) must
      // not be re-broadcast every 60 s poll tick. That re-broadcast is
      // exactly why rows deleted by hand from PMD_LiveStatus kept
      // reappearing: deleting the server row never touched the device
      // cache that recreated it. shiftEndedLongAgo also covers the
      // no-status junk, but the key win here is that it catches OLD
      // rows that DO carry status, which the listProduction junk
      // filter deliberately leaves alone.
      if (shiftEndedLongAgo(shiftId, now)) continue;
      // Read-only devices (PC viewer with no supervisor signed in)
      // never push. Without this gate a stale local cache on a viewer
      // would mirror straight back over the iPad's fresh data on every
      // poll. The device-class rule replaced per-device ownership
      // arbitration after the latter caused fights between iPads on
      // the floor.
      if (!this.canWriteHook()) continue;
      // OwnerDevice column still gets stamped with this device's id
      // (purely for after-the-fact diagnostics — "which iPad last
      // touched this press?"). No claim arbitration: every writable
      // device just overwrites.
      const ownerDevice = this.deviceId;
      const date = shiftId.slice(0, 10);
      const shift = shiftId.slice(11);
      const agg = aggregateSlots(slots);
      tasks.push(() =>
        this.upsertHeaderInto(LISTS.liveStatus, {
          machineCode,
          date,
          shift,
          jobNumber,
          partNumber: partNumByJob.get(jobNumber) ?? '',
          partDescription: '',
          // Order total when the cache knows it — lets another device
          // (or the Trace live board) rebuild a synthetic order for an
          // in-progress job even after Epicor drops it from planning.
          // upsertHeaderInto skips the column when this is 0.
          jobRequired: slots.find((s) => s.jobRequired && s.jobRequired > 0)?.jobRequired ?? 0,
          // Carry cycle time + cavities so a mid-shift reload (editCache
          // lost, rehydrate from PMD_LiveStatus) keeps them. Job Left /
          // Shift Target are deliberately NOT mirrored: they are derived
          // from signed PMD_Production rows on read now — mirroring the
          // old client-frozen snapshot is how a contaminated value
          // spread to every device (SFM507147's phantom "200").
          cycleTime: canon.cycleTime ?? 0,
          cavities: canon.cavities ?? 1,
          timeline: agg.timeline,
          countStart: agg.countStart,
          countEnd: agg.countEnd,
          reject: agg.reject,
          operator: canon.operator,
          supervisor: canon.supervisor,
          runTime: agg.runTime,
          downTime: agg.downTime,
          handover: agg.handover,
          qcChecks: agg.qcChecks,
          rejectsBySlot: agg.rejectsBySlot,
          ownerDevice,
        }).catch((e) => {
          // Snapshot push is best-effort; never propagate. Recorded for
          // the mirror-health badge so a silently-failing iPad is
          // visible on its own screen.
          failures++;
          this.lastMirrorError = `${key}: ${(e as Error)?.message ?? e}`;
          console.warn('[pmd] live snapshot push failed for', key, e);
        }),
      );
    }
    // Push in serial — each upsert is digest + GET-by-key + POST/PATCH
    // (3 round trips). With 5-10 jobs cached on a busy iPad, the old
    // Promise.all fired 15-30 requests at once, immediately hit
    // Safari's 6-connection-per-origin cap and queued the rest while
    // the main thread waited. Serial keeps the connection pool free
    // for the UI's own taps and reload(), at the cost of a slightly
    // longer total snapshot wall-clock — fine, this is a best-effort
    // background mirror, not a user-facing path.
    for (const t of tasks) await t();
    if (failures === 0) this.lastMirrorOkAt = Date.now();
    else this.lastMirrorFailAt = Date.now();
  }

  /**
   * 5-minute-TTL cache for the snapshot push's PartNum lookup. See
   * partNumByJobCache field comment for why this exists.
   */
  private async getPartNumByJob(): Promise<Map<string, string>> {
    const c = this.partNumByJobCache;
    if (c && c.expires > Date.now()) return c.value;
    const planning = await this.listPlanning({}).catch(() => [] as PlanningOrder[]);
    const m = new Map<string, string>();
    for (const o of planning) m.set(o.jobNumber, o.partNumber);
    this.partNumByJobCache = { value: m, expires: Date.now() + SharePointDataLayer.PART_NUM_CACHE_TTL_MS };
    return m;
  }

  async unlockShift(
    machineCode: string,
    shiftId: string,
    jobNumber?: string,
  ): Promise<void> {
    // Redesigned 2026-06-16 (SFM507068 incident): unlock is now
    // PURELY a client-side rehydrate + mark. The signed-off
    // PMD_Production / PMD_BreakDownlog / PMD_Rejects rows STAY on
    // the SharePoint side untouched. lockShift's upsertHeaderInto
    // already merges-if-exists, so the re-sign-off path PATCHes the
    // existing row by ID rather than POSTing a fresh one — original
    // PartNum, PartDescription, Counts, Timeline and Rejects survive
    // any abandonment, network failure, or planning-CSV ageing
    // (Epicor drops completed orders from planning, which the old
    // delete-then-rewrite path then wrote back as empty PartNum).
    //
    // The tuple is added to `unlockedTuples` so the listProduction
    // self-heal does not purge the editCache rows back out (PMD_
    // Production still carries the locked header so signedKeys would
    // otherwise match). lockShift clears the flag on successful
    // commit. The flag is persisted alongside editCache so a page
    // reload mid-edit doesn't strand the operator.
    const existing = await this.listProduction({
      machineCode,
      shiftId,
      ...(jobNumber ? { jobNumber } : {}),
    });
    // Authoritative server-side unlock: flip PMD_Production.Reopened = Yes on
    // the signed row(s) so EVERY device reads the same "reopened" state. This
    // is a single-field MERGE — it never deletes or rewrites the row's data,
    // so it carries none of the data-loss risk that retired the old
    // delete-then-rewrite unlock. The client rehydrate below still runs so the
    // unlocking device can edit immediately without waiting for a reload.
    const reopenJobs = new Set(existing.map((r) => r.jobNumber).filter(Boolean));
    for (const job of reopenJobs) {
      await this.setReopenedFlag(machineCode, shiftId, job, true).catch((e) => {
        console.warn('[unlock] setReopened failed (falling back to device-local):', e);
      });
    }
    let touchedAnyTuple = false;
    for (const r of existing) {
      const rehydrated: ProductionRecord = {
        ...r,
        locked: false,
        reopened: true,
        lockedBy: '',
        lockedAt: '',
      };
      const key = this.cacheKey(r.machineCode, r.shiftId, r.jobNumber);
      const list = this.editCache.get(key) ?? [];
      // Don't clobber any in-flight edits already in cache for the
      // same slot — `existing` may include unsigned slots when
      // listProduction also returns LiveStatus rows.
      if (!list.some((s) => s.slotIndex === r.slotIndex)) list.push(rehydrated);
      this.editCache.set(key, list);
      this.unlockedTuples.add(key);
      // The unlocking device is about to author corrections here.
      this.dirtyTuples.add(key);
      touchedAnyTuple = true;
    }
    this.persistEditCache();
    if (touchedAnyTuple) this.persistUnlockedTuples();
  }

  isUnlockedTuple(machineCode: string, shiftId: string, jobNumber: string): boolean {
    return this.unlockedTuples.has(this.cacheKey(machineCode, shiftId, jobNumber));
  }

  /**
   * Set PMD_Production.Reopened on the signed row(s) for a (machine, shift,
   * job) tuple — a minimal single-field MERGE that leaves every other column
   * untouched. Used by unlock (true) so all devices see the order as reopened.
   * Best-effort: if the Reopened column doesn't exist on the tenant,
   * postWithFieldRetry strips it and the caller falls back to device-local
   * unlock. Date is narrowed to the exact calendar day like upsertHeaderInto.
   */
  private async setReopenedFlag(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    value: boolean,
  ): Promise<void> {
    if (!this.F.production.reopened) return;
    await this.setProductionColumn(machineCode, shiftId, jobNumber, this.F.production.reopened, value);
  }

  /** Narrow single-column MERGE onto every PMD_Production row of a
   *  (machine, shift, job) tuple — deliberately NOT upsertHeaderInto,
   *  whose full-body MERGE can blank sibling columns. Used for the
   *  Reopened flag and the retroactive JobLeft heal. */
  private async setProductionColumn(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    field: string,
    value: unknown,
  ): Promise<void> {
    const F = this.F.production;
    const date = shiftId.slice(0, 10);
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${odataString(machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(shiftId.slice(11))}' and ${F.jobNumber} eq '${odataString(jobNumber)}'`,
      );
    const windowRows = await this.getAllItems<Record<string, unknown>>(LISTS.production, qs);
    const existing = windowRows.filter((r) => dateOnly(r[F.date]) === date);
    const idOf = (r: Record<string, unknown>): number | undefined =>
      (r as { ID?: number; Id?: number }).ID ?? (r as { ID?: number; Id?: number }).Id;
    for (const row of existing) {
      const id = idOf(row);
      if (id == null) continue;
      const body: Record<string, unknown> = {
        __metadata: { type: await this.itemType(LISTS.production) },
        [field]: value,
      };
      this.stripRejectedFields(LISTS.production, body);
      if (!(field in body)) return; // column already known-absent
      await this.postWithFieldRetry(
        LISTS.production,
        `${this.listUrl(LISTS.production)}/items(${id})`,
        body,
        '*',
      );
    }
  }

  /**
   * After a tuple signs off, re-derive the JobLeft column of every
   * LATER-started signed tuple of the same job. Sign-off order on the
   * floor is not chronological — Night regularly signs before a
   * forgotten Afternoon — and JobLeft means "pieces still needed when
   * the shift began" (order TOTAL − Σ good of earlier-started signed
   * shifts), so a late-arriving earlier shift must flow into the later
   * rows or the per-shift ledger the KPIs / Trace / next-shift Job Left
   * read stays overstated forever. Pure decision logic lives in
   * core/jobgood.retroJobLeftFixes; this just executes the MERGEs.
   * Best-effort: a failed heal is retried by the NEXT sign-off of the
   * same job (the recompute always walks the full list).
   */
  private async healLaterJobLeft(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
    required: number,
  ): Promise<void> {
    const F = this.F.production;
    if (!F.jobLeft || !(required > 0)) return;
    const all = await this.listSignedOffProduction({ jobNumber });
    const fixes = retroJobLeftFixes(all, machineCode, shiftId, required);
    for (const f of fixes) {
      console.info(
        `[pmd] JobLeft heal: ${f.machineCode}|${f.shiftId}|${jobNumber} → ${f.jobLeft} (late sign-off of ${shiftId})`,
      );
      await this.setProductionColumn(f.machineCode, f.shiftId, jobNumber, F.jobLeft, f.jobLeft);
    }
  }

  private async upsertProductionHeader(h: HeaderInput): Promise<void> {
    await this.upsertHeaderInto(LISTS.production, h);
  }

  private async upsertHeaderInto(
    list: string,
    h: HeaderInput,
  ): Promise<void> {
    const F = this.F.production;
    // F.date is a DateTime column. Stamp noon UTC of the shift's calendar
    // date so the SP list displays the right date in every regional setting
    // (see shiftDateMarker for why local-clock start was a bad anchor).
    // F.machine is mapped to Title, so writing [F.machine] populates Title
    // with the machine code (e.g. "Batt1") — no separate Machine column.
    const shiftId = `${h.date}-${h.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    const body: Record<string, unknown> = {
      __metadata: { type: await this.itemType(list) },
      [F.machine]: h.machineCode,
      [F.shift]: h.shift,
      [F.jobNumber]: h.jobNumber,
      [F.countStart]: h.countStart ?? null,
      [F.countEnd]: h.countEnd ?? null,
      [F.reject]: h.reject,
      [F.operator]: h.operator,
      [F.supervisor]: h.supervisor,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    // Optional columns: only write if the field map has a non-empty name,
    // otherwise SP rejects the whole POST with "property X does not exist".
    // The `MachineCode` column is repurposed to carry the 16-char status
    // timeline string — see DEFAULT_FIELDS.production for context.
    if (F.machineCodeAlt) body[F.machineCodeAlt] = h.timeline;
    if (F.timeline) body[F.timeline] = h.timeline;
    if (F.partNum) body[F.partNum] = h.partNumber;
    if (F.partDesc) body[F.partDesc] = h.partDescription;
    // Only write JobRequired when non-zero. 0 here usually means the
    // editCache had no rehydrated value (older rows pre-denormalisation)
    // — writing 0 over a real existing value via the MERGE path would
    // blank it. stripRejectedFields tolerates absence of the column.
    if (F.jobRequired && h.jobRequired > 0) body[F.jobRequired] = h.jobRequired;
    // CycleTime: only write a real rate. 0 means "unknown" (no planning
    // row + no cached value) — writing 0 via MERGE would blank a good
    // value, same rationale as JobRequired above.
    if (F.cycleTime && h.cycleTime > 0) body[F.cycleTime] = h.cycleTime;
    // ShiftTarget snapshot — write when we could compute one.
    if (F.shiftTarget && h.shiftTarget != null) body[F.shiftTarget] = h.shiftTarget;
    if (F.downTime) body[F.downTime] = h.downTime;
    if (F.runTime) body[F.runTime] = h.runTime;
    if (F.handover) body[F.handover] = formatHandover(h.handover);
    if (F.qcChecks) body[F.qcChecks] = h.qcChecks;
    if (F.rejectsBySlot) body[F.rejectsBySlot] = h.rejectsBySlot;
    // OwnerDevice (PMD_LiveStatus only). Only write a non-empty id —
    // never blank an existing owner via MERGE. PMD_Production has no such
    // column, but HeaderInput.ownerDevice is left undefined for it so
    // this is skipped anyway; stripRejectedFields covers any tenant that
    // hasn't added the column to the live list yet.
    if (F.ownerDevice && h.ownerDevice) body[F.ownerDevice] = h.ownerDevice;
    // Signoff (PMD_Production only). Only write when lockShift supplied a
    // timestamp — a live snapshot push leaves it undefined so the column
    // is never stamped on an in-progress row.
    if (F.signOff && h.signOff) body[F.signOff] = h.signOff;
    // JobLeft (PMD_Production only). Only write when lockShift supplied a
    // value — live snapshots leave it undefined so the column isn't
    // touched on an in-progress row. The 0 value is meaningful ("job
    // complete") so write it explicitly rather than skipping like the
    // jobRequired guard does.
    if (F.jobLeft && h.jobLeft != null) body[F.jobLeft] = h.jobLeft;
    // Reopened (PMD_Production only). Written explicitly on sign-off (false,
    // re-locks the row) and unlock (true). undefined on live pushes leaves
    // the column untouched.
    if (F.reopened && h.reopened !== undefined) body[F.reopened] = h.reopened;
    // PlannedStart (PMD_Production only). Only write a known value —
    // never blank an existing one via MERGE when planning has since
    // dropped the order.
    if (F.plannedStart && h.plannedStart) body[F.plannedStart] = h.plannedStart;
    // Cavities: write only when > 1 (a real multi-cavity die). 1 is the
    // default, and writing 1 via MERGE is harmless but pointless; skipping
    // also means a tenant without the column never trips stripRejected.
    const cavities = h.cavities && h.cavities > 0 ? h.cavities : 1;
    if (F.cavities && cavities > 1) body[F.cavities] = cavities;
    if (F.totalGood) {
      const cs = h.countStart;
      const ce = h.countEnd;
      // Actual Good = cycles × cavities − rejects (rejects are counted as
      // actual parts, not cycles, so they are not multiplied).
      const good =
        cs != null && ce != null ? Math.max(0, (ce - cs) * cavities - h.reject) : 0;
      body[F.totalGood] = good;
    }
    // SharePoint rejects C0/C1 control characters (NUL, etc.) in text
    // columns with a generic 500 "Invalid text value. A text field
    // contains invalid data." that doesn't say WHICH column. Strip them
    // out of every string value in the body so a stray paste from
    // Excel/Epicor or a zero-width oddity in a handover note can't fail
    // the whole sign-off. Whitespace (\t \n \r) is preserved.
    sanitizeBodyStrings(body);
    // PMD_LiveStatus was rebuilt by the user to mirror PMD_Production's
    // schema, but they may not have added every column yet (e.g.
    // JobHead_PartNum). Strip any fields previously rejected by SP for
    // this list so the rest of the row still lands.
    this.stripRejectedFields(list, body);
    // Find existing by composite key; MERGE if found, else POST. The
    // fetch uses the ±1d window for legacy-timestamp tolerance, but the
    // MERGE target must then be narrowed to the EXACT calendar date —
    // the window also matches the same shift code on adjacent days
    // (same job running Day shift on consecutive days is normal), and
    // merging into yesterday's row destroys yesterday's signed-off
    // record while leaving today unreadable.
    const qs =
      '$filter=' +
      encodeURIComponent(
        `${F.machine} eq '${odataString(h.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(h.shift)}' and ${F.jobNumber} eq '${odataString(h.jobNumber)}'`,
      );
    const windowRows = await this.getAllItems<Record<string, unknown>>(list, qs);
    const existing = windowRows
      .filter((r) => dateOnly(r[F.date]) === h.date)
      .sort((a, b) => (sharePointItemId(a) ?? Number.MAX_SAFE_INTEGER) - (sharePointItemId(b) ?? Number.MAX_SAFE_INTEGER));
    const idOf = (r: Record<string, unknown>): number | undefined =>
      (r as { ID?: number; Id?: number }).ID ?? (r as { ID?: number; Id?: number }).Id;
    const target =
      existing.length > 0
        ? `${this.listUrl(list)}/items(${idOf(existing[0])})`
        : `${this.listUrl(list)}/items`;
    const ifMatch = existing.length > 0 ? '*' : undefined;
    await this.postWithFieldRetry(list, target, body, ifMatch);
    // Re-read AFTER the write. Cleaning only the pre-write snapshot misses
    // the exact race that creates duplicates: two iPads both read zero rows,
    // then both POST. Every writer deterministically keeps the lowest ID, so
    // concurrent cleanups converge on the same canonical row.
    try {
      const afterWindow = await this.getAllItems<Record<string, unknown>>(list, qs);
      const after = afterWindow
        .filter((r) => dateOnly(r[F.date]) === h.date)
        .sort(
          (a, b) =>
            (sharePointItemId(a) ?? Number.MAX_SAFE_INTEGER) -
            (sharePointItemId(b) ?? Number.MAX_SAFE_INTEGER),
        );
      if (after.length > 1) {
        console.warn(
          '[pmd] collapsing',
          after.length - 1,
          'duplicate row(s) on',
          list,
          'for',
          `${h.machineCode}|${shiftId}|${h.jobNumber}`,
        );
        for (const dup of after.slice(1)) {
          const id = idOf(dup);
          if (id == null) continue;
          await this.del(`${this.listUrl(list)}/items(${id})`).catch((e) => {
            console.warn('[pmd] duplicate-row delete failed (will retry next sign-off):', e);
          });
        }
      }
    } catch (e) {
      // The row itself is already written. Treat convergence as best-effort;
      // the next writer repeats this post-write check.
      console.warn('[pmd] post-write duplicate check failed (next write retries):', e);
    }
  }

  /** Per-list cache of column internal names that SP has already
   *  rejected with "property X does not exist". upsertHeaderInto strips
   *  these before posting so a missing column on the broker list
   *  doesn't doom every snapshot. */
  private rejectedFields = new Map<string, Set<string>>();

  /** Fields that are denormalised conveniences or backwards-compatible
   *  extensions. These may be omitted on an older tenant without changing
   *  the tuple's identity or its authoritative counts. Core key/count fields
   *  are intentionally absent: silently dropping one of those would turn a
   *  successful-looking sign-off into corrupted production data. */
  private isFailSoftHeaderField(list: string, field: string): boolean {
    if (list !== LISTS.production && list !== LISTS.liveStatus) return false;
    const F = this.F.production;
    return new Set<string>([
      F.machineCodeAlt,
      F.timeline,
      F.partNum,
      F.partDesc,
      F.jobRequired,
      F.cycleTime,
      F.shiftTarget,
      F.cavities,
      F.runTime,
      F.downTime,
      F.handover,
      F.totalGood,
      F.qcChecks,
      F.rejectsBySlot,
      F.ownerDevice,
      F.signOff,
      F.jobLeft,
      F.reopened,
      F.plannedStart,
    ].filter(Boolean)).has(field);
  }

  private stripRejectedFields(list: string, body: Record<string, unknown>): void {
    const banned = this.rejectedFields.get(list);
    if (!banned) return;
    for (const k of banned) {
      if (this.isFailSoftHeaderField(list, k)) delete body[k];
    }
  }

  /** POST that retries on two SP errors we can recover from:
   *   - 400 "property X does not exist" — column missing on tenant; remember
   *     it so future writes to this list skip it.
   *   - 500 "Invalid text value. A text field contains invalid data." — SP
   *     doesn't say WHICH column. Bisect by retrying without each text
   *     field one at a time so the next sign-off doesn't see the same
   *     blocking failure, and log the offender so the operator can clean
   *     up the source value (usually a stray paste into a handover note).
   *     The retry without the offender lets the rest of the row land.
   */
  private async postWithFieldRetry(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch?: string,
  ): Promise<void> {
    // Iterative, NOT single-shot: one sign-off body can carry SEVERAL broken
    // fields at once (reported on 550T: a missing Cavities column AND a
    // mistyped Reopened column in the same POST). The old code stripped one
    // offender then bare-posted — the second error escaped and failed the
    // whole sign-off. Loop instead, handling one offender per pass; the bound
    // is the theoretical max of strippable fields, and any non-recoverable
    // error still throws immediately.
    const work = { ...body };
    // Strip a missing-property offender named in an SP error message.
    // Returns true when a field was stripped (caller loops for another pass).
    const stripMissing = (msg: string): boolean => {
      const missing = /property\s+'?([A-Za-z0-9_]+)'?\s+does not exist/i.exec(msg);
      if (!missing || !(missing[1] in work)) return false;
      const field = missing[1];
      if (!this.isFailSoftHeaderField(list, field)) return false;
      const banned = this.rejectedFields.get(list) ?? new Set<string>();
      banned.add(field);
      this.rejectedFields.set(list, banned);
      console.warn(
        '[pmd] SP rejected column',
        field,
        'on',
        list,
        '— stripping it from future writes. Add the column in SharePoint to persist this value.',
      );
      delete work[field];
      return true;
    };
    const maxPasses = Object.keys(work).length;
    for (let pass = 0; pass < maxPasses; pass++) {
      try {
        await this.post(url, work, ifMatch);
        return;
      } catch (e) {
        const msg = (e as Error).message || '';
        if (stripMissing(msg)) continue;
        try {
          if (/Invalid text value/i.test(msg)) {
            // The bisect posts the winning trial itself — on success the row
            // has already landed, so return rather than posting again (a
            // second POST on the create path would make a duplicate row).
            const culprit = await this.findInvalidTextField(list, url, work, ifMatch);
            if (culprit) return;
          }
          // 400 "Cannot convert a primitive value to the expected type
          // 'Edm.String'" — a boolean/number written to a column SharePoint
          // has typed as text (e.g. a Reopened column created as Single line
          // of text / Choice instead of Yes/No). Same bisect-and-land pattern.
          if (/convert a primitive value to the expected type/i.test(msg)) {
            const culprit = await this.findMistypedPrimitiveField(list, url, work, ifMatch);
            if (culprit !== null) return;
          }
        } catch (inner) {
          // A bisect trial hit a DIFFERENT error class. If it named a missing
          // property, strip it and take another pass (one body can carry a
          // missing column AND a mistyped column at once — the 550T case);
          // anything else is non-recoverable.
          if (stripMissing((inner as Error).message || '')) continue;
          throw inner;
        }
        throw e;
      }
    }
    throw new Error(`${list}: POST kept failing after stripping every strippable field`);
  }

  /** Bisect the boolean/number fields to find the one whose SharePoint column
   *  is typed as text (Edm.String) — usually a Yes/No column accidentally
   *  provisioned as Single line of text / Choice. Bans it (future writes skip
   *  it) and posts the row without it so the sign-off lands. Booleans first —
   *  they're the newest, rarest columns (Reopened) and the most likely victim
   *  of a wrong type pick; numeric columns have been written for ages. Returns
   *  the offender, or null if removing none helps (caller re-throws). */
  private async findMistypedPrimitiveField(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch: string | undefined,
  ): Promise<string | null> {
    const keys = Object.keys(body)
      .filter(
        (k) =>
          k !== '__metadata' &&
          this.isFailSoftHeaderField(list, k) &&
          (typeof body[k] === 'boolean' || typeof body[k] === 'number'),
      )
      .sort((a, b) => Number(typeof body[b] === 'boolean') - Number(typeof body[a] === 'boolean'));
    for (const k of keys) {
      const trial = { ...body };
      delete trial[k];
      try {
        await this.post(url, trial, ifMatch);
        const banned = this.rejectedFields.get(list) ?? new Set<string>();
        banned.add(k);
        this.rejectedFields.set(list, banned);
        console.warn(
          `[pmd] SP rejected a ${typeof body[k]} written to column '${k}' on ${list} — that column is typed as text, not ${typeof body[k] === 'boolean' ? 'Yes/No' : 'Number'}. Fix the '${k}' column type in SharePoint. Posted the row without it so the sign-off lands.`,
        );
        return k;
      } catch (e) {
        if (!/convert a primitive value to the expected type/i.test((e as Error).message || '')) throw e;
      }
    }
    return null;
  }

  /** Bisect the string-valued fields of a SP body to find the one that
   *  triggers "Invalid text value". Returns the offending field name and
   *  leaves the row written (minus that field) on success — or null if
   *  removing none of them helps (in which case the caller re-throws the
   *  original error). Stops as soon as one removal succeeds. Order:
   *  longest values first, since the most common cause is a JSON payload
   *  (QualityChecks, RejectsBySlot) overflowing a column that was
   *  accidentally provisioned as Single line text (255-char limit). */
  private async findInvalidTextField(
    list: string,
    url: string,
    body: Record<string, unknown>,
    ifMatch: string | undefined,
  ): Promise<string | null> {
    const textKeys = Object.keys(body)
      .filter(
        (k) =>
          k !== '__metadata' &&
          this.isFailSoftHeaderField(list, k) &&
          typeof body[k] === 'string' &&
          (body[k] as string).length > 0,
      )
      .sort((a, b) => (body[b] as string).length - (body[a] as string).length);
    for (const k of textKeys) {
      const trial = { ...body };
      delete trial[k];
      try {
        await this.post(url, trial, ifMatch);
        const val = body[k] as string;
        const lengthHint =
          val.length > 255
            ? ` — value is ${val.length} chars, which exceeds SharePoint's Single line text 255-char limit. Change the '${k}' column to "Multiple lines of text" in SharePoint to persist this.`
            : ` — value contains a character SharePoint refuses (control char / line separator). Clear and retype this field.`;
        console.warn(
          `[pmd] SP rejected text value in column '${k}' on ${list}${lengthHint} Posted the row without it so the rest of the sign-off lands. value=${JSON.stringify(val)}`,
        );
        return k;
      } catch (e) {
        if (!/Invalid text value/i.test((e as Error).message || '')) throw e;
      }
    }
    return null;
  }

  /**
   * Delete every PMD_LiveStatus row matching this (machine, shift,
   * job) tuple. Called at the end of lockShift so the just-signed-off
   * tuple no longer haunts every iPad's Live Status view as an
   * "in-progress" snapshot. Best-effort: a failure leaves a stale row
   * which the next pushLiveSnapshot from anywhere would just refresh,
   * so we surface but don't throw.
   */
  private async deleteLiveRow(
    machineCode: string,
    shiftId: string,
    jobNumber: string,
  ): Promise<void> {
    const F = this.F.production;
    const shift = shiftId.slice(11);
    try {
      await this.deleteByFilter(
        LISTS.liveStatus,
        `${F.machine} eq '${odataString(machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(shift)}' and ${F.jobNumber} eq '${odataString(jobNumber)}'`,
        { field: F.date, date: shiftId.slice(0, 10) },
      );
    } catch (e) {
      console.warn('[pmd] live row cleanup failed for', { machineCode, shiftId, jobNumber }, e);
    }
  }

  /**
   * Per-shift PMD_BreakDownlog write — one row per (machine, shift, job).
   * StatusTimeline is the 16-char string ("RRRBBBCCCRRRRRRR") so the whole
   * shift's status pattern is recoverable from a single row. R/B/C/D/I/M/
   * O/P/S columns are the per-status hour totals (slot count × 0.5h).
   * BDCode = the most frequent breakdown code among the B slots (the
   * dominant cause). Row count stays tiny — one per signed-off shift+job.
   */
  private async replaceBreakdownEvents(
    key: {
      machineCode: string;
      date: string;
      shift: string;
      jobNumber: string;
      partNumber: string;
      timeline: string;
    },
    slots: ProductionRecord[],
  ): Promise<RollbackAction> {
    const F = this.F.breakdown;
    const shiftId = `${key.date}-${key.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    // Count per-status slots across the whole shift; each slot = 0.5h.
    const counts: Record<StatusCode, number> = {
      R: 0, B: 0, C: 0, D: 0, I: 0, M: 0, O: 0, P: 0, S: 0,
    };
    const bdTally: Record<string, number> = {};
    for (const r of slots) {
      const c = r.statusCode as StatusCode | '';
      if (c && c in counts) counts[c as StatusCode] += 1;
      if (c === 'B' && r.bdIssue) bdTally[r.bdIssue] = (bdTally[r.bdIssue] ?? 0) + 1;
    }
    const dominantBd = Object.keys(bdTally).sort(
      (a, b2) => bdTally[b2] - bdTally[a],
    )[0] ?? '';
    const body: Record<string, unknown> = {
      [F.machine]: key.machineCode,
      [F.shift]: key.shift,
      [F.jobNum]: key.jobNumber,
      [F.partNum]: key.partNumber,
      [F.statusTimeline]: key.timeline,
      [F.bdCode]: dominantBd,
      [F.r]: counts.R * 0.5,
      [F.b]: counts.B * 0.5,
      [F.c]: counts.C * 0.5,
      [F.d]: counts.D * 0.5,
      [F.i]: counts.I * 0.5,
      [F.m]: counts.M * 0.5,
      [F.o]: counts.O * 0.5,
      [F.p]: counts.P * 0.5,
      [F.s]: counts.S * 0.5,
    };
    if (slotStartIso) body[F.date] = slotStartIso;
    return this.replaceRowsWithRollback(
      LISTS.breakdown,
      `${F.machine} eq '${odataString(key.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(key.shift)}' and ${F.jobNum} eq '${odataString(key.jobNumber)}'`,
      { field: F.date, date: key.date },
      [body],
      [
        F.machine, F.date, F.shift, F.jobNum, F.partNum, F.statusTimeline, F.bdCode,
        F.r, F.b, F.c, F.d, F.i, F.m, F.o, F.p, F.s,
      ],
    );
  }

  private async replaceRejectEvents(
    key: { machineCode: string; date: string; shift: string; jobNumber: string },
    events: RejectEvent[],
  ): Promise<RollbackAction> {
    const F = this.F.rejects;
    const shiftId = `${key.date}-${key.shift}`;
    const slotStartIso = shiftDateMarker(shiftId);
    const bodies = events.map((ev) => {
      const body: Record<string, unknown> = {
        // F.machine is mapped to Title; setting it populates Title with the
        // machine code. No separate Machine column exists.
        [F.machine]: key.machineCode,
        [F.shift]: key.shift,
        [F.timeline]: ev.timeline,
        [F.jobNum]: key.jobNumber,
        [F.rejectCode]: ev.code,
        [F.rejectCategory]: ev.category,
        [F.rejectNumber]: ev.qty,
      };
      if (slotStartIso) body[F.date] = slotStartIso;
      return body;
    });
    return this.replaceRowsWithRollback(
      LISTS.rejects,
      `${F.machine} eq '${odataString(key.machineCode)}' and (${shiftDateRange(shiftId, F.date)}) and ${F.shift} eq '${odataString(key.shift)}' and ${F.jobNum} eq '${odataString(key.jobNumber)}'`,
      { field: F.date, date: key.date },
      bodies,
      [
        F.machine, F.date, F.shift, F.timeline, F.jobNum,
        F.rejectCode, F.rejectCategory, F.rejectNumber,
      ],
    );
  }

  /**
   * Replace a tuple's child rows without the old delete-first data-loss
   * window. New rows are fully inserted before any old row is removed.
   * The returned compensating action restores the original snapshot, which
   * lets lockShift emulate an atomic multi-list sign-off around SharePoint's
   * otherwise independent REST writes.
   */
  private async replaceRowsWithRollback(
    list: string,
    filterClause: string,
    exactDate: { field: string; date: string },
    bodies: Record<string, unknown>[],
    restoreFields: string[],
  ): Promise<RollbackAction> {
    const readExactRows = async (): Promise<Record<string, unknown>[]> => {
      const rows = await this.getAllItems<Record<string, unknown>>(
        list,
        '$filter=' + encodeURIComponent(filterClause),
      );
      return rows.filter((r) => dateOnly(r[exactDate.field]) === exactDate.date);
    };
    const oldRows = await readExactRows();
    const oldIds = new Set(oldRows.map(sharePointItemId).filter((id): id is number => id != null));
    const createdIds: number[] = [];
    const deletedOldRows: Record<string, unknown>[] = [];
    const type = await this.itemType(list);
    const itemsUrl = `${this.listUrl(list)}/items`;

    const createAndRemember = async (body: Record<string, unknown>): Promise<void> => {
      const response = await this.post(itemsUrl, { __metadata: { type }, ...body });
      let id = await responseItemId(response);
      // Verbose OData normally returns d.ID. Some SharePoint proxies strip
      // the response body; in that case re-read the tuple and identify the
      // newly-created ID so rollback remains possible.
      if (id == null) {
        const known = new Set([...oldIds, ...createdIds]);
        const candidates = (await readExactRows())
          .map(sharePointItemId)
          .filter((candidate): candidate is number => candidate != null && !known.has(candidate))
          .sort((a, b) => b - a);
        id = candidates[0];
      }
      if (id == null) {
        throw new Error(`${list}: create succeeded but SharePoint returned no item ID for rollback`);
      }
      createdIds.push(id);
    };

    const restore = async (rows: Record<string, unknown>[]): Promise<void> => {
      const failures: string[] = [];
      for (const row of rows) {
        const body: Record<string, unknown> = { __metadata: { type } };
        for (const field of restoreFields) {
          if (field && Object.prototype.hasOwnProperty.call(row, field)) body[field] = row[field];
        }
        try {
          await this.post(itemsUrl, body);
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
      if (failures.length) throw new Error(failures.join('; '));
    };

    const compensate = async (rowsToRestore: Record<string, unknown>[]): Promise<void> => {
      const failures: string[] = [];
      for (const id of createdIds) {
        try {
          await this.del(`${itemsUrl}(${id})`);
        } catch (e) {
          failures.push(`delete new ${id}: ${(e as Error).message}`);
        }
      }
      try {
        await restore(rowsToRestore);
      } catch (e) {
        failures.push(`restore old rows: ${(e as Error).message}`);
      }
      if (failures.length) throw new Error(failures.join('; '));
    };

    try {
      for (const body of bodies) await createAndRemember(body);
      for (const row of oldRows) {
        const id = sharePointItemId(row);
        if (id == null) throw new Error(`${list}: existing row has no item ID`);
        await this.del(`${itemsUrl}(${id})`);
        deletedOldRows.push(row);
      }
    } catch (e) {
      const rollbackError = await runRollback(() => compensate(deletedOldRows));
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : '';
      throw new Error(`${(e as Error).message}${suffix}`);
    }

    return async (): Promise<void> => compensate(oldRows);
  }

  /**
   * Delete every item matching a pre-built OData $filter clause.
   * `exactDate` narrows the (intentionally loose, ±1d) date-window
   * clause to rows on one exact calendar date — without it, deletes
   * scoped by shiftDateRange also hit the same shift code on adjacent
   * days (e.g. unlocking 10 June Day would wipe 9 June Day for the
   * same job). The compare runs through dateOnly so all three legacy
   * timestamp formats (midnight-UTC, noon-UTC, local-start) resolve
   * to their intended calendar date first.
   */
  private async deleteByFilter(
    list: string,
    filterClause: string,
    exactDate?: { field: string; date: string },
  ): Promise<void> {
    const rows = await this.getAllItems<Record<string, unknown>>(
      list,
      '$filter=' + encodeURIComponent(filterClause),
    );
    const targets = exactDate
      ? rows.filter((r) => dateOnly(r[exactDate.field]) === exactDate.date)
      : rows;
    for (const r of targets) {
      const id = (r as { ID?: number; Id?: number }).ID ?? (r as { ID?: number; Id?: number }).Id;
      await this.del(`${this.listUrl(list)}/items(${id})`);
    }
  }


  async whoAmI(): Promise<UserContext> {
    const res = await this.getJson<{
      d: { Title: string; Email: string; LoginName: string };
    }>(`${this.siteUrl}/_api/web/currentUser`);
    return { name: res.d.Title || res.d.Email || res.d.LoginName, role: 'operator' };
  }

  // ---- diagnostics ---------------------------------------------------

  /**
   * Print the internal field names of every PMD list to console. Run this
   * once in the browser console (`dal.diagnoseFields()`) to verify the
   * FIELD_MAP guesses match your tenant; copy any mismatches into a
   * `fieldMap` override at construction time.
   */
  async diagnoseFields(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const title of Object.values(LISTS)) {
      try {
        const res = await this.getJson<{
          d: { results: { Title: string; InternalName: string; Hidden: boolean }[] };
        }>(
          `${this.listUrl(title)}/fields?$filter=Hidden eq false&$select=Title,InternalName,Hidden`,
        );
        out[title] = res.d.results.map((f) => `${f.InternalName} (${f.Title})`);
      } catch (e) {
        out[title] = [`<error: ${(e as Error).message}>`];
      }
    }
    // eslint-disable-next-line no-console
    console.table(out);
    return out;
  }
}

// ---- helpers ---------------------------------------------------------

function mergeFieldMap(base: SharePointFieldMap, override?: PartialFieldMap): SharePointFieldMap {
  if (!override) return base;
  const out = { ...base } as SharePointFieldMap;
  for (const k of Object.keys(override) as Array<keyof SharePointFieldMap>) {
    const merged = { ...(base[k] as Record<string, string>), ...(override[k] as Record<string, string>) };
    (out[k] as Record<string, string>) = merged;
  }
  return out;
}

/** Build a value-descending ParetoSlice[] from a code→value tally. */
function paretoFrom(
  tally: Map<string, number>,
  labelFor: (code: string) => string,
  byShiftFor?: (code: string) => Record<ShiftCode, number> | undefined,
  byStatusFor?: (
    code: string,
  ) => Partial<Record<StatusCode | 'Unknown', number>> | undefined,
): ParetoSlice[] {
  return Array.from(tally.entries())
    .map(([code, value]) => {
      const slice: ParetoSlice = { code, label: labelFor(code), value: +value.toFixed(2) };
      const bs = byShiftFor?.(code);
      if (bs) slice.byShift = bs;
      const status = byStatusFor?.(code);
      if (status) slice.byStatus = status;
      return slice;
    })
    .sort((a, b) => b.value - a.value);
}

function rejectMachineStatus(value: string): StatusCode | 'Unknown' {
  const code = value.trim().toUpperCase();
  return code === 'R' ||
    code === 'B' ||
    code === 'C' ||
    code === 'D' ||
    code === 'I' ||
    code === 'M' ||
    code === 'O' ||
    code === 'P' ||
    code === 'S'
    ? code
    : 'Unknown';
}

function getId(r: Record<string, unknown>): number {
  const v = (r as { ID?: number; Id?: number }).ID ?? (r as { Id?: number }).Id;
  return typeof v === 'number' ? v : 0;
}

/** Escape a value inside an OData single-quoted string literal. URL
 * encoding happens afterwards and does not escape apostrophes by itself. */
export function odataString(value: string): string {
  return value.replace(/'/g, "''");
}

function sharePointItemId(r: Record<string, unknown>): number | null {
  const id = (r as { ID?: unknown; Id?: unknown }).ID ?? (r as { Id?: unknown }).Id;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function responseItemId(response: Response | undefined): Promise<number | null> {
  if (!response) return null;
  try {
    const payload = (await response.json()) as {
      ID?: unknown;
      Id?: unknown;
      d?: { ID?: unknown; Id?: unknown };
    };
    const id = payload.d?.ID ?? payload.d?.Id ?? payload.ID ?? payload.Id;
    const n = Number(id);
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // Some proxies return an empty 201 body. Fall through to Location.
  }
  const location = response.headers?.get('Location') ?? '';
  const match = /items\((\d+)\)/i.exec(location);
  return match ? Number(match[1]) : null;
}

async function runRollback(action: RollbackAction): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (e) {
    return (e as Error).message || String(e);
  }
}

// PMD_DieMaintenance stores lifecycle fields as plain text (people also
// edit the list directly in SharePoint), and the Mango mirror feeds the
// same readers its stage/type vocabulary — so normalise whatever's in
// the cell back onto the app's closed unions instead of trusting it.
function normaliseMaintStatus(raw: string): MaintStatus {
  const s = raw.trim().toLowerCase();
  // Mango: "Stage 4 Closed" → done · "Stage 2 Being Investigated" /
  // "Stage 3 Coordinator Reviewing" → in-progress · "Stage 1
  // Coordinator Assessing" (just raised) → open.
  if (/closed|complete|done/.test(s)) return 'done';
  if (/^in|investigat|review|started|wip|progress/.test(s)) return 'in-progress';
  return 'open';
}
function normaliseMaintType(raw: string): MaintType {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('clean')) return 'cleaning';
  // Mango's "3. Preventive Maintenance" / "1. Calibration" are check-ups.
  if (/inspect|preventive|calibrat/.test(s)) return 'inspection';
  if (/repair|fix|breakdown/.test(s)) return 'repair';
  return s ? 'other' : 'other';
}
function normaliseMaintPriority(raw: string): MaintPriority {
  const s = raw.trim().toLowerCase();
  if (s === 'low') return 'low';
  if (s === 'high') return 'high';
  if (s === 'urgent' || s === 'critical') return 'urgent';
  return 'normal';
}

function str(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Coerce a SP "HexColor" cell into a CSS-ready string. Accepts
 *  "#1e3a8a", "1e3a8a", "1E3A8A"; rejects anything that doesn't look
 *  like a 6-digit (or 3-digit) hex so a typo can't pollute inline
 *  styles. Returns '' when invalid. */
function normaliseHex(raw: string): string {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  return '';
}

/**
 * Best-effort resolver for the PMD_ProductDieColor.DieNumber column's
 * SharePoint internal name. SP frequently differs from the display name:
 * a column added as "Die Number" lands as `Die_x0020_Number`; "Die#"
 * becomes `Die_x0023_`. Probe the configured default first, then a small
 * set of common variants, then a regex sweep over the actual row keys.
 * Returns the first key on `row` that resolves to anything (truthy
 * preferred, but null/empty is acceptable to lock in the column choice).
 */
function resolveDieNumberKey(
  row: Record<string, unknown>,
  configured: string | undefined,
): string | null {
  const candidates = [
    configured,
    'DieNumber',
    'Die_x0020_Number',
    'Die_Number',
    'DieNo',
    'DieNum',
    'Die_x0023_',
  ].filter((s): s is string => !!s);
  // First pass: prefer a candidate whose row value is non-empty.
  for (const k of candidates) {
    if (k in row && str(row[k]).trim()) return k;
  }
  // Second pass: configured key exists at all (even if blank on this row).
  for (const k of candidates) {
    if (k in row) return k;
  }
  // Third pass: scan ALL row keys for any "die*num" pattern. Skips
  // anything starting with FieldValuesAsText / OData metadata.
  const fallback = Object.keys(row).find((k) => /^die.*num/i.test(k));
  return fallback ?? null;
}

/** Same variant-tolerant resolution for the `Die` DESCRIPTION column
 *  (the tool's human name). Kept separate from resolveDieNumberKey so a
 *  "Die Number" column can never be mistaken for the description. */
function resolveDieDescKey(
  row: Record<string, unknown>,
  configured: string | undefined,
): string | null {
  const candidates = [
    configured,
    'Die',
    'DieName',
    'Die_x0020_Name',
    'DieDescription',
    'Die_x0020_Description',
  ].filter((s): s is string => !!s);
  for (const k of candidates) {
    if (k in row && str(row[k]).trim()) return k;
  }
  for (const k of candidates) {
    if (k in row) return k;
  }
  return null;
}

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nullOrNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "280" → 280 for SP Number columns; null for blank / non-numeric. */
function numOrNull(s: string): number | null {
  const n = Number(s.trim());
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}

function parseDieComponentsJson(raw: string): Record<string, DieComponentCondition> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, DieComponentCondition> = {};
    for (const c of DIE_COMPONENTS) {
      const cond = parseDieCondition(str(parsed[c.key]));
      if (cond) out[c.key] = cond;
    }
    return out;
  } catch {
    return {};
  }
}

/** SP MultiChoice read: verbose {results:[…]} or a plain array. */
function multiChoice(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  if (v && typeof v === 'object' && Array.isArray((v as { results?: unknown[] }).results))
    return (v as { results: unknown[] }).results.map((x) => str(x)).filter(Boolean);
  return [];
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|yes|y|1)$/i.test(v);
  return undefined;
}

export function dateOnly(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  // SP DateTime is stored UTC. A Sydney Day shift starts 07:00 AEST =
  // 21:00 UTC previous calendar day, so slicing the first 10 chars of
  // the ISO string would shift the shiftId back one day and break every
  // downstream match (KPI shiftIds set, operator sid() comparison,
  // rejects-by-key lookup). Convert UTC back to local, then format the
  // local calendar date — Afternoon and Night sit safely within a single
  // UTC day so this also makes the three shifts symmetric.
  const d = new Date(v);
  if (isNaN(d.getTime())) return v.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDate(v: unknown): string {
  if (typeof v === 'string' && v) return new Date(v).toISOString();
  return '';
}

function parseShiftIdLoose(sid: string): { date: string; shift: string } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-([A-Za-z]+))?/.exec(sid);
  if (!m) return { date: '', shift: '' };
  return { date: m[1], shift: m[2] ?? '' };
}

/**
 * The instant we stamp PMD_Production / PMD_BreakDownlog / PMD_Rejects rows
 * with for a given shift. Midnight UTC of the shift's calendar date.
 *
 * The SP tenant we ship to has its regional setting at Auckland (UTC+12 /
 * +13 NZDT) even though the plant is in Sydney (UTC+10 / +11 AEDT). The
 * earlier choice of noon UTC kept the date stable for negative-offset
 * tenants but slipped a day forward when SP rendered the value in
 * Auckland — the operator reported PMD_Production showing 6/06 in the
 * tooltip while they were working the Sydney 5/06 night shift.
 *
 * Midnight UTC of the shift date works the other way: in any positive
 * regional setting (which is every place this plant could realistically
 * be administered from, +0 through +14) the displayed date is the
 * shift's date, because we add hours to midnight rather than crossing
 * into the next day. Date-Only SP columns also store this correctly —
 * they pick up the date portion of the UTC value as-is.
 *
 * Filters in this file use a ±1-day window so older rows written with
 * the legacy noon-UTC or local-start timestamps still match — no
 * migration required.
 */
function shiftDateMarker(shiftId: string): string {
  return `${shiftId.slice(0, 10)}T00:00:00.000Z`;
}

/** UTC instant for the start (inclusive) and end (inclusive) of a
 *  date-only window padded by 1 day on either side, so both the new
 *  midnight-UTC marker and any legacy local-start timestamps land inside.
 *  `to` defaults to `from` for single-shift queries. */
function shiftDateRange(fromShiftId: string, fDate: string, toShiftId = fromShiftId): string {
  const from = new Date(`${fromShiftId.slice(0, 10)}T00:00:00.000Z`).getTime();
  const to = new Date(`${toShiftId.slice(0, 10)}T00:00:00.000Z`).getTime();
  const lo = new Date(from - 86_400_000).toISOString();
  const hi = new Date(to + 2 * 86_400_000).toISOString();
  return `${fDate} ge datetime'${lo}' and ${fDate} le datetime'${hi}'`;
}

/** Convenience for filters with optional `from` / `to` shiftIds —
 *  returns an empty string when neither bound is set so the caller can
 *  just include it in an `and`-chain. */
function shiftDateRangeFromTo(
  from: string | undefined,
  to: string | undefined,
  fDate: string,
): string {
  if (!from && !to) return '';
  if (from && to) return shiftDateRange(from, fDate, to);
  if (from) {
    const lo = new Date(
      new Date(`${from.slice(0, 10)}T00:00:00.000Z`).getTime() - 86_400_000,
    ).toISOString();
    return `${fDate} ge datetime'${lo}'`;
  }
  // to-only
  const hi = new Date(
    new Date(`${to!.slice(0, 10)}T00:00:00.000Z`).getTime() + 2 * 86_400_000,
  ).toISOString();
  return `${fDate} le datetime'${hi}'`;
}

function productionMatches(r: ProductionRecord, f: ProductionFilter): boolean {
  if (f.machineCode && r.machineCode !== f.machineCode) return false;
  if (f.shiftId && r.shiftId !== f.shiftId) return false;
  if (f.jobNumber && r.jobNumber !== f.jobNumber) return false;
  if (f.shiftIdFrom && r.shiftId < f.shiftIdFrom) return false;
  if (f.shiftIdTo && r.shiftId > f.shiftIdTo) return false;
  return true;
}

function timelineToSlot(t: string): number {
  if (/^\d+$/.test(t)) return Math.max(0, Math.min(15, Number(t)));
  // Expect "HH:MM-HH:MM" or "HH:MM".
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // Shift starts at 07/15/23 — derive by closest match to 30-min grid from 7am.
  const minutes = h * 60 + min;
  const startCandidates = [7 * 60, 15 * 60, 23 * 60];
  let best = 0;
  for (const start of startCandidates) {
    const span = (minutes - start + 60 * 24) % (60 * 24);
    if (span >= 0 && span < 8 * 60) {
      best = Math.floor(span / 30);
      break;
    }
  }
  return Math.max(0, Math.min(15, best));
}

interface HeaderRow {
  id: number;
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  jobRequired: number;
  cycleTime: number;
  /** Identical cavities on the die (pieces per cycle); 1 when the column
   *  is absent / empty. Stamped onto the canonical record so every Good
   *  computation can multiply (CountEnd − CountStart) by it. */
  cavities: number;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string;
  qcChecks: string;
  rejectsBySlot: string;
  /** PMD_Production.Reopened (Yes/No) — true when a signed-off order has been
   *  re-opened for correction. false when locked / column absent. */
  reopened: boolean;
  /** OwnerDevice from PMD_LiveStatus ('' on signed PMD_Production rows). */
  ownerDevice: string;
  /** Sign-off timestamp (ISO) from PMD_Production.Signoff; '' when absent
   *  (live rows, or legacy signed rows from before the column existed). */
  signOff: string;
  /** Job Left frozen at job start from PMD_Production.JobLeft; -1 when the
   *  column is absent or empty (live rows / legacy signed rows). Stamped
   *  onto the canonical record so Trace can read demand-at-start. */
  jobLeft: number;
  /** Shift Target frozen at job start from PMD_Production.ShiftTarget; -1
   *  when absent. Round-tripped onto the canonical record for Trace. */
  shiftTarget: number;
  /** Planned start (local ISO) from PMD_Production.PlannedStart; '' when
   *  the column is absent / empty. Round-tripped onto the canonical
   *  record so Schedule Adherence works after Epicor drops the order. */
  plannedStart: string;
  /** SharePoint's built-in Modified timestamp (ISO). Used to detect a
   *  signed-off tuple that has since been unlocked and re-edited: its
   *  PMD_LiveStatus row gets a Modified NEWER than the PMD_Production
   *  row's, which makes the live mirror win on every device (the unlock
   *  flag itself is device-local). '' when the field is unreadable. */
  modified: string;
}

interface HeaderInput {
  machineCode: string;
  date: string;
  shift: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  jobRequired: number;
  /** Cycle time (hours/piece) for the job — persisted so past shifts
   *  recompute Shift Target. 0 when unknown (the column is skipped). */
  cycleTime: number;
  /** Shift Target snapshot for the SP list / Power BI (PMD_Production
   *  only — live pushes omit it; the value derives from signed rows on
   *  read). null/undefined skips the column write. */
  shiftTarget?: number | null;
  /** Identical cavities on the die (pieces per cycle). 1 (or 0/undefined)
   *  leaves the column at its default; written when > 1. */
  cavities?: number;
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  supervisor: string;
  runTime: number;
  downTime: number;
  handover: string; // JSON {machine,mold,material,method} (4M) from the canonical slot
  /** JSON {"<slotIndex>":"<name>"} — the per-slot QC sign-off map. */
  qcChecks: string;
  /** JSON {"<slotIndex>":{"<code>":qty}} — per-slot per-code reject
   *  breakdown. Mirrors what PMD_Rejects holds for signed-off shifts,
   *  but written eagerly to the LiveStatus row so other iPads can read
   *  the breakdown without waiting for sign-off. */
  rejectsBySlot: string;
  /** PMD_LiveStatus only — the owning device id, or '' to leave the
   *  column untouched. Omitted/'' on PMD_Production writes. */
  ownerDevice?: string;
  /** PMD_Production only — ISO sign-off timestamp written on lockShift.
   *  Omitted on live snapshot pushes so the column is left untouched. */
  signOff?: string;
  /** PMD_Production only — Job Left at sign-off, computed by the
   *  operator UI (jobRequired − sum-of-Good across every shift of this
   *  job including this one). null/undefined skips the column write. */
  jobLeft?: number | null;
  /** PMD_Production only — Reopened (Yes/No). Written explicitly on
   *  sign-off (false, re-locks) and unlock (true). undefined leaves the
   *  column untouched (live snapshot pushes). */
  reopened?: boolean;
  /** PMD_Production only — planned start (local ISO) denormalised at
   *  sign-off. Empty/undefined skips the column write. */
  plannedStart?: string;
}

interface StatusHours {
  R: number;
  B: number;
  C: number;
  D: number;
  I: number;
  M: number;
  O: number;
  P: number;
  S: number;
}

interface RejectRow {
  id: number;
  timeline: string;
  code: string;
  category: string;
  qty: number;
}

interface RejectEvent {
  timeline: string;
  code: string;
  category: string;
  qty: number;
}

/**
 * True if the operator has filled in something worth surfacing on
 * other iPads — a status code on any slot, a counter reading, a
 * reject quantity, a purge weight, or a handover note. Picking a
 * Job# / Operator / Supervisor on its own does *not* count: the
 * editCache row gets created from the very first upsert (typically
 * the Operator select), and pushing that to SP would spam Live
 * Status with empty cards every time someone changed their mind
 * about which order to start.
 */
/**
 * Grace window after a shift's end during which its rows may still be
 * legitimately written/mirrored (late sign-off, last-minute edits).
 * Past this, a shift can no longer be "in progress".
 */
export const LIVE_STALE_GRACE_MS = 8 * 3600_000;

/**
 * Hard retention cap for PMD_LiveStatus. Any live row whose shift ended
 * more than this ago is swept on the next read, WITH or WITHOUT machine
 * status. The 8 h grace above only sweeps status-empty mis-taps; a real
 * in-progress job that the operator recorded but never signed off would
 * otherwise linger on the live board forever. 24 h still covers the
 * observed late-sign-off pattern (a Night/Afternoon shift back-filled
 * the next morning) while getting stale rows off the live board — and
 * out of the cross-shift Good totals — a day sooner. NOTE: this also
 * bounds how long un-signed-off work survives in a device's editCache;
 * a shift must be signed off within a day of ending or its unsigned
 * data is dropped.
 */
export const LIVE_HARD_CAP_MS = 24 * 3600_000;

/**
 * True when `shiftId`'s shift ended more than `graceMs` ago — i.e. it
 * can't possibly be a live, in-progress shift any more. Unparseable
 * shift ids return false (leave alone). Boundary equality counts as
 * "ended" (`<=`).
 */
export function shiftEndedLongAgo(
  shiftId: string,
  now: Date,
  graceMs: number = LIVE_STALE_GRACE_MS,
): boolean {
  const b = shiftBounds(shiftId);
  if (!b) return false;
  return b.end.getTime() + graceMs <= now.getTime();
}

/**
 * "Junk" PMD_LiveStatus row: the shift it points to is decisively in
 * the past (ended more than `graceMs` ago) AND nobody ever stamped a
 * MachineStatus on any half-hour slot of it. These are produced when
 * an operator taps a machine, picks a (wrong) job, maybe types a
 * Count Start, then realises the mistake and walks away — the live
 * snapshot push had already mirrored the partial cache onto
 * PMD_LiveStatus and there was no path to clean it up.
 *
 * The user-facing impact was twofold:
 *  1. PMD_LiveStatus grew an ever-longer list of orphans (one per
 *     mis-tap per device).
 *  2. listProduction's editCache backfill (the SFM507068 fix) would
 *     happily absorb those orphans, shadowing the canonical
 *     PMD_Production rows for the same (machine, shift) when an
 *     operator scrolled back to review a past shift.
 *
 * Only flag rows that have ZERO machine status anywhere — countStart /
 * countEnd / reject on their own are NOT proof of run; a finished
 * shift always has at least one timeline letter. Future-dated rows
 * are never flagged: they may be a deliberately scheduled tap-ahead
 * and we don't want to silently delete planned work.
 *
 * NOTE: an OLD row that DOES carry status (e.g. an abandoned 03/06
 * experiment) is NOT junk by this definition — deleting real data is
 * out of scope here. The defence against those re-appearing on the
 * live board lives in pushLiveSnapshot, which refuses to mirror any
 * shift that `shiftEndedLongAgo`.
 *
 * `now` is injected so the helper is testable; pass `new Date()` in
 * the live path.
 */
export function isStaleLiveHeader(
  h: { date: string; shift: string; timeline?: string },
  now: Date,
  graceMs: number = LIVE_STALE_GRACE_MS,
): boolean {
  if (!shiftEndedLongAgo(`${h.date}-${h.shift}`, now, graceMs)) return false;
  const timeline = h.timeline || '';
  for (const ch of timeline) {
    if (ch && ch !== '·' && ch !== ' ') return false;
  }
  return true;
}

function hasMeaningfulProgress(slots: ProductionRecord[]): boolean {
  for (const r of slots) {
    if (r.statusCode) return true;
    if (r.countStart != null) return true;
    if (r.countEnd != null) return true;
    if (r.purgeKg != null) return true;
    if (r.rejectCount > 0) return true;
    if (r.rejects && r.rejects !== '{}') return true;
    const note = (r.handoverNote ?? '').trim();
    if (note && note !== '{}') return true;
  }
  return false;
}

function aggregateSlots(slots: ProductionRecord[]): {
  timeline: string;
  countStart: number | null;
  countEnd: number | null;
  reject: number;
  operator: string;
  runTime: number;
  downTime: number;
  hours: StatusHours;
  rejectEvents: RejectEvent[];
  bdCode: string;
  handover: string;
  qcChecks: string;
  rejectsBySlot: string;
} {
  const timelineArr = Array.from({ length: 16 }, () => '·');
  const hours: StatusHours = { R: 0, B: 0, C: 0, D: 0, I: 0, M: 0, O: 0, P: 0, S: 0 };
  let canonical: ProductionRecord | undefined;
  let reject = 0;
  const rejectEvents: RejectEvent[] = [];
  // Tally BD codes across all B slots so we can pick the most frequent one
  // for PMD_BreakDownlog.BDCode (analytic-level dominant code).
  const bdTally = new Map<string, number>();
  for (const r of slots) {
    if (r.slotIndex === 0) canonical = r;
    if (r.statusCode && r.slotIndex >= 0 && r.slotIndex < 16) {
      timelineArr[r.slotIndex] = r.statusCode;
      const code = r.statusCode as keyof StatusHours;
      if (code in hours) hours[code] += 0.5;
    }
    if (r.statusCode === 'B' && r.bdIssue) {
      bdTally.set(r.bdIssue, (bdTally.get(r.bdIssue) ?? 0) + 1);
    }
    let obj: Record<string, number> = {};
    try {
      obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
    } catch {
      obj = {};
    }
    const shiftId = r.shiftId;
    const slotLabel = slotClock(shiftId, r.slotIndex) || String(r.slotIndex);
    for (const [code, qty] of Object.entries(obj)) {
      if (!qty) continue;
      reject += qty;
      rejectEvents.push({
        timeline: slotLabel,
        code,
        // RejectCategory = the machine STATUS in that slot (R/D/C/...). Lets
        // Power BI split "defects while running" vs "during a die change" etc.
        category: r.statusCode || 'R',
        qty,
      });
    }
  }
  // Most frequent BD code wins; ties broken by insertion order.
  let bdCode = '';
  let bdMax = 0;
  for (const [code, n] of bdTally) {
    if (n > bdMax) {
      bdMax = n;
      bdCode = code;
    }
  }
  // Quality-check sign-offs roll up into one JSON map keyed by slot
  // index — the PMD_Production.QualityChecks column stores this verbatim
  // so the round-trip is lossless.
  const qcMap: Record<string, string> = {};
  for (const r of slots) {
    if (r.qcBy && r.slotIndex >= 0 && r.slotIndex < 16) qcMap[String(r.slotIndex)] = r.qcBy;
  }
  // Per-slot per-code reject map — same data PMD_Rejects holds, but
  // serialised onto the LiveStatus header so other iPads see it during
  // a live shift (PMD_Rejects is only written on sign-off).
  const rejectsBySlotMap: Record<string, Record<string, number>> = {};
  for (const r of slots) {
    if (r.slotIndex < 0 || r.slotIndex >= 16) continue;
    let obj: Record<string, number> = {};
    try {
      obj = JSON.parse(r.rejects || '{}') as Record<string, number>;
    } catch {
      continue;
    }
    const filtered: Record<string, number> = {};
    for (const [code, qty] of Object.entries(obj)) {
      const n = Number(qty);
      if (!n) continue;
      filtered[code] = n;
    }
    if (Object.keys(filtered).length) rejectsBySlotMap[String(r.slotIndex)] = filtered;
  }
  return {
    timeline: timelineArr.join(''),
    countStart: canonical?.countStart ?? null,
    countEnd: canonical?.countEnd ?? null,
    reject,
    operator: canonical?.operator ?? '',
    runTime: hours.R,
    downTime: hours.B + hours.M,
    hours,
    rejectEvents,
    bdCode,
    handover: canonical?.handoverNote ?? '',
    qcChecks: Object.keys(qcMap).length ? JSON.stringify(qcMap) : '',
    rejectsBySlot: Object.keys(rejectsBySlotMap).length ? JSON.stringify(rejectsBySlotMap) : '',
  };
}


/** Turn the handover JSON {machine,mold,material,method} into readable text. */
/**
 * Strip characters that SharePoint REST rejects from string values in a
 * POST/MERGE body. The 500 "Invalid text value. A text field contains
 * invalid data." error doesn't name the offending column, so the safer
 * play is to scrub up front. Removes:
 *   - C0 control characters U+0000..U+001F except \t \r \n (NUL, VT, etc.
 *     come back from Excel paste / clipboard glitches; SP refuses them).
 *   - C1 controls U+007F..U+009F.
 *   - Unicode line / paragraph separators U+2028 / U+2029 (slip in from
 *     Word and break the JSON parser SP uses for verbose envelopes).
 *   - The BOM U+FEFF anywhere except position 0 (also a common CSV gift).
 * Mutates the body in place. `__metadata` and non-string values are left
 * alone.
 */
export function sanitizeBodyStrings(body: Record<string, unknown>): void {
  const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/g;
  for (const [k, v] of Object.entries(body)) {
    if (k === '__metadata' || typeof v !== 'string') continue;
    if (bad.test(v)) body[k] = v.replace(bad, '');
  }
}

function formatHandover(json: string): string {
  if (!json) return '';
  try {
    const h = JSON.parse(json) as Record<string, string>;
    return (['machine', 'mold', 'material', 'method'] as const)
      .filter((k) => (h[k] ?? '').trim())
      .map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${h[k].trim()}`)
      .join('\n');
  } catch {
    return json; // already plain text
  }
}

function excelDate(v: unknown): Date | null {
  if (v == null || v === '') return null;

  // Excel serial — happens when Graph is asked with valuesOnly=true or for
  // workbook ranges where the cell type is numeric DateTime. Decompose the
  // serial as UTC to extract the wall-clock components Excel intended, then
  // rebuild via the local Date constructor so a Sydney user gets 12:00
  // local for a cell that reads "12:00", not 12:00 UTC (= 22:00 Sydney).
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 200000) {
    const utcMs = (v - 25569) * 86400 * 1000;
    const u = new Date(utcMs);
    return new Date(
      u.getUTCFullYear(),
      u.getUTCMonth(),
      u.getUTCDate(),
      u.getUTCHours(),
      u.getUTCMinutes(),
      u.getUTCSeconds(),
    );
  }

  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;

  // Some exports write a date column as the raw Excel serial *string*
  // ("46234"). Treat a pure number in the plausible serial range (≈1954+)
  // as a serial so those dates aren't silently dropped. Small integers
  // (a "Time" of "7") stay untouched.
  if (/^\d{5,6}$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial <= 200000) return excelDate(serial);
  }

  // Year-first dates, EITHER separator:
  //  · Graph ISO 8601 "2026-05-25T12:00:00.000Z" (dashes, optional time/Z)
  //  · the Mango/Minto export's "2025/10/10" / "2026/07/31" (slashes,
  //    year-first — day last, confirmed by values >12 like 31).
  // Excel has no timezone — the "12:00" the user typed is wall-clock, not
  // UTC. Parsing via `new Date()` would treat the Z as UTC and shift by the
  // local offset (Sydney AEST: 10 h, the "10:00 PM" symptom). Extract the
  // components and anchor them to local time instead. The time portion is
  // optional so a bare "2026-05-25" / "2025/10/10" date is accepted too.
  const iso =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/i.exec(
      s,
    );
  if (iso) {
    return new Date(
      +iso[1], +iso[2] - 1, +iso[3],
      iso[4] ? +iso[4] : 0,
      iso[5] ? +iso[5] : 0,
      iso[6] ? +iso[6] : 0,
    );
  }

  // AU date with optional time, e.g. "25/05/2026", "25/05/2026 14:00",
  // or "25/05/2026 2:00:00 PM". JS's native parser is unreliable here
  // because en-US engines flip to MM/DD interpretation.
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?)?$/i.exec(s);
  if (au) {
    let hour = au[4] ? parseInt(au[4], 10) : 0;
    if (au[7]) {
      const isPm = au[7].toLowerCase() === 'pm';
      if (isPm && hour < 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
    }
    return new Date(
      +au[3], +au[2] - 1, +au[1],
      hour, au[5] ? +au[5] : 0, au[6] ? +au[6] : 0,
    );
  }

  return null;
}

function bdFallback(): BdCode[] {
  return BD_TAXONOMY.map((c, i) => ({
    code: c.code,
    label: c.cause,
    subCategory: bdCategoryOf(c.code)?.label ?? '',
    sequence: i + 1,
    owner: c.owner,
  }));
}

// Used by trace view bd label fallback (re-exported so consumers don't
// have to dig into ../core/breakdown directly when working with codes
// surfaced from SharePoint).
export { bdLabelFor };

// ---------------------------------------------------------------------------
// CSV parsing for the Epicor → CSV → SharePoint file → app pipeline.
// Tiny single-purpose parser: handles quoted fields with embedded commas
// and double-double-quote escapes; ignores BOM and CRLF/LF line endings.
// ---------------------------------------------------------------------------

export function parsePlanningCsv(text: string): PlanningOrder[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) throw new Error('Planning CSV is empty');
  const header = rows[0].map((c) => c.trim());
  const idx = (name: string): number => header.indexOf(name);
  const firstIdx = (...names: string[]): number => {
    for (const n of names) {
      const i = idx(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iJob = idx('JobHead_JobNum');
  if (iJob < 0) {
    throw new Error(
      `Planning CSV schema invalid: required column 'JobHead_JobNum' is missing (header: ${header.join(' | ')})`,
    );
  }
  const iPart = idx('JobHead_PartNum');
  const iMachine = idx('Machine');
  const iDesc = idx('JobHead_PartDescription');
  const iProd = idx('JobHead_ProdQty');
  const iRem = idx('Calculated_RemainingQty');
  const iStart = idx('JobHead_StartDate');
  const iDue = idx('JobHead_ReqDueDate');
  const iQty = idx('JobOper_ProdStandard');
  // Optional column: decimal hours-of-day for the planned start
  // (e.g. 18.68 → 18:40:48). Epicor emits this separately from the
  // date so JobHead_StartDate is just YYYY-MM-DD; we layer the
  // decimal-hours value back onto that date here. The Epicor field
  // is JobHead_StartHour; the remaining variants are kept as
  // defensive fallbacks so a header rename in the export tool
  // doesn't require a code change.
  const iStartTime = firstIdx(
    'JobHead_StartHour',
    'JobHead_StartTime',
    'JobHead_Start_Time',
    'Start_Time',
    'StartTime',
    'Start Time',
  );
  const out: PlanningOrder[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;
    // Trim the JobNum like Part # below — a stray trailing space / NBSP in
    // the Epicor export cell makes the exact-match lookups in orderForJob /
    // the Job# dropdown miss, so Order Qty + Product Description silently come
    // back blank for that order even though the row is present. (Reported:
    // SFM507057 / Batt1 wouldn't load its Qty + description.)
    const job = (row[iJob] ?? '').trim(); // trim() also strips NBSP / BOM
    if (!job) continue;
    let startIso = csvDateToIso(row[iStart] ?? '');
    // Layer the start-time decimal onto the start-date when the
    // column is present and parses as a finite non-negative number
    // less than 24. Anything else (blank, NaN, > 24) is ignored so
    // a missing value can't silently shift a job to midnight.
    if (startIso && iStartTime >= 0) {
      const raw = (row[iStartTime] ?? '').trim();
      if (raw !== '') {
        const decH = parseFloat(raw);
        if (isFinite(decH) && decH >= 0 && decH < 24) {
          startIso = applyDecimalHoursToIso(startIso, decH);
        }
      }
    }
    // Both fields now contain the actual Sydney wall-clock time. DueDate
    // is authoritative for the schedule end; duration is their elapsed
    // span, not the retired Calculated_RemaingLaborHrs export column.
    const dueIso = csvDateToIso(row[iDue] ?? '');
    let dur = 0;
    if (startIso && dueIso) {
      const startMs = new Date(startIso).getTime();
      const dueMs = new Date(dueIso).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(dueMs) && dueMs > startMs) {
        dur = (dueMs - startMs) / 3600_000;
      }
    }
    // Epicor now exports JobOper_ProdStandard as pieces/hour. The app's
    // established internal field is hours/piece, so invert once at the
    // boundary and keep every downstream calculation unit-safe.
    const piecesPerHour = parseFloat(row[iQty] ?? '0') || 0;
    out.push({
      id: 0,
      jobNumber: job,
      machineCode: (row[iMachine] ?? '').trim(),
      originalMachine: (row[iMachine] ?? '').trim(),
      // Trim Part # so a stray trailing space in the Excel cell can't
      // break the PMD_ProductDieColor Map lookup (operator swatch +
      // KPIs colour column both key on this).
      partNumber: (row[iPart] ?? '').trim(),
      partDescription: row[iDesc] ?? '',
      plannedStart: startIso,
      plannedEnd: dueIso,
      // Order Qty = total ProdQty; Job Left = remaining. Fall back to the
      // remaining value when the export predates the ProdQty column.
      orderQty:
        (iProd >= 0 ? parseFloat(row[iProd] ?? '0') : 0) ||
        parseFloat(row[iRem] ?? '0') ||
        0,
      jobRequired: parseFloat(row[iRem] ?? '0') || 0,
      qtyPerHr: piecesPerHour > 0 ? 1 / piecesPerHour : 0,
      duration: dur,
      released: true,
      isDieChange: false,
      manuallyAdded: false,
      source: 'ERP',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mango plant-equipment work-order report (CSV) → DieMaintenanceRequest[].
// Downloaded by scripts/sync-mango-csv.mjs into the OneDrive-synced folder
// (same pipeline as Planning.csv). Mango has no API for this module, so the
// CSV report is the only machine-readable surface we get.
// ---------------------------------------------------------------------------

/** Direct field → EXACT column-name map for the Mango "AU - Minto
 *  Maintenance Request" export. The report header is fixed and published,
 *  so each field maps to the one column it comes from — no fuzzy guessing.
 *  Names are matched after normalising (lowercase, non-alphanumerics
 *  stripped), so a trailing space in "Type of Maintenance " or the
 *  punctuation in "Cost (parts, labour)" doesn't matter. If Mango ever
 *  renames a column the console warning names it and prints the header row.
 *
 *  User-confirmed mapping (2026-07):
 *   Die number  ← Plant/Equipment        Issue       ← Brief Description
 *   Raised by   ← Employee               Full issue  ← Describe the issue
 *   Due date    ← To be completed by     Maint type  ← Type of Maintenance
 *   Assignee    ← Assign to Action       Outcome     ← Summary of work
 *   completed + Corrective action taken + Preventative action taken +
 *   Summary     Cost/effort ← Cost (parts, labour) + Downtime + Labour Hours */
const MANGO_HEADERS: Record<string, string> = {
  ticket: 'Number',
  downtime: 'Downtime',
  labourHours: 'Labour Hours',
  status: 'Current Stage',
  asset: 'Plant/Equipment',
  description: 'Brief Description',
  requestedBy: 'Employee',
  createdAt: 'Created Date',
  dueDate: 'To be completed by',
  type: 'Type of Maintenance',
  issueDetail: 'Describe the issue',
  actionsTaken: 'Actions taken',
  contact: 'Assign to Action',
  workSummary: 'Summary of work completed',
  cost: 'Cost (parts, labour)',
  correctiveAction: 'Corrective action taken',
  preventativeAction: 'Preventative action taken',
  summary: 'Summary',
};

/** Columns whose absence is a real problem (everything else is optional
 *  detail). Without Plant/Equipment there are no die numbers; without
 *  Current Stage the lifecycle can't be resolved. */
const MANGO_REQUIRED = new Set(['asset', 'status']);

/**
 * Parse Mango's work-order CSV report into the app's work-order shape.
 *
 * The report covers the WHOLE plant (forklifts, presses, dock levelers…).
 * Rows whose Plant/Equipment names a DIE belong to Die Management: the die
 * assets follow the site convention "AU - Die 280 Postura Max 430 & 460" —
 * the number after the word "Die" IS the PMD_ProductDieColor DieNumber, so
 * it's extracted directly (word-boundary match: "Diesel" never qualifies).
 * A die row whose number can't be extracted keeps the asset name so it
 * stays visible. Every other row is a machine/plant work order, surfaced
 * separately by parseMangoMachineWorkOrdersCsv for the Die board's Machine
 * column (matched to a press by code — see assetNamesMachine).
 *
 * Status maps the Mango stages (Stage 1 Assessing → open · Stage 2/3 →
 * in-progress · Stage 4 Closed → done); cancelled/declined orders are
 * skipped. The Minto export carries no completion-date column, so for
 * closed orders the date is recovered from the "Actions taken" log — the
 * newest "… to Stage 4 Closed" line, else the log's last date. Ids are
 * synthetic (the UI is read-only against this source).
 */
export function parseMangoWorkOrdersCsv(text: string): DieMaintenanceRequest[] {
  return parseMangoReport(text, 'die');
}

/** The machine/plant half of the same Mango report: every work order whose
 *  Plant/Equipment does NOT name a die. The raw asset is preserved on
 *  `asset` so the Die board can match a row to a press by its code; the
 *  synthetic-die `dieNumber` is left empty. Same header detection, cell
 *  mapping, status/closure logic as the die parser. */
export function parseMangoMachineWorkOrdersCsv(text: string): DieMaintenanceRequest[] {
  return parseMangoReport(text, 'machine');
}

function parseMangoReport(text: string, mode: 'die' | 'machine'): DieMaintenanceRequest[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length === 0) throw new Error('Mango CSV is empty');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(Object.values(MANGO_HEADERS).map(norm));
  // Mango prefixes the export with a report-TITLE line ("AU - Minto
  // Maintenance Request 1783728039982" — the number is the export
  // timestamp, different every time), sometimes followed by blanks. The
  // real header is the first row carrying the known column names.
  let headerAt = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const score = rows[i].reduce((n, c) => n + (c && wanted.has(norm(c)) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      headerAt = i;
    }
  }
  if (headerAt < 0 || bestScore < 3) {
    throw new Error(
      `Mango CSV schema invalid: could not locate the report header (best score ${bestScore}; first lines: ${rows
        .slice(0, 3)
        .map((r) => r.join(',').slice(0, 120))
        .join(' / ')})`,
    );
  }
  // Direct map: each field takes the column whose header matches its exact
  // name. The layout is fixed, so no prefix/contains guessing.
  const header = rows[headerAt].map(norm);
  const idx: Record<string, number> = {};
  for (const [field, name] of Object.entries(MANGO_HEADERS)) {
    idx[field] = header.indexOf(norm(name));
  }
  const missing = [...MANGO_REQUIRED].filter((f) => idx[f] < 0).map((f) => MANGO_HEADERS[f]);
  if (missing.length > 0) {
    throw new Error(
      `Mango CSV schema invalid: required column(s) missing: ${missing.join(', ')}; header: ${rows[
        headerAt
      ].join(' | ')}`,
    );
  }
  // The due-date column drives the Maint traffic light and is the one
  // people most often forget to fill. Make its resolution explicit.
  if (idx['dueDate'] < 0) {
    console.warn(
      "[pmd] Mango CSV: no '" + MANGO_HEADERS.dueDate + "' column in the export.",
      'Header row was:', rows[headerAt].join(' | '),
    );
  } else {
    console.info(
      "[pmd] Mango CSV: due-date column = '" + rows[headerAt][idx['dueDate']] + "' (index " + idx['dueDate'] + ')',
    );
  }
  const cell = (row: string[], field: string): string =>
    idx[field] >= 0 ? (row[idx[field]] ?? '').trim() : '';
  // "…Die 280…" as a WORD then the number — "Diesel" has no boundary
  // after "die" so it never matches.
  const dieRe = /\bdie\b[^0-9a-z]*(\d+)/i;
  const out: DieMaintenanceRequest[] = [];
  // Per die-row raw "To be completed by" cell — so when a date fails to
  // surface we can show exactly what the parsed bytes held at that column
  // (empty file vs. a value the app parsed differently than Excel shows).
  const dueDiag: { ticket: string; raw: string }[] = [];
  for (let r = headerAt + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;
    const asset = cell(row, 'asset');
    // Split the plant into dies vs everything else. Die mode keeps the die
    // assets ("AU - Die 171 …"); machine mode keeps the rest (presses,
    // forklifts, …) so the Die board's Machine column can match a press to
    // its work orders by code (assetNamesMachine).
    const dieMatch = dieRe.exec(asset);
    const isDieAsset = !!dieMatch || /\bdies?\b/i.test(asset);
    if (mode === 'die' ? !isDieAsset : isDieAsset) continue;
    const ticket = cell(row, 'ticket');
    const description = cell(row, 'description');
    if (!asset && !description && !ticket) continue;
    if (mode === 'machine' && !asset) continue; // machine WOs match on the asset
    const rawStatus = cell(row, 'status');
    if (/cancel|declin|reject|void/i.test(rawStatus)) continue;
    const status = normaliseMaintStatus(rawStatus);
    // Closure date: a real completed column when the layout has one,
    // else the newest "to Stage 4 Closed" line of the actions log, else
    // the log's last date (entries are chronological).
    let closedAt = csvDateToIso(cell(row, 'closedAt'));
    if (!closedAt && status === 'done') {
      const log = cell(row, 'actionsTaken');
      const toClosed = Array.from(
        log.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})[^\n]*to\s+stage\s*4\s*closed/gi),
      ).pop();
      const anyDates = log.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
      const pick = toClosed?.[1] ?? anyDates?.[anyDates.length - 1] ?? '';
      if (pick) closedAt = csvDateToIso(pick);
    }
    out.push({
      id: 1_000_000 + r, // synthetic — this source is read-only in the UI
      dieNumber: mode === 'machine' ? '' : dieMatch ? dieMatch[1] : asset,
      asset,
      status,
      maintType: normaliseMaintType(cell(row, 'type')),
      priority: normaliseMaintPriority(cell(row, 'priority')),
      description: description || asset,
      contact: cell(row, 'contact'),
      requestedBy: cell(row, 'requestedBy'),
      machineCode: '',
      jobNumber: '',
      mangoTicket: ticket,
      createdAt: csvDateToIso(cell(row, 'createdAt')),
      closedAt,
      downtime: cell(row, 'downtime') || undefined,
      labourHours: cell(row, 'labourHours') || undefined,
      issueDetail: cell(row, 'issueDetail') || undefined,
      actionsTaken: cell(row, 'actionsTaken') || undefined,
      workSummary: cell(row, 'workSummary') || undefined,
      correctiveAction: cell(row, 'correctiveAction') || undefined,
      preventativeAction: cell(row, 'preventativeAction') || undefined,
      summary: cell(row, 'summary') || undefined,
      cost: cell(row, 'cost') || undefined,
      dueDate: csvDateToIso(cell(row, 'dueDate')) || undefined,
    });
    dueDiag.push({ ticket, raw: idx['dueDate'] >= 0 ? (row[idx['dueDate']] ?? '') : '' });
  }
  // Diagnostics for the due date that drives the Maint traffic light: for
  // any rows whose date didn't surface, print the ticket + the RAW cell
  // the app parsed at the due-date column. If the raw cell is '' the file
  // the app loaded has no date there (empty export / stale-or-wrong file —
  // the value in Excel is from a different copy); if it holds text the app
  // parsed it wrong and the sample shows exactly what to teach excelDate.
  const missingDue = out
    .map((o, i) => ({ o, d: dueDiag[i] }))
    .filter((x) => !x.o.dueDate);
  if (mode === 'die' && idx['dueDate'] >= 0 && missingDue.length > 0) {
    console.warn(
      `[pmd] Mango CSV: ${missingDue.length}/${out.length} die rows have no parsed`,
      `'${rows[headerAt][idx['dueDate']]}' (col ${idx['dueDate']}). Raw cells:`,
      missingDue.slice(0, 8).map((x) => `${x.d.ticket || '?'}=${JSON.stringify(x.d.raw)}`).join(' · '),
    );
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Convert decimal hours-of-day to (hh, mm, ss). 18.68 → 18:40:48.
 * Rounds the seconds and carries 60 → 00 + next-minute / next-hour so
 * a value of 23.999999 doesn't materialise as 23:59:60 (which Date
 * happily accepts but quietly rolls into the next day).
 */
export function decimalHoursToHms(h: number): [number, number, number] {
  let hh = Math.floor(h);
  const remMin = (h - hh) * 60;
  let mm = Math.floor(remMin);
  let ss = Math.round((remMin - mm) * 60);
  if (ss === 60) {
    ss = 0;
    mm += 1;
  }
  if (mm === 60) {
    mm = 0;
    hh += 1;
  }
  return [hh, mm, ss];
}

/** Replace the wall-clock time of an ISO timestamp with the decimal
 *  hours-of-day value. Keeps the original calendar date untouched. */
function applyDecimalHoursToIso(iso: string, decimalHours: number): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  const [hh, mm, ss] = decimalHoursToHms(decimalHours);
  d.setHours(hh, mm, ss, 0);
  return localDateTimeIso(d);
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // A double-quote only OPENS a quoted field when it's the field's first
  // character (RFC 4180). A `"` in the middle of an unquoted field — an
  // inch mark ("6" tall"), or an unbalanced quote in free-text like
  // "Actions taken" — is then a literal character, not a delimiter, so it
  // can't flip the parser into quote mode and swallow the commas / newlines
  // that follow (which would desync every column after it, blanking cells
  // like "To be completed by" on later rows).
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fieldStart = true;
    } else if (c === '\r') {
      // skip — \n handles the row break
    } else if (c === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      fieldStart = true;
    } else {
      field += c;
      fieldStart = false;
    }
  }
  if (inQuotes) {
    throw new Error('CSV format invalid: unterminated quoted field');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

function csvDateToIso(s: string): string {
  // PowerShell emits ISO; manually-edited CSVs sometimes carry en-AU
  // dd/mm/yyyy [HH:mm[:ss] [am/pm]] or bare dates. excelDate handles all
  // three and anchors the value to LOCAL time (Excel/Mango dates are
  // wall-clock, not UTC).
  const d = excelDate(s);
  if (!d) return '';
  // Serialise from the LOCAL calendar components — never via toISOString(),
  // which converts to UTC and rolls a bare date back a day in any UTC+
  // timezone (Sydney: 31/07/2026 → local midnight → 2026-07-30T14:00Z →
  // "2026-07-30"). A date-only value stays a stable YYYY-MM-DD; a datetime
  // keeps its wall-clock time with no Z so the day never shifts.
  const p = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  // Preserve an EXPLICIT midnight as a datetime. Looking only at the Date's
  // numeric components collapses "2026-07-01T00:00:00" to a bare date and
  // loses the fact that Epicor actually scheduled the job for midnight.
  const hasTime = /(?:T|\s)\d{1,2}:\d{2}/i.test(s.trim());
  return hasTime
    ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    : date;
}

function localDateTimeIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/**
 * Take whatever the operator put in VITE_PLANNING_CSV_PATH and reduce it
 * to a clean server-relative path (`/sites/…/file.csv`, spaces unencoded).
 * Tolerates: a full URL, a leading-slash path, a no-leading-slash path,
 * already %-encoded characters, and trailing slashes.
 */
export function toServerRelativePath(input: string): string {
  let p = (input ?? '').trim();
  if (!p) return p;
  // Full URL → take the pathname (URL.pathname drops query/fragment but
  // does NOT decode percent-encoding, so the decode below still applies).
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      // malformed URL — fall through and treat as a raw path
    }
  } else {
    const q = p.indexOf('?');
    if (q >= 0) p = p.slice(0, q);
    const h = p.indexOf('#');
    if (h >= 0) p = p.slice(0, h);
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // input wasn't percent-encoded — leave as is
  }
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}
