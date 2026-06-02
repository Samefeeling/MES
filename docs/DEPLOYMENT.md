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
| **D. Epicor → PMD_Planning sync** | Keep Planning fresh from Epicor REST every 15 min | 30 min | Runs unattended on shop-floor PC |

A and B are about hosting the **app**. D is about keeping
PMD_Planning **fresh from Epicor**, server-side, with credentials kept
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

## D. Epicor → PMD_Planning sync (PowerShell on shop-floor PC)

Planning data now comes straight from Epicor REST (BAQ) instead of the
.xlsm workbook. A small PowerShell script (`scripts/sync-epicor-to-sp.ps1`)
runs on the always-on PC at the PMD shop floor every 15 minutes via
Task Scheduler, pulls released PMD orders, and upserts them to
PMD_Planning. The in-app **⟳ Refresh** button just re-reads
PMD_Planning — no API or Graph calls from the browser, so credentials
never touch the front end.

### D.1 One-time PC setup

```powershell
# 1. PowerShell 5.1 ships with Windows. Install the two modules.
Install-Module PnP.PowerShell    -Scope CurrentUser -Force
Install-Module CredentialManager -Scope CurrentUser -Force

# 2. Make a folder for config + logs (outside the git repo).
New-Item -ItemType Directory C:\PMDSync -Force | Out-Null
```

### D.2 Register an Entra ID app for SharePoint writes

You need an app-only identity so the scheduled task can write to
PMD_Planning without an interactive logon. Cert-based, no client
secrets — uses Microsoft's recommended modern auth.

```powershell
# Pick a 10-year cert lifetime and store it in CurrentUser\My.
# Tenant + Username = a global admin (one-time, only to register the app).
Register-PnPEntraIDAppForInteractiveLogin `
  -ApplicationName "PMD-Planning-Sync" `
  -Tenant "<tenant>.onmicrosoft.com" `
  -Interactive `
  -ValidYears 10
```

That command:
- Creates the app registration in Entra ID
- Issues a self-signed certificate, installs it in `CurrentUser\My`
- Prints the **ClientId** and **Thumbprint** — note them down.

Then in Entra ID admin → API permissions: grant `Sites.Selected`
(Application). Then run **one** elevated PowerShell to allow this
single site:

```powershell
# Replace <site> with the PMD site URL, <ClientId> with the app id.
Connect-PnPOnline -Url "https://<tenant>-admin.sharepoint.com" -Interactive
Grant-PnPAzureADAppSitePermission `
  -AppId "<ClientId>" `
  -DisplayName "PMD-Planning-Sync" `
  -Site "https://<tenant>.sharepoint.com/sites/<PMDsite>" `
  -Permissions Write
```

### D.3 Store the Epicor credential

```powershell
# Open cmd.exe (cmdkey doesn't work in PS 7+ window):
cmdkey /generic:PMDSync.Epicor /user:<EpicorUser> /pass:<EpicorPassword>
```

`PMDSync.Epicor` is the credential name the script reads. The user
field is the Basic-auth username, the password field is whatever Epicor
wants in the Basic header (most Kinetic deployments accept the user
password; some use an API token in its place).

If your Epicor also requires an `X-API-Key` header (Kinetic 2021+),
put that *key* (which is an identifier, not a secret per se) in
`config.json` below.

### D.4 Drop the non-secret config in place

Copy `scripts/sync-epicor-to-sp.config.example.json` to
`C:\PMDSync\config.json` and fill in:

```json
{
  "EpicorUrl":         "https://<epicor-host>/<EnvName>/api/v2/odata/<Company>/BaqSvc/<BaqId>_BaqId/",
  "EpicorApiKey":      "<paste-X-API-Key-here-or-leave-empty>",
  "SharePointUrl":     "https://<tenant>.sharepoint.com/sites/<PMDsite>",
  "PlanningListTitle": "PMD_Planning",
  "SPClientId":        "<ClientId-from-step-D2>",
  "SPTenantId":        "<your-tenant-guid>",
  "SPCertThumbprint":  "<Thumbprint-from-step-D2>"
}
```

The repo never sees this file — it's ignored by `.gitignore` even if
someone drops a copy under `scripts/`.

### D.5 Smoke-test once

