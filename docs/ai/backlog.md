# Backlog

> Future work, roughly prioritised. Move items to a commit + delete when done.

## P1 — needed to go live

- [ ] **SPFx deploy** (blocked on IT: App Catalog access + Graph API
      approval for `Files.Read.All`, `Sites.Read.All`). Steps in
      `/docs/DEPLOYMENT.md § B`. `.sppkg` already builds.
- [ ] **First end-to-end run on the live tenant** — once same-origin, run
      the smoke test (`/docs/LOCAL_DEV_WITH_SHAREPOINT.md`) and fix any
      400 field-name errors via `DEFAULT_FIELDS` / `fieldMap`.
- [ ] **Graph token wiring confirmed** — verify SPFx `onInit()` sets
      `window.__pmdGraphToken` and Excel sync actually pulls.

## P2 — data freshness & ops

- [ ] **Power Automate daily sync** of `PMD_Planning` from the `.xlsm`
      (06:00 Sydney) — server-side backstop. Recipe in
      `/docs/DEPLOYMENT.md § C`.
- [ ] Consume **`RDO Roster 2026-2030`** to auto-fill the on-duty
      supervisor by (date, shift) instead of manual dropdown.
- [ ] Confirm/ء add **`RunTime`** handling end-to-end (column exists in
      PMD_Production; adapter writes it).

## P3 — UX / analytics

- [ ] **Defect "Visual Signs" tooltip** — add a `VisualSigns` column to
      `PMD_RejectCategories`, surface as an ℹ️ hover/popover on each D-code
      row so operators see "Incomplete fill; cold/sharp edges…".
- [ ] Trace view: add OEE% / Yield% columns and a date-grouped chart.
- [ ] Operator sheet: "previous shift handover" read-only banner (spec §5.8).
- [ ] Auto-fill rules (spec §5.9) — deferred from v1.

## P4 — platform

- [ ] Implement `SqlDataLayer` (Phase 2) when on-prem SQL lands.
- [ ] Implement `AzureDataLayer` (Phase 3).
- [ ] Admin module (manage machines/operators/products/codes) — spec §9.
- [ ] Reports page (PDF/Excel exports) — spec §10.
- [ ] MES integration adapter — see `/docs/INTEGRATION.md` (Zendesk doc was
      auth-gated; design is generic, confirm transport/auth when available).

## Tech debt / nice-to-have

- [ ] Component/e2e tests (currently business-logic unit tests only).
- [ ] Batch SharePoint writes via `$batch` instead of serial MERGE in
      `lockShift` (atomicity + fewer round-trips).
- [ ] Multi-device live sync of in-progress (unsaved) shift edits — today
      SharePoint backend only persists on sign-off.
