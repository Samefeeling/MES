# Current Status

> Snapshot of where the project is. Update this when state changes.

**Branch**: `claude/rewrite-production-app-e18pD` → PR #1
(`github.com/Samefeeling/MES/pull/1`). Push here; the PR updates itself.
**Do NOT open new PRs.**

**Build health**: `tsc --noEmit` clean · 56/56 Vitest pass · `npm run build`
ok (~76 KB JS / 24 KB gzip).

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
  "ready to raise" card with Yes / No. Yes drafts Mango's Improvement
  Workflow form (`core/impw.ts`), validates every field Mango marks
  required, copies it to the clipboard and opens IMPW in a new tab. Mango
  stays the system of record — PMD never keeps a second register. Yes / No
  is supervisor-gated and remembered per browser (`pmd.impwDecisions`); the
  plant's Mango dropdown answers are remembered too (`pmd.impwSite`).

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
Default (no env) = `memory`. `VITE_MANGO_IMPW_URL` is the deep link the KPI
"Raise in Mango" button opens — **confirm the real IMPW path and set it**;
the default is the best guess, and Mango exposes no write API for this form,
so the handoff is clipboard + form, exactly like the maintenance-request
link on the Die tab.

## Immediate next action

When IT grants access: follow `/docs/DEPLOYMENT.md § B` (SPFx) → upload
`dist/` to `SiteAssets/pmd/` → run the smoke test in
`/docs/LOCAL_DEV_WITH_SHAREPOINT.md` → report any 400 (field-name) errors.
