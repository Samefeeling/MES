# PMD Dashboard ⇄ Advanced MES — Integration Design

> The reference article
> `https://erphelp121100.zendesk.com/hc/en-us/articles/40443315967885-Data-Integration-Setup-on-Advanced-MES`
> is behind Zendesk authentication and returned **HTTP 403** to the build
> environment, so it could not be read automatically. This document captures
> the integration **seam** in our codebase and the **questions to confirm**
> against that article. Paste the article contents (or grant access) and the
> `### To confirm` items can be turned into a concrete field map.

## 1. Where integration plugs in

The whole app depends only on the `PmdDataLayer` interface
(`src/dal/types.ts`). The two systems are fused at exactly **two seams**:

1. **Inbound (MES/ERP → PMD)** — released production orders land in
   `PMD_Planning` (`listPlanning`). Today seeded; in production this is an
   ERP/MES sync job (§7 of the spec, §12 cutover).
2. **Outbound (PMD → MES)** — confirmed shift actuals (`PMD_Production`,
   locked shifts) flow back so MES sees OEE / downtime / scrap / setup.

```
Advanced MES  ──(orders, parts, routings)──▶  PMD_Planning ─▶ PMD UI
Advanced MES  ◀──(production actuals, lock)──  PMD_Production ◀ PMD UI
```

No UI or core-logic code changes when the backend changes — only a new
`PmdDataLayer` implementation (or an ETL feeding the existing tables).

## 2. Recommended integration pattern

Advanced MES "Data Integration Setup" tools are typically one of:

- **Pull via REST/OData** from MES on a timer (planner releases → PMD).
- **Push via webhook/file drop** from MES into a staging endpoint.
- **Shared database / linked server** (most relevant for Phase 2 SQL).

Map each to our seam:

| MES capability | PMD side | Implementation |
|---|---|---|
| Order release feed | `listPlanning` source | Scheduled ETL writes `PMD_Planning`; set `Released=true` only when MES authorizes (§5.7) |
| Part master | `listProducts` | Reference sync (15-min TTL cache, §6.2) |
| Work center ↔ machine | `PMD_Machines.OriginalMachine` | Keep the pre-mapping code for audit (§3.5) |
| Production confirmation | locked `PMD_Production` | On `lockShift`, emit a per-(machine,shift) rollup to MES |
| Downtime / breakdown | `BdIssue`, `MangoTicket` | Map BD codes ↔ MES failure taxonomy |

### Field mapping (canonical)

`JobNumber` is the integration key (ERP `SFM…`). Die-change pseudo-orders
(`DC_*`) are PMD-internal and must be **filtered out** of any outbound feed
to MES unless MES models changeovers explicitly.

## 3. Idempotency, ordering, concurrency

- The app is **last-write-wins** (§5.6). The MES sync job must be **idempotent
  on the composite key** `(MachineCode, ShiftId, JobNumber, SlotIndex)` so a
  replay never duplicates rows — mirror `upsertProductionRecord`'s match.
- Outbound rollups should only fire for **locked** shifts (immutable, §5.5) to
  avoid sending partial data MES would have to revise.
- Time zone: storage is site-local today (Sydney). Any MES exchange should
  carry an explicit offset; international rollout needs UTC (§13 Q4).

## 4. Phase alignment with the spec

- **Phase 1 (SharePoint)** — integration is an Azure Function / Power Automate
  ETL: MES → SharePoint list `PMD_Planning`; SharePoint → MES on lock.
- **Phase 2 (SQL)** — linked server or the REST API layer brokers both
  directions; cleanest place for the MES "Data Integration Setup" connector.
- **Phase 3 (Azure)** — SWA Functions call the MES integration API directly;
  bacpac migration keeps the schema identical to Phase 2.

## 5. To confirm against the Advanced MES article

1. Transport: REST/OData pull, webhook push, file drop, or DB link?
2. Auth: API key, OAuth2 client-credentials, or Windows/AD?
3. Entity coverage: does MES expose order *release* status, or only created
   orders? (Drives the `Released` flag, §5.7.)
4. Granularity MES expects back: per-slot, per-job/shift, or per-shift OEE?
5. Failure-mode taxonomy: is there a standard map between our 31 BD codes and
   MES downtime reasons?
6. Polling limits / batch size and any change-data-capture (delta) support.

Once answered, implement a `MesIntegrationAdapter` alongside the DAL (it does
not replace `PmdDataLayer`; it feeds/drains the same tables).
