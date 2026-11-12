# Known Issues & Gotchas

> Traps that already cost time. Read before debugging the same thing twice.

## SharePoint hosting / auth

- **You cannot test from `localhost` against SharePoint.** Two stacked
  blockers:
  1. CORS — fixable with a browser CORS-unblock extension.
  2. **SP "Origin check" → 403 with empty body.** Even with CORS fixed and
     a logged-in session, SharePoint rejects REST calls whose `Origin`
     isn't the site itself. A CORS extension can't fix this (it's an
     app-layer SP decision). Signature: `403 Forbidden` + "Unexpected end
     of JSON input" on `r.json()`.
  - **Workaround for dev**: launch Edge/Chrome with
    `--disable-web-security --user-data-dir="C:\temp\edge-pmd-dev"`. Often
    **blocked by corporate policy** (no yellow "unsupported flag" banner =
    blocked). If blocked, use a portable browser or just deploy SPFx.
  - **Real fix**: SPFx hosting → same-origin → both problems vanish.

- **Modern SharePoint force-downloads `.html` from doc libraries.** So you
  can't just drop `index.html` in SiteAssets and open it. `.js` and `.css`
  from SiteAssets DO serve inline — which is why the SPFx web part renders
  the shell itself and only loads `assets/index.js` + `index.css` from
  `SiteAssets/pmd/` (see `/docs/DEPLOYMENT.md § B`).

## SharePoint field names

- Internal column names ≠ display names, and are **frozen at column
  creation**. Excel-imported lists put the primary key in `Title` and gave
  other columns auto-names (`field_1`) or `_x00NN_` encodings. All real
  names are mapped in `DEFAULT_FIELDS` (`src/dal/sharepoint.ts`) and
  documented in `data-model.md`.
- If a list reads back all-empty values but the GET succeeds → a column
  name in `DEFAULT_FIELDS` is wrong. Run `window.__pmdDal.diagnoseFields()`
  (dev) and patch, or pass a `fieldMap` override.
- DateTime columns (`SlotStart_x003a_`, `PMD_Rejects.Date`,
  `PMD_BreakDownlog.Date`) must be filtered with `eq datetime'...'`, not a
  plain date string. Already handled in the adapter via `shiftBounds`.

## App behaviour

- **Status = "offline"** + blank body means `route()` threw (usually the
  first DAL call failed). Check the F12 console/network for the real error;
  it's almost always SP auth/CORS/field-name, not the app code.
- **Daily auto-sync** (`main.ts`) is gated by a `localStorage` timestamp
  (6 h). It silently no-ops if `graphToken` isn't wired yet — don't expect
  a toast. The ⟳ Refresh button is the manual override.
- **`+`/`−` direction**: `+` zooms IN (toward single-shift detail), `−`
  zooms OUT (Today → 7d → 30d). This was reversed once; keep it this way.
- **SharePoint backend persists only on Sign off & Save.** Mid-shift slot
  edits live in the adapter's in-memory cache; a page reload before sign-off
  loses unsaved edits from the LAST 60 s, but everything before that has
  already been pushed to PMD_LiveStatus and is recovered on the next read
  (see editCache reconciliation below). Acceptable for v1.
- **editCache ↔ PMD_LiveStatus reconciliation** (fix for SFM507068 14:23
  incident, 2026-06-15): `listProduction` backfills editCache from
  PMD_LiveStatus per slot. PMD_LiveStatus is the 60 s mirror, lags the
  live keystrokes but reliably survives reloads / asset redeploys /
  fresh devices. Before the fix, a reload that ended up with a partial
  editCache (e.g. only slot 0 and slot 9 instead of 0..9) plus a
  subsequent Sign Off & Save would aggregate only the cache and burn a
  partial timeline into PMD_Production, silently dropping every slot
  and reject the cache had lost. The backfill merges per-slot — cache
  wins per slot since it's strictly fresher than the 60 s mirror — and
  skips tuples already signed off in PMD_Production (canonical).
  Sign-off then deletes the PMD_LiveStatus mirror (`deleteLiveRow`) so
  the next read finds no stale snapshot.
