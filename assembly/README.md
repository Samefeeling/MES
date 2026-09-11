# Assembly Board — Resero

A day-scale **Gantt** for the sofa / chair / table assembly lines: crew
allocation, **Due** and **Expect** dates, and end-of-shift booking.

Sized for the real department — ~15 people, one white shift, the supervisor
dispatches on the floor. Nobody reports by the hour: the shift's output is
booked once at the end of the day, so there is no event stream and no live
polling.

Source data comes from Epicor via SharePoint, refreshed **every five minutes
and on demand**: orders from the `Planning1.csv` export, people from the
`ASSY_Operator` list, material requirements from `JobMaterialReq.csv`, and
on-hand quantities from `OnHandInventory.csv`. The
plan goes back the other way, into the `ASSY_Production` list.

## What it does

- **Four row groups** — `PMD` (the moulding plan, mirrored for context: greyed
  out, not draggable, never scheduled here), then `UPL`, `ASSY` and `TABLE`.
- **Three kinds of work order** — Cutting/Sewing and Upholstery run on UPL;
  Final Assembly runs on ASSY and TABLE.
- **One row per order**: Order · Order Qty · Start Date · Due Date · Expect
  Date · Team, beside the day grid with a draggable bar. Start is
  Epicor's own scheduled start, to the hour; any date column can be hidden to
  make room.
- **A load histogram along the top** — one bar per day, hours booked against
  the hours the shift can deliver, so the week reads as a shape before anyone
  reads a number. Green below 80%, orange to 90%, red beyond. Drag a bar to a
  greener day to level the week.
- **Yesterday is still on the board** — the first column is the previous
  working day (Friday, on a Monday), because the first question of the morning
  is what the last shift actually finished. Those columns carry *booked
  output*, not plan: the shift's entered quantities valued at the order's
  standard hours, drawn hollow so the two are never confused. Nothing is ever
  scheduled into them.
- **A line down today's column** — assembly works **07:00–15:30**, and the
  marker sits where the shift has got to, nudged on every five minutes. Before
  07:00 and after 15:30 it rests against the edge of the column.
- **The head stays put** — the day columns are frozen at the top, and the line
  summaries and their people pin to the left edge, so the board can be scrolled
  in either direction without losing what a row means. The **Order column can
  be dragged wider** by its right-hand edge when descriptions need the room.
- **Each line carries its own people** — the summary row for UPL, ASSY and
  TABLE lists whoever is standing there today, in the order the board reaches
  for them, each with five squares for the week ahead (click one for the
  day-by-day detail). **Once each**: somebody trained on two lines is qualified
  for both but is only ever at one of them, so they appear on the line their
  work today is on, and on the line they normally work when they have nothing
  on. Their squares still count every order they are on, whichever line it
  belongs to — that question is "how much room has this person got".
- **Who is still free** — the Team column's header names everyone in today with
  nothing allocated, in full and wrapped rather than cut off at the column's
  edge. It answers "who can I still put on this?" beside the crews themselves.
- **UPL is three benches, not one** — cutting and sewing, building the smart
  softies, and upholstering the frame are different trades, and the people are
  not interchangeable between them. Which one an order is comes off its part
  description (`Smart Softie`/`Ottoman` → softies, `Cut` → cutting), because
  that is where the floor reads it and it is the one field every export
  carries. The badge on the row says which of the three it is, so a chain reads
  down the line in order. Softie work is **restricted**: only someone named for
  it can be put on it, by hand or by *Crew N orders*.
- **Three orders at a time per line** — a line is a length of floor with
  several build positions, not one station, so three orders run side by side
  and a fourth waits for the first to clear (`parallelOrders` on each line in
  `domain/assembly.ts`).
