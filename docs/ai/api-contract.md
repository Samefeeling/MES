# API Contract

> The `PmdDataLayer` interface every backend implements, plus the
> SharePoint-specific extensions. UI/core code only ever calls this.

## PmdDataLayer (`src/dal/types.ts`)

```ts
interface PmdDataLayer {
  // Reference data (cache-friendly)
  listMachines(): Promise<Machine[]>
  listOperators(): Promise<Operator[]>
  listSupervisors(): Promise<Supervisor[]>
  listProducts(): Promise<Product[]>
  listRejectCategories(): Promise<RejectCategory[]>
  listBdCodes(): Promise<BdCode[]>

  // Planning
  listPlanning(filter: PlanningFilter): Promise<PlanningOrder[]>
  upsertPlanningOrder(order: PlanningOrder): Promise<PlanningOrder>
  deletePlanningOrder(id: number): Promise<void>

  // Production (hot path)
  listProduction(filter: ProductionFilter): Promise<ProductionRecord[]>
  upsertProductionRecord(record: ProductionRecord): Promise<ProductionRecord>
  deleteProductionRecord(id: number): Promise<void>
  lockShift(machineCode, shiftId, supervisor, operator): Promise<void>
  unlockShift(machineCode, shiftId): Promise<void>

  // Identity
  whoAmI(): Promise<UserContext>
}

PlanningFilter   { machineCode?, released? }
ProductionFilter { machineCode?, shiftId?, shiftIdFrom?, shiftIdTo?, jobNumber? }
```

## Semantics (must hold for every backend)

- **`upsertProductionRecord`**: upsert by composite key
  `(machineCode, shiftId, jobNumber, slotIndex)`. Last-write-wins, no
  version check (§5.6). `id<=0` means "insert or match-by-key".
- **`lockShift`** = "Sign off & Save". Marks the shift's records locked /
  signed off. In SharePoint this is where the cached slot edits flush to
  the three lists (header + analytic + events). Creates a slot-0
  placeholder if the shift had no records.
- **`unlockShift`**: clears the lock; in SharePoint deletes the header +
  analytic + reject rows for that (machine, shift) so it can be refiled.
- **`listProduction`**: returns per-slot `ProductionRecord[]`. Memory
  backend stores them directly; SharePoint reconstructs them from the
  `PMD_Production` header (`Status` string → slots) + `PMD_Rejects` events.
- **Reference lists** are safe to call repeatedly; callers cache as needed.
- All returned objects are owned by the caller (memory backend deep-clones
  on the way out).

## Filters

- `ProductionFilter.shiftId` exact; `shiftIdFrom`/`shiftIdTo` are date-range
  (lexicographic on `YYYY-MM-DD-...`). The SharePoint adapter translates
  these to `datetime'...'` filters on the DateTime date columns.

## SharePoint-only extensions (`SharePointDataLayer`)

Not on the interface — feature-detected by the UI:

```ts
syncPlanningFromExcel(): Promise<{ inserted: number; skipped: number }>
diagnoseFields(): Promise<Record<string, string[]>>   // dev: prints real column names
```

- **`syncPlanningFromExcel`**: Graph Workbook API reads the `Planning`
  sheet of the `.xlsm`, keeps rows with a Start Date, **clears** then
  repopulates `PMD_Planning`. Needs `graphToken` + `planningFilePath`
  (constructor options). Columns A,B,C,D,E,F,G,H,O,Q,R → planning fields.
- **`canSyncPlanning(dal)`** (exported from `src/dal`) — duck-type guard
  the UI uses to decide whether ⟳ Refresh + daily auto-sync should run the
  Excel pull.

## Construction / config

```ts
createDataLayer(env)          // src/dal/index.ts — reads VITE_BACKEND
new SharePointDataLayer({
  siteUrl, planningFilePath?, graphToken?, fieldMap?  // fieldMap overrides DEFAULT_FIELDS
})
```

- `graphToken: () => Promise<string>` — supplied at runtime via
  `window.__pmdGraphToken` (set by the SPFx `onInit()` token provider, or
  MSAL in standalone dev).

## Auth & transport (SharePoint backend)

- List CRUD: SharePoint REST (`/_api/web/lists/getbytitle(...)`), browser
  cookies (`credentials:'include'`), `X-RequestDigest` + `IF-MATCH:*` for
  writes. Works same-origin (SPFx) automatically.
- Excel read: Microsoft Graph (`/sites/.../workbook/worksheets('Planning')
  /usedRange`), Bearer token from `graphToken`.
