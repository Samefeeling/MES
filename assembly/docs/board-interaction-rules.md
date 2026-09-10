# Board interaction rules

## What the board opens with

**Every order it has.** There is no window to choose and nothing to switch
back from: the "All orders" and "5 working days" buttons are gone, because a
board that opens already hiding two thirds of its rows — with nothing on
screen saying so — reads as a board that has lost them.

**Six of the eight lines.** TBP and PMD open folded away: neither is planned
here — PMD mirrors moulding's own schedule and TBP is scheduled elsewhere —
so they used to lead a board whose subject is the assembly floor. Each folded
line leaves a **+ TBP** / **+ PMD** chip in the header, which is where it
comes back from, and every line carries a **×** on its own row to fold it.

**Whatever column widths the reader last dragged.** All seven frozen columns
— Order, Order Qty, Required Hours, the three dates and Team — are dragged by
their right-hand edge, or moved with ← / → once the grip has focus. Which
column needs the room is not something a default can know.

The title bar, the board's own heading and the orders are three deliberately
different grounds — slate, the dashboard's dark blue, and white. They used to
be three shades of the same near-white stacked on each other, so the controls
read as the first row of the board.

## Date filtering

Two narrowings, and an order has to satisfy both:

**The order-count button under each timeline date.** Select it to show orders
with work on that day, select it again — or press the day chip that appears in
the header — to return to every order. The header chip is the filter's only
trace, and it is drawn only while a day is picked, so a filter cannot be left
on unnoticed.

**Due ≤ 2d**, in the header, with a count on it. What has to go out before the
board is next looked at: orders due within two *working* days — asked on a
Friday it reaches Monday — **and everything already past its Due Date**. An
order that was due last Tuesday is not less urgent than one due tomorrow, and
a "due soon" list that quietly drops the late ones is the list you would least
want to work from.

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


## Operational groups

The board runs the eight lines in `docs/OPERATIONAL-LINES.md`. Factory General
holds support work and is excluded from automatic crewing. Supervisor roster
moves release current off-line allocations but retain recorded crew snapshots.

A line's own row is deliberately not lettered like an order: it carries a
tinted band and a dark-blue name in capitals, the one colour on the board no
order row can take. Scrolling a long board, the band is what tells you which
line you are inside.

### Lines the supervisor opens

**+ Line** in the header, supervisor only. The plant is built as eight lines;
what it is *running* this week is a different question — a second table bench
for a rush, a bay set up for one big order, a crew split off to clear a
backlog. Those had nowhere to go, so the work sat on a line it was not
happening on and the people on it read as booked somewhere else.

An added line schedules exactly like a built-in one: it is a drop target, it
takes crew, it carries its own load, and it appears in the Move-to-line picker
on every operator. It runs every order type — nothing has said yet what
belongs there, which is why somebody opened it.

It lives in the **shared plan**, not in one browser: a bench opened this
morning is a fact about the week. **Close line** on its own row removes it and
tips whatever is on it back into the unplaced pool — closing a bench is not a
decision about where its work belongs.

## Why an order has no Expect Date

Because some of its hours have nobody free to do them. The board says how
many: the Expect Date cell carries it on hover, and the order's detail panel
shows an **"N h not covered"** badge naming anyone whose diary left no room.

A person's other bookings cost this order only the days they are actually on
something else. One booking used to close their availability for good, so a
single day elsewhere next week cost the order every day after it — five days
of work covered two, and the Expect Date went blank while the crew were
plainly not full.

What has not changed: **one person's day is never split between two orders.**
Capacity is charged a day at a time, so a shift with anything on it is not
offered to a second order. The exception is a hand-over — somebody coming off
an order at eleven takes the next one from eleven, and that day is shared
exactly once.
