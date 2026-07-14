# Deploying the PMD Operator Sheet

## TL;DR — IT is needed ONCE; everyday updates are self-service

The SPFx web part is a thin shell that loads the app's JS/CSS from
`SiteAssets/pmd/` by URL. So:

- **One-time (needs IT):** deploy the `.sppkg` to the App Catalog + approve
  the Graph API permissions (§ B). The shell rarely changes after that.
- **Every release (just you, no IT):** `npm run deploy` — builds and uploads
  the two asset files to SiteAssets via the m365 CLI. No App Catalog, no
  `.sppkg`, no waiting on IT. The web part cache-busts on each page open so
  there's no manual hard-refresh.

```bash
npm i -g @pnp/cli-microsoft365   # once per machine
m365 login                        # once (device code; no app registration)
npm run deploy                    # every release: build + upload to SiteAssets
```

Only re-deploy the `.sppkg` (back to IT) if you change the **web part shell
itself** — full-screen behaviour, Graph token wiring, the asset folder path.
Normal app iteration (UI, logic, field maps, KPIs) never touches it.

---

You have three deployment paths. Pick based on how much you want to
test before going to production.

| Path | Use it when | Effort | Who can use it |
|---|---|---|---|
| **A. Local dev** | Today — first end-to-end validation against the real lists | 15 min | Just you, in your browser |
| **B. SPFx web part** | Production rollout for operators on the floor | 1-2 h first time | Anyone on the site, including iPads |
| **D. Epicor → CSV → SharePoint** | Keep planning fresh from Epicor REST every 15 min | 30 min | Runs unattended on shop-floor PC |

A and B are about hosting the **app**. D is about keeping planning data
**fresh from Epicor**, server-side, with credentials kept
out of the browser. You want B + D.

---

## A. Local dev test (today, 15 min)

This lets you confirm the field map + writes work against your real
tenant before investing in SPFx packaging.

```cmd
:: 1. Clone + install
git clone https://github.com/Samefeeling/MES.git
cd MES
git checkout claude/rewrite-production-app-e18pD
nvm use 18.20.4
npm install

:: 2. Configure the backend
notepad .env.local
```

Paste into `.env.local`:

```ini
VITE_BACKEND=sharepoint
VITE_SITE_URL=https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
VITE_PLANNING_PATH=Shared Documents/General/Planning/PMD/PMD Schedule_master_epicor 300424.xlsm
```

Then:

```cmd
:: 3. Get past the CORS wall (dev only)
::    Chrome → install "CORS Unblock" extension, enable for sharepoint.com
::    Edge → same extension works
::    Make sure you're SIGNED INTO the SharePoint site in the same browser

:: 4. Run
npm run dev
```

Open `http://localhost:5173`. Click ⟳ Refresh to pull planning from
the Excel. Run the smoke test from
`docs/LOCAL_DEV_WITH_SHAREPOINT.md` § "Smoke test" to write one of
each list type and read it back.

If everything reads/writes OK, you're cleared to go to Path B.

---

## B. SPFx web part deploy (production, 1-2 h)

This produces a `.sppkg` file you upload to the App Catalog. Once
deployed, operators open the URL from any browser/iPad and it works
with their SharePoint session — no CORS hacks, no extension, real
auth for the Graph token.

### B.1 Prerequisites (one-time per machine)

```cmd
nvm install 18.20.4
nvm use 18.20.4
npm install -g yo @microsoft/generator-sharepoint@1.18 gulp-cli
```

### B.2 Scaffold the wrapper

