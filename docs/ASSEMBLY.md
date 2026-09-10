# Assembly in MES

MES contains two production domains. PMD continues to use its machine/shift DAL and PMD Lists. Assembly is built from the Planning application in `assembly/` and stores job/day results separately. The imported baseline is Planning commit `64d8f5690a88e9bed7db949284ab1173907410bb`; subsequent integration changes are included in this directory.

## Navigation and runtime

The header reads MES, the former Operator tab reads PMD, and Assembly opens the React planning board. The frame remains mounted when switching departments so pending saves and inspector edits survive. Production uses a same-origin srcdoc frame that loads Assembly JavaScript/CSS, avoiding SharePoint's HTML download behavior. The host passes only its operational supervisor state. SharePoint permissions remain the actual access control. The frame carries the dashboard's own `#f1f5f9` ground: it fills the viewport under the top bar, so a white one flashed a white page on every switch and read as a load that had failed.

## Assembly results (`#/kpi/assembly`)

`PMD` and `Assembly` are the first two buttons of the KPI toolbar, ahead of the period tabs (`src/ui/kpi-nav.ts`) — the same kind of choice, so the same control, department first because it decides what the rest of the row means. They were their own band above the page until then, a third row of navigation under the top bar's own.

The page is laid out the way the PMD KPI page is, so the two can be read one after the other in the same meeting: period tabs and a From/To range, headline tiles, one table with a `TOTAL` under it, and a legend saying what every colour means. PMD rolls machine-shifts up per press; Assembly rolls order-days up per **line**, and each line opens into the orders behind it. The day-by-day bookings stay underneath as the evidence. Assembly never contributes to PMD machine OEE, efficiency or shift sign-off totals, and duplicate job/day rows cause a visible error instead of inflated totals.

| Column | Definition |
| --- | --- |
| Orders / Output / Complete / Reject / Rework | Summed over the window; an order booked on five days is **one** order in every count. |
| Yield% | Complete ÷ (Complete + Reject) — PMD's own definition. 🟢 ≥ 98% · 🟡 ≥ 95%. |
| Crew h | People booked on the order that day × 7.5 h — the 07:00–15:30 shift less morning tea and lunch, which is exactly what the board schedules with, so the KPI is measured against the plan the floor was given. |
| Std h | Units finished × the order's own standard (`PlannedHours ÷ OrderQty`). |
| Efficiency* | Std h ÷ Crew h. 🟢 ≥ 90% · 🟡 ≥ 75%. A day on an order carrying no standard is left out of **both** sides rather than scored zero — an order nobody gave a labour standard is not an order that was worked badly, and PMD drops an unjudgeable job-shift for the same reason. |
| Support h | Factory General work, measured in the hours it took. It has no output at all, so it is never folded into Output, Yield or Efficiency. |
| On time% | Orders finished on or before their Due Date ÷ orders finished with a Due Date to judge. 🟢 ≥ 95% · 🟡 ≥ 85%. |

Thresholds are fixed and printed on the page, not editable: PMD's are argued over in the meeting because its presses are compared with one another, and there is no equivalent argument here yet.

**`PlannedHours` now rides on every row**, not just support ones (`assembly/src/data/sharepoint/production.sync.ts`). It is an order-level column, so the next sync backfills it on rows written weeks ago. Without it the record says what came off the line but not what the work was supposed to take, and no honest efficiency can be read back out of it — which is why a row that still lacks one is excluded rather than counted.

## SharePoint schema

`config/assembly-lists.json` is the exact internal-name/type contract.

| List | Purpose | Key |
| --- | --- | --- |
| ASSY_Operator | Real operator names (Title), Position, Skills, Supervisor, OnShift and PlannedAnnualLeave | SharePoint item ID |
| ASSY_Plans | Shared working plan, crew windows, pinned starts, output history and ignored orders | Unique Title = current |
| ASSY_Production | Daily job quantities, crew snapshot, dates, completion and pause details | Unique RecordKey = Job + pipe + YYYY-MM-DD |

Planning1.csv, JobMaterialReq.csv and OnHandInventory.csv remain upstream files in the document library. No additional material List duplicates them. On-hand inventory is availability evidence, not a stock reservation; picking must still be confirmed against warehouse stock.

The provisioning script inventories existing Lists, adds missing fields, enables versioning/indexes and rejects incompatible types. It does not delete items or convert existing columns. Existing duplicate or blank keys must be resolved before unique constraints can be enabled.

