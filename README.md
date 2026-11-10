# PMD Dashboard

> **AI / contributor onboarding:** start with [`docs/ai/`](docs/ai/) —
> `architecture.md`, `current-status.md`, `coding-rules.md`,
> `data-model.md`, `api-contract.md`, `backlog.md`, `known-issues.md`.
> That folder is the maintained source of truth; load it first to avoid
> re-reading the whole codebase.

Backend-agnostic, real-time shift production tracking for the Precision
Moulding Department (8 machines, 3 shifts, 30-min slots). Rebuilt from the
DEMO per `PMD_Dashboard_Spec.md` v1.0.

## Stack

- TypeScript + Vite (builds to static HTML/JS — deployable to SharePoint
  SiteAssets, IIS/Kestrel, or Azure Static Web Apps without code changes).
- No runtime dependencies. Vitest for unit tests.

## Architecture

```
src/
  types.ts          domain model (§3)
  core/             pure, fully-tested business logic
    shifts.ts       shift/slot time math (§2.3, §5.1)
    status.ts       status codes + decision table (§2.2, §16)
    metrics.ts      Efficiency / scrap% / downtime / setup rollups (§4.1)
    schedule.ts     Planning.csv windows cut into shifts, die changes
    kpi-attainment.ts  Schedule Adherence and the plan of record
    jobgood.ts, targets.ts   Job Left / Shift Target
    die.ts, maint.ts, impw.ts   tooling, maintenance, Mango tickets
  dal/              data access layer (§6)
    types.ts        PmdDataLayer interface — the single backend seam
    memory.ts       in-memory backend (seeded demo data, Appendix A)
    sharepoint.ts   the production backend (SharePoint lists + CSV files)
    index.ts        createDataLayer() — VITE_BACKEND feature flag (§12.3)
  ui/               operator sheet, KPI, Maint, modal, toast, charts
tests/              business-logic and DAL unit tests
docs/INTEGRATION.md PMD ⇄ Advanced MES integration design
```

## Develop

```bash
npm install            # PMD dashboard (this package)
npm run setup:assembly # Assembly board (assembly/ — its own package.json)
npm run dev            # http://localhost:5173 — uses the in-memory backend
npm test               # unit tests
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + static bundle to dist/, both apps
```

**Both install steps are needed, and both again after a `git pull` that
changes either package.json.** The repository is two npm packages with two
lockfiles, so one `npm install` leaves a tree that looks installed and is
not — which surfaces as `Cannot find module 'node:url'` from
`vite.config.ts`, or as a wall of unresolved `react` / `zustand`
imports when `vite` starts. `npm run dev` and `npm run build` check for this
first and print the command to run (`scripts/check-deps.mjs`).

## Switching backend

Set the feature flag (§12.3) — no UI changes:

```bash
VITE_BACKEND=sharepoint VITE_SITE_URL=https://reseroglobal.sharepoint.com/...
```

`memory` (default) is the contract reference the SharePoint adapter must
satisfy; they are the only two backends. The value is baked in at build
time, and a build that cannot have the backend it asked for — no
`.env.local`, a mistyped value, `sharepoint` without `VITE_SITE_URL` — runs
on the demo data and says so in a red bar under the top bar
(`backendWarning` in `src/dal/index.ts`). SQL / Azure adapters are not
written yet (see `docs/ai/backlog.md`).

## Status

In production on SharePoint: operator sheet, sign-off / unlock, Job Left and
Shift Target, KPI and Schedule Adherence, Maint (dies, machines, team),
Mango tickets, and the Assembly board. Current state and open items:
`docs/ai/current-status.md`, `docs/ai/known-issues.md`.

## Assembly planning

MES includes PMD and Assembly with separate production data and KPI views. See [Assembly integration](docs/ASSEMBLY.md) for setup, Lists, file paths, migration and deployment.
