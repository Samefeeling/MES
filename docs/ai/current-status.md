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

## Assembly line routing (`assembly/`)

The board runs **eight lines — TBP, PMD, UPL-CUT, UPL-Gluing, UPL-SSS, ASM,
Table, General** (`assembly/src/domain/assembly.ts`). PMD is a read-only
context lane. The old `UPL` catch-all and `ASSY_STOOL` are retired and
migrated on read, so saved plans and rosters still open.

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