```powershell
powershell.exe -ExecutionPolicy Bypass -File C:\PMDSync\sync-epicor-to-sp.ps1
```

You should see something like:

```
[2026-06-02 14:00:01] GET https://...BaqSvc/...
[2026-06-02 14:00:03]   Epicor returned 423 rows
[2026-06-02 14:00:03]   Kept 38 after PMD/Released filter
[2026-06-02 14:00:11] Done: +6 (added)  ~31 (updated)  -2 (removed)  0 errors
```

Then refresh PMD_Planning in SharePoint and confirm rows are correct.

### D.6 Schedule it

Open **Task Scheduler** → **Create Task**:

- **General** tab
  - Name: `PMD Planning Sync`
  - "Run whether user is logged on or not"
  - "Run with highest privileges" (only if your account requires it)
- **Triggers** tab → New
  - Daily, recur every `1 day`
  - "Repeat task every `15 minutes` for a duration of `1 day`"
- **Actions** tab → New
  - Program: `powershell.exe`
  - Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\PMDSync\sync-epicor-to-sp.ps1" *>> "C:\PMDSync\sync.log"`
- **Settings**: tick "Allow task to be run on demand", "If the task fails, restart every 5 min, attempt 3 times".

Tail `C:\PMDSync\sync.log` for run history.

### D.7 What the script writes to PMD_Planning

Field mapping (left = Epicor BAQ field, right = SharePoint internal name):

| Epicor | SharePoint | Note |
|---|---|---|
| `JobHead_JobNum` | `Title` | natural key + display |
| `JobHead_JobNum` | `JobHead_JobNum` | queryable copy |
| `JobHead_PartNum` | `JobHead_PartNum` | |
| `JobHead_PartDescription` | `JobHead_PartDescription` | |
| `Calculated_RemainingQty` | `Calculated_RemainingQty` | |
| `JobHead_StartDate` | `StartDateTime` | |
| `JobHead_ReqDueDate` | `Due_Date` | |
| `Calculated_RemaingLaborHrs` | `Duration` | hours |
| `JobOper_ProdStandard` | `QTYperHour` | |

Filter:
`JobHead_JobReleased = true AND JobHead_PersonID = 'PMD' AND NOT JobHead_JobClosed AND NOT JobHead_JobComplete`

Orphans (jobs that disappear from the Epicor result set) are deleted
from PMD_Planning, so the list always reflects the latest active PMD
workload.

---

## Troubleshooting checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 The field 'XYZ' is not recognised` | Field map wrong | Run `window.__pmdDal.diagnoseFields()` in DEV; patch `DEFAULT_FIELDS` in `src/dal/sharepoint.ts` |
| Refresh button does nothing, console says `graphToken: pass …` | MSAL/SPFx token provider not wired | In SPFx: confirm `onInit()` sets `window.__pmdGraphToken`. In dev: install MSAL per `docs/LOCAL_DEV_WITH_SHAREPOINT.md` |
| `403` from any list GET | Operator doesn't have Edit on that list | SharePoint Site Settings → Permissions → ensure they're in `PMD-Members` (or whatever Edit group you used) |
| Sign off & Save writes nothing | No supervisor selected, or count end < count start | Toast tells you; check console |
| Smoke test fails on `lockShift` 500 | One of the 3 production lists' column missing or required | Check the failed list's settings → which column was required? |
| `sync.log` shows `Missing Credential Manager entry 'PMDSync.Epicor'` | Cred was created under a different Windows user | Re-run `cmdkey` as the user the scheduled task runs as |
| `sync.log` shows 401 from Epicor | Wrong user/password or missing X-API-Key | Check `cmdkey /list:PMDSync.Epicor`; set `EpicorApiKey` in config.json |
| `sync.log` shows 403 from SharePoint | App permission not granted on that site | Re-run `Grant-PnPAzureADAppSitePermission` (§ D.2) with `Write` |

---

## Roll-back

Every step is reversible:

- **SPFx**: in App Catalog, delete the `.sppkg` → web part disappears from pages.
- **Epicor sync**: Task Scheduler → disable `PMD Planning Sync`. PMD_Planning will go stale but the app keeps working with the last-synced values.
- **Lists**: data lives on. If you need to start clean: Site Contents → List Settings → Delete this list.