```cmd
cd ..
mkdir pmd-spfx
cd pmd-spfx
yo @microsoft/sharepoint
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| Solution name | `pmd-operator-sheet` |
| Target SharePoint version | **SharePoint Online only (latest)** |
| Place files in | **Use the current folder** |
| Deploy as tenant-wide | **N** (we'll do site-scoped) |
| Permissions to access web APIs | **N** (we'll add manually) |
| Component to create | **WebPart** |
| Web part name | `PMD Operator Sheet` |
| Description | `Real-time shift production tracking` |
| Framework | **No framework** |

### B.3 Wire the Vite build into the web part

Build the Vite app from the MES repo:

```cmd
cd ..\MES
npm run build
```

Copy `MES/dist/` into the SPFx project:

```cmd
xcopy /E /I dist ..\pmd-spfx\src\webparts\pMDOperatorSheet\assets
```

Edit `pmd-spfx/src/webparts/pmdOperatorSheet/PmdOperatorSheetWebPart.ts`.
The app's JS/CSS are hosted in `SiteAssets/pmd/` (uploaded separately,
step B.3a below) and loaded by URL — NOT bundled through SPFx's webpack
(which chokes on pre-built `.js`/`.css`). In **read mode** the web part
mounts into a fixed full-viewport overlay so the app uses the whole iPad
screen and the SharePoint chrome (suite bar / site header / command bar /
left nav) is hidden behind it; in **edit mode** it renders inline so the
page stays editable.

```ts
import { Version, DisplayMode } from '@microsoft/sp-core-library';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';

export interface IPmdOperatorSheetWebPartProps {}

const ASSET_FOLDER = '/SiteAssets/pmd';

