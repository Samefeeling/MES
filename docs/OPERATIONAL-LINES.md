# Operational lines and support work

The board has seven production lines and a normally empty Factory General group. PMD remains a separate, read-only context lane.

| Display name / Skills value | Stable key |
| --- | --- |
| UPL - Cut/Sewing | UPL_CUT_SEW |
| UPL - Gluing | UPL_GLUING |
| UPL - ASSY | UPL |
| UPL - Softie (SSS) | UPL_SOFTIE |
| ASSY - Stool | ASSY_STOOL |
| ASSY - Seats | ASSY |
| Table | TABLE |
| Factory General | FACTORY_GENERAL |

The UPL and ASSY keys remain stable for compatibility with saved plans. Skills can contain the display names, separated by semicolons, or SharePoint multi-choice values. A supervisor's current line allocation controls crew availability; skills rank candidates within that line. Dragging an operator does not grant a permanent skill.

## Initial order placement

- Cut anywhere in the description has highest priority: UPL - Cut/Sewing.
- Other UPL orders: Sewing goes to Cut/Sewing; Glue, Gluing or Foamed Up goes to Gluing; Smart Softies, Softie, SSS or Ottoman goes to Softie; the remainder goes to UPL - ASSY.
- ASSY orders containing Stool go to ASSY - Stool. All other ASSY orders, including rails, arms and trolleys, go to ASSY - Seats.
- Table remains Table. PMD parts remain PMD regardless of product names. Unknown resources remain unassigned.
- Old UPL/ASSY placements are migrated once, preserving crew and pinned dates. Later supervisor moves survive refresh. Cut continues to enforce the explicit Cut/Sewing rule.

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