- **Stale PMD_LiveStatus cleanup** (added 2026-06-16): operators
  occasionally tap a machine on the wrong job / wrong shift / wrong
  date and walk away, leaving a partial row in PMD_LiveStatus that
  nobody ever signs off. Without cleanup these rows accumulated and
  the editCache reconciliation absorbed them as "in-progress live
  data", shadowing the canonical PMD_Production row when an operator
  scrolled back to review a past shift. `listProduction` now treats
  a PMD_LiveStatus row as junk when its shift ended more than 8 h ago
  AND no MachineStatus letter is set on any half-hour slot — the row
  is filtered out of the merge/display and fire-and-forget deleted
  from PMD_LiveStatus on the next read. editCache entries matching
  the same staleness rule are also purged so the next
  `pushLiveSnapshot` tick doesn't recreate the row. Future-dated
  rows (planned tap-ahead) are never touched. See
  `isStaleLiveHeader` in `src/dal/sharepoint.ts`.
- **Deleted PMD_LiveStatus rows reappearing** (fix 2026-06-16, same
  day follow-up): a supervisor deleted junk from PMD_LiveStatus by
  hand and the app re-wrote it all back — including old 03/06
  experimental data. Two causes: (1) `pushLiveSnapshot` re-broadcast
  EVERY editCache tuple every 60 s poll tick with no shift-age check,
  and the editCache lives in the DEVICE's localStorage, so deleting
  the server row never touched the cache that recreated it. (2) The
  editCache GC added earlier that day was nested under "saw a stale
  server row", so once the rows were deleted by hand it stopped
  firing. Fixes: `pushLiveSnapshot` now skips any tuple whose shift
  `shiftEndedLongAgo` (8 h past end) — this is the key defence and
  also catches OLD rows that carry real status (e.g. the 03/06
  experiment), which the junk filter deliberately leaves alone. The
  listProduction editCache GC is now UNCONDITIONAL (runs even with no
  stale server rows present). Net effect: after deploying, delete the
  old rows once more and they stay gone — the device cache no longer
  re-mirrors past shifts. See `shiftEndedLongAgo`.
- **Unlock-and-edit redesign — append/PATCH, never delete-then-rewrite**
  (fix 2026-06-16, SFM507068 second incident): after unlock + edit +
  re-sign-off, the PMD_Production row was coming back with empty
  PartNum / PartDescription / CountStart / CountEnd / Reject /
  MachineStatus. Three root causes: (1) unlockShift deleted the
  signed-off rows from PMD_Production / PMD_BreakDownlog / PMD_Rejects
  up front, so any later failure / abandonment lost the data outright;
  (2) lockShift looked up PartNum / PartDescription from the CURRENT
  PMD_Planning CSV — Epicor drops completed orders from planning, so
  the re-write put empty strings into both columns; (3) lockShift's
  "nothing edited → write a placeholder header" branch PATCHed an
  existing row with all-blank values via the MERGE path. Redesign:
  unlockShift now leaves SP rows untouched and just rehydrates the
  editCache + marks the tuple in `unlockedTuples` (persisted in
  localStorage). The listProduction self-heal skips purge for any
  tuple in this set even though PMD_Production still carries the
  locked row. lockShift sources partNumber / partDescription
  cache-first (the rehydrated slot 0 holds the originals) and falls
  back to planning only when the cache is empty (a brand-new order).
  An empty editCache for a tuple short-circuits lockShift with no
  write — the existing row stays as-is. `ProductionRecord` gained an
  optional `partDescription` field and `HeaderRow` reads
  `JobHead_PartDescription`. See `unlockShift` / `lockShift` /
  `unlockedTuples`.
