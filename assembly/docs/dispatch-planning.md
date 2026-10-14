# Dispatch planning

The **Dispatch** page plans outbound shipments from the waybill export: which
orders leave on which day, in what vehicle or container, and how full it is.
It runs beside the Assembly board and does not change it.

## Who can open it

Dispatch is a supervisor's page. Inside MES the top bar shows **🚚 Dispatch**
only while *Supervisor* is signed in (`#/dispatch`); signing out on it goes
back to Assembly. A bookmarked `#/dispatch` opened without signing in shows
*Dispatch Planner is for supervisors* instead of the page. Standalone (the dev
server and the demo), the **Assembly | Dispatch** switch beside the page name
appears once the board's own Supervisor lock is open. With no
`VITE_SUPERVISOR_PASSWORD` configured MES has no way to sign in, so Dispatch
is not reachable there at all.

The page is the same app as the Assembly board, in the same frame: switching
between the two is instant and the board keeps loading, saving and syncing
behind Dispatch. Dispatch reads the board's plan of every order, released or
not (see *Input: the Assembly board* below).

## Where the waybill comes from: the Waybill list

There is nothing to load by hand. Epicor's waybill export is `Waybill.csv`
and the cubics sheet `Cubics.csv`, both in the folder that holds
`Planning1.csv` (`VITE_WAYBILL_CSV_PATH` / `VITE_CUBICS_CSV_PATH` to put
them elsewhere). The waybill is kept in the **`Waybill` SharePoint list**
(`VITE_WAYBILL_LIST` to name another), one row per order release, its
columns named exactly as `Waybill.csv` names them.

Each time the board reads its own exports — the five-minute refresh, the
board's Refresh, or **Refresh** on this page:

1. **A supervisor's screen syncs the list.** `Waybill.csv` is compared with
   the list row by row (`Order` + `Line` + `Rel`): only the cells that differ
   are written; a release new to the export is added (Title is set to
   `18532-5-1`); a release gone from it is not deleted but stamped
   `ClosedAt`. The list's version history is then the record of every
   change Epicor made — a Need By moved three times is three versions of the
   row. A screen nobody is signed in on never writes. If the export suddenly
   lists less than half of the open rows (more than 20 of them), it looks
   partial and nothing is closed until **Close … gone from the export** is
   pressed.
2. **Every screen reads it.** The open rows (`ClosedAt` empty) are the
   waybill this page plans from and the board reads Ship By off. Rows
   dispatched in the last 400 days, closed or not, are the shipment log for
   SIFOT and the Performance tab.

The planner's decisions are columns on the same rows, which the sync never
touches. Each decision is per order and written to every open line of it,
a moment after it is made — only the orders this screen changed, so another
screen's changes to other orders are not written over. A write that fails is
kept on the screen and sent again at the next refresh rather than lost. Load
edits wait for **Save** (see *Planner decisions*).

| Column to add | Type | Holds |
| --- | --- | --- |
| `PlannedDay` | Date | **Pin to day** |
| `HoldReason` | Single line of text | **Hold back**, with its reason (`Held` when none was given) |
| `VolumeM3` | Number (2 decimals) | **Volume m³** entered for the order |
| `LoadId` | Single line of text | the booked, edited or dispatched loads it is on |
| `LoadDetail` | Multiple lines of text (plain) | those loads as JSON: day, vehicle, status, its volume and split piece, and what left |
| `DispatchedAt` | Date and time | when its load was marked dispatched |
| `ClosedAt` | Date and time | when the release left Waybill.csv |

Without the first six the decisions stay on each screen, as before the
list, and the page says which columns are missing; without `ClosedAt`
nothing is ever closed. Once the list passes 5,000 rows SharePoint only
filters on indexed columns: index **`ClosedAt`** and **`DispatchedAt`**
(List settings → Indexed columns). Until then it is read whole, and the page
says so.

**Columns missing?** A supervisor's screen shows **Add N columns to the
list** whenever the list lacks a planner column above or a column
`Waybill.csv` has (an export column with nowhere to go is not kept, so floor
screens never see it). It adds them with the types above — `ClosedAt` and
`DispatchedAt` indexed — and the export's with a type read off what they
hold: dates as Date, TRUE/FALSE as Yes/No, quantities as Number, comments
(or anything over 255 characters) as multiple lines, and identifiers such as
`WaybillNbr` or `MTOJobNum` as a single line of text, kept exactly as
exported. It then syncs again so the new columns fill in. The planner's
changes made on that screen while its columns were missing are kept and
written to the list; other screens take the list's. Adding columns needs
edit (Manage Lists) permission on the list; when SharePoint refuses, the
page says why and the columns can be added by hand.

