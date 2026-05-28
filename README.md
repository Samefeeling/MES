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
    conflicts.ts    conflict detection + real-time guard (§5.4)
    metrics.ts      OEE / scrap% / downtime / setup rollups (§4.1)
    lock.ts         shift lock rules (§5.5)
    planning.ts     order bar region + auto die-change (§5.2, §5.3)
  dal/              data access layer (§6)
    types.ts        PmdDataLayer interface — the single backend seam
    memory.ts       in-memory backend (seeded demo data, Appendix A)
    sharepoint.ts   Phase 1 skeleton (§7.1)
    sql.ts          Phase 2 skeleton (§7.2)
    azure.ts        Phase 3 skeleton (§7.3)
    index.ts        createDataLayer() — VITE_BACKEND feature flag (§12.3)
  ui/               dashboard, machine view, modal, toast, charts
tests/              business-logic unit tests
docs/INTEGRATION.md PMD ⇄ Advanced MES integration design
```

## Develop

```bash
npm install
npm run dev        # http://localhost:5173 — uses the in-memory backend
npm test           # unit tests
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + static bundle to dist/
```

## Switching backend

Set the feature flag (§12.3) — no UI changes:

```bash
VITE_BACKEND=sharepoint VITE_SITE_URL=https://reseroglobal.sharepoint.com/...
VITE_BACKEND=sql        VITE_API_BASE=/api
VITE_BACKEND=azure      VITE_API_BASE=/api
```

`memory` (default) is the contract reference the other adapters must satisfy.

## Status

v1 scope implemented: Dashboard + Machine View, conflict detection, shift
lock/unlock, per-job counts/rejects, handover, auto die-change, 60s polling.
SharePoint/SQL/Azure adapters are documented skeletons (DAL contract is
defined and tested via the in-memory backend). Auto-fill rules (§5.9) and
the Admin/Reports modules (§9, §10) are intentionally out of v1 scope.
