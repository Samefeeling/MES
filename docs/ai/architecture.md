# Architecture

> Single source of truth for how this app is put together. Read this first.

## What it is

PMD Operator Sheet — a backend-agnostic, single-page web app for the
Precision Moulding Department at Resero Operations AU. Operators log what
each injection-moulding machine is doing in 30-minute slots across an
8-hour shift; supervisors sign off and the data lands in SharePoint for
analysis and product traceability.

Rebuilt from `PMD_Dashboard_Spec.md` + the Excel/VBA `modPMDOperator.bas`
the floor was using.

## Stack

- **TypeScript + Vite** SPA. No UI framework (vanilla DOM + template strings).
- **Vitest** for unit tests (business logic only; no DOM/e2e).
- No runtime dependencies. Builds to static `dist/` (`index.html` +
  `assets/index.js` + `assets/index.css`, hash-free filenames for SPFx).
- Target host: SharePoint Online (SPFx web part). Also runs standalone for
  dev with the in-memory backend.

## Layering (the important part)

```
UI (src/ui/*)  ──depends-on──►  Core logic (src/core/*)   pure, tested
     │                          Domain types (src/types.ts)
     └──────────depends-on──►  DAL interface (src/dal/types.ts: PmdDataLayer)
                                       ▲
                  ┌────────────────────┼─────────────────────┐
              MemoryDataLayer    SharePointDataLayer    Sql/AzureDataLayer
              (seeded mock)      (real, 11 SP lists)    (skeletons)
```

- **UI and core never import a concrete backend.** They only touch
  `PmdDataLayer`. Swapping backends = one factory switch (`VITE_BACKEND`).
- **Core is pure and fully unit-tested.** No DOM, no network, no `this`.
- The DAL is the *only* seam where SharePoint specifics live.

## File map

| Path | Role |
|---|---|
| `src/types.ts` | Domain model (Machine, ProductionRecord, RejectCategory, BdCode, …) |
| `src/core/shifts.ts` | Shift/slot time math: 3 shifts × 16 slots; shiftId `YYYY-MM-DD-Day\|Afternoon\|Night` |
| `src/core/status.ts` | 9 status codes (R/B/C/D/I/M/O/P/S) + colours + decision table |
| `src/core/conflicts.ts` | Same-slot-two-orders conflict detection (§5.4) |
| `src/core/metrics.ts` | OEE / scrap% / downtime / setup rollups + KPI colour thresholds |
| `src/core/lock.ts` | Shift sign-off / lock rules |
| `src/core/planning.ts` | Gantt in-slot region + auto die-change. **NOT** the Excel sync |
| `src/core/breakdown.ts` | 11-category / 91-code breakdown taxonomy + helpers |
| `src/dal/types.ts` | `PmdDataLayer` interface + filter types |
| `src/dal/memory.ts` | In-memory backend (seeded), the contract reference |
| `src/dal/seed.ts` | Demo/reference seed data |
| `src/dal/sharepoint.ts` | **Real backend.** 11 lists, field map, save-on-signoff, Excel sync |
| `src/dal/sql.ts`, `azure.ts` | Documented skeletons (throw NotImplemented) |
| `src/dal/index.ts` | `createDataLayer(env)` factory (reads `VITE_BACKEND`) |
| `src/ui/operator.ts` | The Excel-style operator sheet (biggest UI module) |
| `src/ui/trace.ts` | `#/trace` traceability search view |
| `src/ui/breakdown.ts` | Two-tier breakdown cascade modal |
| `src/ui/charts.ts` | Dependency-free SVG output/reject bar chart |
| `src/ui/modal.ts`, `toast.ts` | Modal host + toast |
| `src/main.ts` | Boot, hash router, 60s poll, daily auto-sync |

## Routing (hash-based)

- `#/` or `#/op/<MachineCode>` → operator sheet (default machine = first active)
- `#/trace` → traceability search

## Views

- **Operator sheet** (view level 1): one machine + one shift + one job. 16
  half-hour columns; rows = Machine Status + 10 named reject rows (D01-D10).
  `+`/`−` zoom levels: 1 Shift (editable) → 2 Today (3 shifts) → 3 Past 7
  days → 4 Past 30 days. Levels 2-4 are read-only summary table + bar chart.
- **Trace** (`#/trace`): search by JobNumber / date range / machine → per
  (machine, shift, job) timeline strip + reject + breakdown detail.

## Build / deploy paths

- **Dev**: `npm run dev` (memory backend, no network). See `coding-rules.md`.
- **Prod**: SPFx web part hosting `dist/` assets from SiteAssets, deployed
  via App Catalog. Full steps in `/docs/DEPLOYMENT.md`.
- Backend chosen at build time via `VITE_BACKEND=memory|sharepoint|sql|azure`.

## Cross-references

- Deep deploy steps: `/docs/DEPLOYMENT.md`
- Local SharePoint dev + smoke test: `/docs/LOCAL_DEV_WITH_SHAREPOINT.md`
- MES integration design: `/docs/INTEGRATION.md`
- Data shapes + SP field maps: `data-model.md`
- DAL contract: `api-contract.md`
