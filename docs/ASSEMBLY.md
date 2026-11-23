# Assembly in MES

MES contains two production domains. PMD continues to use its machine/shift DAL and PMD Lists. Assembly is built from the Planning application in `assembly/` and stores job/day results separately. The imported baseline is Planning commit `64d8f5690a88e9bed7db949284ab1173907410bb`; subsequent integration changes are included in this directory.

## Navigation and runtime

The header reads MES, the former Operator tab reads PMD, and Assembly opens the React planning board. The frame remains mounted when switching departments so pending saves and inspector edits survive. Production uses a same-origin srcdoc frame that loads Assembly JavaScript/CSS, avoiding SharePoint's HTML download behavior. The host passes only its operational supervisor state. SharePoint permissions remain the actual access control. The frame carries the dashboard's own `#f1f5f9` ground: it fills the viewport under the top bar, so a white one flashed a white page on every switch and read as a load that had failed.

**The top bar is the application's only chrome, and it does the whole job.** It lights the page you are on (`aria-current`), and it holds the one Supervisor button — the framed board draws no lock of its own and no title of its own, because both would be the top bar's work repeated one band lower. What the board adds under it is a single block: its controls row and its column/timeline heading on one ground, a step lighter than the top bar's `#075985`, so the page carries two tiers of chrome rather than four.

## Assembly results (`#/kpi/assembly`)

`PMD` and `Assembly` are the first two buttons of the KPI toolbar, ahead of the period tabs (`src/ui/kpi-nav.ts`) — the same kind of choice, so the same control, department first because it decides what the rest of the row means. They were their own band above the page until then, a third row of navigation under the top bar's own.

The page is laid out the way the PMD KPI page is, so the two can be read one after the other in the same meeting: period tabs and a From/To range, headline tiles, one table with a `TOTAL` under it, and a legend saying what every colour means. Assembly never contributes to PMD machine OEE, efficiency or shift sign-off totals.

**Every figure comes from `ASSY_CompletedJobs`** (`VITE_COMPLETED_JOBS_LIST` overrides the name): one row per order finished on a day, as Epicor reported it in `CompletedJobs.csv` and a supervisor confirmed who finished it on the Assembly board (below). A big order finished over several days has a row for each day — that is the record, not a duplicate — and is **one** order in every count. Two rows for the same order on the same day are one completion written twice; the newer stands. `ASSY_Planning` is not read here: an order leaves it once it is finished, so it cannot be the record of what was made.

Lines roll up the completions, and each line opens into the orders behind it; a per-person table and the list of completions sit underneath.

A **Names** column beside People shows who is on each line and each order. Pressing a name, or an order number, narrows the **Completions** list to it (press again, or ✕ Show all, to let go); narrowed to a person, the list adds their **Share** of each order — its Std h ÷ the people who finished it — which is what their By person row adds up. By person already shares every order equally among the people who finished it. Pressing a name also puts that person on the efficiency chart.

**By person** (left half) lists everyone on `ASSY_Operator` except supervisors and managers (by Position), with a **Leave** column: the days in the period the board has them on leave — booked annual leave (`PlannedAnnualLeave`) and days marked off on the board (`workerOnLeave` in the working plan, `ASSY_Plans`, read with the board's own plan codec). Somebody named on no confirmed completion is **On leave** when the board has leave for them in the period, else **No completion** (at work on orders not yet finished, or not recorded). The right half, **Efficiency**, charts the From–To range chosen at the top (Last 24h, Last Week or any range typed in) in buckets that suit its length: **days** for up to 14 days (a weekend day only when something was finished on it), **weeks** up to 26 weeks, **months** beyond — counting only the days inside the range; a week or month it holds only part of is marked `*`. The card is always exactly as tall as the By person table (its top and bottom line up with the table's), and how to read it sits under it on the page, as the notes do under By person; and drawn at its own size so its text matches the table: one line per Assembly line, or, with a person picked, that person beside the whole floor; hovering a week lists every line's value. Weeks rather than days, because a completion credits the day the order was finished and a daily line jumps between nothing and several hundred percent.

