# Board interaction rules

## What the board opens with

**Every order it has.** There is no window to choose and nothing to switch
back from: the "All orders" and "5 working days" buttons are gone, because a
board that opens already hiding two thirds of its rows — with nothing on
screen saying so — reads as a board that has lost them.

**Six of the eight lines.** TBP (**To Be Processed**) and PMD open folded away:
neither is planned here — PMD mirrors moulding's own schedule and TBP is
scheduled elsewhere —
so they used to lead a board whose subject is the assembly floor. Each folded
line leaves a **+ TBP** / **+ PMD** chip in the header, which is where it
comes back from, and every line carries a **×** on its own row to fold it.

**Whatever column widths the reader last dragged.** All seven frozen columns
— Order, Qty, Hours, the three dates and Team — are dragged by
their right-hand edge, or moved with ← / → once the grip has focus. Which
column needs the room is not something a default can know.

**Two tiers of chrome, and MES owns the upper one.** The application's own top
bar is above this frame on every screen — it names the department, lights the
page you are on, and holds the Supervisor button. Everything the board puts
under it is a single block: the controls row and the column/timeline heading
share one ground and close with one rule, so it reads as one thing rather than
as a second and a third title bar. The orders are the only white on the page.

**Dark top bar → pale block (`#BAE6FD`) → white orders**, and the weight falls
off in that order. The block used to be a second dark blue, which put two heavy
bars across the top of a page whose whole subject is underneath them; reading
down, the work is now the brightest thing on the screen. The heading takes the
three load bands a few steps darker than the board's own pastels — green scores
1.5:1 against this ground, which is not a colour, it is a suggestion.

The board also stopped titling itself: the top bar already says Assembly, and a
page repeating its own name one band lower is the extra band this removes.

**The timeline opens fully zoomed in.** A column is a shift and a drag lands on
five minutes of it, so how wide the column is *is* how finely the board can be
worked by hand — at the narrowest zoom a five-minute landing is half a pixel.
Seeing further ahead is one press away and is something a reader asks for
deliberately; being able to place the work in front of them is not.

## What the one row of chrome holds

Left to right it reads as a question and its answer.

**Show** — what the board is being asked to draw. Weekends, any folded line, any
hidden column, **+ Line**, and **New support order**, which is the one control
on the row that adds to the board instead of narrowing it. It used to have the
far corner, which is the position a board's most frequent action takes; this one
is pressed once or twice a week. Below 1500px the whole Show group takes a line
of its own, so **New support order** can never come to rest beside **Refresh** —
one creates a support order and the other re-reads the export, and a support
order raised by somebody reaching for Refresh is a row in the plan nobody meant
to make.

**Show all**, beside them, and only while something is being held back: every
line unfolded, every column back, both filters off. Each of those can already be
undone where it was made, which is the right size of undo for the one column
somebody hid a minute ago — it is not how anybody gets back from a board that
opened with two lines folded, then had a day picked on it, then Due ≤ 2d.
Saturday and Sunday are not in it: the compact working week is the axis the
board draws, not something a reader hid, and sweeping it in would leave two
empty columns behind every "show me everything" and put the chip on screen for
the life of every board.

**Timeline** — how wide a day column is.

**Then four figures**, right-aligned: hours on the board, what is due within two
working days, how much of today's roster is allocated, and how many orders are
waiting to be looked at. **Due within 2 days** is also a narrowing, and it is
the only pressable thing among them; it used to go amber when it was on, which
is a filter wearing a schedule's colour on a board whose whole point is spotting
the amber bars. **Crew allocated** came up from the Team column heading, where a
figure about the whole board sat inside one column's title. Who is *not*
allocated stayed there, as names: that is the list you read while deciding who
to put on the order in front of you, and it is capped at two lines so a shift
with nobody on anything cannot push the day columns down the page.

**Review orders** is the fourth. Two counts used to sit side by side up here —
*Crew N orders*, the orders with nobody on them, and *Review orders*, the ones
somebody had set aside — which are the same question asked twice: which orders
is this board not carrying yet. One chip, one count, and the button that crews
them is inside it, next to the list it acts on.

The time the export was read is at the far end, beside the button that re-reads
it, with the source itself on its hover — which export this is has not changed
since the board was built and cannot change while anybody is looking at it, so
as a chip in the header it was a word answering a question nobody had. That and
the read time are what is left of a band the board used to open with, above the
row that actually does something — and inside MES that band sat one step under a
top bar already carrying the name.

## The heading under it

Seven column titles on the left and one cell per day on the right, and they have
to be the same height, because they are the same row.

The titles are **one word each**: Order, Qty, Hours, Start, Due, Expect, Team.
"Required Hours" and "Start Date" wrapped to two lines in columns narrow enough
to hold what they label, and "Date" appeared three times in a row of columns
that are all dates.

