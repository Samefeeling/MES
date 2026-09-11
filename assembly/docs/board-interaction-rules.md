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

**Two tiers of chrome, and MES owns the upper one.** The application's own top
bar is above this frame on every screen — it names the department, lights the
page you are on, and holds the Supervisor button. Everything the board puts
under it is a single block: the controls row and the column/timeline heading
share one ground and close with one rule, so it reads as one thing rather than
as a second and a third title bar. The orders are the only white on the page.

That block's blue is deliberately a step lighter than the top bar's. It was
that exact colour, with a slate band wedged between the two, which gave the
page two identical dark bars and nothing to say which of them owned the board.
The board also stopped titling itself: the top bar already says Assembly, and a
page repeating its own name one band lower is the extra band this removes.

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

## Who may move an order

**The supervisor gate covers every change to the plan, moving orders
included.** Dragging a bar pins a start day, dropping it on another line moves
it there, dropping it on the strip takes it off the schedule, and the pinned
day goes out to the production list as this order's start — all of it read by
every other screen on the floor. Putting a *name* on an order has been behind
the gate since the beginning; moving the order itself was not, which had it
backwards. Signed out, a bar and an unplaced card still open for reading and
still say what is holding them; they no longer offer to be picked up, and
**Release** on a pinned start is disabled with the same reason.

**There is one Supervisor button and it is in the MES top bar.** Inside MES the
board draws no lock of its own: a second control for one session would let
somebody sign in here, walk to PMD, and find the top bar still saying signed
out. `mesBridge` marks the board *hosted* on connect, which both removes the
board's lock and shuts the gate until the host says who is signed in — an open
board in that gap is a board anybody can rearrange. Every "you need to be
signed in" line on the board is built from `signInAt(hosted)` for the same
reason: they used to send the reader to "the header", which is the one place
the control is not. The board keeps its own lock only when it is opened on its
own — the mock demo and the dev server, which have no top bar above them.

What the gate is has not changed, and is worth restating: `VITE_SUPERVISOR_PASSWORD`
is one shared password compiled into the JavaScript bundle, so anyone who opens
the browser's dev tools can read it. It stops the board being changed by
whoever is standing at the terminal. It is not authorization, and it does not
say *which* supervisor made a change — SharePoint's own Modified By does that,
because the board writes as the signed-in user. Real authorization means
restricting write permission on `ASSY_Plans` and `ASSY_Production` to a
SharePoint group, so the server refuses the write rather than our JavaScript.
See `store/supervisorStore`.

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

**The working day is 07:00 to 15:30, less three breaks**, and the board plans
to the clock rather than to a fraction of a calendar day:

| | |
| --- | --- |
| 07:00 – 09:00 | two hours |
| 09:00 – 09:15 | morning tea |
| 09:15 – 12:00 | two and three quarters |
| 12:00 – 12:30 | lunch |
| 12:30 – 15:15 | two and three quarters |
| 15:15 – 15:30 | afternoon tea, and putting the bench away |

That is **450 minutes on the job**, which is the 7.5 hours every duration on
this board is divided by — a test holds the two together, because a break moved
without the arithmetic following would have the board planning to a different
day than it draws. Work is laid into those stretches in order and the breaks
are stepped over: two hours of work ends at **09:00**, two and a quarter ends
at **09:30**. A bar can finish at 15:15 and never at 15:30.

The same fraction means two different times depending on which end is asking.
Two hours of work is *reached* at 09:00 and *resumes* at 09:15, so the order
following it starts at 09:15 — nobody picks a job up during morning tea. Ends
ask one question of the clock and starts ask the other; mid-stretch they are
the same moment, which is what a hand-over is.

Day columns are the shift, 07:00 at the left edge and 15:30 at the right, so a
bar sits where the work sits. They used to be midnight to midnight, which drew
an order that starts at seven a third of the way into its own column and left
every morning on the board empty.

**A person's shift is 7.5 hours of continuous capacity, and orders queue into
it back to back.** Somebody coming off an order at eleven picks the next one up
at eleven; if that fills the day, the one after it starts tomorrow morning. Five
orders totalling nineteen hours are one person's 7.5, 7.5 and 4 — and two
people's 7.5 each today and 2 each tomorrow.

The one thing charged whole is a **full** day: a person whose shift is entirely
spoken for is not in this order at all that day. A day with two hours on it has
five and a half left, and the next order takes them. That used to be true only
of an order's *opening* day, so a run that lost two hours of a Monday skipped
the Monday altogether, finished a day later than it needed to, and drew a hole
over hours nobody was using.

Nobody is ever charged more than one shift in a day, however many orders queue
into it.

## Why a bar has a gap in it

Because its crew are on something else for those days, and that is a real day
on the floor rather than a fault in the drawing. Two blocks with a hole between
them can mean opposite things:

**A weekend** — the factory is shut, the closed-day stripe shows through, and
that is the whole explanation. With the compact working-week axis the two
blocks meet and there is nothing to see at all.

**An open day** — this order's crew are on another order **for the whole of
it**. The blocks are **joined by a dashed rule** and the bar says how many days
and which order took them; the detail panel carries a **put down N days** badge
saying the same. Two separate blocks read as two orders, and the answer that
invited was to drag the bar back together until it looked whole.

A day the other order only *part*-used is no longer one of these: this order
takes the rest of it and the bar runs straight through. Most of the gaps the
floor was dragging bars over were that, not a full day.

**Part of a day** — the newest kind, and only expressible now that the board
keeps clock times. The crew are on another order until quarter to three, so
this one has the last half hour of the day; the hole is narrower than a column
and means the same thing. It is joined by the same dashed rule and the bar says
**put down for part of a day**, naming what took it.

**Dragging a bar over its own pause does not find room.** It pins the order,
and a pinned order consults no diary at all — which is right for a placement
somebody made on purpose, and is exactly why the hole closes. The person is
then on both orders on the same day, so both bars are **hatched in amber** and
each names the other and the person they are sharing. The ways out are to take
somebody off the other order, add crew to this one, or accept the pause. Only a
pinned or a started order can be hatched; the board's own schedule never
double-books anybody.
