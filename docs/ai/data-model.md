# Data Model

> Domain types (camelCase, used everywhere) + the 11 SharePoint lists and
> their real internal column names. The DAL maps between the two.

## Core concepts

- **Machine**: 8 injection presses (125T, 320T, 550T, 850T, 1600T, Batt1,
  Batt2, HS). Code lives in each list's `Title` column on the SP side.
- **Shift**: Day (07–15), Afternoon (15–23), Night (23–07, dated by start
  day). `shiftId` = `YYYY-MM-DD-Day|Afternoon|Night`.
- **Slot**: 30 min. 16 per shift, index 0–15. Slot 0 is "canonical" — holds
  per-job counts/operator/supervisor in the memory model.
- **Status codes** (9): R Run, B Breakdown, C Colour, D Die, I Insert,
  M Maintenance, O No-work, P Purge, S Startup.
- **Defect codes** (10, flat): D01 ShortShot, D02 FlashMelt-out,
  D03 Burnmarks, D04 SinksWarpage, D05 FlowMarks, D06 WhiteStressMarks,
  D07 BubblesBlisters, D08 Cracked, D09 DamagedDirty, D10 Contamination.
  (Replaced the old 21 P-codes. All "named" — own row on the sheet.)
- **Breakdown codes** (91): 11 categories (ELE/MEC/HYD/HEA/CTL/TOOL/SAF/
  AUX/UTL/MAT/OTH) × causes, e.g. `ELE-02`. In `src/core/breakdown.ts`.

## Domain types (`src/types.ts`)

```ts
ShiftCode = 'Day' | 'Afternoon' | 'Night'
StatusCode = 'R'|'B'|'C'|'D'|'I'|'M'|'O'|'P'|'S'

Machine { id, machineCode, displayName, sequence, active }
Operator/Supervisor { id, operatorName, employeeId?, active, linkedUser? }
Product { id, partNumber, description, standardCycleSec, cavities, active }
RejectCategory { code, label, sequence, kind:'named'|'other' }   // all 'named' now
BdCode { code, label, subCategory?, sequence, owner? }
PlanningOrder { id, jobNumber, machineCode, originalMachine?, partNumber,
  partDescription, plannedStart, plannedEnd, jobRequired, qtyPerHr,
  duration, released, isDieChange, manuallyAdded, source }
ProductionRecord { id, machineCode, shiftId, jobNumber, slotIndex,
  statusCode, countStart, countEnd, rejectCount, rejects(JSON),
  otherType, otherCount, purgeKg, operator, supervisor, bdIssue,
  mangoTicket, handoverNote(JSON), locked, lockedBy, lockedAt,
  createdAt, updatedAt }
UserContext { name, role:'operator'|'supervisor'|'admin' }
```

- `rejects` is a JSON string: `{"D01":3,"D04":1}`.
- `handoverNote` is a JSON string: `{machine,mold,material,method}` (the
  "4M"). Pre-4M rows containing `people`/`plant` keys are read but those
  fields are discarded by the parser; legacy plain text is surfaced
  under `method`.

## Storage model: per-slot in memory, header+events in SharePoint

- **MemoryDataLayer**: one `ProductionRecord` per (machine, shift, job,
  slot). Simple, granular. Used for dev + as the contract reference.
- **SharePointDataLayer**: live slot edits cache in memory; on
  `lockShift` (= Sign off & Save) they flush to **three** lists:
  - `PMD_Production` — 1 header row per (machine, shift, job): 16-char
    `Status` timeline string + counts + reject total + RunTime/Downtime.
  - `PMD_BreakDownlog` — 1 analytic row: hours per status code + `BDCode`
    (most-frequent breakdown code on the shift).
  - `PMD_Rejects` — 1 event row per reject (code + qty + slot time).
  Reads hydrate slot records back by expanding the `Status` string and
  merging `PMD_Rejects` events. This keeps under the 5000-item view
  threshold (per-slot would be ~280k rows/yr).

## The 11 SharePoint lists (real internal names — verified 2026-05)

Pattern: many lists were Excel-imported, so the **primary key sits in
`Title`** and other columns got auto-names (`field_1`) or `_x00NN_`
encodings (`/`→`_x002f_`, `:`→`_x003a_`, space→`_x0020_`). All maps live
in `DEFAULT_FIELDS` in `src/dal/sharepoint.ts`; override via the
constructor `fieldMap` option, never edit call sites.

| List | Key (Title) | Notable columns (internal → meaning) |
|---|---|---|
| `PMD_Machine` | machineCode | `IsActive_x003a_Yes_x002f_No`, `DisplayOrder` |
| `PMD_Operator` | operator name | `Shift`, `Position`, `Supervisor` (text), `Supervisor0` (lookup) |
| `PMD_Supervisor` | role title | `Name` (person) |
| `PMD_Products` | PartNum | `field_1`=desc, `field_2..6`=family/group/class/type/cost |
| `PMD_Planning` | machine code | `StartDateTime`, `Qty_x002f_Hour`, `DueDate`, `JobHead_JobNum`, `JobHead_PartNum`, `JobHead_PartDescription`, `Calculated_RemainingQty`, `Duration`, `Machine`(=DieNumber!), `D_x002f_C` |
| `PMD_Production` | machine code | `SlotStart_x003a_`(DateTime, "Date"), `ShiftId`, `Status`(timeline), `JobNumber`, `CountStart/End`, `Reject`, `Operator`, `Supervisor`, `RunTime`, `Downtime`, **`Handover`** (multi-line, **must be added** — field map default `''` skips it until present) |
| `PMD_Rejects` | machine code | `Date`(DateTime), `Shift`, `Timeline`, `JobHead_JobNum`, `RejectCode`, **`RejectCategory` = the slot's machine STATUS** (R/D/C/…) so you can split defects "while running" vs "during a die change", `RejectNumber` |
| `PMD_BreakDownlog` | machine code | `Date`(DateTime), `Shift`, `JobHead_JobNum`, `JobHead_PartNum`, `StatusTimeline`, `BDCode`, `R_Runtime`,`B_BreakDown`,`C_ColorChange`,`D_DieChange`,`I_InsertChange`,`M_Maintainance`,`O_NoWork`,`P_Purge`,`S_StartUpShutdown` |
| `PMD_RejectCategories` | code (D01..) | `Description` (label) |
| `PMD_BreakdownMaster` | cause (Title) | `Code`, `Category`, `LikelyOwner` |
| `RDO Roster 2026-2030` | shift | `field_0`=ShiftDate, ShiftStart/End, PublicHoliday, Weekend, RDO — **not consumed yet** |

Gotchas baked into the adapter:
- `PMD_Production.SlotStart_x003a_`, `PMD_Rejects.Date`,
  `PMD_BreakDownlog.Date` are **DateTime** — filtered with
  `eq datetime'<shiftStart ISO>'` (computed from `shiftBounds`).
- `PMD_Planning.Machine` (internal) actually means **DieNumber**; machine
  code is in `Title`.
- `Title = machine code` is the deliberate, consistent convention across
  Production / Rejects / BreakDownlog (confirmed by the user).
