# KPI plan and efficiency

The KPI page reads signed production records for output. Its plan depends on
the period:

- **Last 24h — Schedule Adherence** plans from Planning.csv, for every
  finished shift of the window, whether the press ran or not. A press
  planned for a shift and left idle (no crew, no material) shows 0 against
  its plan instead of dropping out of the denominator.
- **Wider periods — Vs Target** use the saved PMD_Production.ShiftTarget of
  what ran, grouped by Machine + Shift + Job. Planning.csv is overwritten on
  every export, so it is not a historical plan source for weeks and months.

Every figure is a sum of Machine + Shift + Job plan lines
(`AttainmentTuple` in `src/core/kpi-attainment.ts`), so machine, shift,
order, category and floor totals cannot be judged by different rules.

## Schedule Adherence (Last 24h)

For each finished shift and each order Planning.csv has on the press in it:

- **Crewed shifts.** The "no of shift" column lists the shifts the press is
  crewed for — M (Morning = Day), A (Afternoon), N (Night); "MAN" is all
  three. A shift outside the list is not planned, however far the order's
  Start–Due window stretches across it. A blank or unreadable value means no
  restriction.
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

## Vs Target (wider periods)

Σ Good ÷ Σ ShiftTarget, uncapped. Count each snapshot once, even when
repeated across slots. A canonical zero target overrides a stale positive
slot value. Missing targets are not zero. Incomplete totals show /— and no
percentage; the tooltip reports coverage and the known subtotal. Die-change
pseudo-orders have no piece plan and do not reduce coverage.

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
compatibility. The KPI page does not read VSPLAN as its comparison source.
No historical SharePoint rows are rewritten.
