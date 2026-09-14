# KPI plan and efficiency

The KPI page reads signed production records. Every period uses the saved
PMD_Production.ShiftTarget as Plan, grouped by Machine + Shift + Job.
Current Planning.csv start/due windows are not a historical plan source.

- Output displays total Good / total ShiftTarget at machine, shift, job,
  category and floor levels. Count each snapshot once, even when repeated
  across slots. A canonical zero target overrides a stale positive slot value.
- Last 24h Schedule Adherence is sum(min(Good, ShiftTarget)) / sum(ShiftTarget).
  This measures target fulfilment, not whether the planned start time was met.
- Wider periods retain Vs Target: sum(Good) / sum(ShiftTarget), without capping.
- Missing targets are not zero. Incomplete totals show /— and no percentage;
  the tooltip reports coverage and the known subtotal. An explicit zero-output
  tuple with a positive target still counts as a miss. Die-change pseudo-orders
  have no piece plan and do not reduce coverage.

For example, targets 256, 256 and 259 with Good 134, 0 and 119 produce
253 / 771 and 33% adherence when all three target snapshots exist.
Over-production on one job cannot hide another job's miss in Schedule Adherence.

Efficiency is sum(Good * hours-per-piece) / sum(R hours). Prefer the saved
CycleTime; otherwise use a matching machine/job planning standard, including
the existing HS-to-Hstamp alias. Keep source precision until the final ratio.
A running job with no finite standard makes the aggregate unavailable, rather
than adding its runtime to a denominator with no matching standard hours.
The hours columns still show all recorded runtime. Co-running jobs retain their
own output and runtime. Machine identity is part of every quantity tuple, so
the same job on two presses is never collapsed into one set of counters.

Legacy VSPLAN sign-off snapshots retain their existing write behaviour for
compatibility. The KPI page calculates from ShiftTarget and does not read
VSPLAN as its comparison source. No historical SharePoint rows are rewritten.