Each day cell is the **load standing on the left** — a bar filled to the day's
percentage, with the figure inside the top of its own track — and the **date
over its order count** taking the rest. Those four things used to stack, which
made this heading four lines deep while the titles beside it were one, and the
whole block was then as tall as three rows of orders. The count is a figure
rather than "10 orders": the column it sits under is the only thing it could be
counting.

## Folding and arranging the lines

**The triangle in the Order column folds a line's orders away.** It used to be
what clicking the line's *name* did, with the triangle along as decoration.

**The triangle in the Order heading folds every line at once**, and opens them
all again. Each line keeps its own; this is the one to reach for on the way to
"which line is this job on", where eight presses is seven too many.

**The line's name is now the grip that arranges the lines.** Drag one onto
another and it takes that line's place: dropped on a line below it comes to rest
under it, dropped on one above it pushes that line down. Alt + ↑ / ↓ does the
same without a pointer. One press cannot mean both "collapse this" and "pick
this up", which is why the triangle became the control it was already drawn as.

`LINES` is the order the plant lists its benches in, which is not the order any
particular floor runs them — cutting feeds gluing on one shift and the other way
round on the next, and reading the board against the bench order is most of what
makes it quick to read. So the sequence is in the **shared plan**, not in one
browser, for the same reason a line opened this morning is: a board two
supervisors read in two different orders is two boards. It is behind the
supervisor gate like every other change to that plan.

A plan saved before there was an arrangement holds none, which reads as the
built-in order rather than as an empty board; a bench opened after one was made
joins at the end until somebody moves it; and a bench that closes takes its key
with it.

## Filing an order onto another line

**Drag the order number in the Order column.** It changes the order's line and
nothing else: it keeps falling in behind its crew and its predecessor, exactly
as it did on the line it left.

Dragging the *bar* sideways onto another line does this too, and will go on
doing it — but a bar carries a day as well as a line, so that gesture also pins
whatever start day the pointer happened to be over. On a board scrolled six
weeks out the bar is not on screen at all while its number is. The number is the
handle for *this belongs on another line*; the bar stays the handle for *this
starts on another day*.

Same gesture as an unplaced card from the strip, and behind the same gate.
Factory General support orders carry no grip: the plan files them to that line
and refuses to move them.

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

**A drag pins the order to a moment, and lands on five minutes of the shift
clock.** A day column *is* the shift, so two thirds of a column is two thirds of
a shift: half an hour along the row moves the order half an hour.

This used to round to the nearest whole column, and that made a drag something
you could not take back. A bar drawn at a quarter to three — because that is
when its crew came off the last order — went to 07:00 the moment anybody touched
it, since a pin could only name a day and every pinned order began at the open
of its shift. Dragging it home then only ever offered 07:00 on the day it came
from, never the quarter to three it left. The floor's report was "I moved it once
and can never move it back", and it was exactly right.

Ties break the way the pointer is going, so out and back is the same moment
rather than five minutes further on each trip. Running off either end of a
column carries into the next one **the reader can see** — with the compact
working week that is Monday, not Saturday — and a landing inside a break
resolves forward to the moment the crew come back.

A pin stored before any of this is a midnight, which reads as 07:00 that
morning: exactly what it used to mean.

A drag asks the same question a marked run asks: the earliest moment it may
begin, which is the latest of today, the time its material lands, and the finish
of every component it waits on. A drag past that floor comes to rest on the
floor. A drag that cannot move the order at all writes nothing — pinning is not
free, because a pinned order stops falling in behind its crew and its
predecessor, and paying that for a drag that changed nothing is how a board ends
up pinned order by order.

A marked run moves whole columns, and every bar in it keeps its own time of day.
Half of what gives a run its shape is where in the shift each order sits;
flattening all of them to the open of their day is not moving the run, it is
redrawing it.

A bar standing against a component that is not finished yet carries a dashed
amber stop on its left edge, and says which order is holding it on hover.

The order detail shows the pinned start — to the minute — with a **Release**
button, which hands the order back to the schedule: it then starts as early as
its crew, its line and the orders it waits on allow.

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

## Drag alignment and stable viewport

Dragging a bar shows a dashed vertical guide with its requested start in
Australian date format and 24-hour time. The guide and drop use the same
landing function, including breaks, predecessor floors, the five-minute
minimum movement, and the existing marked-group rules. It is a visual aid;
it does not silently change another order's crew or end time.

The empty unplaced-order strip reserves 48 px even before a drag begins.
Only its visibility changes while dragging an order. This prevents the board
viewport shrinking under the last row when the drop target appears. Workers
and line headers do not activate this order-only target. Automatic edge
scrolling is disabled during bar drags so a move near the bottom cannot run
away. Scroll
the board to the desired area before dragging; worker and line drags retain
their existing automatic scrolling.

The line label is Assembly Seats. Stored ASSY keys and legacy ASM values
continue to resolve to the same line. The Refresh action carries its updated
HH:mm time underneath; day load bars have no outline.