**On time** is judged once per order, against its **Due Date**, on the day it was finished in full (`JobCompleted`, the day the export's running total reached the order's quantity). On time% = orders finished in full in the period on or before their Due Date ÷ orders finished in full that have one. In the Completions list a part delivered after the Due Date is already **Late**; one before it is **In progress**.

**Last Week** is Monday to Sunday of the week before this one. **Last 24h** is the last working day before today — never today: yesterday on a normal morning, Friday to Sunday on a Monday (the same window the board's completed-orders dialog asks about). The period or range chosen is kept while MES is open, so going to PMD and back does not reset it. Each row's day is the one its `RecordKey` names (`Job|YYYY-MM-DD`, plain text); the `Date` column, which SharePoint returns shifted by the site's timezone, is only the fallback for a row without one.

| Column | Definition |
| --- | --- |
| Orders | Distinct orders with a completion in the period. |
| Qty / Std h | Epicor's quantity and standard hours (`LaborDtl_LaborQty`, `LaborDtl_LaborHrs` — standard hours, not clocked time). |
| People | Distinct people named as having finished them. |
| Person-days | Each person counted once for each day they are named on a completion. |
| Std h / person-day | Std h ÷ Person-days. |
| Efficiency | Std h / person-day ÷ 7.5 h (the 07:00–15:30 shift less morning tea and lunch). 🟢 ≥ 90% · 🟡 ≥ 75%. It counts **finished** work only: a day spent on an order finished on a later day earns nothing that day, so it reads low for anyone on long orders. |
| On time% | Orders finished in full in the period on or before their Due Date ÷ orders finished in full with a Due Date (see below). 🟢 ≥ 95% · 🟡 ≥ 85%. |

### Attendance — the timesheets behind efficiency

Payroll's weekly timesheet exports go in an **`Attendance`** folder beside the PMD `Planning.csv` (the folder `CompletedJobs.csv` is in), one workbook per pay run, e.g. `TimesheetReport-PayRun44.xlsx`. MES reads the **`Export`** sheet of every `.xlsx` (or `.csv` saved from it) in the folder — the 60 most recently changed — with its own reader (no spreadsheet library; the browser's own decompression). A line in two overlapping exports is counted once.

| Timesheet column | Read as |
| --- | --- |
| Employee Id | The person: matched to `ASSY_Operator.EmployeeId` (add a Text or Number column of that name and fill it in). Names are never matched — payroll's "CHANTHAN PEOV" is not the board's PreferName. |
| Start Date | The day. |
| Total Duration (else Duration, else Units in hours, else End − Start Time) | Hours. Paid time: the fixed 54-minute break is already out of it (07:00–15:30 = 7:36). Unpaid Break Duration is not taken off again. |
| Work Type | Any type naming **leave** or a **holiday** (Annual, Personal, Long Service Leave Taken, Public Holiday…) is leave: its days are leave days, its hours are not worked. Everything else (blank, Ordinary, Overtime…) is worked; the page lists any unusual worked type it counted. |
| Location | Worked hours at a location whose last level is **Direct** (`… / Assembly / Assembly Direct`) are **direct hours** — the efficiency denominator. **Indirect** hours are not counted (a person with only those is *No completion · indirect only*). |
| Status | Rejected, deleted or cancelled lines count for nothing. |

With timesheets for **every week** of the period chosen, **By person** shows **Direct h** and Efficiency = their Std h ÷ their Direct h, in place of Std h / day ÷ 7.5 h; otherwise it keeps the person-day measure and says so. Leave there is the board's and the timesheets' together; **On leave** means leave and no direct hour in the period, and someone at work without a confirmed completion shows their direct hours (*No completion · 38.0 direct h*).