- **Today is picked out and the weekend is closed** — the factory does not run
  Saturday or Sunday, so a bar *steps over* them: three days of work started on
  a Thursday finishes on the Monday, and a closed column reads 0%. Such a bar is
  **drawn as two blocks with the closed days showing through**, ending on its own
  Expect Date; one block of three columns would stop short of that date, and one
  of five would claim the crew worked the weekend. Drop a bar on a Saturday and
  the board asks before writing the work — approve overtime, move it to the
  Monday, or cancel. An approved order runs straight through as one block,
  marked `OT`, and the weekend column then shows what it is carrying. PMD rows
  are continuous too: the presses keep their own calendar and that lane only
  mirrors it.
- **A short order is a marker with its name beside it** — a couple of hours of
  work is a few pixels of bar, and a label crammed into those pixels came out
  as one clipped character, naming nothing. Any label too wide for its bar sits
  in the empty grid beside the block instead (to the left where the bar is near
  the end of the timeline), and a bar under half a day carries **its hours** as
  well — `018321-1-1 · 0.8 h` — because by then the block is at its minimum
  width and its length is no longer telling anyone anything.
- **Work load, in standard hours** — the remaining hours of an order
  (`Calculated_RemainingLaborHrs`), shared by its crew and spread over the days
  its bar covers. Shown three ways: per line on the group header, for the whole
  board in the title bar, and per person — every name on a line's summary row
  carries **five 10px squares**, one per working day. Click a name for the same
  week in full, order by order, against a shift's capacity — a week holds five
  working days, so the squares and the popup cover exactly the same window.

  A day is worth **7.5 hours per person**: 07:00 to 15:30 is 8.5 hours on the
  floor, less half an hour of morning tea and half an hour of lunch. Every
  duration on the board divides an order's remaining hours by that, so it is
  the one number to change if the shift changes — `PRODUCTIVE_HOURS_PER_PERSON`
  in `domain/assembly.ts`, derived from the clock so the two cannot drift.

  A **person** is banded differently from the department, deliberately: the
  board sizes every bar to exactly fill the crew on it, so anyone allocated is
  booked a whole shift, and the department's bands — where 90% is already red —
  would paint every working person red. So green has room, orange is full, and
  red is *over*: two orders at once, or work landing on leave or a closed day.
  An idle day is hollow rather than green, and planned leave is hatched.
- **Must start** — the last day work can begin and still be finished by the Due
  Date: the due date less the remaining hours, counted back over open days at
  the crew on the order. That is where Epicor's own `JobHead_StartDate` comes
  from, so the order detail shows both — a gap between them means the crew size
  or the hours differ from whatever Epicor assumed, which is worth knowing
  before the week is planned around it. It is the *latest* day, not the
  planned one: the schedule works forward from today and says so when it has
  had to start later than this.
- **Everything starts as early as it can** — an order asks for today and is
  pushed out only by something real: a component another order is still making,
  material that has not landed, a crew still on something else, or a line with
  no build position free. Nothing waits for the day Epicor pencilled in; that
  date is worked back from the due date and is a *deadline*, carried as **Must
  start** rather than as an instruction to stand idle. What decides who gets
  the position and the people when everything wants today is how much slack an
  order has left — whoever runs out first goes first.
- **One order picks up where the last left off** — to the hour, not to the day.
  A component finished 46% of the way through Wednesday hands over at 46% of
  Wednesday, and the order taking it gets the other 54% of that shift; the two
  bars meet exactly instead of spending a day at the link. The same holds for a
  crew: what is left of the day they came free is what their next order gets,
  so nobody works two shifts in one and nobody stands about. So dragging a bar
  takes everything downstream with it — the orders waiting on its parts *and*
  the orders waiting on its people — and dragging it back brings them in again.
- **A team does not wait for its slowest member** — an order begins the moment
  the *first* of its crew is free, and the rest join on the day they come off
  what they are on. The bar runs at one person's pace until they arrive, which
  is both what the floor does and what stops a fortnight of idle time appearing
  behind whoever happens to be busiest.
