# Current Status

> Snapshot of where the project is. Update this when state changes.

**Branch**: `claude/rewrite-production-app-e18pD` → PR #1
(`github.com/Samefeeling/MES/pull/1`). Push here; the PR updates itself.
**Do NOT open new PRs.**

**Build health**: `tsc --noEmit` clean · 56/56 Vitest pass · `npm run build`
ok (~76 KB JS / 24 KB gzip).

**Two npm packages, two installs.** The dashboard is this package; the
Assembly board is `assembly/`, with its own package.json and lockfile. A
`git pull` that adds a dependency to either half leaves a tree that looks
installed and is not, and the symptoms name neither npm nor the missing
package — `Cannot find module 'node:url'` out of `vite.config.ts` (root
`@types/node`), or a wall of unresolved `react` / `zustand` / `xlsx`
imports when `vite` starts (Assembly). `npm run dev` and `npm run build`
now run `scripts/check-deps.mjs` first, which names the missing packages
and the command to fix them (`npm install` / `npm run setup:assembly`).
Deliberately not a `postinstall`: that would couple installing the
dashboard to Assembly's registry being reachable.

## Done & working

- Full operator sheet UI (Excel-style), trace view, breakdown cascade,
  multi-fill drag, shift colour themes (Day=blue / Afternoon=green /
  Night=yellow), iPad/elderly sizing, RESERO logo.
- Pure core logic (shifts, status, conflicts, metrics, lock, planning,
  breakdown) — all unit-tested.
- `MemoryDataLayer` — fully working seeded backend (`npm run dev` shows it).
- `SharePointDataLayer` — full implementation against the **real 11 lists**.
  Field map calibrated from actual `diagnoseFields()` / `$top=1` output
  (not guesses). Save-on-signoff writes PMD_Production + PMD_BreakDownlog +
  PMD_Rejects; reads hydrate history back from headers.
- `syncPlanningFromExcel()` — reads the planning `.xlsm` via Graph, clears +
  repopulates PMD_Planning. Wired to ⟳ Refresh + daily auto-sync.
- Reject catalog migrated 21 P-codes → **10 flat D-codes (D01-D10)**.
- SessionStart hook (`.claude/hooks/session-start.sh`) installs deps on web.
- **KPI meeting view** (`#/kpi`): per-machine Output/Reject/Yield%/Run/Down/
  Setup/OEE*/Schedule-Adherence, period selector (this/last week/month).
- **Full-screen SPFx web part**: read mode mounts a fixed full-viewport
  overlay (hides SP chrome on iPad); edit mode renders inline.
- **Reject↔status**: `PMD_Rejects.RejectCategory` now carries the slot's
  machine status so die-change defects are distinguishable.
- **Live-column highlight**: the whole current-time column (status + all
  reject rows) is tinted, not just the status cell.