The **Efficiency** chart is **Std h finished in `CompletedJobs.csv` ÷ hours**, by line — earned hours over attended direct hours, which needs no confirmation and so reaches back as far as both files do. The export's planner is the line it can name: TBP, UPL, ASSY (Assembly), TABLE, GENERAL; PMD is left out. **UPL is the three benches together**, because the export does not tell UPL-CUT, UPL-Gluing and UPL-SSS apart. A person's hours go to their line on the board (the saved plan's `workerLines`), else the first line their Skills name; hours of anybody with no `EmployeeId` match count for the whole floor only — the page names them, because their line then reads high. The hours are decided **day by day**: a day a timesheet covers uses the direct hours attended (solid point); any other day uses the **people the supervisor confirmed** on that day's completions **× 7.5 h** (hollow point; a bucket that mixes both says so in the tooltip). With a person picked, their share of confirmed completions over their direct hours, beside the whole floor (dashed). Hovering a point shows the Std h and hours behind it and which kind of hours they are.

The headline tiles and the line table keep the person-day measure for now.

Per person, an order's Std h is shared equally among the people who finished it. **Order done** in the completions list marks the day the export's running total reached the order's quantity (`JobCompleted`).

The board's own shift entries (Output, Reject, Booked h…) stay in `ASSY_Planning` for the board; they are no longer on this page, because they leave with the order.

### Completed orders — who finished what

**TBP is not assessed** while its equipment waits to be replaced: the dialog asks about no TBP order (by its planner, or by the board's line for it), nothing of TBP is written to `ASSY_CompletedJobs`, and KPIs · Assembly leaves TBP out everywhere — its standard hours in `CompletedJobs.csv`, the hours of people whose line is TBP, any older TBP completion, and its people in By person. A finished TBP order still leaves `ASSY_Planning` as any other does. To measure it again, remove it from `NOT_ASSESSED_PLANNERS` (`assembly/src/engine/assembly/completedJobs.ts`) and `NOT_ASSESSED` (`src/core/assembly-history.ts`).

From **`CompletedJobs.csv`** — Epicor's labour entries of finished quantities (`LaborDtl_JobNum`, `LaborDtl_CreateDate`, `LaborDtl_LaborQty`, `LaborDtl_LaborHrs`, `Calculated_PlannerID`, `JobAsmbl_PartNum`, …), exported to the same folder as the PMD dashboard's `Planning.csv` (override with `VITE_COMPLETED_JOBS_CSV_PATH` / `_URL`).

1. Every morning the Assembly board reads the file and takes **every planner but PMD** (moulding records its own operators) for the days from the last working day up to yesterday — Friday to Sunday on a Monday, and across a public holiday or RDO from the FactoryCalendar. An order reported twice in a day is one completion.
2. The **✓ Completed** chip in the board header says how many are waiting; the dialog opens by itself once a session when a signed-in supervisor has any. The orders are **grouped by line** in the board's own line order. Each order offers its **line's group on the board for that day** — everybody the board places on that line (the supervisor's line moves, else the crew of the day, else the roster's first skill; bench people count for their lane) — **less anyone on leave that day** (booked leave or marked off on the board), who are listed under the names as *On leave*. A line the board has nobody grouped on falls back to the board's crew on the order that day, then the names on the order's `ASSY_Planning` rows. The groups are the board's as they stand now, so somebody moved to another line since the completion day is offered on their new line. Each line heading shows that group (on-leave names struck through): a name can be dragged onto any order, names can be added to or taken out of the group, and **Fill line** puts the group on every order of the line not yet confirmed. Names nobody has changed are offered afresh whenever the roster, the line groups or the leave change; names a supervisor has changed are kept. The supervisor reviews and confirms a line at a time (**Confirm line**), one order, or all; typing or scanning an order number and pressing **Enter** confirms that order as shown.
3. The answer is written as a row of its own in **`ASSY_CompletedJobs`** (same columns as `ASSY_Planning`), keyed `RecordKey = Job|YYYY-MM-DD` and looked up by that key before its Date: `Title`, `Date`, `Line`, `Operators`/`OperatorIds` (who finished it), `Complete` = `ShiftOutput` = Epicor's quantity that day, `OrderQty` and `PlannedHours` (written so that Complete × PlannedHours ÷ OrderQty is exactly Epicor's hours), `RemainingQty`, `DueDate`, `JobCompleted`/`CompletedAt` (the day the running total reaches the order's quantity), and the eight completion columns `EpicorQty`, `EpicorHours`, `EpicorPartNum`, `EpicorCompletedAt`, `CompletedBy`, `CompletedByIds`, `CompletionConfirmedBy` (the signed-in SharePoint user) and `CompletionConfirmedAt`. Confirming again writes over the same row. Line, Due Date and order quantity come from the board while it still holds the order, else from the order's `ASSY_Planning` rows. The eight completion columns are added the first time a supervisor confirms (session mode); a column the list lacks otherwise is skipped rather than failing the confirmation.

4. **KPIs · Assembly** reads `ASSY_CompletedJobs` (see *Last 24h* above). A row without a `RecordKey` has its `Date` read in the **site's** time zone (`_api/web/RegionalSettings/TimeZone`), never the browser's: a Date cell is the UTC instant of the site's midnight — on this tenant (Auckland, UTC+13 in summer) 19 November is `2026-11-18T11:00:00Z`, which a Sydney browser reads as the 18th. The list is asked for a day more on each side and each row's own day decides whether it is in the window. `DueDate` is read the same way, so On time is not judged a day early.

`LaborDtl_LaborHrs` is read as **standard** hours: in every sample the hours are the quantity times one fixed rate per part (100 pieces 12.5 h, 50 pieces 6.25 h).

### Finished orders leave `ASSY_Planning`

`ASSY_Planning` (once `ASSY_Production`; columns unchanged; `VITE_PLANNING_LIST` overrides the name) is kept in step with `Planning1.csv` and the board as before. Once `CompletedJobs.csv` shows an order's **whole quantity** reported — the export's total for the order across all its days, against the board's order quantity, or the largest `OrderQty` on its rows for an order the board no longer holds — the sync moves all its rows to the **site recycle bin** (restorable) and stops writing it. Two exceptions: an order with a completion in the confirm window that nobody has confirmed yet is kept until it is (the dialog reads its line, Due Date and crew from there), and support orders are never taken off this way.

A row another open board wrote while a pass was running answers **409 Save Conflict** (Level the week moves every order, so its pass is long). The row is read again and written over at its new version — the columns follow the plan every board shares — unless its shift figures changed meanwhile: that is somebody's newer booking, so it stands and the next pass reads it afresh. A conflict no longer stops the rest of the pass. The sync waits for `CompletedJobs.csv` to be read before it writes, so a finished order is not reopened only to be taken off again.

Thresholds are fixed and printed on the page, not editable: PMD's are argued over in the meeting because its presses are compared with one another, and there is no equivalent argument here yet.

## SharePoint schema

`config/assembly-lists.json` is the exact internal-name/type contract.

| List | Purpose | Key |
| --- | --- | --- |
| ASSY_Operator | Real operator names (Title), Position, Skills, Supervisor, OnShift, PlannedAnnualLeave and EmployeeId (payroll's, to match the timesheets) | SharePoint item ID |
| ASSY_Plans | Shared working plan, crew windows, pinned starts, output history, ignored orders and the Crew orders rules, plus one read-only row per day of history; a plan too large for one row also has part rows | Unique Title = current, day-YYYY-MM-DD, or `<plan>#<generation>#<n>` for a part |
| FactoryCalendar | Every day the factory is shut beyond weekends — the public holidays and the RDOs; once read, the whole calendar (the worked-out NSW holidays only stand in when it cannot be read): Date (date only) and Name ("RDO" or the holiday's name). Written from Crew capacity → Closed days the moment a day is added. | SharePoint item ID |
| ASSY_Planning | The board's planning list (once ASSY_Production): open orders' daily rows — quantities, booked labour hours, crew snapshot, dates, completion and pause details. Finished orders leave it. | Unique RecordKey |
| ASSY_CompletedJobs | Confirmed completions — what KPIs · Assembly reads: one row per order per day finished in Epicor, with who finished it (same columns as ASSY_Planning plus `EpicorQty` … `CompletionConfirmedAt`) | Unique RecordKey = `Job|YYYY-MM-DD` |

`ASSY_Planning.RecordKey` is the row's identity and nothing else: the board generates it when a shift first saves that day's entry, both sides carry it, and it is never rebuilt from anything. It used to be `Job|YYYY-MM-DD`, which tied a row's identity to a date — the one field on the record that can be read two ways, because a SharePoint date column answers in the site's timezone rather than the shift's. Keep the unique index on it. Rows opened by the sync before any booking (the blank row an order starts with) still take `Job|YYYY-MM-DD`, which both sides can work out; the first real entry for that day claims the row and writes its own key over it.

**Add the `BookedHour` column before deploying this build.** Every column the sync writes must exist, so until it does the write fails with `Missing SharePoint column: BookedHour` in the board's banner and no production is recorded. `config/assembly-lists.json` carries it; re-run `provision-assembly.ps1 -Apply`, or add a Number column named exactly `BookedHour`.

Planning1.csv, JobMaterialReq.csv and OnHandInventory.csv remain upstream files in the document library. No additional material List duplicates them. On-hand inventory is availability evidence, not a stock reservation; picking must still be confirmed against warehouse stock.

The provisioning script inventories existing Lists, adds missing fields, enables versioning/indexes and rejects incompatible types. It does not delete items or convert existing columns. Existing duplicate or blank keys must be resolved before unique constraints can be enabled.

Use an IT-approved Microsoft Entra application registration with delegated SharePoint permissions and your own Manage Lists permission on this site. Browser authentication remains subject to company Conditional Access; do not use copied cookies or another identity. CLI for Microsoft 365 requires an app ID configured through its settings/environment or supplied explicitly.

With Node 22+ and CLI for Microsoft 365 installed, sign in using the company-approved app, then review and apply:
```powershell
m365 login --authType browser --appId <approved-app-id> --tenant 6d8c062c-6bdc-4fb9-87dc-08aea00c443f
./scripts/provision-assembly.ps1 -SiteUrl https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
./scripts/provision-assembly.ps1 -SiteUrl https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU -Apply
```

These scripts and schema definitions do not certify that a site's Lists have already been provisioned.

## Configuration

Both builds read the MES root .env.local. Retain existing PMD settings and add the Assembly file paths. Verify the actual document-library locations before deployment; the defaults below are examples, not discovered locations.

```dotenv
VITE_BACKEND=sharepoint
VITE_SITE_URL=https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
VITE_ASSEMBLY_PLANNING_CSV_PATH=/Shared Documents/Planning1.csv
VITE_JOB_MATERIAL_CSV_PATH=/Shared Documents/JobMaterialReq.csv
VITE_ON_HAND_INVENTORY_CSV_PATH=/Shared Documents/OnHandInventory.csv
# Optional; defaults to PODetail.csv in the same folder as Planning1.csv
VITE_PO_DETAIL_CSV_PATH=/Shared Documents/PODetail.csv
VITE_PRODUCT_LINES_PATH=/Shared Documents/product-lines.v3.json
# The PMD lane's press plan: the PMD dashboard's Planning.csv. Defaults to
# VITE_PLANNING_CSV_PATH, which is that file; a /sites/... path is server-relative.
VITE_PMD_PLANNING_CSV_PATH=/sites/<PMDsite>/Shared Documents/PMD/Planning.csv
# Optional overrides of the list names
VITE_PRODUCT_DIE_COLOR_LIST=PMD_ProductDieColor
VITE_FACTORY_CALENDAR_LIST=FactoryCalendar
VITE_PLANNING_LIST=ASSY_Planning
VITE_COMPLETED_JOBS_LIST=ASSY_CompletedJobs
VITE_ASSEMBLY_PLAN_LIST=ASSY_Plans
# KPIs · Assembly: payroll's timesheets and Epicor's export. Default to the
# Attendance folder and CompletedJobs.csv beside VITE_PLANNING_CSV_PATH.
VITE_ATTENDANCE_FOLDER=/sites/<PMDsite>/Shared Documents/PMD/Attendance
VITE_COMPLETED_JOBS_CSV_PATH=/sites/<PMDsite>/Shared Documents/PMD/CompletedJobs.csv
# Every MES screen reloads itself after this many minutes (at a quiet moment:
# no field focused, no dialog open, nobody touching it for 2 minutes). 0 = off.
VITE_AUTO_REFRESH_MINUTES=60
```

Do not reuse PMD's VITE_PLANNING_CSV_PATH for Assembly. A production Assembly build selects planning-csv and cookie-authenticated SharePoint REST when VITE_BACKEND=sharepoint. No Graph bearer token is bundled for this path. Keep the existing VITE_SUPERVISOR_PASSWORD configuration for the host operational gate.

## Benches: UPL-SSS and UPL-Gluing are routed lines

Both lanes are three benches on the floor — **Foaming, Sewing, Stapling** — and the export gives one order with one line and one figure for the hours, so four people allocated to "UPL-SSS" said nothing about which bench any of them was standing at. Each lane now draws its three benches indented under it, and each bench holds orders, takes people and draws bars of its own.

What a bench is *not* is a second order. An order has one number and one set of quantities; what changes as it is built is **where it is on its route** — operation 10, then 20, then 30 — which is how every ERP models this and how the floor talks about it. So the board stands each order at the one bench working it now, marked `2/3 Sewing` on the row, and moves it on when that operation is finished. A bench the order has not reached yet has nothing to allocate people to, because you cannot staple a cover nobody has sewn.

**How the route is worked out.** **UPL-SSS** foams to stock: an order consuming foam (`FOAM`, by `domain/lineRules`) has a single foaming operation. Every other order on the lane is sewn and then stapled, at **half an hour a unit** for the sewing — and those hours come **out** of the order's figure rather than being added to the lane, so 26.3 h becomes 4.5 + 21.8 because the sewing was always inside it. **UPL-Gluing** does all three against one order: the hours split into even thirds, foaming and sewing wait for nobody and are worked side by side, and stapling waits for both. Gluing is the one place an order is at two benches at once, which is what two crews working it at once means.

**How it moves on.** An operation is finished when the quantity confirmed against it reaches the order's, or when the shift closes it explicitly. The order is then at the next bench immediately — on the board, in the pool, in the crew picker — without waiting for the next export. Crew is allocated per operation, so moving on is a fresh allocation: that is the point of the split.

**The units are received once, at the last operation.** A booking at any earlier one writes `WorkType=WIP`, its LaborHours and **zero** for ShiftOutput, Complete, Reject and Rework; the order's own OrderQty, RemainingQty and standard hours are on every row of it because they are the *order's*, and the record carries one row per order per operation per day. Nine covers sewn are the same nine the stapling bench will finish. The KPI page reports those hours in their own **WIP h** column: they are real hours that bought a half-built order, so they are neither output nor support, and they are charged against the order when the last operation reports it finished.

**Dates.** A row's bar is its operation, because that is what the people on it are doing. The order's **expected finish** is the bar plus the benches still in front of it, estimated at the crew on this one — an order whose sewing lands on Friday is not an order ready on Friday, and anything waiting for that order waits for the whole route. A bench's queue likewise counts the hours routed to it that have not arrived (`LineLoad.incomingHours`), so the last bench of a busy line does not read as the emptiest place in the factory.

**Skills.** A roster naming the **lane** qualifies somebody for any of its benches, and the crew picker on a bench offers everyone standing on the lane.

**Every line can be renamed.** Double-click the name on its row (supervisor). The name is part of the planning — the whole floor reads the same one — so it is published by Save with the rest, and an empty name puts the built-in one back. Renaming does not change the key anything is stored under.

## Incremental planning and conflicts

Refresh reconciles jobs by job number and retains existing crew and pinned dates. Orders absent from a partial export keep their plan for 14 days. Date sorting leaves PMD source order unchanged; daily Assembly filtering and counts exclude PMD. Crew orders fills unallocated eligible orders; it does not reset already allocated work. What it does is set by the **Crew orders rules** (Review orders → Crew rules, or Crew capacity), saved in the plan and shared on Save: order-number prefixes it never crews (default `SUNF`, Epicor's unfirm jobs), released orders only (default on), an optional Due Date horizon, the Due Date bands crewed in turn (default 14 / 28 / 56 days), team size by remaining hours (default 1 up to 7.5 h, 2 up to 50 h, 3 beyond), per line whether it is crewed automatically or by hand and an optional fixed team (default Table 3), and whether a person's trade must match the bench (default on). Within those, people come from the line's current roster, skilled first, then nobody marked away during the stretch the order runs, then whoever is free soonest. The button's count and the panel list only what the rules let it crew; orders the rules leave alone are listed last with the reason, and after a run the panel says how many were crewed and which are still waiting for want of a free person with the trade. Which line an order goes to comes from ERP, then `product-lines.v3.json`, then its BOM — see [Operational lines and support work](OPERATIONAL-LINES.md); a supervisor's own move survives refresh. Real material links determine predecessors.

A component an order already has is not a component it waits for. Free on-hand is allocated across the open orders before the wait-for graph is read — earliest need date first (the order's own start, else its due date, ties on job number), each order drawing from what the ones before it left, so forty covers cover one order for forty or two for twenty and never two for forty. An order the shelf covers in full waits for nobody; part of a requirement buys part of the run, and the bar is pulled back from the component's date by the work that stock supports, so it runs out exactly as the rest lands. A material row with no quantity on it cannot be netted and is treated as covering nothing — a missing column must not free an order. `OnHandInventory.csv` remains availability evidence and not a reservation: the allocation says who has first claim on the board, and the pick is still confirmed against the warehouse.

Where several open orders build the same part they are alternatives, not a queue: the consumer needs one of them, so it waits for the first that can supply it rather than the last. Ready means the board's own Expect Date for that order — the result of actually scheduling it — and a batch with no honest date is skipped in favour of one that has a date. Only when no batch of the part has been planned at all does the consumer stall, which the row says. Different components are all needed, so across parts it is still the latest that governs.

Planning is published, not autosaved. Line placement, crew, pinned starts, weekend and double-booking approvals, added lines and the line order leave a browser only when **Save** is pressed; until then they are a draft held on that screen. A refresh — the Refresh button or the five-minute timer — takes the saved plan back and drops that draft, as does leaving the page. Whoever saves last is the current plan. Shift records are not gated behind Save: production start, the shift's own bookings (Shift output, Reject, Rework, Complete, Job completed, pause and notes), who was marked off for the day and the last-seen days are written as they are made, onto whatever planning is current at that moment, so an entry is never lost because nobody pressed a button.

Somebody not at work is a day they give their orders nothing. Planned leave and OnShift come from `ASSY_Operator`; **Not in today** on the operator's own popup is the supervisor's record of a phone call, and it is dated so a known absence can go in ahead of the day; dragging the name into the **On Leave** roll in the crew column writes the same thing in one gesture, and dragging it back into **Free** says they turned up after all. The schedule then runs the order on the hands that are there — the bar lengthens with one fewer, and shows a gap when the last one goes — and the load histogram, the crew suggestion and the pickers all stop offering that person. Nobody is taken off an order for being away: a half-built order belongs to whoever was building it, so the chip is marked instead, and the **On Leave** roll in the crew column names who is out and counts the begun orders nobody else is on.

ASSY_Plans stores a versioned JSON snapshot. An ETag mismatch stops the shift-record write and production sync; reload the saved plan before editing again. Failed reads never save an empty replacement.

One row's PlanJson holds 60,000 characters. A plan that fits is stored as plain JSON, as before, so a screen on an older build still reads it. A plan that does not is deflated and base64'd (typically to about a fifth) inside an envelope in the same row; if it still does not fit, the packed text is split into part rows titled `current#<generation>#0`, `#1`, … and the plan's own row names them by generation, count, length and checksum. The parts are written first and the plan's row is updated last, at the version it was read at — that one ETag-guarded update is still the moment a save lands or does not. A refused update takes its new parts back; the parts a save replaced are removed after it, and parts left by a write that never finished are removed after an hour. A reader that finds a part missing (another screen saving at that moment) reads the plan's row again. Rows are read by Title, which `config/assembly-lists.json` already makes indexed and unique; part titles carry their generation, so they never collide. An older build that meets a packed plan refuses to edit ("Saved plan is invalid") rather than overwrite it — deploy this build to every screen. A failed write now says "Plan not saved" (not "not loaded"): nothing on SharePoint was written over, and the screen saves nothing more until it reads the plan again.

On the first write of each new day — a Save or a shift entry, whichever touches the plan first — the previous day's last stored plan is filed under `day-YYYY-MM-DD` beside `current`, giving one read-only row per day the board was used. That row holds what the day closed as, which is also the state the next day opened on — the board is not reset overnight. A day already filed is never rewritten, so a second screen or a tab open across midnight cannot overwrite it with a staler copy; a day that cannot be filed is reported and skipped rather than stopping the working plan from saving. Nothing deletes these rows: at roughly 250 rows a year they stay well inside a List, and they are the only history the board has. Read one back with `repo.load('day-YYYY-MM-DD')`.

A legacy browser-local plan on a different origin is not automatically accessible to MES. Preserve that plan before first production rollout and migrate it to the shared working plan; do not assume another browser or website shares localStorage. New-order highlight history remains device-local; operational crew/date/output state is shared.

## Build and release

Use Node 22 or newer.
```sh
npm ci
npm --prefix assembly ci
npm run typecheck
npm test
npm --prefix assembly test
npm run build
npm run deploy
```

Deploy uploads both applications, all lazy chunks and nested asset folders. The MES version marker is uploaded last. The SPFx shell continues loading SiteAssets/pmd/assets/index.js and index.css, so this integration does not require a new SPFx package.

Before rollout, verify actual CSV paths, existing field types/keys, roster names and permissions on the signed-in site. Test a new job refresh, a second-session save conflict, barcode lookup and an Assembly daily entry appearing in KPIs. Local mock checks cannot validate tenant permissions or real file contents.


See [Operational lines and support work](OPERATIONAL-LINES.md) for the eight lines, how a part is routed to one, and the additional support fields.

### Imported list columns and operator moves

Assembly reads each list's column metadata and maps display names to internal
names for both reads and writes. Lists imported from a spreadsheet can therefore
keep names such as field_1 internally. PreferName is the roster display name;
blank values fall back to the existing operator name. Skills accepts text,
multiple choices, and the current line labels. Missing skills leave a person in
General until the supervisor places them; they do not grant every skill.

Sign in through the MES top bar's Supervisor button — the only one there is —
to move operators **or orders**.
Drag a name onto a line or click the name and use Move to line. This changes
the saved roster placement without rewriting the operator's skill
qualifications. Recorded shift history is retained. The same gate now covers
moving an order — dragging a bar to a new day or line, filing an unplaced order
onto a line, and releasing a pinned start — because each writes the shared plan
and the pinned day goes out to the production list. It remains an operational
gate on one compiled-in password, not access control: SharePoint's permissions
on ASSY_Plans, ASSY_Planning and ASSY_CompletedJobs are what actually decide who may write, and
its Modified By is what records which supervisor did. See
`assembly/docs/board-interaction-rules.md`. A missing production column stops that sync at the first
permanent error; correct the list schema and retry. No columns or list records
are automatically created or deleted by field discovery.
