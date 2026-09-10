# Operational lines and support work

The board has eight lines. PMD is a read-only context lane mirroring moulding's plan; the other seven are scheduled here.

| Display name / Skills value | Stable key |
| --- | --- |
| TBP | TBP |
| PMD | PMD |
| UPL-CUT | UPL_CUT_SEW |
| UPL-Gluing | UPL_GLUING |
| UPL-SSS | UPL_SOFTIE |
| ASM | ASSY |
| Table | TABLE |
| General | FACTORY_GENERAL |

The keys keep their older spellings on purpose: they are written into saved plans, into `ASSY_Operator` skills and into the SharePoint containers, so renaming them would orphan every plan already on the tenant. Skills can contain the display names, separated by semicolons, or SharePoint multi-choice values. A supervisor's current line allocation controls crew availability; skills rank candidates within that line. Dragging an operator does not grant a permanent skill.

Two lines were retired. `UPL` (the catch-all upholstery lane) and `ASSY_STOOL` no longer exist: the BOM rules below say which upholstery bench a part belongs on, and stools are ordinary ASM work. Anything still filed against either — a saved plan, a roster skill, an ERP export — is read onto its successor (`UPL` → UPL-Gluing, `ASSY_STOOL` → ASM), never dropped into the pool.

## Which line builds a part

Three sources, in strict order. Nothing below invents a line: when all three come up empty the order stays where ERP put it.

**1. ERP names the line.** `JobHead_PersonID` settles TBP, PMD, Table and General outright, and no BOM overrides that. `UPL` and `ASSY` name a *department*, not a line, so they fall through to the rules below.

**2. `product-lines.v3.json`** — the reviewed routing table, sitting beside `JobMaterialReq.csv` in the document library. It is the output of the plant's `classify-lines.mjs` run over the full BOM export and then corrected by hand. That review is the point: a part already in this file is never re-derived, because re-deriving it every load would throw the correction away. Rows read `{ code, description, line, key, confidence, evidence }`; `EXCLUDE` marks a configurator placeholder that is never scheduled, and `UNKNOWN` hands the part to the rules below.

**3. The BOM**, for a part nobody has made before: its direct components out of `JobMaterialReq.csv`, put through `src/domain/lineRules.ts` — a transcription of `classify-lines.mjs` v4, rule numbers and evidence wording included.

| Rule | Fires on | Line |
| --- | --- | --- |
| P0 | part number starts `CP-` | never scheduled |
| P1 | no BOM rows for the part | UPL-CUT (ruled: usually a fabric colourway) |
| R1 | resin / masterbatch issued by the kilo | PMD |
| R1s | part number `HST*`/`STMP*`, or "Hot Stamp" in the description | PMD |
| R2 | description starts "Cut Fab", or every component is cloth by the metre | UPL-CUT |
| R3 | foam, adhesive or lining, or it consumes a Cut Fab sub-assembly | UPL-Gluing |
| R4 | anything else that is built | ASM |
| R5 | an R3 hit whose description says "Smart Soft", or that rolls up into an `SSOT*` product | UPL-SSS |

Priority when several fire is PMD > UPL-CUT > UPL-Gluing > ASM, and the result is reported as `ruled` rather than `high` so the report can list it for someone to check.

Two properties are load-bearing and both come straight from the plant's script. **Direct children only:** the BOM expresses the process boundary in its levels, so recursing into grandchildren drags the downstream operation's materials up and every assembly starts looking like moulding. **Units matter:** resin only counts as moulding feedstock when it is issued by the kilo, and cloth only counts as face fabric by the metre.

Everything that used to be inferred from the part description — "contains cut", "contains softie", "contains stool" — is gone. A description is what somebody typed; the BOM is what the part is made of.

## People and production records

Drag a worker's name from a line header to another line. The move removes their current allocations on other lines, including started orders, while retaining recorded start and daily crew snapshots. A started order can receive replacement crew. Empty active crew arrays are preserved so a historical start snapshot cannot silently reassign someone.

Factory General workers are not consumed by automatic Crew orders. Move them back to a production line when they return. A person without a recognised initial line is shown in Factory General rather than disappearing.

## Manual support orders

Use New support order with supervisor access. Enter the receiving department, work description, date (dd/mm/yyyy), and total planned labour hours. The order appears in Factory General and is saved with the shared plan, independently of ERP exports.

Select the crew from workers moved to Factory General. Each order supports the existing maximum of four concurrent people; use separate orders for larger teams. Save daily total labour hours and notes, and mark the order complete when finished. Hours are totals across the selected crew, not hours per person. Daily bookings upsert by order and date.

Support records use ASSY_Production with WorkType=Support. OrderQty, RemainingQty, Complete and ShiftOutput are zero in SharePoint; LaborHours carries actual support time. Internally the scheduler measures manual work in hours. MES KPI excludes support records from manufactured orders and quantities and reports support orders/hours separately.

## Existing SharePoint Lists

Keep ASSY_Operator, ASSY_Plans and ASSY_Production. No SKU skill mapping Lists are needed.

Add these fields to ASSY_Production using the existing provisioning script and the updated schema:

| Internal name | Type |
| --- | --- |
| WorkType | Text |
| WorkDescription | Multiple lines of plain text |
| SupportDepartment | Text |
| LaborHours | Number |
| PlannedHours | Number |

Run scripts/provision-assembly.ps1 with SiteUrl to preview, then with Apply to add missing fields. Existing fields and records are preserved. Configure a supervisor password for the MES deployment and use the host supervisor sign-in.

Deploy both MES and Assembly after applying the schema. Live SharePoint writes require validation on the tenant; local mock tests do not prove a live deployment. The existing shared-plan 60,000-character limit still applies.