- **Mango IMPW actions** (`#/kpi`): signed-off shifts that lost time to a
  breakdown (B slots only — *not* the Down h column, which counts Smoko),
  missed the yield threshold, or blew the per-shift reject allowance raise a
  "ready to raise" card with Yes / No, open to anyone at the screen. Yes
  drafts the improvement (`core/impw.ts`) and files it through **Mango's
  Public API v4** (`ui/mango-api.ts`), transcribed from the vendor document
  into `docs/mango-api-v4.md` — that file is the authority, nothing here is
  inferred from the web form:
  - `POST /api/auth/authenticate` → bearer token (in memory only; Mango
    ties a token to the acquiring IP, and one 401 retry re-authenticates);
  - `GET /api/v4/improvement/new` → the tenant's own Type of Improvement
    and Coordinator lists, so those two are **picked from Mango**, never
    guessed. Every KPI ticket is filed under one Type of Improvement —
    **Process Gap** — so the register can be grouped; the dialog narrows
    Mango's list to it, and falls back to the full list if this tenant
    spells it differently rather than leaving nothing to pick. The web
    form's own `Type` (Design Defect / Equipment / Process Improvement /
    Quality) is suggested from what actually went wrong, and never
    auto-picks Design Defect — a KPI miss cannot prove a design is wrong.
    **Investigator** defaults to Avila Pushparaj and rides in
    `improvementDetails` as a request: v4 has no investigator field, Mango
    assigns the real one, and pressing the ticket number reads that back;
  - `POST /api/v4/improvement` → the ticket; the reply's
    `abbreviation + number` ("IMP 0123") is shown on the card.
  - `GET /api/v4/improvement/{id}` → **the ticket number on the row is a
    button**: pressing it asks Mango where the ticket has got to and shows
    Current Stage / Investigator / "To be completed by" first, then the rest
    of what Mango holds (nothing editable — the API has no PUT, and a second
    place to edit a stage would be a second version of the truth). The
    dialog carries the same `kpi-impw-modal` shell, sections and labelled
    fields as the one that wrote the ticket, so the pair cannot drift; it
    links nowhere, because the vendor document contains no web-app URL and
    the only path known is the IMPW form's front page, not the record. The
    document's page for this endpoint is a copy-paste of the Compliance one,
    so PMD checks what came back and falls back to `GET /api/v4/improvement`
    (the register, matched on id or number) when it gets the stub the
    document describes. The three progress fields are then kept on the
    decision and shown on the row **with the time they were read** — a
    stage from last week is not today's stage.
  - **Never raised twice.** A confirmed ticket is written into that shift's
    Handover (`IMPW: IMP 0123`), which lives in SharePoint, so *every*
    device reads the same answer: `impwTicketFromHandovers()` puts it on the
    slice, and a shift that already carries one is listed with its ticket
    number instead of a Raise button, is out of the pending count, and is
    refused by `openImpwTicket()` even if a stale render lets the click
    through. The Yes / No ledger is per browser and cannot do this on its
    own — before it, a second iPad (or cleared site data) would offer the
    same shift again and put two people on one night's fault.

  The API takes 10 fields where the web form asks for 26, so what PMD can
  actually prove — press, **material (Part # and description, per order)**,
  orders, output/reject/yield, every breakdown cause with the operator's own
  note — goes into `improvementDetails` (4096 chars) rather than into
  invented fields. The part number also leads the Brief Description: the
  register lists tickets by that one line, and "which press" without "which
  part" does not tell a reader whether the ticket is theirs. Region / Branch /
  Department / Other are optional to the API but must name something that
  already exists in the tenant; a blank one is omitted rather than sent.
  With no sign-in stored, Yes copies the filled form and opens IMPW to
  paste into, and any API failure falls back to that same path quoting
  Mango's own response — filing a ticket never depends on the API being
  reachable. Mango stays the system of record; PMD keeps no register.
  Decisions are remembered per browser (`pmd.impwDecisions` — the ticket
  reference, Mango's record id, and the last progress read), as are the
  plant's answers (`pmd.impwSite`).

## Assembly results (`#/kpi/assembly`)

**PMD / Assembly are the first two buttons of the KPI toolbar**, ahead of
`Last 24h` (`src/ui/kpi-nav.ts`, shared by both pages). They were their own
band above the page, which put a third row of navigation under the top bar's
own; they are the same kind of choice as the period tabs beside them, so they
are now the same control.

The page carries PMD's own layout — period tabs, From/To, headline tiles, one
`.kpi-table` with a `TOTAL`, a legend — because the two are read one after the
other in the same meeting. PMD rolls machine-shifts up per press; Assembly
rolls order-days up per **line**, each opening into its orders, with the
day-by-day bookings kept underneath as the evidence. Metrics are **Output / Plan** /
Complete / Reject / Rework / **Yield%** / **Crew h** / **Booked h** /
**Std h** / **Efficiency\*** / **Support h** / **On time%**, all in
`core/assembly-metrics.ts` (pure, unit-tested). Output is read against a plan
the way PMD reads its own — the figure, a small `/n`, and the colour from the
ratio — where the plan is Crew h ÷ the order's standard, since Assembly keeps
no separate daily schedule. Booked h values *everything* that came off the
line at that standard and Std h only the good pieces, so the gap between them
is what the rejects cost in time. Two rules keep the figures honest and both are printed on
the page:

- **Support work is never production.** It has no output at all, so folding
  its rows in would report a line that made nothing all week.
- **A day with no standard is out of *both* sides of Efficiency**, not scored
  zero — an order nobody gave a labour standard is not an order that was
  worked badly. Same reasoning as PMD dropping an unjudgeable job-shift.

Efficiency needs a standard on the record, so **`PlannedHours` is now written
on every order** rather than only on support ones (`production.sync.ts`,
order-level, backfilled on the next sync). No new SharePoint column: it is
already in the list. `PlannedHours ÷ OrderQty` is the hours one finished unit
is worth; Crew h is the people on the row × 7.5, the same figure the board
schedules with, so the KPI measures against the plan the floor was given.

## Assembly line routing and the board (`assembly/`)

The board runs **eight lines — TBP, PMD, UPL-CUT, UPL-Gluing, UPL-SSS, ASM,
Table, General** (`assembly/src/domain/assembly.ts`). PMD is a read-only
context lane. The old `UPL` catch-all and `ASSY_STOOL` are retired and
migrated on read, so saved plans and rosters still open.

**The supervisor can open a line** (`+ Line`, supervisor only) beyond the
eight — a second bench for a rush, a bay for one big order. Key `VL_<NAME>`,
so it stays a `LineKey` everywhere; stored in the shared plan
(`planStore.virtualLines` → `ASSY_Plans`), not in one browser; schedules,
takes crew and appears in the Move-to-line picker like a real line; closing it
tips its orders back into the pool. `reconcile` supplies its work centre
itself, because the export has never heard of it.

**A `Due ≤ 2d` filter** in the header, with a count: what has to go out within
two *working* days, **plus everything already late**. It ANDs with the day
chip.

**TBP and PMD open folded away** — neither is planned here — each leaving a
`+ TBP` / `+ PMD` chip in the header, and every line carries a `×` to fold it.
A folded line's orders still count towards the roster load, the day columns
and the totals. **All seven frozen columns are dragged** by their right-hand
edge or moved with ← / →; the widths live in `uiStore` and the grid starts
where the frozen block ends, so nothing has to keep a second copy of them.
The **"All orders" / "5 working days" buttons are gone**: the board shows
everything, and the only narrowing left is the day chip under a timeline
column, which puts a blue chip in the header naming the day it picked and
clearing back to everything. A line's row is now a tinted band with a
dark-blue name in capitals, so it cannot be mistaken for an order row, and
chrome is three deliberate tiers — a slate title bar, the dashboard's dark
blue for the board's own heading, and white for the orders alone. All three
used to be shades of the same near-white.

**A blank Expect Date now says why.** `uncoveredHours` and `crewWithoutRoom`
were computed on every row and shown nowhere; the Expect cell carries them on
hover and the inspector shows an `N h not covered` badge. The underlying
cause was in the scheduler: a person's availability for one order was a single
window that **closed at their first other booking and never reopened**, so one
day elsewhere next week cost the order every day after it — five days of work
covered two, and the date went blank while the crew were plainly not full.
`planVariableCrew` now takes a per-day `TakenOnDay` instead
(`crewSchedule.ts`, `board.ts:takenOnDay`). Covered by
`tests/engine/crewDiary.test.ts`.

**And a shift is filled continuously.** `TakenOnDay` returns *how much* of a
person's day is gone, not whether any of it is — the diary already stores the
instant they come off, so the fraction is how far into the day that lands.
`planVariableCrew` starts each day at the latest of what the order was waiting
for and what its crew were already on, so orders queue into a person's 7.5
hours back to back, in the middle of a run exactly as they always did on an
order's opening day. It was a yes/no before and a booked day was refused whole:
an order whose crew lost two hours of a Monday skipped the Monday, finished a
day later and drew a hole over five and a half hours nobody was using. Only a
day with nothing left in it now costs the order the day — so `pauses` still
fire, but only for real ones. The floor's own numbers are the tests: nineteen
hours over five orders is 7.5 / 7.5 / 4 for one person and 15 / 4 for two, and
no one is ever charged more than a shift in a day.

**A bar is no longer drawn in pieces.** The per-day availability above is what
lets an order keep the Friday and the Tuesday while somebody else has the
Monday — right, and drawn as two separate blocks it read as two orders, so the
floor dragged the bar back together until it looked whole. Two holes mean
opposite things: a weekend is the factory being shut (`openDaysBetween` in
`dates.ts` counts none), an open day is the crew being elsewhere. The second
kind is **joined by a dashed rule** (`.bar-link`), counted, and named —
`OrderRow.pauses` (`board.ts`, from `crewSchedule.idleRuns` plus a
`worker|day → jobId` diary) says which order took the days, on the bar's title
and as a `put down N days` badge in the inspector.

And the drag itself is answered: pinning is what closes the hole, because a
pinned order consults no diary — so both orders are then **hatched in amber**
and each names the person and the other order (`OrderRow.doubleBooked`,
`markDoubleBookings`, read off the finished board so it is symmetric rather
than landing on whichever resolved second). A hand-over is not a clash: both
sides of one are computed by division, so the overlap test carries a `1e-6`
tolerance — without it every clean hand-over on the board reads as a double
booking (seven of them on the demo seed).

**Moving an order is behind the supervisor gate**, like allocating crew has
always been: the bar drag (pin day / change line / drop to the pool), filing an
unplaced card, and **Release** on a pinned start. `OrderBar` and the pool card
disable their draggable and say why; `useDragDrop.onDragEnd` refuses as the
backstop. Unchanged and worth restating: one shared password compiled into the
bundle is an operational gate, not authorization — SharePoint's list
permissions decide who may write and its Modified By records which supervisor
did. A real boundary means restricting write on `ASSY_Plans` /
`ASSY_Production` to a SharePoint group.

**The board keeps clock times, not fractions of a calendar day.**
`engine/assembly/shift.ts` is the single place work and the clock meet: the
07:00–15:30 shift less breaks at 09:00, 12:00 and 15:15, with the work
stretches *derived* from the breaks and a test tying their 450 minutes to
`PRODUCTIVE_HOURS_PER_PERSON`. `clockAtWorkMinutes` / `workMinutesAtClock` are
exact inverses; `shiftClockAt` is the end side of a fraction and `shiftStartAt`
the start side (they part by a break and nowhere else — a component off a press
at 12:10 is picked up at 12:30, not 12:00). Sub-minute precision is carried
rather than rounded, or a successor starts before its own predecessor finishes.
Wired through `planVariableCrew` (`opening`, `first`, the end of each day),
`board.ts:takenOnDay` (work done by then, not time elapsed), `latestStart`, and
`timelineDayOffset` — a day column is now the shift, so bars sit where the work
sits. `startOfCrewDay`/`endOfCrewDay` derive the two times rather than storing
them. The old `shiftMoment`/`shiftFraction` in `dates.ts` spread the breaks
evenly across the span and are gone: three hours before a shift ends must start
at 11:45, and the even spread said 12:06 — inside lunch, 2.75 h left.

A run of days is one block when nothing open lies between them and neither end
stops short, rather than when two instants share a midnight — otherwise every
multi-day bar would come apart at every night. A gap **inside** a day is now
drawable, so `OrderBar` links any visible gap rather than only one swallowing
whole days, and says *put down for part of a day*.

**Still to do on this:** dragging is whole-column and ignores a move inside a
day. Landing on 5 minutes needs the pinned start to carry a time, and
`orderStarts` is a `YYYY-MM-DD` map in the shared plan that goes out to
`ASSY_Production` — a stored-format change with back-compatibility, which is
why it is not in this commit. The zoomable time view is the same feature as the
Timeline stops in the banner prototype.

**The gate is the host's, and now says so.** `mesBridge.connectMes` sets
`hosted` on the supervisor store; `SupervisorLock` renders nothing when it is
set, so inside MES the top bar's button is the only one — the board used to
hide its lock on `window.parent !== window`, which was the right behaviour for
an accidental reason. Every "you need to be signed in" line is built from
`signInAt(hosted)` (`store/supervisorStore`): they all said "in the header",
and inside MES that is the one header with no such control on it.

**The board's chrome is two tiers, not four.** MES's top bar now lights the
page you are on (`markNav`, `aria-current`, `main.ts` + `.top-nav a` in
`styles.css`), which is what let the board stop titling itself — the `<h1>`
renders only when the board is unhosted. `.app-header` and `.assy-head` share
one ground (`--head-bg`, moved from `#075985` to `#0369a1`) parted by a
hairline, so the controls row and the column heading read as one block instead
of a slate band plus a dark-blue band identical to the top bar's. Controls on
it are translucent white, the same language as the top bar's own nav buttons.
Lightening the ground cost contrast, so the heading's greys (`--muted` /
`--faint` on past and weekend columns, which were near-black on blue and
already wrong) and its load figures are lightened to clear 4.5:1 —
`board-chrome-e2e.mjs` measures the ratios rather than trusting the eye.

One blank-cell warning was dropped: an order whose hours cells are empty is no
longer named in the banner. The banner is for problems with the *export*, and
a real one has dozens of those rows — none of which the supervisor can fix
from that screen. The header-level check (no hours column at all) stays.

Which line builds a part is decided in `engine/assembly/lineRouter`, three
sources in strict order: **ERP** (`JobHead_PersonID` settles TBP / PMD /
Table / General; `UPL` and `ASSY` name only a department), then
**`product-lines.v3.json`** — the plant's reviewed routing table, beside
`JobMaterialReq.csv` in the document library — then **the part's BOM** out of
`JobMaterialReq.csv` through `domain/lineRules`, a transcription of the
plant's `classify-lines.mjs` v4 (rule numbers and evidence wording kept, so a
result reads against that script's `--report` line for line). A reviewed part
is never re-derived: doing that every load would throw the hand review away.
Nothing invents a line — all three coming up empty leaves the order where ERP
put it.

Every description-keyword rule is gone: "contains cut" → cutting, "contains
softie" → SSS, "contains stool" → the stool line. A description is what
somebody typed; the BOM is what the part is made of. `workKind` is now a
property of the line for the same reason. Set `VITE_PRODUCT_LINES_PATH` if
the routing table is not at `/Shared Documents/product-lines.v3.json`. Full
rules table in `docs/OPERATIONAL-LINES.md`.

## Action needed on the SharePoint side

- **Add a multi-line `Handover` column to PMD_Production**, then set the
  field map `production.handover` to `'Handover'` (currently `''` = skipped)
  so supervisor handover notes persist. Until then sign-off still works,
  just doesn't store the handover text.

## Verified against the real tenant

- All 11 SharePoint list field maps confirmed from live schema (2026-05).
- User has updated `PMD_RejectCategories` list to D01-D10.

## Pending / blocked

1. **SPFx deploy — BLOCKED on IT permissions.** `.sppkg` builds; user is
   waiting on App Catalog access + Graph API approval (`Files.Read.All`,
   `Sites.Read.All`). Deploy steps ready in `/docs/DEPLOYMENT.md`.
2. **No end-to-end run against the live tenant yet.** Local dev can't reach
   SharePoint from `localhost` (CORS + SP Origin check 403 — see
   `known-issues.md`). First real validation happens once SPFx is deployed
   (same-origin) OR via the smoke test inside a deployed page.
3. **Graph token wiring** — `window.__pmdGraphToken` is set by the SPFx
   `onInit()` (`aadTokenProviderFactory`). Until SPFx is live, Excel sync
   can't run; list CRUD still works once same-origin.

## Environment config (build-time)

```
VITE_BACKEND=sharepoint
VITE_SITE_URL=https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
VITE_PLANNING_PATH=Shared Documents/General/Planning/PMD/PMD Schedule_master_epicor 300424.xlsm
VITE_MANGO_IMPW_URL=https://my.mangolive.com/improvement-workflow
```
Default (no env) = `memory`. `VITE_MANGO_IMPW_URL` is the human IMPW form the
KPI page opens for the copy-and-paste path — **confirm the real path**.

The Mango **API** sign-in is deliberately NOT build-time config: the account
password is rotated, and an env var would mean a rebuild every rotation. It
is entered on the device from KPI → ⚙ Mango connection (supervisor only)
and stored in that browser's localStorage under `pmd.mangoApi`
(`{baseUrl, username, password}`, default host `https://api.mangolive.com`;
`https://api-uk.mangolive.com` for a UK-hosted account). The API paths are
fixed by Mango and are not configurable. Each device that files tickets
needs it set once, and the dialog's **Test sign-in** answers on the spot.

Two things must be true on the first live run, and neither is a code
change:

1. **API access is enabled on that Mango account.** An ordinary Mango login
   is not automatically an API login — it is switched on per user inside
   Mango. A 400 from `/api/auth/authenticate` says so.
2. **`api.mangolive.com` must return CORS headers for the SharePoint
   origin.** The calls are cross-origin from the browser, so Mango has to
   allow them; no front-end change can work around a refusal. A browser
   reports a CORS refusal exactly like being offline, and
   `describeImpwApiFailure` names both causes. The copy-and-paste path is
   kept precisely so this cannot block the plant.

## Immediate next action

When IT grants access: follow `/docs/DEPLOYMENT.md § B` (SPFx) → upload
`dist/` to `SiteAssets/pmd/` → run the smoke test in
`/docs/LOCAL_DEV_WITH_SHAREPOINT.md` → report any 400 (field-name) errors.