- **Unlock display: Order Qty / Part# / Description / Reject preserved
  even after Epicor drops the order** (fix 2026-06-16, follow-up to the
  unlock redesign): the supervisor unlocked 1300T Day 507071 and the
  header bar came back with empty Order Qty / Part# / Description, and
  the per-slot Rejects were also missing. Two causes: (1) `selectedOrder()`
  only looked at `S!.planning`, and Epicor drops completed orders from
  the active CSV — so the synthetic order's partNumber / partDescription
  / jobRequired stayed blank. (2) `JobRequired` wasn't denormalised onto
  PMD_Production at all, so there was nothing to fall back to even when
  the rest of the row survived. Fixes: `selectedOrder()` now falls
  through to a synthetic built from `S!.prod` canonical (slot 0) when
  planning has dropped the job, surfacing the denormalised partNumber /
  partDescription / jobRequired. A new optional `JobRequired` column on
  PMD_Production is written on every sign-off (fail-soft if the column
  isn't added on the tenant yet — `stripRejectedFields` tolerates
  absence; the only consequence is Order Qty showing `—`). Reject total
  is also preserved via a new safety net in `lockShift`: when the
  per-slot rejects map aggregates to 0 but the canonical slot 0 carries
  a non-zero `rejectCount` (rehydrated from `PMD_Production.Reject` of
  an existing row whose `PMD_Rejects` / `RejectsBySlot` was wiped by an
  earlier failed unlock), the existing total wins. See `selectedOrder`
  in `src/ui/operator.ts` and the `jobRequiredOf` / `reject` resolution
  in `lockShift`.
- **Sign off fails with `POST 500 Invalid text value. A text field
  contains invalid data. Please check.`** (fix 2026-06-17): SharePoint
  returns this when a text column receives content it refuses, and
  the error names no column. Two distinct causes both surface as this
  message:
    1. **Single-line text column overflow** (most common, confirmed by
       the field 2026-06-17). The 255-char limit silently truncates
       Single line text, but the verbose REST API rejects the write
       outright. `QualityChecks` and `RejectsBySlot` carry JSON maps
       keyed by slot index and easily run 400–600 chars on a full
       shift — both MUST be provisioned as **Multiple lines of text**
       (plain, not rich/enhanced), see the DEPLOYMENT.md column table.
       Symptom: the column ends up persistently blank in
       PMD_Production while other columns on the same row save fine.
    2. **C0/C1 controls / U+2028 / U+2029 / BOM** in a value, typically
       dropped into a handover textarea by Excel/Word copy-paste.
  Fixes: (1) `sanitizeBodyStrings` scrubs the body just before every
  PMD_Production / PMD_LiveStatus write — strips C0 (except `\t \n \r`),
  C1, U+2028, U+2029 and the BOM, killing cause 2 before it reaches SP.
  (2) `postWithFieldRetry` handles the 500 by bisecting string fields
  (longest first, so QC/RejectsBySlot overflow surfaces immediately),
  logging the offender, and writing the row without it so the rest of
  the sign-off lands. The log message distinguishes the two causes:
  values > 255 chars are flagged as needing a column-type change in
  SharePoint; shorter values are flagged as having a bad character.
  See `sanitizeBodyStrings` + `findInvalidTextField` in
  `src/dal/sharepoint.ts`.

- **A re-opened order could only be corrected on the device that unlocked
  it** (fix 2026-11-10). `Reopened = Yes` opens the row on every device,
  but the rehydrate + `unlockedTuples` flag only ran where Unlock was
  pressed. Anywhere else the sheet showed "Re-opened for correction", an
  edit snapped back on the next read (purged as a stale copy of a signed
  tuple), and Sign Off found an empty cache, wrote nothing and still
  toasted "Signed off" — leaving the row Reopened, which the KPI page
  (`r.locked` only) then left out. Now: the first edit on another device
  adopts the tuple from the signed row the server last gave
  (`adoptReopenedTuple`); a sign-off with nothing changed sets
  `Reopened = No` itself and throws if that fails; and once an unlock the
  server confirmed reads `Reopened = No` again, every device drops its
  local flag and copy (`reopenSeen`) instead of shadowing the row another
  device signed. A tenant without the column keeps the device-local
  unlock. See `tests/reopened-cross-device.test.ts`.
- **PMD_ShiftPlan is not kept from a planning read that holds no plan**
  (2026-11-10). Its rows are never rewritten, so a header-only export or a
  renamed `Machine` / date column froze "nothing planned" onto every press
  of the shift. `keepShiftPlans` now answers null (the keeper retries in
  ten minutes) unless Planning.csv has at least one ERP order with a press
  and a Start–Due window (`planningHoldsAPlan`). A file that is only
  *partly* wrong — half its rows — cannot be told from a short plan here;
  the export script's atomic write is the defence for that.
- **Throttling** (2026-11-10). SharePoint Online answers 429, or 503 with
  `Retry-After`, without running the request; one of those used to fail a
  whole sign-off. Every call now goes through `fetchThroughThrottle` (three
  more tries, waits as asked, 15 s at most). A 503 with no `Retry-After` is
  not retried — the request may have been run.
