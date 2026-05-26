# Deploying the PMD Operator Sheet

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

Edit `pmd-spfx/src/webparts/pMDOperatorSheet/PMDOperatorSheetWebPart.ts`:

```ts
import { Version } from '@microsoft/sp-core-library';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';
import { AadTokenProvider } from '@microsoft/sp-http';

export default class PMDOperatorSheetWebPart extends BaseClientSideWebPart<{}> {
  protected async onInit(): Promise<void> {
    // Provide Graph token to the bundled app so syncPlanningFromExcel works.
    const tokenProvider: AadTokenProvider =
      await this.context.aadTokenProviderFactory.getTokenProvider();
    (window as any).__pmdGraphToken = () =>
      tokenProvider.getToken('https://graph.microsoft.com');
  }

  public render(): void {
    this.domElement.innerHTML = `
      <div class="top">
        <img class="brand-logo" src="${require('./assets/resero-logo.svg')}" alt="Resero" />
        <h1>PMD Operator Sheet</h1>
        <span class="top-nav">
          <a href="#/">Operator</a>
          <a href="#/trace">🔍 Trace</a>
        </span>
        <span class="st" id="ss">☁ ready</span>
      </div>
      <div class="vw" id="app"></div>
      <div class="mbg" id="modal"><div class="mdl" id="mc"></div></div>
      <div class="toast" id="toast"></div>
    `;
    // Inject the Vite bundle styles + scripts.
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = require('./assets/assets/index.css'); // hash will be filled by webpack
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.type = 'module';
    js.src = require('./assets/assets/index.js');
    document.body.appendChild(js);
  }

  protected get dataVersion(): Version { return Version.parse('1.0'); }
}
```

> **Note:** Vite's bundle filenames have content hashes
> (`index-CYX-PL67.css`). After each `npm run build` you'll need to
> update the `require()` paths above. To avoid that pain, configure
> Vite to emit non-hashed filenames for the SPFx target — add
> `rollupOptions: { output: { entryFileNames: 'assets/index.js',
> assetFileNames: 'assets/index[extname]' } }` to `vite.config.ts`
> before `npm run build`.

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

## C. Power Automate scheduled refresh (30 min)

The browser-side auto-sync (in `src/main.ts`) only runs when an
operator opens the app. To guarantee PMD_Planning is current every
morning regardless of who's logged in, add a scheduled flow.

### C.1 Create the flow

1. Open `https://make.powerautomate.com` → sign in with the same
   account that has Edit on ReseroOperationsAU.
2. **+ Create → Scheduled cloud flow**.
3. Name: `PMD Daily Planning Sync`.
4. Starts: pick `06:00` Sydney time.
5. Repeat every `1 Day`.

### C.2 Add the steps

**Step 1 — Run script** (Office Scripts). Reads the .xlsm and
returns the rows.

- Action: **Excel Online (Business) → Run script**
- File: `/General/Planning/PMD/PMD Schedule_master_epicor 300424.xlsm`
- Script (paste into Office Scripts editor first, save as
  `read-pmd-planning`):

```ts
function main(workbook: ExcelScript.Workbook): Row[] {
  const sheet = workbook.getWorksheet('Planning');
  const used = sheet.getUsedRange();
  const values = used.getValues();
  const out: Row[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[16] /* col Q = StartDateTime */) continue;
    out.push({
      machine: String(r[1] ?? ''),       // B
      jobNumber: String(r[2] ?? ''),     // C
      partNumber: String(r[3] ?? ''),    // D
      partDescription: String(r[4] ?? ''), // E
      jobRequired: Number(r[5] ?? 0),    // F
      qtyPerHr: Number(r[6] ?? 0),       // G
      duration: Number(r[7] ?? 0),       // H
      originalMachine: String(r[14] ?? ''), // O
      startDateTime: r[16] as string,    // Q
      dueDate: r[17] as string,          // R
    });
  }
  return out;
}
interface Row {
  machine: string; jobNumber: string; partNumber: string;
  partDescription: string; jobRequired: number; qtyPerHr: number;
  duration: number; originalMachine: string;
  startDateTime: string; dueDate: string;
}
```

**Step 2 — Clear PMD_Planning** (so we replace, not append):

- Action: **SharePoint → Get items**
- Site: `https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU`
- List: `PMD_Planning`
- (no filter — pull all)
- Then **Apply to each** item → **Delete item**.

**Step 3 — Insert rows**:

- **Apply to each** on `outputs('Run_script')?['result']`
- Inside, **SharePoint → Create item**
- Site: same
- List: `PMD_Planning`
- Fields:
  - `Title` = `items('Apply_to_each_2')?['machine']`
  - `JobHead_JobNum` = `items('Apply_to_each_2')?['jobNumber']`
  - `JobHead_PartNum` = `items('Apply_to_each_2')?['partNumber']`
  - `JobHead_PartDescription` = `items('Apply_to_each_2')?['partDescription']`
  - `Calculated_RemainingQty` = `string(items('Apply_to_each_2')?['jobRequired'])`
  - `Qty_x002f_Hour` = `items('Apply_to_each_2')?['qtyPerHr']`
  - `Duration` = `items('Apply_to_each_2')?['duration']`
  - `Machine` = `items('Apply_to_each_2')?['originalMachine']` (this is the column that displays as "DieNumber" — leave it for the original ERP machine code)
  - `StartDateTime` = `items('Apply_to_each_2')?['startDateTime']`
  - `DueDate` = `items('Apply_to_each_2')?['dueDate']`

**Step 4 — Save & test**. Use the **Test** button → Manually → Run.
Watch the run history; if rows appear in PMD_Planning, you're done.

### C.3 What about the in-app Refresh button?

It still works. The operator hits ⟳ Refresh → `syncPlanningFromExcel()`
fires immediately (uses Graph) → bypasses the flow. So:

- **Power Automate** guarantees a fresh PMD_Planning every morning.
- **Browser auto-sync** (every 6 h per operator) catches mid-day edits.
- **Refresh button** is the manual override when planning team
  just dropped an emergency change.

All three write to the same PMD_Planning list. Last-write-wins.

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