export default class PmdOperatorSheetWebPart
  extends BaseClientSideWebPart<IPmdOperatorSheetWebPartProps> {

  private booted = false;
  private host?: HTMLElement;

  protected async onInit(): Promise<void> {
    const tokenProvider =
      await this.context.aadTokenProviderFactory.getTokenProvider();
    (window as unknown as { __pmdGraphToken: () => Promise<string> })
      .__pmdGraphToken = () => tokenProvider.getToken('https://graph.microsoft.com');
  }

  public render(): void {
    if (this.booted) return;
    this.booted = true;

    if (this.displayMode === DisplayMode.Edit) {
      this.host = this.domElement;
      this.host.innerHTML =
        `<div style="padding:10px;background:#fffbe6;border:1px solid #f0c36d;
          border-radius:6px;font:600 13px/1.4 sans-serif;color:#7a5b00">
          PMD Operator Sheet — shown inline while editing.
          Publish &amp; open the page to see it full-screen.
        </div>`;
      return;
    }

    const host = document.createElement('div');
    host.id = 'pmd-fullscreen-host';
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:#f1f5f9;' +
      'overflow:auto;-webkit-overflow-scrolling:touch;';
    document.body.appendChild(host);
    document.body.style.overflow = 'hidden';
    this.host = host;

    const base = this.context.pageContext.web.absoluteUrl + ASSET_FOLDER;
    // top-nav is left empty on purpose — the app fills it (ensureNav() in
    // src/main.ts) so adding a view never needs an .sppkg rebuild.
    host.innerHTML = `
      <div class="top">
        <img class="brand-logo" src="${base}/resero-logo.svg" alt="Resero" />
        <h1 id="pt">PMD Operator Sheet</h1>
        <span class="top-nav"></span>
        <span class="st" id="ss">&#9729; ready</span>
      </div>
      <div class="vw" id="app"></div>
      <div class="mbg" id="modal"><div class="mdl" id="mc"></div></div>
      <div class="toast" id="toast"></div>
    `;

    // Cache-bust so a re-uploaded SiteAssets bundle is picked up without a
    // manual hard-refresh. Filenames are hash-free; ~26 KB gzip re-download
    // per page open is negligible for a once-a-shift iPad.
    const v = `?v=${Date.now()}`;

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}/assets/index.css${v}`;
    document.head.appendChild(css);

    const js = document.createElement('script');
    js.type = 'module';
    js.src = `${base}/assets/index.js${v}`;
    document.body.appendChild(js);
  }

  protected onDispose(): void {
    if (this.host && this.host.id === 'pmd-fullscreen-host') {
      this.host.remove();
      document.body.style.overflow = '';
    }
  }

  protected get dataVersion(): Version { return Version.parse('1.0'); }
}
```

**B.3a — upload the app assets to SiteAssets** (once per app-code change):
build the Vite app (`npm run build` in the MES repo with `.env.local` set,
see § A) then drag `dist/resero-logo.svg`, `dist/assets/index.js`, and
`dist/assets/index.css` into `SiteAssets/pmd/` (keep the `assets/`
subfolder). Hard-refresh (Ctrl+F5) after replacing — filenames are
hash-free so the browser caches them.

**iPad full-screen**: the overlay reclaims the SharePoint chrome. To also
hide the Edge/Safari browser chrome, open the page in **Safari → Share →
Add to Home Screen**, or for a locked-down floor tablet use **iPad
Settings → Accessibility → Guided Access** (triple-click to lock to the
page).

> **Stable filenames**: `vite.config.ts` emits `assets/index.js` and
> `assets/index.css` (no hash) so the SiteAssets URLs stay valid after
> every `npm run build`.

Edit `pmd-spfx/config/package-solution.json` to declare Graph
permissions:

```json
{
  "solution": {
    "...": "...",
    "webApiPermissionRequests": [
      { "resource": "Microsoft Graph", "scope": "Files.Read.All" },
      { "resource": "Microsoft Graph", "scope": "Sites.Read.All" }
    ]
  }
}
```

### B.4 Package + upload

```cmd
cd ..\pmd-spfx
npm install
gulp bundle --ship
gulp package-solution --ship
```

Output: `sharepoint/solution/pmd-operator-sheet.sppkg`.

1. In a browser, open **App Catalog** (`https://reseroglobal.sharepoint.com/sites/AppCatalog` — ask SharePoint admin for the URL if you don't have it).
2. Drag the `.sppkg` into the **Apps for SharePoint** library.
3. Tick **"Make this solution available to all sites"** → **Deploy**.
4. SharePoint admin opens **SharePoint Admin Center → Advanced → API access** → approve the two Graph requests.

### B.5 Add to a site page

1. Go to `https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU`.
2. **Gear → Add an app** → install **PMD Operator Sheet**.
3. **+ New → Page** → blank layout → name it "PMD Operator".
4. Click **+** in the page → search **PMD Operator Sheet** → insert.
5. **Publish**.

The operators open that page URL on any iPad / desktop and it just
works. No CORS extension, no localhost.

---

## D. Epicor → CSV → SharePoint (PowerShell + OneDrive sync)

Planning data flows from Epicor REST into a single CSV file that lives
in a SharePoint document library. The MES app fetches the CSV directly.
No SP write credentials, no Entra app, no list upsert loop.

```
[ Epicor BAQ ]            (Basic auth, password in Credential Manager)
        │ Invoke-RestMethod
        ▼
[ scripts/sync-epicor-to-sp.ps1 ]    runs every 15 min via Task Scheduler
        │ Export-Csv (atomic: .tmp → rename)
        ▼
[ C:\Users\you\…\PMD - Documents\PMD\Planning.csv ]  (OneDrive-synced)
        │ OneDrive client
        ▼
[ SharePoint: /sites/PMD/Shared Documents/PMD/Planning.csv ]
        │ GET …/_api/web/getFileByServerRelativeUrl(...)/$value
        ▼
[ MES app — SharePointDataLayer.listPlanning() ]
```

### D.1 One-time PC setup

```powershell
# CredentialManager is the only module needed now — PnP/Entra are gone.
Install-Module CredentialManager -Scope CurrentUser -Force

# Folder for config + log.
New-Item -ItemType Directory C:\PMDSync -Force | Out-Null
```

### D.2 Store the Epicor credential

```cmd
:: Use cmd.exe (cmdkey expects native quoting). User = Epicor user name,
:: password = whatever Epicor wants in the Basic header.
cmdkey /generic:PMDSync.Epicor /user:<EpicorUser> /pass:<EpicorPassword>
```

Verify:

```cmd
cmdkey /list:PMDSync.Epicor
```

If your Epicor instance requires an X-API-Key header (Kinetic 2021+),
put that header value in `config.json` (it's a non-secret API identifier
that's fine to keep in config).

### D.3 Sync the PMD library to your PC

Open SharePoint → PMD site → the document library where the CSV will
live (e.g. **Documents**). Click **Sync** in the toolbar. OneDrive opens
and registers the library as a folder under `C:\Users\<you>\<Tenant>\`.

After sync completes you'll have a path like:

```
C:\Users\<you>\<Tenant>\PMD - Documents\
```

Create a `PMD\` subfolder inside it — that's where the CSV will land.

### D.4 Drop the script + non-secret config in place

Copy these two files into `C:\PMDSync\`:

- `scripts/sync-epicor-to-sp.ps1` → `C:\PMDSync\sync.ps1`
- `scripts/sync-epicor-to-sp.config.example.json` → `C:\PMDSync\config.json` (rename, drop the `.example`)

Edit `C:\PMDSync\config.json`:

```json
{
  "EpicorUrl":     "https://<epicor-host>/<EnvName>/api/v1/BaqSvc/<BaqId>(<Param>)/",
  "EpicorApiKey":  "",
  "OutputCsvPath": "C:\\Users\\<you>\\<Tenant>\\PMD - Documents\\PMD\\Planning.csv"
}
```

`.gitignore` blocks `scripts/sync-epicor-to-sp.config.json` defensively
in case a copy ever lands inside the repo.

### D.5 Smoke-test

```powershell
powershell.exe -ExecutionPolicy Bypass -File C:\PMDSync\sync.ps1
```

Expected output:

```
[2026-06-02 14:00:01] GET https://...BaqSvc/...
[2026-06-02 14:00:03]   Epicor returned 580 rows
[2026-06-02 14:00:03]   Kept 27 after PMD/Released filter
[2026-06-02 14:00:03] Wrote 27 rows to C:\Users\…\PMD - Documents\PMD\Planning.csv
```

Watch the OneDrive icon in the system tray — within a few seconds it
should report the file as uploaded. Confirm in the browser: PMD site →
Documents → PMD → `Planning.csv`.

### D.6 Point the MES app at the CSV

Add this env var when building the app:

```
VITE_PLANNING_CSV_PATH=/sites/<PMDsite>/Shared Documents/PMD/Planning.csv
```

(`/Shared Documents/` is the SP server-relative form of the "Documents"
library; SP rewrites the display name automatically.)

Rebuild + re-upload `dist/` to SiteAssets. App will now read planning
from the CSV instead of PMD_Planning list. The list can be left empty
or deleted.

### D.7 Schedule it

Task Scheduler → **Create Task**:

- **General**: name `PMD Planning Sync`. "Run only when user is logged on" is fine — OneDrive needs the user logged in to keep syncing anyway.
- **Triggers** → New: daily, repeat every `15 minutes` for `1 day`.
- **Actions** → New:
  - Program: `powershell.exe`
  - Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\PMDSync\sync.ps1" *>> "C:\PMDSync\sync.log"`
- **Settings**: "Allow task to be run on demand"; "If the task fails, restart every 5 min, attempt 3 times".

Tail `C:\PMDSync\sync.log` for run history.

### D.8 CSV column contract

The app's CSV parser (`parsePlanningCsv` in `src/dal/sharepoint.ts`)
looks up columns by header name, not position. If you ever change the
columns, both ends have to move together.

| CSV column | App field | Notes |
|---|---|---|
| `JobHead_JobNum` | jobNumber | required, natural key |
| `JobHead_PartNum` | partNumber | |
| `JobHead_PartDescription` | partDescription | |
| `JobHead_ProdQty` | orderQty | total order quantity → **Order Qty** display. Falls back to `Calculated_RemainingQty` if the column is absent. |
| `Calculated_RemainingQty` | jobRequired | remaining qty → **Job Left** countdown |
| `JobHead_StartDate` | plannedStart (date) | ISO 8601 preferred; AU dd/mm/yyyy also accepted |
| `JobHead_StartHour` | plannedStart (time-of-day) | optional; decimal hours, e.g. `18.68` = 18:40:48. Layered onto `JobHead_StartDate`. Blank/missing = keep the date's own time. **The BAQ must include `JobHead.StartHour` in its output fields or this column will be empty.** |
| `JobHead_ReqDueDate` | plannedEnd (fallback if no duration) | same date formats |
| `Calculated_RemaingLaborHrs` | duration (hours) | |
| `JobOper_ProdStandard` | qtyPerHr | |

Filter applied by the PowerShell script before write:
`JobHead_JobReleased = true AND JobHead_PersonID = 'PMD' AND NOT JobHead_JobClosed AND NOT JobHead_JobComplete`.

---


## PMD_Production columns the app writes

The list is read with the field map under `DEFAULT_FIELDS.production` in
`src/dal/sharepoint.ts`. Most columns are required; a few are
fail-soft (the app strips them on the first 400 and the rest of the
row still lands). When adding the SP list on a fresh tenant, mirror
this set:

| SP column | Type | Required? | Purpose |
|---|---|---|---|
| `Title` | Single line | Y | Machine code (e.g. `1300T`) — Title is repurposed |
| `MachineCode` | Single line | Y | The 16-char Machine-Status timeline (e.g. `SSRRRRRRRR······`) — column is repurposed |
| `SlotStart_x003a_` | Date+Time | Y | Anchor date for the shift (noon UTC of the shift's calendar day) |
| `ShiftId` | Single line | Y | `Day` / `Afternoon` / `Night` |
| `JobNumber` | Single line | Y | Job# (e.g. `507071`) |
| `JobHead_PartNum` | Single line | Y | Part # denormalised for KPI swatch + supervisor read |
| `JobHead_PartDescription` | Single line | Y | Part description denormalised. **Read on unlock so the editable view shows the right part even after Epicor drops the order from planning.** |
| `JobRequired` | Number | **N (add when ready)** | Order quantity (total `JobHead_ProdQty`) at sign-off. New 2026-06-16 — denormalised so unlocking an Epicor-aged-out order still shows Order Qty. The app omits the field if the column is missing (fail-soft via `stripRejectedFields`); the only consequence is Order Qty showing `—` on unlocked old orders. |
| `CountStart` / `CountEnd` | Number | Y | Header counts (slot 0) |
| `Reject` | Number | Y | Total reject across the shift; preserved on re-sign-off |
| `Operator` / `Supervisor` | Single line | Y | Names |
| `RunTime` / `Downtime` | Number | Y | Hours per status family |
| `Handover` | Multi-line | Y | 4M JSON `{machine,mold,material,method}` |
| `QualityChecks` | Multi-line | Y | Per-slot QC sign-off JSON `{"<slotIndex>":"<name>"}` |
| `RejectsBySlot` | Multi-line | Y | Per-slot per-code reject JSON; powers per-slot rebuild on unlock when PMD_Rejects events have been wiped |
| `TotalGood` | Number | Y | Convenience column: `CountEnd − CountStart − Reject` |

PMD_LiveStatus mirrors PMD_Production's schema (same field map). The
list re-uses the same DEFAULT_FIELDS section.

---

## Die Management work orders — Mango is the system of record

The Trace page's **🛠 Die Management** tab tracks per-die usage (shots /
pieces / rejects, joined to production via `PMD_ProductDieColor.DieNumber`)
and shows each die's maintenance work orders. **Work orders live in
Mango** (management decision, 2026-07): every *Raise Request in Mango*
button deep-links to Mango's form, and the in-app list is a **read-only
mirror** — there is no separate PMD request form.

Statuses flow back from Mango via a CSV report sync (Mango has no API
for the Plant/Equipment module):

1. **`scripts/sync-mango-csv.mjs`** (Playwright, Node) runs on the same
   always-on PC as the Epicor sync, every 15-30 min via Task Scheduler.
   It opens Mango's work-order report page with a saved browser session
   and downloads the CSV into the OneDrive-synced folder — no SharePoint
   credentials in the script, same pattern as `Planning.csv`.
   It drives the PC's own **Microsoft Edge** by default
   (`BrowserChannel: "msedge"` — corporate IT policy commonly blocks
   Playwright's downloaded Chromium, and Edge is already installed and
   whitelisted). One-time setup (in the script's header too):
   `npm i playwright` (no browser download needed for Edge), copy
   `scripts/sync-mango-csv.config.example.json` to
   `C:\PMDSync\mango-sync.config.json`, then `node sync-mango-csv.mjs
   --login` once to sign into Mango by hand (MFA-safe — the session is
   stored and reused). `--probe` screenshots the report page and lists
   its buttons if the export control needs to be named explicitly
   (`ExportSelector`).
2. The app reads that file when **`VITE_MANGO_CSV_PATH`** is set (e.g.
   `/sites/ReseroOperationsAU/Shared Documents/General/Planning/Data/MangoWorkOrders.csv`).
   The parser is calibrated against the real "AU - Minto Maintenance
   Request" export: it skips the title/ordering lines above the header,
   keeps ONLY rows whose `Plant/Equipment` names a die (the plant-wide
   rest — presses, forklifts — is dropped), and takes the die number
   straight from the site convention `AU - Die 280 …` (matching
   PMD_ProductDieColor.DieNumber). Stages map to open ("Stage 1") /
   in-progress ("Stage 2/3") / done ("Stage 4 Closed"); the closure
   date is recovered from the "Actions taken" log's "to Stage 4 Closed"
   line since the export has no completion-date column. Columns are
   matched by tolerant header names (`MANGO_CSV_COLUMNS` in
   `src/dal/sharepoint.ts` — extend there if a future report layout
   renames one; a console warning names any essential field that failed
   to match).
3. Without `VITE_MANGO_CSV_PATH` (or while the file doesn't exist yet)
   the tab falls back to the legacy `PMD_DieMaintenance` list, whose
   schema stays documented below for the sync-less transition period:
   `Title` = DieNumber, `Status`, `MaintType`, `Priority`, `Description`
   (Multi-line), `Contact`, `RequestedBy`, `Machine`, `JobNumber`,
   `MangoTicket`, `ClosedAt` (ISO text) — all free text, normalised on
   read.
- **Preventive-service reminders** follow the furniture-mould tonnage
  rule (100-150T: 100k · 210-350T: 50k · 450-560T: 20k · 650-850T: 10k ·
  1000T+: 8k shots — bands in `src/core/die.ts` `SERVICE_BANDS`). The
  shot counter resets at the newest **Done** maintenance request's
  closed date, uses the strictest band among the presses the die ran
  on, and goes ⏳ amber at 80% / 🔧 red past the interval. Dies never
  serviced count from the window start (shown as "at least"). The
  Done-request reset reads the mirrored Mango orders too (their
  completed date fills `closedAt`).

## PMD_DieChangeLog (die-change condition reports)

Created by hand (2026-07); internal names verified against the list
schema export. The operator sheet pops a **Die Change Log** form the
first time a tuple's timeline gets a **D** (Die Change) or **I**
(Insert Change) status: date / shift / die setter / machine / job /
Die-Out / Die-In are prefilled (setter can correct them), and the
operator rates the 13 die components — Bolts, Cores, EjectorPins,
ElectricalIssues, GasNeedle, GuidePins, HotRunners, MouldingSurfaces,
Nozzle, NozzleTip, OilLeaks, Venting, WaterLeaks — as
*1. Good work order* / *2. Operational but worn* / *3. Damaged or
can't be used* (defaults to 1; a 2 or 3 requires a problem
description). Saving writes one row; **Skip** is allowed (the prompt
fires once per machine+shift+job per session). Writers need Edit
permission on the list.

## PMD_DieMaster (die asset register)

Optional list, created by hand (2026-07), that feeds the Die Management
table's **Status** column and the "Die master" block in the die detail
popup. One row per physical tool; the toolroom maintains it directly in
SharePoint (the app only reads it — a hard reload picks up edits).

- Columns: `DieNumber` (may live in `Title` — both are probed),
  `DieDescription`, `Cavities`, `CycleTime`, `DieWeightKG`, `LeanReady`
  (Yes/No), `ToolInjectorPlate`, `ChangeOverIn`, `ChangeOverOut`,
  `LifeCycle`, `DateStamp`, `ToolStatus`. Internal column names are
  resolved at read time from the list's own field map (display title →
  internal name), so renamed / re-created columns keep working — the
  resolution is logged to the console (`PMD_DieMaster field resolution`).
- `ToolStatus` values (free text, tolerantly parsed): **Serviced**
  (green), **In service** (blue), **To be Serviced** (orange),
  **Problems** (red). Anything else / empty shows as "—". Sorting the
  Status column surfaces Problems first.
- A die missing from this list still shows in the table (usage comes
  from `PMD_ProductDieColor` + production) — only its Status is "—".

---

## Troubleshooting checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 The field 'XYZ' is not recognised` | Field map wrong | Run `window.__pmdDal.diagnoseFields()` in DEV; patch `DEFAULT_FIELDS` in `src/dal/sharepoint.ts` |
| Order Qty shows `—` on an unlocked old order | `JobRequired` column not added to PMD_Production yet | Add the column (Number type), then re-sign-off the order to populate it |
| Sign off fails with `POST 500 Invalid text value. A text field contains invalid data.` and console says `column 'QualityChecks' / 'RejectsBySlot' / 'Handover' … value is N chars` | That column was provisioned as **Single line** text (255-char limit); a full-shift JSON payload overflows | In SharePoint list settings → that column → Change column type to **Multiple lines of text** (plain text, not enhanced). Existing data is preserved. The sign-off retry path keeps the rest of the row writing in the meantime, so only that one column is blank until you change the type and re-sign-off. |
| Sign off fails with `POST 500 Invalid text value` and console flags a value < 255 chars | Operator pasted from Excel/Word and a hidden control char / line separator landed in a handover textarea | `sanitizeBodyStrings` strips most of these before they hit SP. If you still see this, clear and retype the flagged field (the column name and value are in the warning) and sign off again. |
| Refresh button does nothing, console says `graphToken: pass …` | MSAL/SPFx token provider not wired | In SPFx: confirm `onInit()` sets `window.__pmdGraphToken`. In dev: install MSAL per `docs/LOCAL_DEV_WITH_SHAREPOINT.md` |
| `403` from any list GET | Operator doesn't have Edit on that list | SharePoint Site Settings → Permissions → ensure they're in `PMD-Members` (or whatever Edit group you used) |
| Sign off & Save writes nothing | No supervisor selected, or count end < count start | Toast tells you; check console |
| Smoke test fails on `lockShift` 500 | One of the 3 production lists' column missing or required | Check the failed list's settings → which column was required? |
| `sync.log` shows `Missing Credential Manager entry 'PMDSync.Epicor'` | Cred was created under a different Windows user | Re-run `cmdkey` as the user the scheduled task runs as |
| `sync.log` shows 401 from Epicor | Wrong user/password or missing X-API-Key | Check `cmdkey /list:PMDSync.Epicor`; set `EpicorApiKey` in config.json |
| Planning button in app shows "Planning CSV fetch failed (404)" | CSV path env var doesn't match the real SharePoint path | Confirm the file is in the library and `VITE_PLANNING_CSV_PATH` is the server-relative path (starts with `/sites/...`) |
| OneDrive icon says "Sign in to sync" | Sync stalled | Click OneDrive tray icon → sign in. Until then `Planning.csv` won't reach SP, app keeps reading the last-uploaded copy |

---

## Roll-back

Every step is reversible:

- **SPFx**: in App Catalog, delete the `.sppkg` → web part disappears from pages.
- **Epicor sync**: Task Scheduler → disable `PMD Planning Sync`. PMD_Planning will go stale but the app keeps working with the last-synced values.
- **Lists**: data lives on. If you need to start clean: Site Contents → List Settings → Delete this list.