- **Nobody is on two orders at once** — putting someone on an order that runs
  across one they are already on **asks the supervisor first**, and nothing is
  written until they answer. *Queue it* puts them on and lets the order wait for
  them, which is what the board does with a crew by default. *Both at once* is
  for a day genuinely being split or handed over part-way: the pair is recorded
  as approved, the two bars are left overlapping, and that person's day reads as
  over-booked. The crew picker offers busy people last and says what they are
  already on; a chip marks any overlap that remains, `!` for one nobody approved
  and `≡` for one somebody did. A bar the planner dragged keeps its day whatever
  else its crew is on — a drag is an instruction — so that overlap is *marked*
  rather than prevented, as is one a refreshed export creates by moving a date.
- **Crew drives duration** — up to **4 people** per order; bar length is
  remaining standard hours ÷ (crew × productive hours), so adding someone
  visibly shortens it and pulls the Expect Date in. The picker offers only
  people who are on shift *and* qualified for that line.
- **The order detail opens only from an order block** — beside the pointer,
  over the board. Clicking a row, date, team cell or empty timeline does not
  open it. `×` or `Escape` closes it.
- **Scan an order barcode** — click `Scan order`, scan a job-number barcode
  with a USB or Bluetooth keyboard-wedge scanner, and the order detail opens
  on Enter. Labelled payloads such as `JOB:018140-1-1` are accepted; partial
  matches never open the wrong order.
- **Incremental refresh** — the first successful load creates a known-order
  baseline. Later refreshes retain the working plan, append unseen jobs to
  their home line, show `N new today`, and mark those rows `NEW`. An order
  that stops appearing in the export keeps its crew, pinned start, bookings
  and place in its line for a fortnight, so a partial export cannot destroy
  planning. See `docs/incremental-order-updates.md`.
- **Start, then book the shift** — `Start production` records the exact start
  instant and locks the order against further dragging. Entering the completed
  quantity moves Expect Date; saving `Job Completed` stores the exact completion
  instant and releases the active crew in the same state update.
- **Production actuals** — Shift Output, Complete, Reject, Rework, Job Completed and Pause
  reasons are captured as daily records for the `ASSY_Production` SharePoint
  list. Its columns intentionally mirror `PMD_Production`, allowing KPI.ts to
  aggregate the two departments without a second mapping layer.
- **Drag** a bar — by the block or by its label — sideways to move its start
  day, or down onto another line to change lines. Every bar moves, in both
  directions — a drag is an instruction, so an order dropped where the line is
  already full stays put and the day reads over capacity rather than snapping
  back. Three things it cannot be dragged past, because the schedule enforces
  them either way: today, the day its material lands, and the finish of a
  component it is made from. It comes to rest against whichever of those is
  latest, and a drag that cannot move it at all writes nothing — a bar
  standing against a component carries a dashed amber stop and names the order
  holding it. The detail panel shows the pinned day with a **Release**, which
  hands the order back to the schedule. Dragging never touches the Due Date;
  if the new start pushes Expect Date past Due, the row turns red.
  **Rows themselves never move on their own**: the order they sit in is the
  planner's, and only dropping a bar on another line changes it. Which order
  claims a build position first is a separate question, settled by date — and a
  dragged bar claims its *people* before anything else does, or the order it was
  taken off would simply take them back.
- **Colour by date** — Due is the date the customer asked for, and finishing
  during that day counts as making it:

  | | Condition | Meaning |
  | --- | --- | --- |
  | 🟢 green | finishes on or before the Due Date | will make the customer date |
  | 🔴 red | finishes after it | the customer date will be missed |
  | ⚪ grey | no Expect Date, or no Due Date | nothing to judge it against |

  The bands are exhaustive and non-overlapping. Note that an Expect Date is an
  *exclusive* end — work filling Tuesday ends at Wednesday midnight — so the
  comparison is against the moment the due date closes, not its own midnight.
  Ship Date was removed from this board in agreement with logistics.

