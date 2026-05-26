# Running the PMD app locally against the real SharePoint site

The repo defaults to the in-memory mock backend so `npm run dev` works with
no network. To wire it up against the Resero Operations AU lists, follow
the steps below.

## 1. Clone & install

```bash
git clone <repo-url> mes
cd mes
nvm use 18           # SPFx-compatible; 20/22 also work for plain Vite
npm install
```

## 2. Verify Node version

```bash
node -v              # expect v18.x or newer
```

## 3. Switch the backend

Create `.env.local` at the repo root (Vite reads `VITE_*` vars):

```bash
VITE_BACKEND=sharepoint
VITE_SITE_URL=https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU
VITE_PLANNING_PATH=Shared Documents/General/Planning/PMD/PMD Schedule_master_epicor 300424.xlsm
```

Start dev:

```bash
npm run dev          # http://localhost:5173
```

> **Heads up — CORS.** The browser will block `fetch(/_api/...)` against
> SharePoint when the page is served from `localhost`. To get around this
> locally:
>
> 1. **Easiest** — install the [SharePoint Online CORS workaround browser
>    extension](https://chromewebstore.google.com/search/cors) or any CORS
>    unblocker for `*.sharepoint.com` (dev only, never in production).
> 2. **Cleanest** — deploy as an SPFx web part to a page on the site; SP
>    REST then works automatically through the page's same-origin cookies.
>
> The data model and adapter itself works the same way in both modes.

## 4. Verify column internal names

The SharePoint adapter ships with **best-guess internal names**. SP mangles
spaces / slashes (e.g. `Qty/Hour` → `Qty_x002f_Hour`). If your tenant uses
different internal names the GETs will succeed but every column reads as
empty.

In the browser console, run:

```js
window.__pmdDal.diagnoseFields()
```

It prints a table of every PMD list and its actual internal names. To
expose `__pmdDal`, drop this two-liner at the top of `src/main.ts` while
debugging:

```ts
import { createDataLayer } from './dal';
(window as any).__pmdDal = dal;
```

For any column where the internal name in the table doesn't match the
default in `src/dal/sharepoint.ts → DEFAULT_FIELDS`, pass an override in
`src/dal/index.ts → createDataLayer`:

```ts
return new SharePointDataLayer({
  siteUrl: env.VITE_SITE_URL ?? '',
  fieldMap: {
    planning: { qtyHour: 'Qty0', dc: 'D_C' },   // ← actual internal names
    production: { downTime: 'DownTime' },
  },
});
```

## 5. Sign-in + Graph token for the Excel sync

The Refresh button calls Microsoft Graph to read the planning workbook.
You need an access token with `Files.Read.All` (delegated). Quick path
using MSAL:

```bash
npm install @azure/msal-browser
```

In `src/main.ts`:

```ts
import { PublicClientApplication } from '@azure/msal-browser';

const msal = new PublicClientApplication({
  auth: {
    clientId: '<your Entra app registration client id>',
    authority: 'https://login.microsoftonline.com/<tenant id>',
    redirectUri: window.location.origin,
  },
});
await msal.initialize();
const account = (await msal.handleRedirectPromise())?.account ?? msal.getAllAccounts()[0];
if (!account) await msal.loginRedirect({ scopes: ['Files.Read.All', 'Sites.Read.All'] });

window.__pmdGraphToken = async () => {
  const res = await msal.acquireTokenSilent({
    scopes: ['Files.Read.All', 'Sites.Read.All'],
    account: account ?? msal.getAllAccounts()[0],
  });
  return res.accessToken;
};
```

You'll need a SharePoint admin to register an Entra app with:
- Platform: SPA
- Redirect URI: `http://localhost:5173` (dev) + your production URL
- Permissions: `Files.Read.All`, `Sites.Read.All` (delegated)

## 6. Run

```bash
npm run dev
```

- Open `http://localhost:5173/#/op/1600T`
- Click **⟳ Refresh** → expects "Planning synced · N rows in" toast
- Fill a slot → it caches in memory (no network on every keystroke)
- Click **✅ Sign off & Save** → flushes one row into PMD_Production,
  one into PMD_BreakDown, N rows into PMD_Rejects

## 7. Trace view

`http://localhost:5173/#/trace` (or click the 🔍 Trace link in the top
bar).

- Search by Job Number, date range, or both
- Each match shows the 16-slot Timeline strip, totals, rejects, and
  breakdown events for that (machine, shift, job)
- Works with both backends — memory + SharePoint

## 8. Tests

```bash
npm test             # 56 unit tests
npm run typecheck    # tsc --noEmit
npm run build        # static bundle to dist/
```

## What to send back if something doesn't read

For each list that shows empty rows / null values, paste the output of:

```
https://reseroglobal.sharepoint.com/sites/ReseroOperationsAU/_api/web/lists/getbytitle('PMD_Production')/items?$top=1
```

…into chat. With the actual JSON I can pin the exact internal names and
ship a `fieldMap` patch.
