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
  loses unsaved edits. Acceptable for v1 (mirrors the old .bas flow).

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
