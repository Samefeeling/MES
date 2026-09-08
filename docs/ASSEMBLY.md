# Assembly in MES

MES contains two production domains. PMD continues to use its machine/shift DAL and PMD Lists. Assembly is built from the Planning application in `assembly/` and stores job/day results separately. The imported baseline is Planning commit `64d8f5690a88e9bed7db949284ab1173907410bb`; subsequent integration changes are included in this directory.

## Navigation and runtime

The header reads MES, the former Operator tab reads PMD, and Assembly opens the React planning board. The frame remains mounted when switching departments so pending saves and inspector edits survive. Production uses a same-origin srcdoc frame that loads Assembly JavaScript/CSS, avoiding SharePoint's HTML download behavior. The host passes only its operational supervisor state. SharePoint permissions remain the actual access control.

Assembly results are available under KPIs > Assembly through `src/ui/kpi.ts`. The dedicated Assembly adapter reads ASSY_Production, and its own metrics aggregate daily output, Complete, Reject and Rework while deduplicating order counts. Assembly does not contribute to PMD machine OEE, efficiency or shift sign-off totals. Duplicate job/day rows cause a visible error instead of inflated totals.

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
VITE_PRODUCTION_LIST=ASSY_Production
VITE_ASSEMBLY_PLAN_LIST=ASSY_Plans
```

Do not reuse PMD's VITE_PLANNING_CSV_PATH for Assembly. A production Assembly build selects planning-csv and cookie-authenticated SharePoint REST when VITE_BACKEND=sharepoint. No Graph bearer token is bundled for this path. Keep the existing VITE_SUPERVISOR_PASSWORD configuration for the host operational gate.

## Incremental planning and conflicts

Refresh reconciles jobs by job number and retains existing crew and pinned dates. Orders absent from a partial export keep their plan for 14 days. Date sorting leaves PMD source order unchanged; daily Assembly filtering and counts exclude PMD. Crew orders fills unallocated eligible orders; it does not reset already allocated work. Cut anywhere in a description takes precedence and corrects an old saved non-UPL placement on refresh. Softie remains a subsequent trade; real material links determine predecessors.

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