The **settings** (vehicles, windows, limits, holidays) are still kept per
browser.

Without a SharePoint session (the dev server) `Waybill.csv` is read straight
from `VITE_WAYBILL_CSV_URL` and the decisions stay in the browser.

## Input: the waybill export

One row per order line. Columns are matched by header name, so their order
does not matter; the Orders tab lists, under *Waybill columns read*, which
column (by spreadsheet letter) each field was read from.

| Column | Used for |
| --- | --- |
| `Order` | the shipment unit — lines are rolled up per order |
| `Description` | delivery zone (how it ships), which decides the route (`NSW-Metro-South`, `QLD- Metro`, `NZ-North`, …). If the export has two `Description` columns (a part description too), the one whose values look like zones is used |
| `City` (or `ShipToCity`) | ship-to city: proximity for NSW runs; destination port for `Export-ROW`. If there are two `City` columns, the last one is the ship-to city |
| `Ship By` | **the last day the order may leave** — the planned dispatch day (Australian `d/mm/yyyy`). Settings can switch this to `Need By`; an order without the chosen date uses the other one |
| `ExpDeliveryDt` | the day the customer receives it — on every load card and the booking sheet |
| `Need By` | the day the customer is to have it — typically 7 days after Ship By in NSW, 14 interstate, 4 weeks overseas. Shown for reference |
| `PickListComment` (`OHPickListComment` in the BAQ) | what the warehouse wrote once packed. A cube in it — `2C`, `1.5 C`, `3CBM`, `0.8 m3` — is the order's **packed volume** and beats every estimate. Shown on every drop |
| `ShipToCustName` | who the load goes to: on the card's title row, each drop and the booking sheet |
| `ShipToAddress1-3`, `ShipToState`, `ShipToZip` | ship-to address on the booking sheet, when the export has them |
| `Part` + `UOM` = `CBM` + `LeftToShip` | **volume**: the freight line (`FRTNSW`, `FRTQLD`, `FRTWAU`, `FRTVIC`, `FRTSA`, `FRTTAS`, `FRTACT`, `FRTSEB`, `FRTEXP`) carries the order's cube in m³. `FRT911` is a charge, not a volume, and is ignored |
| `FulfillmentMethod`, `Status`, `AllocatedQty` | **readiness**: goods lines (not `Other`) are ready when `Status` is `Ready` or they are fully allocated |
| `CreditHold`, `On Hold` | keep the order off every load |
| `InPicking`, `Cust. ID`, `Ship Via`, `ReleaseVal` | shown |

## Input: the cubics sheet (optional, more precise)

`Cubics.csv` is "Drews Cubics and Freight Calc" saved as CSV, read from the
export folder with the waybill. Without it orders are sized from their freight
lines, and the page says it was not read. Excel saves only the sheet that is
open as CSV: save the cubics sheet itself, not the freight calculator. The
header row is found however far down the title rows go; UTF-8, Unicode
(UTF-16) and plain "CSV (Comma delimited)" saves all read. When the file is
not the sheet the page says what its first row holds. One row per part and
stack size:

