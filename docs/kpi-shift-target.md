# KPI plan and efficiency

The KPI page reads signed production records for output. Its plan depends on
the period:

- **The plan of record — PMD_ShiftPlan.** Every press in every shift has its
  plan kept once the shift is under way (see below), with its die changes
  given their four hours as on the Assembly board. Last 24h and wider periods
  alike judge a press-shift by that row, whether the press ran or not: a
  press planned for a shift and left idle (no crew, no material) shows 0
  against its plan instead of dropping out of the denominator — and so does
  one that booked work nobody has signed off yet.
- **Without a kept plan** (shifts before PMD_ShiftPlan held every press):
  Last 24h plans from Planning.csv as it stands, and a wider period adds up
  what each sign-off saved (PMD_Production.ScheduleAttain and SchedulePlan).
  Planning.csv is overwritten on every export, so it is not a historical plan
  source — which is why the plan is kept.

**The plan never leaves the denominator.** Whatever happened on the floor —
press idle, operator never booked, supervisor never signed — the pieces the
plan asked for stay in Σ plan, and only signed Good is credited against them.
Example, Monday 12 Oct 2026: MES had rows for 902 planned pieces, but the plan
was 1,231 — 1300T's night (128, booked and not signed) and 320T's night (200,
nothing booked) were missing. Credited 615: 50%, not the 68% the page showed
before.

Every figure is a sum of Machine + Shift + Job plan lines
(`AttainmentTuple` in `src/core/kpi-attainment.ts`), so machine, shift,
order, category and floor totals cannot be judged by different rules.

## Schedule Adherence (Last 24h)

For each finished shift and each order Planning.csv has on the press in it:

- **Crewed shifts.** The "no of shift" column lists the shifts the press is
  crewed for — M (Morning = Day), A (Afternoon), N (Night); "MAN" is all
  three. A shift outside the list is not planned, however far the order's
  Start–Due window stretches across it. A blank or unreadable value means no
  restriction. The list is for weekdays.
- **Weekend overtime.** A Saturday or Sunday (07:00 to 07:00 the next
  morning; Friday's night is a weekday shift, Sunday's is weekend) is worked
  a whole day at a time, all three shifts, or not at all. Which days were is
  read off the order itself (`weekendDaysWorked`): the work is
  Calculated_RemainingQty ÷ JobOper_ProdStandard hours; take away the weekday
  shifts of its Start→Due window that "no of shift" crews, and what is left
  had to be done on the weekend — about nothing, no day; about 24 h, one day
  (the earlier); about 48 h, both. Up to 2 h short is the planner's own
  allowance for an insert or colour change and is never read as overtime. A weekend day not worked is not planned.
  An order with no rate keeps its "no of shift" on weekends too.
- **Plan** = the order's share of the shift's planned runtime ×
  JobOper_ProdStandard (`plannedRuntimeForShift`), never more than is left of
  the order quantity after the earlier shifts of its window were asked for
  theirs. Epicor's window includes setup time, so hours × rate alone would
  ask for more pieces than the order holds.
- **Whole pieces** (`wholePieces`): rounded down, except that within a
  hundredth of a piece of a whole one is that piece. Epicor keeps the cycle as
  hours per piece to 4–8 decimals, so 18/h comes back as 17.99999856/h and
  four hours of it as 71.99999 — 72, not 71. ShiftTarget uses the same rule.
- **Credited** = min(Good, plan) per order, so over-producing one order
  cannot hide missing another.
- Adherence = Σ credited ÷ Σ plan.

Lines outside the comparison:

- Output of an order Planning.csv holds for another press or shift is
  *unscheduled*: neither credited nor asked for; the tooltip reports it.
- Output of an order Planning.csv no longer holds (Epicor drops finished
  jobs) uses the ShiftTarget saved when it ran.
- A shift with unsigned records and no signed ones is *awaiting sign-off*:
  its plan counts and nothing is credited until it is signed — the KPI page
  credits signed output only. The row is tagged **UNSIGNED** so it is not
  read as a press that never ran. (It used to be left out of both sides,
  which let a shift nobody signed take its plan out of the comparison.)
- A planned order with no rate, or a run order with no saved ShiftTarget,
  has no known quantity: the total shows /— and no percentage; hover for
  coverage.

Example (850T, 22 Sept 2026, planned 18:14 → 08:33 at 33/h, not run):
Afternoon asks 30 + 60 + 34 = 124, Night 66 + 100 + 60 = 226 — 0 / 350, 0%.

A press-shift with a kept plan in PMD_ShiftPlan (see below) is planned from
that row, order by order, rather than from Planning.csv as it stands now.

Why: Epicor redraws the past on every export. An order under way is put to
start at the export's "now", so the 27 Oct 07:00 export moved 1600T's
SFM507844 out of all three shifts of 26 Oct, and judged by that file the
1600T's whole day read as unplanned. The kept plan is the plan as it stood
while the shift ran.