Use an IT-approved Microsoft Entra application registration with delegated SharePoint permissions and your own Manage Lists permission on this site. Browser authentication remains subject to company Conditional Access; do not use copied cookies or another identity. CLI for Microsoft 365 requires an app ID configured through its settings/environment or supplied explicitly.

With Node 22+ and CLI for Microsoft 365 installed, sign in using the company-approved app, then review and apply:
```powershell
m365 login --authType browser --appId <approved-app-id> --tenant 6d8c062c-6bdc-4fb9-87dc-08aea00c443f
./scripts/provision-assembly.ps1 -SiteUrl https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
./scripts/provision-assembly.ps1 -SiteUrl https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU -Apply
```

These scripts and schema definitions do not certify that a site's Lists have already been provisioned.

## Configuration

Both builds read the MES root .env.local. Retain existing PMD settings and add the Assembly file paths. Verify the actual document-library locations before deployment; the defaults below are examples, not discovered locations.

```dotenv
VITE_BACKEND=sharepoint
VITE_SITE_URL=https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
VITE_ASSEMBLY_PLANNING_CSV_PATH=/Shared Documents/Planning1.csv
VITE_JOB_MATERIAL_CSV_PATH=/Shared Documents/JobMaterialReq.csv
VITE_ON_HAND_INVENTORY_CSV_PATH=/Shared Documents/OnHandInventory.csv
VITE_PRODUCT_LINES_PATH=/Shared Documents/product-lines.v3.json
VITE_PRODUCTION_LIST=ASSY_Production
VITE_ASSEMBLY_PLAN_LIST=ASSY_Plans
```

Do not reuse PMD's VITE_PLANNING_CSV_PATH for Assembly. A production Assembly build selects planning-csv and cookie-authenticated SharePoint REST when VITE_BACKEND=sharepoint. No Graph bearer token is bundled for this path. Keep the existing VITE_SUPERVISOR_PASSWORD configuration for the host operational gate.

## Incremental planning and conflicts

Refresh reconciles jobs by job number and retains existing crew and pinned dates. Orders absent from a partial export keep their plan for 14 days. Date sorting leaves PMD source order unchanged; daily Assembly filtering and counts exclude PMD. Crew orders fills unallocated eligible orders; it does not reset already allocated work. Which line an order goes to comes from ERP, then `product-lines.v3.json`, then its BOM — see [Operational lines and support work](OPERATIONAL-LINES.md); a supervisor's own move survives refresh. Real material links determine predecessors.

ASSY_Plans stores a versioned JSON snapshot. An ETag mismatch stops autosave and production sync; reload the saved plan before editing again. Failed reads never save an empty replacement. The initial release limits the snapshot to 60,000 characters and reports an error without replacing the saved plan if exceeded. A partitioned plan repository is required for larger histories.

A legacy browser-local plan on a different origin is not automatically accessible to MES. Preserve that plan before first production rollout and migrate it to the shared working plan; do not assume another browser or website shares localStorage. New-order highlight history remains device-local; operational crew/date/output state is shared.

## Build and release

Use Node 22 or newer.
```sh
npm ci
npm --prefix assembly ci
npm run typecheck
npm test
npm --prefix assembly test
npm run build
npm run deploy
```

Deploy uploads both applications, all lazy chunks and nested asset folders. The MES version marker is uploaded last. The SPFx shell continues loading SiteAssets/pmd/assets/index.js and index.css, so this integration does not require a new SPFx package.

Before rollout, verify actual CSV paths, existing field types/keys, roster names and permissions on the signed-in site. Test a new job refresh, a second-session save conflict, barcode lookup and an Assembly daily entry appearing in KPIs. Local mock checks cannot validate tenant permissions or real file contents.


See [Operational lines and support work](OPERATIONAL-LINES.md) for the eight lines, how a part is routed to one, and the additional support fields.

### Imported list columns and operator moves

Assembly reads each list's column metadata and maps display names to internal
names for both reads and writes. Lists imported from a spreadsheet can therefore
keep names such as field_1 internally. PreferName is the roster display name;
blank values fall back to the existing operator name. Skills accepts text,
multiple choices, and the current line labels. Missing skills leave a person in
General until the supervisor places them; they do not grant every skill.

Sign in through the MES Supervisor button to move operators. Drag a name onto
a line or click the name and use Move to line. This changes the saved roster
placement without rewriting the operator's skill qualifications. Recorded shift
history is retained. A missing production column stops that sync at the first
permanent error; correct the list schema and retry. No columns or list records
are automatically created or deleted by field discovery.