| Column | Used for |
| --- | --- |
| first (unnamed) | category, e.g. `SS` |
| `CODE` | matched to the waybill's `Part` (case and spaces ignored) |
| `Name` | shown |
| `Quantity` | units in the stack (the first `Quantity` column; the second is the sheet's own calculator input) |
| `Volume per STACK` | m³ of that stack; worked out from `Length` × `Depth` × `Height` (mm) when blank |
| `Weight Per Unit` | kg, summed into each load |

Section rows (`SOFT SEATING`) are read as headings; rows without a `CODE`
cannot be matched to the waybill and are counted in the page header.

Each goods line's quantity is packed into the part's stack sizes so the total
volume is smallest: five Astral ottomans are a stack of four plus a single
(1.27 + 0.41 m³), not two pairs and a single. An order is **sized by cubics**
only when the sheet lists every goods line; otherwise its freight line is
used, and failing that the part the sheet covers. Settings can make the
freight line the first choice instead, and a volume entered on the order
always wins. In the tables a `C` beside a volume means it came from the
sheet, `E` that it was entered. The Exceptions tab lists every part code the
sheet is missing, by how many open orders it holds up.

An order with no volume from either source has **unknown volume**: it is planned as 0 m³
and listed under Exceptions until someone enters its cube. An order carrying
two freight lines with the same cube (seen once: `FRTTAS` + `FRTSEB`) uses the
largest rather than the sum.


## Routing

| Zone | Route | Equipment |
| --- | --- | --- |
| NSW zones in a run class | **NSW delivery** — a contractor's truck, booked for the run, delivers to the customer. Consolidated per `Description` + `Ship Via` (`NSW-Metro-South` / `ANMS`, `NSW-Metro-North` / `ANMN`, …), nearby customers first; Settings can let neighbouring zones of a run class share a truck | Rigid 8-pallet, Rigid 12-pallet, Semi 22-pallet, or a part load (pallet freight) |
| Other states (`QLD`, `VIC`, `SA`, `WA`, `TAS`, `NT`) | **Interstate linehaul** — to the state's hub city, where the local carrier does the last mile. Consolidated per `Description` + `Ship Via` (`QLD- Metro` / `AQMC`, `QLD- Reg-North` / `AQRN`, …): different carriers or regions never share a departure | FTL semi, or LTL part load |
| `NZ`, `Export`, `Hong Kong` | **Export containers** — consolidated per destination and `Ship Via` (`Export-ROW` per city, since its cities are different ports) | 20' GP, 40' GP, 40' HC, or LCL |
| `NSW-Customer Pickup` | **Customer pickup** — dock schedule only | — |

A zone that matches none of these is flagged *unrouted*; add it in Settings.

There is no own fleet: every load is booked with a contractor. Settings →
**Contractors** names the transport company for each `Ship Via` code; the
name shows on the load cards, the booking sheet and its CSV.

## How loads are built

1. **Window.** Each order must leave on the last dispatch day of its route on
   or before its `Ship By`, and may leave up to *Pull forward* working days sooner
   (3 for NSW delivery and linehaul, 10 for containers by default). This is the
   warehouse limit: shipping early means finishing and staging early, so
   tighten it in peak season.
2. **Only due orders open a load.** An order with time left never causes a
   truck or container on its own.
3. **Orders stay whole.** An order is split only when it is bigger than the
   largest vehicle: full loads plus a remainder.
4. **Top-up.** Spare space is filled with open orders on the same route.
   For NSW delivery the nearest are taken first — same customer, then same
   city, then distance — and every drop on a run must be within the run
   class's radius of every other drop (30 km metro, 120 km regional) and the
   drop limit (8 metro, 4 regional). Inside the firm window (2 working days)
   only orders whose goods are ready are pulled forward.
5. **Right-size.** Each load takes the smallest vehicle or container that
   holds it. An NSW run of 2 m³ or less is booked as a part load (pallet freight)
   rather than a whole truck. A linehaul or
   container shipment at or below the part-load limit (25 m³ LTL, 15 m³ LCL)
   goes as a part load, unless open orders together reach a properly filled
   full load (80% FTL, 85% FCL).
6. **Volume advice.** A full load under its fill target, or only just over the
   next size down (within 10%), says so on the card.

7. **Daily limits.** The dock loads out about **3 trucks** (NSW truck runs
   and linehaul FTL) and **2 containers** (FCL) a day, from past dispatches;
   part loads are not counted. A day over a limit, or over the marshalling
   capacity, has proposed loads brought forward to the latest earlier day the
   route departs that still has room — only inside every order's pull-forward
   window, never before today, into the firm window only with all goods
   ready, and never a load carrying a pinned order. Nothing is moved later;
   what cannot move leaves the day flagged over its limit. The card of a
   moved load says where it came from.

The **marshalling capacity** is derived from the same limits: what the dock
can load out in a day, at the largest sizes — 3 × 75 m³ (semi or FTL
trailer) + 2 × 68 m³ (40' HC) = **361 m³**. It follows the limits and the
sizes on the Settings tab; turn derivation off there to enter a figure.

## Input: the Assembly board

Goods built to order (`FulfillmentMethod` = `Job`) come off the Assembly
board, and the two pages share one join: an Assembly job is named after the
order release it fills — `0` + the order number, then line and release.
`018140-1-1` builds order `18140`, line 1, release 1, the same `Order`,
`Line` and `Rel` as the waybill. Stock jobs (`SFM…`, `ASM…`) map to no order.

For every order on a load, the Dispatch page reads the board's forecast for
the jobs building the order lines still open on the waybill: the line each
is on, what is left to build, and its **Expect Date** (the end of its bar at
the crew it has). The last one off the line decides:

- **A routed order is one job.** An upholstered order at two benches at once
  (`018532-5-1#10` foaming beside `#20` sewing) is filed once, as
  `018532-5-1`, at *UPL-Gluing › Foaming · UPL-Gluing › Sewing*. Each bench's
  Expect Date already carries the benches still in front of the order, so the
  latest of them is when the order comes off the line. It is done only once
  its last operation is.
- **A press run counts.** A moulded part sold as it is never reaches an
  Assembly line; its run on a PMD press sub-line (*PMD › M12*) is its
  forecast, the end of the run in the press plan. Changeovers are not orders.

| Chip | Meaning |
| --- | --- |
| `Assy 14/10` green | off the line before the load leaves |
| `Assy 15/10` amber | off the line the day the load leaves — tight |
| `Assy 16/10` red | off the line after the load has left |
| `Assy no date` amber | a job still to build has no Expect Date: on no line, or nobody on it |
| `Assy done` green | every job finished |

The chip is on each order of a load card, the booking sheet (and an
*Assembly* column in its CSV) and the Orders table. The Day board adds an
**Assembly** tile and alerts naming the orders that are late, same-day or
undated; the Look-ahead adds *Assembly late* to the plan facts and each day's
overview; an order's detail lists its jobs with line, quantity, start and
Expect, and says when Assembly finishes after its due date (a SIFOT miss
unless Assembly brings it forward). **Assembly link** on the Orders tab says
how many of the waybill's built-to-order orders the board has a job for, and
lists the ones it does not. The plan itself is not moved by it: it flags.

The other way round, the Assembly board shows each job's order **Ship By**
— `SHIP 21/10`, red when the job finishes after it, `LAST` when it is the one
line the order is waiting for (see *Ship By on an order* in
`board-interaction-rules.md`), read from the Waybill list on every screen.

The board's dates are only as good as its crew. Without the `ASSY_Operator`
roster (no SharePoint), nobody is on any order and every order reads *no
date*.

## Input: stock and open purchase orders

Lines that are not built to order — `Stock` and `BTO` — get a date too, from
the two exports the Assembly board already reads beside `Planning1.csv`:
`OnHandInventory.csv` (on hand by part) and `PODetail.csv` (open PO
releases by part), plus the **stock jobs** on the board (`ASM…`, `SFM…`:
jobs built for no order, on their Expect Date).

Neither export carries a sales order number, so supply is shared out **by
part**, the way MRP pegs it:

1. On hand less what the waybill already has allocated is **free stock**,
   ready today.
2. Then the open supply, earliest first: a PO release on the later of its
   due date and the supplier's promise (an overdue release counts as today),
   a stock job on its Expect Date. Undated supply comes last.
3. The lines short of goods (left to ship less allocated) take from it in
   the order they are due — `Ship By`, then `Need By`, then order number —
   first due, first served. A line covered by two releases is in when the
   second arrives.

| Chip | Meaning |
| --- | --- |
| `Goods in stock` amber | free stock covers it but it is not allocated — allocate and pick it the day it leaves |
| `Goods 22/10` green | everything short is in before the load leaves |
| `Goods 22/10` amber / red | in the day the load leaves / after it has left |
| `Goods no date` amber | some of it has no stock, PO or stock job — or its PO has no date |

The chip sits beside the Assembly one on load cards, the booking sheet and
the Orders table (*Assembly · Goods*). The Day board lists the orders whose
goods arrive after their load leaves, and those with no supply. An order's
detail has a **Stock and bought-in goods** table — each short line, where its
goods come from (`20 from stock · 30 on PO 504290 (Acme) 22/10`,
`10 from job ASM8008 23/10`) and when they are in — and its *Lines* table
says the same per line, or *Allocated*, or the job building it.

It is an estimate, and says so: a release bought for one customer is
credited to whichever line is due first, which is also what the warehouse
does with it on arrival. Without `OnHandInventory.csv` nothing is shown — a
stock line would otherwise read *no supply* with the shelf full. Without
`PODetail.csv` only stock and stock jobs count, and the order's detail says
so.

## Who it is for, and the page

Three readers: the **warehouse manager** (space, labour, what is not ready),
the **dispatch office** (what to book, what has gone) and **their manager**
(dollars out the door, service level, vehicles). The page is laid out in
that order of the working day.

### Headline figures

Five tiles on every tab, each opening the view behind it:

| Tile | What it counts |
| --- | --- |
| **Shipped today** | value of the loads marked dispatched today; under it, what is still to go today |
| **Shipped month to date** | value dispatched this month; under it, the month-end forecast (shipped + still planned this month) |
| **SIFOT month to date** | Shipped In Full, On Time — orders due this month that left complete by their due date, against the target (95% by default: green at or above, amber within 10 points, red below) |
| **Trucks today** | contractor trucks leaving today — NSW truck runs and linehaul FTL trailers; how many have gone; NSW part loads and LTL apart |
| **Containers this week** | FCL containers leaving Monday–Sunday, by size; LCL apart |

**Where the dollars come from.** The waybill lists open orders only — a
shipped order drops out of it — so shipped dollars and SIFOT come from the
*shipment log*: every load marked dispatched records what left, its value,
its due date and whether its goods were ready. `ReleaseVal` is the value still
open on each line (it falls as lines part-ship). By default the figures count
goods only; Settings can add the freight charged. A split order's value is
shared by m³. **Undo dispatch** removes the record.

**SIFOT rule.** Measured on orders *due* in the period (the strict form that
counts backlog): shipped complete on or before the due date with every goods
line ready is a hit; shipped late, shipped with goods not ready (a part
shipment), or still open after the due date are misses. Open orders are only
counted from the first load marked dispatched, since before that the app
cannot tell a shipped order from a missing one.

### Day board (opens on today)

- **Day head** — previous/next dispatch day, Today, a date picker, and the
  day's loads, m³ and value.
- **Where the day stands** — loads *To book → Booked → Dispatched*, each with
  m³ and value; **Goods not ready** on the loads still to go; **Load-out**
  — trucks and containers against the daily limits; **Marshalling** against
  the area's daily capacity.
- **Alerts** — loads from earlier days not marked dispatched, the orders not
  ready (check with production before booking), loads with warnings, a day
  still over its limits (book extra or move a load by hand), and loads
  brought forward to this day.
- **To book** and the route filter; **Load cards** or **Booking sheet**;
  **Edit loads**, then **Save** or **Cancel**.
- Loads by route. **Mark booked** once the contractor has the load;
  **Mark dispatched** when it leaves. Mark dispatched is also on unbooked
  loads leaving today or earlier, for a load booked by phone and not marked.

### Look-ahead

Plan facts for the whole waybill (open orders, m³, loads, average fill,
orders pulled forward, orders sized by pick list or cubics, orders past their
due date), then the volume chart by day or week against the marshalling line,
the weekly table and the day strip, each day with its trucks and containers
(over a limit in red). Clicking a day — column, chip or week row — selects it
and shows its **day overview** below, without leaving the look-ahead: loads,
trucks and containers against the limits, part loads, marshalling, value,
goods not ready, what to book, and each load with its route, size,
contractor, ship-to, m³, fill, due date, status and notes. **Open on Day
board** takes the day there to work.

### Performance

The month: dollars shipped per working day with what is still planned on
top, a week-by-week table (shipped and planned dollars, trucks, containers,
part loads, orders due, SIFOT), and every SIFOT miss with its reason.

### Load cards

Each card's title row names the route and the ship-to customers on it
(`Sydney metro  Acme Fitout · Beta School +2`); loads are numbered per day
(`L1`, `L2`, …) the same way on cards and on the booking sheet. Each drop
shows ship-to name, city and customer ID, the pick-list comment, m³ with its
source (P packed, C cubics sheet, E entered, unmarked freight line),
`Ship By`, `ExpDeliveryDt` and goods readiness. A drop leaving after its
`Ship By` or after the customer's delivery date is shown in red.

### An order

Clicking an order number anywhere opens it in a panel on the right, over a
dimmed page; it closes with ×, Escape or a click anywhere outside it. From
the top: the order, its readiness and what the planner did to it (Held,
Pinned, on a fixed load); the four dates that decide a dispatch — `Ship By`,
`Need By`, `ExpDeliveryDt` and the planned day (red when it leaves after its
deadline, or has no day); what needs attention; **Delivery** (ship-to and
address, customer, Ship Via, zone, city, route); **Size and value** (volume
and where it came from, value, freight line, packed cube from the pick-list
comment, cubics sheet, weight); the Assembly jobs building it and where its
stock and bought-in goods come from; **Planner actions** (pin to day, volume
m³, hold back); and its **Lines**, each with what covers its goods and when.

## Booking sheet

The day's loads as one table the dock books carriers from: per load, what to
book, route, m³, fill, weight and status (Proposed, Edited, Booked); under
it, every order with ship-to name, address, zone, Ship Via, pick-list
comment, m³, kg, `Ship By`, delivery date and readiness. **Download CSV**
writes one row per order with the load repeated on each row;
**Print** prints the sheet alone on landscape A4.

## What to book

Every load card leads with its recommendation — for example
`1 × Rigid 12-pallet truck — 45 m³ usable · 12 pallet spaces` or
`1 × 40' HC container — 68 m³ usable · Internal 12.03 × 2.35 × 2.69 m` —
and shows the route's whole size ladder beneath it: each truck or container
with how full this load would make it, the ones it does not fit marked
*too small*, and the chosen one outlined. Part loads read *book a part load (pallet freight)*,
*book LTL* or *book LCL*. The day header and the weekly table add up the
same picks into a booking list (`2 × Semi 22-pallet · 1 × 40' HC · 3 × LTL`).
Sizes, usable volumes and notes are edited on the Settings tab.

## Look and feel

The page follows the MES KPI page (`src/ui/kpi.ts` / `src/styles.css`): the
same toolbar card with tab
buttons, one row of headline tiles with a traffic-light top border, dark
header tables, and the MES theme colours (read from the MES variables when
present, with the Day-shift values as fallback). The toolbar and tiles scroll
away with the page; only the filter row stays pinned. The route colours in
the chart are blue, teal, violet and orchid — never orange, amber or red,
which MES keeps for warnings.

## Planner decisions

- **Edit loads** (on the day) opens every card for hand changes, because a
  proposal can be wrong — two customers who must not share a truck, a site
  that only receives on Fridays. The changes show on the plan at once but
  reach nobody else until **Save**; the bar beside it counts the orders
  changed. **Cancel** drops every change made since Edit loads — pins, holds
  and bookings made meanwhile too. On another tab a banner says edits are
  open; closing or reloading the page drops them, after the browser asks.
  - **Move to** on a drop: onto another load (any day, same route type),
    onto a truck or container of its own, or *take off* and let the
    optimiser place it elsewhere. A split piece moves alone; the rest of the
    order stays planned.
  - **Size**: click a size on the ladder to book that truck or container.
  - **Dispatch day**: change the day.

  Every change freezes the loads it touches (*Edited*): re-planning keeps
  them as left and plans the rest around them. Unless a size was picked, an
  edited load is re-sized to what it now carries. Nothing is refused, but
  everything is checked: over capacity, more drops than the run takes, drops
  further apart than the run radius, an order on a load that does not go its
  way, a day the hub or port does not depart, and orders leaving after their
  `Ship By` are all warned on the card. **Reset to plan** drops the edits.
- **Mark booked** records a proposal or an edited load as booked with the
  contractor: re-planning no longer touches it. **Mark dispatched** records
  it left; **Release** hands its orders back.
- On an order: **Pin to day**, **Hold back** (with a reason), and **Volume m³**
  to enter or correct its cube.

Decisions are kept on the Waybill list (see *Where the waybill comes from*),
so every screen plans from the same ones. The settings are kept in each
browser (`resero.dispatch.v1` in localStorage).

## Assumptions to confirm

Every default — vehicle and container usable volumes, pull-forward windows,
the firm window, staging capacity, hub departure days (Brisbane and
Melbourne Tue/Thu, Adelaide and Hobart Wed, Perth and Darwin Mon), container
stuffing day (Thu), part-load limits and fill targets — is a starting value
and editable on the Settings tab. Public holidays are entered there too.

NSW proximity uses approximate suburb centres in
`src/domain/dispatchLocations.ts`; a city missing from it only shares a run
with the same city or its own zone and is listed under Exceptions.