- **A value SharePoint refuses at sign-off is shown to the signer**
  (2026-11-10). The row still lands without it (see the `Invalid text
  value` entry above), but the sheet now reads `takeWriteWarnings()` after
  `lockShift` and holds a notice open naming the column — it used to be a
  console line only, so a shift's Quality Checks could be lost behind a
  "Signed off" toast.

- **Co-Run no longer asks for equal Order Quantities** (2026-11-10). The
  ⛓ Co-Run link, the status mirror and the Trace board's co-run cards used
  to need both orders at the same quantity. An uneven pair is real: both
  parts run together until the smaller order is made, then that cavity is
  blocked and the die carries on. The quantity test was only ever a stand-in
  for "not two colours of the same die", so that is now asked directly: two
  orders co-run when they are two different parts, same non-empty
  `DieNumber`, both `CoRun = Yes`, and `PMD_ProductDieColor` does not give
  the two parts different colours (a matching `ActualColor` name OR a
  matching hex is the same colour; a part with no colour recorded is not
  told apart). **If a link is missing, check the two parts' colour and
  DieNumber in the list** — they are compared as text.
- **🔒 Block a cavity** (2026-11-10). On the operator sheet, under the
  header row: shown when a part of the die has less than one full shift of
  its standard output left (8 h ÷ `JobOper_ProdStandard`) and another part
  has more left. Added up by PART over every order of it the press has in
  its list, so an order with another order for the same part behind it does
  not raise it. Job Left is the sheet's own figure (signed shifts + this
  shift), so a missing sign-off on an earlier shift delays the reminder the
  same way it overstates Job Left. No standard on the order → no reminder.
  See `cavityBlockReminders` and `tests/corun-cavity-block.test.ts`.

### Open — not fixed, needs a decision or facts from the site

- **`scripts/sync-epicor-to-sp.ps1` cannot produce the Planning.csv the app
  reads.** It writes no `Machine` column and no "no of shift" column; the
  parser, every test fixture and the Assembly press parser all need
  `Machine`. Deployed as DEPLOYMENT.md § D says, it yields a file in which
  no order belongs to any press. Whatever produces the real file is not in
  this repository — bring that script in, or add the two columns here once
  the Epicor field behind `Machine` is known. Until then the script's own
  header check (`JobHead_JobNum` only) does not protect the app.
- **All shift maths runs on the device's clock and time zone.** There is no
  plant time zone in the code: a viewer whose computer is on Auckland time
  sees "now", the current shift and Last 24h two hours out, and a device
  that writes from there keeps the shift plan early and sweeps live rows
  early. Floor iPads on automatic Sydney time are unaffected. Either pin
  the zone in `core/shifts.ts` or refuse to write from a device that is
  not on it.
- **The two daylight-saving nights.** A shift is 16 half-hours from its
  local start, so the Night that gains an hour (first Sunday of April) has
  no slot for 06:00–07:00, and the Night that loses one (first Sunday of
  October) runs its last two slots into the Day shift. Two shifts a year;
  how to book the ninth hour is a floor decision.
- **List view threshold.** Only `PMD_ShiftPlan.ShiftId` and
  `PMD_DieChangeLog.EventKey` are indexed by the app. Reads of
  `PMD_Production`, `PMD_Rejects`, `PMD_BreakDownlog` and `PMD_LiveStatus`
  filter on `Title` and the date column; past 5,000 rows SharePoint refuses
  a filter on an un-indexed column. `PMD_Rejects` (one row per reject
  event) gets there first. Check that the date column of each is indexed
  on the tenant.
- **Sign-off is a picked name, not a login.** The supervisor on a signed
  row is whoever was chosen in the dropdown; the supervisor password
  (compiled into the bundle) gates Unlock and the overrides only. There is
  no record of who unlocked a row, when, or what it said before the
  correction — turn on version history for `PMD_Production` to get the
  before/after from SharePoint itself.

## Assembly board

