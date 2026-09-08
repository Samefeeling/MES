# Board interaction rules

## Date filtering

The board opens on **All orders**. The header carries the two windows — All
orders and 5 working days — and each timeline date has an order-count button:
select it to show orders with work on that day, select it again to return to
the window that was showing before.

A narrowed board also keeps whatever the shown orders are waiting for, up the
whole chain. The press job for a shell usually ran before this week, so no
date window would pick it, and the arrow between the two is drawn only where
both bars are on screen.

Counts use positive scheduled crew hours or recorded production output, once
per order. Idle gaps, unstaffed orders and unapproved weekends do not count.
PMD context orders use their source bars because their crews are managed
outside assembly. Counts include collapsed lines and use the same rows as
the filter. Historical results only include orders still loaded on the board;
this is not a complete production-history report.

## Row order

Initial display sorts each line by ascending start time. Editing starts,
changing crews and background recalculation preserve existing row order.
New orders append to their line; removed orders disappear. Filtering does
not discard the full row-order snapshot, so clearing a filter restores it.
An order moved outside the active date filter no longer matches that filter.

Clicking a sortable date heading explicitly reorders rows. Manual Refresh
waits for the source load and then sorts by ascending start time again.
Automatic refresh preserves the current row order. Display order is separate
from the scheduler's resource and dependency sequence.

## Dragging a bar

A bar is grabbed by the block **or by its label**. A couple of hours of work is
a ten-pixel block with its label out in the grid beside it, and the label is
part of the bar for the pointer as well as for the eye.

A drag pins the order to the day it lands on, and asks the same question a
marked run asks: the earliest day it may begin, which is the latest of today,
the day its material lands, and the finish of every component it waits on. A
drag past that floor comes to rest on the floor. A drag that cannot move the
order at all writes nothing — pinning is not free, because a pinned order
stops falling in behind its crew and its predecessor, and paying that for a
drag that changed nothing is how a board ends up pinned order by order.

A bar standing against a component that is not finished yet carries a dashed
amber stop on its left edge, and says which order is holding it on hover.

The order detail shows the pinned day with a **Release** button, which hands
the order back to the schedule: it then starts as early as its crew, its line
and the orders it waits on allow.

## Crew orders

The button fills orders that have remaining work and no crew. It preserves
manual allocations and the supervisor's current line placement of workers.

1. Use the current production-line roster. Do not silently transfer workers
   from another line based on an old Skills value.
2. Within that roster, prefer matching line skills and work-kind trades.
   Current line placement remains authoritative if no skill match is listed.
3. Among equally skilled candidates, prefer availability, then fewer existing
   bookings, then original roster order for deterministic results.
4. Prefer one person for up to 7.5 remaining standard labour hours, two for
   more than 7.5 through 50 hours, and three for more than 50 hours.
5. Table assembly prefers three people at any positive workload.

Team sizes are preferences: use fewer people when the current roster is
smaller. Exclude people off shift or on leave today. Busy workers can queue
behind their existing work; recompute the schedule between waves and remove
suggestions that would still overlap. Workers are never duplicated within a
crew. A line with no available roster remains unstaffed.

Skills are categorical because the current operator data does not contain a
numeric skill level. These preferences do not claim to optimize efficiency or
certification. Future dated attendance remains a separate integration need.