## Wider periods — the plans saved at sign-off

Two optional Number columns on PMD_Production, written at every sign-off onto
each order row it signs:

- **ScheduleAttain** — the machine-shift's Schedule Adherence %, exactly as
  Last 24h works it out (`scheduleSnapshotForShift`), to two decimals. Blank
  when nothing was planned on the press in the shift. The column may be a
  plain number (87.5) or one shown as a percentage (0.875); the app reads
  which from the column's settings.
- **SchedulePlan** — the pieces that plan asked for. 0 = nothing planned.

Both are the whole machine-shift's figures, not the order's: a shift with
three orders carries the same two numbers on all three rows (Power BI: take
one row per machine-shift, never sum them).

A percentage alone cannot be added up — 95% of a 20-piece plan and 60% of a
5,000-piece plan are 60% together, not 77.5% — hence the plan beside it:

  Adherence = Σ (ScheduleAttain × SchedulePlan) ÷ Σ SchedulePlan

which is the Last 24h formula over more shifts.

Rules:

- The shift is judged whole, up to its end, even when signed before it ends.
- Only signed output is credited, as on the KPI page: the orders already
  signed plus the ones signing now. Orders signed at different times each
  carry the figure as it stood then; the KPI page reads the last-signed one.
- Not written when the shift could not be read at sign-off, or when a planned
  order has no rate (its quantity, and so the plan, is unknown).
- A re-sign-off after Epicor has dropped every order of the shift from
  Planning.csv keeps the plan saved the first time.
- Shifts signed before the columns existed use their ShiftTarget, capped per
  order — the rule Last 24h uses for an order Epicor has dropped.
- Before SchedulePlan exists on the tenant, shifts save only their %. The
  page then averages the machine-shifts (each counts once) and says so in
  the tooltip, all or nothing across the page.
- Order rows show output only: a shift's plan cannot be shared out between
  its orders after the fact. A shift's plan counts in the category of the
  order that made most of it.

## The plan of record — PMD_ShiftPlan

Every press in every shift gets one row (`shiftPlanChanges`):

- **When.** Once the shift is under way — 30 minutes in, room for an export
  made at the shift change to land — by the first device that writes (an
  iPad, or a supervisor signed in; `ui/shift-plan-keeper.ts`, checked every
  ten minutes). Every sign-off of the shift keeps the presses still missing
  a row, for a shift nobody had a device open in — by then Planning.csv may
  already have moved on, which is why it is not left to sign-off.
- **What.** The press's plan for the whole shift (`shiftPlanFor`): each order
  planned there, in the shifts its "no of shift" is crewed for, asked for its
  share of the shift × JobOper_ProdStandard, up to its quantity, with the
  hours it was to run. Die changes first, as on the Assembly board
  (`pressRunsAfterDieChanges`): an order on a different die from the one
  before it on the press (PMD_ProductDieColor; an unknown die counts as
  different) waits four hours for the change, and a press's first order in
  the file starts with one unless it is under way, starts at the export's
  "now", or the press was last running its die (its records from the shift
  before). The hot-stamp press has no dies. A press with nothing planned is
  kept too, at 0 — output there is outside the plan. A press with a planned
  order that has no rate keeps nothing (its quantity is unknown) and falls
  back to Planning.csv.
- **Never rewritten.** Two devices keeping at once can each write a row for
  a press; the next keep deletes the later one, and readers take the first.

Judging a shift by its row (`keptPlanTuples`): per order, credited =
min(signed Good, plan); output on an order the row does not have is
unscheduled. The plan is shared down only when the shift booked more
changeover allowance and smoko than the plan left room for (the rule
Planning.csv's plan is judged by). Sign-off saves that same figure to
PMD_Production.ScheduleAttain / SchedulePlan (`keptPlanSnapshot`).

A wider period counts a kept shift the same way (`keptShiftTuples`), a press
with nothing signed at its plan with nothing credited. Without a row, a
signed shift uses what its sign-off saved and an idle one what Planning.csv
still holds (`idleShiftTuples`) — a fallback that loses plans the further
back the shift is.

Known limits: a shift with no device open and nobody signing keeps no plan.
Order rows of a wider period still show output only.

## Efficiency

Efficiency is sum(Good * hours-per-piece) / sum(R hours). Prefer the saved
CycleTime; otherwise use a matching machine/job planning standard, including
the existing HS-to-Hstamp alias. Keep source precision until the final ratio.
A running job with no finite standard makes the aggregate unavailable, rather
than adding its runtime to a denominator with no matching standard hours.
The hours columns still show all recorded runtime. Co-running jobs retain their
own output and runtime. Machine identity is part of every quantity tuple, so
the same job on two presses is never collapsed into one set of counters.

Legacy VSPLAN sign-off snapshots retain their existing write behaviour for
compatibility (an older formula). The KPI page does not read VSPLAN; it reads
ScheduleAttain / SchedulePlan. No historical SharePoint rows are rewritten.