- **Dependencies across the four lines** — `JobMaterialReq.csv` says what each
  order builds and consumes (`JobMtl_JobNum` builds `JobHead_PartNum` from
  `JobMtl_PartNum`). A child part is matched to another material row's parent
  part; that row's `JobMtl_JobNum` is the supplying order. Both job numbers must
  exist in `Planning1.csv`. The parent cannot start until its supplier finishes
  — a chair on ASSY waits for its cover on UPL and its shell on a press. An
  order waits for the *latest* of its components; the bar carries a `⇠` marker
  and the inspector lists each one, which order supplies it and when, with the one
  actually holding it up in bold. A component nobody is making is bought in or
  on the shelf, and constrains nothing. Press jobs that assembly is waiting on
  are pulled to the front of the PMD row so they can be chased.
- **Material gates release** — a short component is flagged, and material that
  only lands on a future PO pushes the bar out.

## Quick start

Needs **Node 18, 20 or 22** (Vite 6's requirement). `.nvmrc` and
`.devcontainer/` pin 22; on an older Node, `npm run dev` fails with
`crypto$2.getRandomValues is not a function`.

```bash
nvm use            # or: nvm install 22
npm install
npm run dev        # http://localhost:5173 — runs on bundled mock data
npm test           # engine, adapter and integration tests (125)
npm run build      # type-check + production build
```

### GitHub Codespaces

If a Codespace was created before the Node 22 dev-container configuration was
added, **Update Branch does not rebuild the running container**. In the
Codespaces command palette run **Codespaces: Rebuild Container**, then run:

```bash
npm run doctor     # checks Node, Web Crypto and installed Vite
npm run dev
```

The dev container runs `npm ci` both when it is created and when its checked-out
content is updated. `npm run dev` also runs the doctor first, so an old Node
runtime or missing install produces an actionable message rather than Vite's
indirect `crypto.getRandomValues` or `vite: not found` error.

The app starts on a **mock data source** (`src/data/mock/seed.json`, a real
slice extracted from the master workbook, plus a 15-person roster with one
person absent), so it is fully populated with no network or credentials.

## Data sources

Configure via `.env.local` (see `.env.example`):

| `VITE_DATA_SOURCE` | Behaviour |
| ------------------ | --------- |
| `mock` (default)   | Bundled `seed.json`. Instant, offline. |
| `planning-csv`     | Orders from `Planning1.csv`, dependencies from `JobMaterialReq.csv`, people from the `ASSY_Operator` SharePoint list. |
| `excel`            | Fetch the master workbook from SharePoint (Microsoft Graph) and parse it with SheetJS. Falls back to a manual file upload if Graph isn't configured. |

The Excel source (and the heavy `xlsx` dependency) is **lazy-loaded**, so
neither the mock nor the CSV build ships the parser.

Whichever is configured, **Load orders** and **Load JobMaterialReq** in the
header parse files picked from disk through exactly the same code — the
quickest way to check an export against the board without wiring up Graph auth.
Two buttons because the two files answer different questions and are checked
separately: what to build, and what has to finish first. Either picker still
takes either file — which is which is decided by the header row, not the file
name, so a copy saved out of Excel lands in the right parser — but picking the
wrong one says so rather than loading it silently.

**Did the links land?** The header carries the answer: *N orders wait on
another*, and hovering it lists every one of them — `ASM8020 (UPL) waits on
ASM8019 · SFA3S-STRM-SS`. It reads *No order links* when nothing waits, which
is what an unloaded or mismatched `JobMaterialReq.csv` looks like. Without it
every order is free to start on its own date, and that is indistinguishable
from a file that loaded but matched nothing.

### `Planning1.csv` → domain

Columns are matched **by header name, not position** (`mapHeaders` strips the
`JobHead_` / `JobOper_` / `Calculated_` prefix), so reordering the BAQ is safe.

| CSV column | Becomes | Note |
| --- | --- | --- |
| `JobHead_JobNum` | order id | first occurrence wins |
| `JobHead_PartNum` / `PartDescription` | part, description | |
| the `PMD` / `ASSY` column | line + department | `PMD` and press names → moulding; `UPL`/`ASSY`/`TABLE` → assembly |
| `JobHead_ProdQty` − `Calculated_RemainingQty` | completed qty | drives the progress fill |
| `JobHead_StartDate` + `JobHead_StartHour` | **Start Date** and material `Req. By` | the hour is decimal — `23.67` is 23:40 |
| `JobHead_ReqDueDate` | **Due Date** | |
| `Calculated_RemaingLaborHrs` | work load and bar length | the BAQ spells it *Remaing*; falls back to `Calculated_LaborHrs`, then to `RemainingQty × JobOper_ProdStandard` |
| `JobOper_ProdStandard` | run rate | inverted to qty/hr |

Every hour on the board comes from that one column, so it is matched
generously: the export's own spelling, the correct one, the British ones, and
failing all of those any header that reads as labour hours (`/^rem.*lab.*hrs?$/`
after the prefix is stripped). If none matches at all the board says so **once**,
with the headers it did see — a mis-spelled column is one problem with the
export, not eighty problems with the rows.

Both hours columns hold the work **remaining**, not the order total — in the
sample `LaborHrs` equals `RemainingQty × ProdStandard` exactly. The board needs
a total, because booking output during the shift has to shrink the bar, so the
adapter reduces the export to hours-per-unit and grosses it back up. Reading the
remaining figure as the total would discount it a second time and under-schedule
every part-run order.

If no header matches the `PMD`/`ASSY` column, the parser finds it by looking for
the column whose values *are* line names — so an unfamiliar BAQ alias still
works.

### `JobMaterialReq.csv` → the dependency chain

The second BAQ export, one row per component of an order. Three columns carry
the whole chain; the rest are ignored.

| CSV column | Becomes | Note |
| --- | --- | --- |
| `JobMtl_JobNum` | the order that consumes | must also appear in `Planning1.csv`, or the row is skipped |
| `JobHead_PartNum` | the part that order builds | indexed inside this export; also cross-checked against Planning1 |
| `JobMtl_PartNum` | the component consumed | matched to another row's `JobHead_PartNum` |
| `JobMtl_RequiredQty` | quantity | carried, not yet used for scheduling |

Both part columns end in `PartNum`, so header matching deliberately strips only
the `JobHead_` prefix — a bare `PartNum` is never taken for the component,
because one part column cannot say which end of a link it is.

The rule, in `engine/assembly/dependencies.ts`, is a two-stage join. First,
`JobMtl_JobNum` must equal a current `Planning1.csv` `JobHead_JobNum`. Second,
each `JobMtl_PartNum` child is matched to the `JobHead_PartNum` parent on another
`JobMaterialReq.csv` row; that row's `JobMtl_JobNum` is the order the consumer
waits for. Part matching ignores case and surrounding spaces. A component with
no producing material row is bought in, already on the shelf, or outside the
current export and constrains nothing. Where several batches of the same part
are open, the consumer waits for the one scheduled **first** — the earliest
supply it could take, not all of them — with ties broken on job number so the
same export always yields the same schedule. Circular links (two orders each
listing the other's part) are broken deterministically and reported in the
header.

An order that has no material export at all schedules exactly as before, so
this file is optional.

**Not in today's order export**, and read automatically once added:
`OrderType`, `Predecessor`, `MaterialStatus`. One consequence worth knowing:

- **Order type** is inferred from the line where that is unambiguous — ASSY and
  TABLE only run Final Assembly. UPL runs both Cutting/Sewing and Upholstery, so
  its orders show no type until the column exists.

The CSV carries no inventory, BOM or POs, so under `planning-csv` the material
engine sees nothing and every order reads as material-OK. Use `excel` when the
shortage view matters.

### `ASSY_Operator` → roster

| List column | Becomes |
| --- | --- |
| `Operator` | name |
| `Skills` | which lines the person may be allocated to, best first — and which bench, where it names one |
| `Position`, `Supervisor` | shown on the crew chip / picker |
| `PlannedAnnualLeave` | ISO dates excluded from future daily load-rate capacity |

`Skills` is normalised onto the four lines, so both short codes and what people
actually type work: *Cutting/Sewing* and *Upholstery* → `UPL`, *Final Assembly*
→ `ASSY`, *Table* → `TABLE`. A multi-choice column (array) and a delimited text
column both parse. Anyone with no recognised skill is reported in the warning
banner, because they can never be allocated.

**Order matters, twice.** Within `Skills`, the first line listed is the one
that person leads on. And the order of the list itself is a priority order: the
row at the top is the first name reached for. Both are read as written — see
*Crewing a fresh import*.

**A bench, where `Skills` names one.** `UPL` alone says which line; `UPL, Cut &
Sew` says which bench on it, and that person then does cutting and nothing
else. *Smart Softie* and *Ottoman* are the same trade and are **restricted** —
nobody works them without being named. A roster that names no bench behaves
exactly as it did before benches existed: anyone on the line does anything on
it that is not restricted.

Attendance is **not** in the list — the supervisor confirms who is in each
morning — so everyone counts as on shift unless an `OnShift` column is added.

Workers are keyed by SharePoint **list item id**, not name, so renaming someone
does not orphan the allocations already saved against them.

**When the list cannot be read** — no site URL configured yet, a 403, an empty
list — the board falls back to the fifteen demo people from `seed.json` and says
so in the warning banner. An empty roster is not a degraded board but a blank
one: with nobody to allocate, no order has a crew, so no order has a bar, an
Expect Date, or a share of the load. Borrowed names are worth less than real
ones and far more than none.

### Crewing a fresh import

`Planning1.csv` says what to build, never who builds it, so every order arrives
with nobody on it. **Crew N orders**, inside the header's **Review orders**
queue, staffs them all at once from the qualified people on shift, behind the
same supervisor lock as allocating by hand. It only ever *adds*: an order that
already has a crew is left exactly as it is, and the button disappears once
nothing is unstaffed. It is a starting point to argue with, not an answer.

It is inside that queue rather than beside it because the two were the same
question asked twice — *Crew N orders* counted the orders with nobody on them
and *Review orders* listed the ones somebody had set aside, and both answer
"which orders is this board not carrying yet".

**Who it reaches for first** is the roster's own order. `Skills` is read as
written, so whoever has this line *first* leads on it and comes before someone
helping out from a line they know better; among equals, the `ASSY_Operator`
list is a priority list and is read top down. Anyone already busy across the
order's days is out of the running before either rule applies, so the pick is
the top of the list *of those free to take it*. The crew picker offers people
in that same order, which is what makes the two agree.

It respects the same one-order-at-a-time rule as the picker, and that is why it
works the way it does: it crews the earliest waiting order on each line, **asks
the scheduler for the board back**, and crews the next against the dates that
came out. Crewing an order moves it — it takes a build position, and anything
waiting on its parts follows it out — so a suggestion that guessed where the
next one would land put people on two orders at once about a fifth of the time.
Asking costs a few milliseconds a round, which is why it runs on the click and
not behind the label. An order nobody is free for is left for the supervisor.

### The plan → `ASSY_Production`

The board mirrors itself into the `ASSY_Production` list Resero already
designed — the same shape as `PMD_Production`, so KPI work can aggregate both
departments without a second mapping layer. **One row per order per day.** Set
`VITE_PRODUCTION_LIST` to turn it on; blank disables it, so the mock demo never
writes.

Each row carries two kinds of column, and the split is the whole design:

| Column | Kind | Owner | Written when |
| --- | --- | --- | --- |
| `RecordKey` (`Job|YYYY-MM-DD`), `Title`, `Date` | key | — | the row is opened |
| `Line` | order-level | the planner | an order moves between lines |
| `StartDate` | order-level | the planner | a bar is dragged |
| `ActualStartAt`, `StartOverrideReason` | order-level | the supervisor | production is started |
| `DueDate` | order-level | `Planning1.csv` | a refreshed export changes it |
| `OrderQty`, `RemainingQty` | order-level | `Planning1.csv` | a refreshed export changes them |
| `ExpectDate` | order-level | derived | the crew or the queue moves it |
| `Operators`, `OperatorIds` | row-level snapshot | the supervisor | the entry is saved |
| `ShiftOutput`, `Complete`, `Reject`, `Rework` | row-level | the shift | the entry is saved |
| `JobCompleted`, `CompletedAt`, `Paused`, `PauseReason`, `Notes` | row-level | the shift | the entry is saved |

**Dragging a bar to level the load writes `StartDate` only** — Epicor owns the
Due Date and this board never changes it. Conversely a refreshed export updates
`DueDate` and `RemainingQty` without disturbing the crew or anyone's booked
output: order-level columns are kept in step on *every* row of a job, so a
changed Due Date reaches rows booked weeks ago, and the patch carries only the
columns that actually drifted.

Every order holds **at least one row**. An order the list has never seen opens
one on its start day with the production figures at zero; from then on each
booked shift is its own row. The opening row is created once and never again,
so it cannot drift to a new day when the bar moves.

`StartDate` is the planned/effective day on the schedule. `ActualStartAt` is a
separate immutable instant set by the Start production button, so a planned
date can never be mistaken for proof that production began.

Rows are diffed before writing, so a five-minute refresh with nothing changed
costs one read and no writes. Orders that leave the export keep their rows —
the list is the production record, not a copy of today's CSV. A read failure
aborts before any write and transient failures retry with bounded backoff.
Duplicate Job + Date rows are reported and left untouched. See
[`docs/sharepoint-production-schema.md`](docs/sharepoint-production-schema.md)
before enabling write-back.

### The supervisor gate

Only a supervisor decides who works an order, so allocating and removing crew
is behind `VITE_SUPERVISOR_PASSWORD`, entered once per session from the header.
Approving weekend overtime sits behind the same gate — it costs money. Booking
the shift's output is deliberately **not** gated: that is the shift's own
number to report. Leave the variable blank and the gate disappears entirely,
which is how the demo runs.

> **This is an operational gate, not a security boundary.** Every `VITE_*`
> variable is compiled into the JavaScript bundle, so anyone who opens dev tools
> can read the password. It stops the board being changed by whoever happens to
> be standing at the terminal; it does not protect the SharePoint list — the
> Graph token and the list's own permissions do that. Making it a real check
> means moving the comparison to a server that holds the secret and returns a
> session. Until then, do not reuse a password that matters anywhere else.

### Sheet → domain mapping (`excel` source)

| Workbook sheet | Parser | Used for |
| --- | --- | --- |
| `planning` | `job.parser` | orders — assembly rows, and moulding jobs for the PMD context row |
| `ohb` | `inventory.parser` | free-on-hand |
| `part req` | `bom.parser` | components per order |
| `po` | `supply.parser` | incoming raw material |
| `total req` | `demand.parser` | period demand |
| `resource` | `machine.parser` | which moulding lines' jobs to load |

To drive assembly from the same sheet, add these columns to `planning`
(`job.parser` reads them when present and defaults every row to moulding
otherwise): `Department`, `OrderType`, `Priority`, `MaterialStatus`, `Line`,
`CompletedQty`.

The shift roster is **not** in the workbook — it is the `ASSY_Operator` list
above. The mock source supplies one; `SharePointExcelSource.fetchWorkers()`
returns empty.

## Architecture

A strict one-way dependency flow keeps the core testable and the data source
swappable:

```
domain  →  lib  →  engine  →  store  →  features (UI)
                      ↑           ↑
              data (adapters)  persistence
```

- **`domain/`** — pure types, branded ids, constants. Zero dependencies.
  `assembly.ts` holds the lines, the three work-order types and the shift
  constants.
- **`data/`** — the `DataSource` contract with three implementations (`mock`,
  `csv/PlanningCsvSource`, `excel`). Every parser is lenient and reports what it
  could not read as a warning rather than failing the load.
- **`engine/`** — pure, unit-tested functions. Shared: `materialAvailability`,
  `materialExplosion`, `netRequirements`, `indexes`. Assembly:
  `assembly/{duration,dates,release,board,workload,dependencies}`. No React,
  no I/O.
- **`store/`** — Zustand. `dataStore` (loaded data + indexes), `planStore`
  (placement, crew, pinned starts, booked output — the only mutable plan
  state), `assemblySelectors` (derives the schedule), `uiStore` (selection).
- **`persistence/`** — `PlanRepository` with a REST (`ApiPlanRepository`) and a
  localStorage fallback; the working plan autosaves.
- **`features/`** — `assembly` (board, rows, bars, crew chips, inspector, the
  supervisor lock, dnd), `refresh`, `source` (the manual CSV loader) and `sync`
  (write-back).

### How the schedule is derived

`engine/assembly/board.computeAssemblyGantt` is a pure function from
(orders + placement + crew + bookings) to the view model. Per order it:

1. folds in the booked output, shrinking the remaining work;
2. divides that by the crew to get the bar length in days;
3. starts it where it asks to start — the planner's drag, else Epicor's
   scheduled start — pushed later by any order still making one of its
   components, by material still on a PO, or by the weekend;
4. gives it one of the line's three build positions, queueing it behind the
   first to free only when all three are busy *and* the planner did not put it
   there by hand;
5. runs the bar across working days only, unless overtime is approved on it;
6. sets Expect Date at the bar's end and colours it against the Due Date.

Because the whole schedule is derived, allocating a person or booking output
re-lays-out the board with no separate update path.

## Roadmap

| Stage | Scope | Backend |
| --- | --- | --- |
| 1 ✅ | Assembly Gantt on mock data: crew, dates, booking, colours, predecessors | no |
| 1b ✅ | Read the real sources: `Planning1.csv` orders, `ASSY_Operator` roster | no |
| 2 ✅ | Write the plan back to the `ASSY_Production` SharePoint list | no |
| 3 | Merge with the PMD dashboard into one page | yes |
| 4 | KPI view; actual hours feed back to correct standard hours | yes |

Stage 2 landed as a **direct Graph write** to `ASSY_Production` (see above)
rather than a service: crew, start day, line and the shift's booked output all
go straight to the list, and a refreshed export pushes Due Date and remaining
quantity back into it. No backend to run.

`PlanRepository` is still there as the local working copy — localStorage by
default — so the board survives a reload before the next sync, and a REST
service can take over by setting `VITE_PERSIST_API_URL`.

That service receives `X-Production-List: ASSY_Production` and
upserts `assembly.production` by Job + Date. Each entry has `Complete`,
`ShiftOutput`, `Complete`, `Reject`, `Rework`, `JobCompleted`, `Paused`,
`PauseReason`, and `Notes` fields.
Without `VITE_PERSIST_API_URL`, the same payload is retained in localStorage
for offline development, but is not yet in SharePoint.

Stage 3 is already half-built: `Planning1.csv` holds PMD and assembly rows in
one file, and `PlanningCsvSource` splits them by the `PMD`/`ASSY` column, so
both pages can read one source without a second fetch.

## Notes

- **The moulding (PMD) board was removed.** Its jobs still load so the PMD row
  can mirror the plan, but there is no moulding scheduling, changeover or
  Epicor-export code any more. It is recoverable from git history if wanted.
- **Working days.** Assembly runs Monday to Friday on one 8 h shift (0.75 h
  break, so 7.25 productive hours a person). Bars step over Saturday and
  Sunday; the only work that lands there is an order the supervisor explicitly
  approved for overtime. The arithmetic is in `engine/assembly/dates`.
- **Mock dates** are anchored to a fixed epoch and shifted forward on load, so
  the demo always reads as the current week.
- **`xlsx`** is the npm SheetJS build; it carries known advisories and is only
  loaded for the (trusted, internal) Excel source.

## MES integration and SharePoint sessions

The Assembly board is also embedded in MES on the operator-shift-target branch.
See [MES integration](docs/mes-integration.md) for the separate Assembly data
contract, shared plan persistence, provisioning and rollout instructions.

The board no longer exposes manual CSV load buttons. Live CSVs are read from
configured SharePoint paths. A roster read failure displays a warning and no
employees; demo people are only available with the mock source.