- **FactoryCalendar days one day early in summer — 1 January a working
  day** (2026-11-10). A date-only cell comes back as the UTC instant of the
  SITE's midnight. It was taken to the nearest UTC midnight, which is the
  right day only for a site within eleven hours of UTC. On a site whose
  regional time zone is further east (Auckland, UTC+13 in summer) every
  summer day read one early: Christmas on the 24th, New Year's Day on
  31 December, and 1 January open with work loaded on it; winter days
  (UTC+12, exactly on the half) read right, which hid it. The board and the
  KPI page's Machine Utilization now ask the site for its zone
  (`_api/web/RegionalSettings/TimeZone`) and read each cell in it; a day
  added from the board is written as the site's midnight. If the zone cannot
  be read the old reading stands. Not covered: a person whose PERSONAL
  SharePoint regional settings use another zone than the site types days in
  that zone — set the site's zone, or enter the days from the board.
- **Two identical `ASSY_Production` rows for one job-day** (fixed
  2026-09-16). The sync reads the whole list once, decides which days have
  no row yet, and opens them. Two boards on the same plan — a second tab,
  another supervisor's screen, the terminal left open on the line — both
  read "no row for today" and both opened one, so the day's *first* row
  could be written twice. It showed on closing an order because that is
  when a day's first row is usually written; updates are idempotent and
  never duplicated anything. Downstream, `createAssemblyDataLayer` throws
  `Duplicate Assembly result: job|day` and the Assembly KPI page refuses
  the range, which is correct — it cannot know which row is the figure.
  Three things close it: rows are matched on `RecordKey` rather than on a
  parsed `Date` (a SharePoint date column answers in the site's timezone,
  not necessarily the shift's day); the key is asked for again immediately
  before a row is opened, so a row another board has just written is
  updated instead; and a create refused by the list's unique index on
  `RecordKey` is recovered by writing into the row that won. **Keep that
  unique index** — `config/assembly-lists.json` asks for it, and
  provisioning cannot enable it while duplicates already exist, so clear
  them first.
- **`RecordKey` is generated, not derived** (since 2026-09-16). The board
  makes one when a shift first saves a day's entry and stores it on the
  plan; both sides then carry it. Deriving it from `Job|YYYY-MM-DD` tied a
  row's identity to the one field on the record that can be read two ways.
  The old key and the `Date` column are still tried, in that order, so
  nothing already in the list is orphaned — and a row recognised that way
  is rewritten under the booking's key, so each is asked the old questions
  once in its life. If the saved plan is ever lost the keys go with it; the
  day fallback then matches those rows and re-keys them, so no duplicates
  are written.
- **`BookedHour` must exist on the list before this build is deployed.**
  Every column the sync writes has to be there, so until it is the write
  fails with `Missing SharePoint column: BookedHour` in the board's banner
  and *no production is recorded at all*. It is in
  `config/assembly-lists.json`; re-run `provision-assembly.ps1 -Apply` or
  add a Number column named exactly `BookedHour`.
- **Efficiency reads blank for everything booked before that.** It is now
  Std h ÷ Booked h, and a row with no measured hours is excluded from both
  sides rather than scored — a day nobody timed did not take no time. The
  figure fills in from the first entry saved after the column exists.
- **Duplicates already in the list are reported, not removed.** The sync
  names the extra row's item id in the banner and keeps the *oldest* row
  for that day current. Deleting somebody's production row is not a
  decision a background sync makes; delete the named extras in SharePoint
  and the KPI page reads the range again.
- **A missing column is not a red light.** `JobReleased` and
  `MaterialPrep` are optional in `Planning1.csv`. Where the export carries
  neither, every order reads `released: null` / `materialPrep: 'unknown'`,
  and the start gate used to stop every start with "Release status is
  missing · kit status missing" and ask for an override — which the floor
  then clicked through on the orders that mattered too. `startEligibility`
  now gates on what the plant has said (not released, a real shortage, a
  kit reported not ready, nobody allocated) and steps over what it has not.

## Build / toolchain

- **Deployed app shows mock data / old P-codes = built without
  `VITE_BACKEND=sharepoint`.** The page now says so itself: a red bar under
  the top bar, "Demo data — this page is not connected to SharePoint…"
  (`backendWarning`, 2026-11-10), also for a mistyped value or a missing
  `VITE_SITE_URL`. Vite bakes env vars in at *build* time only.
  No `.env.local` (or wrong content) → `createDataLayer` falls back to
  `memory`, so you see seeded data and Afternoon/Night look empty. Fix:
  create `.env.local` (VITE_BACKEND + VITE_SITE_URL + VITE_PLANNING_PATH),
  `npm run build`, re-upload `dist/assets/index.js` + `index.css` to
  `SiteAssets/pmd/assets/`, hard-refresh (Ctrl+F5). Confirm via the
  `[pmd] backend = …` console log on boot.
- **Stable filenames + browser cache**: assets are hash-free
  (`assets/index.js`), so after re-uploading you MUST hard-refresh
  (Ctrl+F5) or the browser serves the cached old bundle. If sticky, add a
  `?v=<n>` query param to the `<script>`/`<link>` src in the SPFx web part.

- SPFx needs **Node 18** (`nvm use 18.20.x`); 20/22 are fine for plain Vite
  but the SPFx generator (`@microsoft/generator-sharepoint@1.18`) wants 18.
- Vite emits **hash-free** `assets/index.js` / `index.css` on purpose so the
  SPFx wrapper's URLs stay stable across rebuilds. Don't re-enable hashing.
- `noUnusedLocals` is on — an unused import/var fails `tsc` and the build.

## Process

- Push to `claude/rewrite-production-app-e18pD` only → updates PR #1.
  **Never open a new PR.** If push is rejected, `git pull --rebase` first
  (the branch sometimes gets commits from the Claude Code UI, e.g. shift
  label tweaks).

## Schedule Adherence: a shift charged for the shift before (fixed going forward)

- Symptom (HStamp, 12 Nov 2026): Afternoon ran SFM508005 all shift (209
  good) and read 209/185, 51%, with SFM508226 at 0/91; Day read 56/— with a
  blank order row.
- Cause 1: the plan of record was Planning.csv's windows as written that
  morning. SFM508005 was to end at 19:30 — true only if the Day made its
  180; it made 56. Fixed: the plan is kept from where the press stands at
  the shift's start (`pressPlanFromShiftStart`, docs/kpi-shift-target.md).
- Cause 2 (blank row): the Day's PMD_ShiftPlan row was kept at plan 0, and
  output against a 0 plan was one nameless "unscheduled" line. Fixed: it is
  reported order by order.
- NOT fixed, and not confirmed: WHY the Day's row was kept at 0. The row is
  written 30 minutes into the shift from PMD_Planning as it then stands;
  most likely the 07:30 plan had not reached it yet. Check the row's Created
  time in SharePoint against when the planning sync ran.
- Rows already kept are never rewritten: 12 Nov's figures stay as they are.

## A shift recorded under the crew of the shift before (fixed)

- Symptom (HStamp, 12 Nov 2026): the Afternoon sheet named John Taylor and
  Tin Maung — the Day's operator and supervisor — while every Quality Check
  on it was signed by the Afternoon operator. The KPI page showed the Day's
  people in the Afternoon.
- Cause: on the Operator page the names of a sheet not yet confirmed are
  only staged, and the staged names survived a change of shift. A crew that
  tapped ✅ Confirm without re-picking was recorded as the crew it relieved.
- Fix, capture (`namesForSheet`, core/crew.ts): staged names carry to the
  next order on the same press in the same shift only; a new shift or
  another press starts blank, and ✅ Confirm then asks for both.
- Fix, reading old sheets (`sheetPeople`): where the named Operator signed
  none of the operator Quality Checks and somebody else did, the signers are
  the operators. Used
  by the KPI Operator column, the shift head-counts and the per-operator
  tables. PMD_Production itself is not rewritten — a supervisor can still
  correct a sheet by unlocking it.
- Break cover: the Quality Checks are signed by whoever is running the
  press, so a sheet can have more than one signer. All of them show on the
  press and order rows (named Operator first); the shift and floor
  head-counts count each person once. The sheet's output stays with the
  named Operator in the per-operator tables.
- Limit: a sheet with a leftover name and NO Quality Check signed cannot be
  told from a correct one. And an operator who never signs his own checks,
  on a press where somebody else signs all of them, reads as a leftover.
- Supervisors are NOT second-guessed: the one a sheet names and whoever
  signed it off both count. Production confirmed (13 Nov 2026) that a person
  on overtime is rightly in two shifts — Tin Maung on 12 Nov, Day and
  Afternoon. The same person in two shifts is not, by itself, an error.

