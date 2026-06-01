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
| **C. Power Automate daily sync** | Belt-and-braces server-side refresh of PMD_Planning | 30 min | Runs unattended |

A and B are about hosting the **app**. C is about keeping
PMD_Planning **fresh from the Excel file** even when nobody opens
the app. You probably want B + C.

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

## C. Power Automate scheduled refresh (the only path now)

The in-browser Graph sync was removed. The Planning workbook
(`PMD Schedule_master_epicor 300424.xlsm`) is >10 MB with VLOOKUPs +
macros, which makes every Graph `/workbook/.../range` call 504 at
`MaxRequestDurationExceeded`. Office Scripts runs server-side inside
Excel itself with no such timeout, so the keep-PMD_Planning-fresh job
lives there now. The in-app **⟳ Refresh** button just re-reads
PMD_Planning — it never touches Graph.

### C.1 Create the flow

1. Open `https://make.powerautomate.com` → sign in with the same
   account that has Edit on ReseroOperationsAU.
2. **+ Create → Scheduled cloud flow**.
3. Name: `PMD Daily Planning Sync`.
4. Starts: pick `06:00` Sydney time.
5. Repeat every `1 Day` (or 30 min if planning is edited mid-day).

### C.2 Add the steps

**Step 1 — Run script** (Office Scripts). Reads the .xlsm and returns
the rows. Column letters match the live workbook (A,B,C,D,E,F,G,H,O,Q,R):

- Action: **Excel Online (Business) → Run script**
- File: `Shared Documents/General/Planning/PMD/PMD Schedule_master_epicor 300424.xlsm`
- Script (paste into Office Scripts editor first, save as
  `read-pmd-planning`):

```ts
// Excel column layout (matches src/dal/sharepoint.ts:syncPlanningFromExcel):
//   A=Machine  B=StartDateTime  C=QtyPerHour  D=Due_Date
//   E=JobHead_JobNum  F=JobHead_PartNum  G=JobHead_PartDescription
//   H=Calculated_RemainingQty  O=DIENumber  Q=Duration  R=DIEChange
function main(workbook: ExcelScript.Workbook): Row[] {
  const sheet = workbook.getWorksheet('Planning');
  const used = sheet.getUsedRange();
  if (!used) return [];
  const values = used.getValues();
  const out: Row[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[1] /* B = StartDateTime */) continue;
    out.push({
      machine: String(r[0] ?? ''),                  // A
      startDateTime: String(r[1] ?? ''),            // B
      qtyPerHour: Number(r[2] ?? 0),                // C
      dueDate: String(r[3] ?? ''),                  // D
      jobNumber: String(r[4] ?? ''),                // E
      partNumber: String(r[5] ?? ''),               // F
      partDescription: String(r[6] ?? ''),          // G
      remainingQty: String(r[7] ?? ''),             // H — list column is Text
      dieNumber: String(r[14] ?? ''),               // O
      duration: Number(r[16] ?? 0),                 // Q
      dieChange: String(r[17] ?? ''),               // R
    });
  }
  return out;
}
interface Row {
  machine: string;
  startDateTime: string;
  qtyPerHour: number;
  dueDate: string;
  jobNumber: string;
  partNumber: string;
  partDescription: string;
  remainingQty: string;
  dieNumber: string;
  duration: number;
  dieChange: string;
}
```

**Step 2 — Clear PMD_Planning** (so we replace, not append):

- Action: **SharePoint → Get items**
- Site: `https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU`
- List: `PMD_Planning`
- (no filter — pull all)
- Then **Apply to each** item → **Delete item**.

**Step 3 — Insert rows**. Field names below match the live
PMD_Planning schema:

- **Apply to each** on `outputs('Run_script')?['result']`
- Inside, **SharePoint → Create item**
- Site: same
- List: `PMD_Planning`
- Fields (internal names):
  - `Title` = `items('Apply_to_each_2')?['machine']`
  - `StartDateTime` = `items('Apply_to_each_2')?['startDateTime']`
  - `QTYperHour` = `items('Apply_to_each_2')?['qtyPerHour']`
  - `DueDate` = `items('Apply_to_each_2')?['dueDate']`
  - `JobHead_JobNum` = `items('Apply_to_each_2')?['jobNumber']`
  - `JobHead_PartNum` = `items('Apply_to_each_2')?['partNumber']`
  - `JobHead_PartDescription` = `items('Apply_to_each_2')?['partDescription']`
  - `Calculated_RemainingQty` = `items('Apply_to_each_2')?['remainingQty']`
  - `DIENumber` = `items('Apply_to_each_2')?['dieNumber']`
  - `Duration` = `items('Apply_to_each_2')?['duration']`
  - `DIEChange` = `items('Apply_to_each_2')?['dieChange']`

**Step 4 — Save & test**. Use the **Test** button → Manually → Run.
Watch the run history; if rows appear in PMD_Planning, you're done.

### C.3 Refresh button in the app

The in-app **⟳ Refresh** now just re-reads PMD_Planning (which the
flow keeps fresh). Operators hit it after the planning team says "the
new orders are in" without waiting for the next scheduled run.

If you ever need to test the Office Scripts piece manually without
waiting for the schedule, use the flow's **Run** button or call the
script straight from Excel Online → Automate.

---

## Troubleshooting checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 The field 'XYZ' is not recognised` | Field map wrong | Run `window.__pmdDal.diagnoseFields()` in DEV; patch `DEFAULT_FIELDS` in `src/dal/sharepoint.ts` |
| Refresh button does nothing, console says `graphToken: pass …` | MSAL/SPFx token provider not wired | In SPFx: confirm `onInit()` sets `window.__pmdGraphToken`. In dev: install MSAL per `docs/LOCAL_DEV_WITH_SHAREPOINT.md` |
| `403` from any list GET | Operator doesn't have Edit on that list | SharePoint Site Settings → Permissions → ensure they're in `PMD-Members` (or whatever Edit group you used) |
| Sign off & Save writes nothing | No supervisor selected, or count end < count start | Toast tells you; check console |
| Smoke test fails on `lockShift` 500 | One of the 3 production lists' column missing or required | Check the failed list's settings → which column was required? |
| Daily Power Automate run shows 429 | Throttling on bulk delete | Add a 30 s Delay step between Get items and Apply-to-each-Delete |

---

## Roll-back

Every step is reversible:

- **SPFx**: in App Catalog, delete the `.sppkg` → web part disappears from pages.
- **Power Automate**: turn off the flow (top-right toggle).
- **Lists**: data lives on. If you need to start clean: Site Contents → List Settings → Delete this list.
