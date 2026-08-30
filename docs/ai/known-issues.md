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

## Build / toolchain

- **Deployed app shows mock data / old P-codes = built without
  `VITE_BACKEND=sharepoint`.** Vite bakes env vars in at *build* time only.
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
