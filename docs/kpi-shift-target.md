# KPI plan and efficiency

The KPI page reads signed production records for output. Its plan depends on
the period:

- **Last 24h — Schedule Adherence** plans from Planning.csv, for every
  finished shift of the window, whether the press ran or not. A press
  planned for a shift and left idle (no crew, no material) shows 0 against
  its plan instead of dropping out of the denominator.
- **Wider periods — Schedule Adherence from the saved plans.** Planning.csv
  is overwritten on every export, so it is not a historical plan source for
  weeks and months. Each sign-off saves the shift's Last 24h figure instead
  (PMD_Production.ScheduleAttain and SchedulePlan), and a wider period adds
  those up.

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
- **Credited** = min(Good, plan) per order, so over-producing one order
  cannot hide missing another.
- Adherence = Σ credited ÷ Σ plan.

Lines outside the comparison:

- Output of an order Planning.csv holds for another press or shift is
  *unscheduled*: neither credited nor asked for; the tooltip reports it.
- Output of an order Planning.csv no longer holds (Epicor drops finished
  jobs) uses the ShiftTarget saved when it ran.
- A shift with unsigned records and no signed ones is *awaiting sign-off*:
  its plan stays out until it is signed, so a shift waiting for its
  supervisor is not scored as a shift that never ran.
- A planned order with no rate, or a run order with no saved ShiftTarget,
  has no known quantity: the total shows /— and no percentage; hover for
  coverage.

Example (850T, 22 Sept 2026, planned 18:14 → 08:33 at 33/h, not run):
Afternoon asks 30 + 60 + 34 = 124, Night 66 + 100 + 60 = 226 — 0 / 350, 0%.

Known limit: Planning.csv is the latest export. If the planner reschedules a
missed order before the page is read, the old window is gone and so is that
shift's plan.

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

Known limit: a press planned for a shift and never run has no row to save a
plan on. Last 24h counts it as 0 against its plan; a wider period cannot see
it.

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
