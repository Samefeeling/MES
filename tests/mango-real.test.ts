import { describe, it, expect } from 'vitest';
import { parseMangoWorkOrdersCsv } from '../src/dal/sharepoint';

// The user's EXACT header + a die row modelled on their real first row
// (multi-line quoted Actions taken, a comma in "Assign to Action", a
// filled "To be completed by"). Proves whether dueDate survives.
const HEADER =
  'Number,Downtime,Labour Hours,Current Stage,Plant/Equipment,Brief Description,Employee,Created Date,Branch,To be completed by,Type of Maintenance ,Identified By,Date identified,Time,AM/PM,Work shift,Describe the issue,Actions taken,Region,Department,Assign to Action,Work can be done to,Summary of work completed,"Cost (parts, labour)",Corrective action taken,Preventative action taken,Summary';

const dieRow =
  'MWO 02100,,4,Stage 1 Coordinator Assessing,AU - Die 171 Podium Seat,Sprue gate wear \\ hopper,Karl Stevens,3/07/2026,Resero - Minto,31/07/2026,2. Breakdown,,3/07/2026,7,AM,Day,,"Wed, 01/10/2025, Steven Brough ():  Created \n Wed, 01/10/2025, Anil Pattarath (Stage 1): Comment: please action",Minto (AU),Moulding,"Aryan Apte, Wisam Istefo",,"Found drive motor tripped.",,Restored CCT.,Informed operator.,Need to resolve.';

describe('parseMangoWorkOrdersCsv — user real header', () => {
  it('pulls dueDate from a die row shaped like the real export', () => {
    const out = parseMangoWorkOrdersCsv([HEADER, dieRow].join('\n'));
    expect(out.length).toBe(1);
    expect(out[0].dieNumber).toBe('171');
    // Bare dd/mm/yyyy → a stable YYYY-MM-DD with NO time and NO UTC shift.
    // The old toISOString() path produced '2026-07-31T00:00:00.000Z' (and
    // rolled the day back in any UTC+ timezone), so exact-equality guards
    // both regressions at once.
    expect(out[0].dueDate).toBe('2026-07-31');
  });

  it('an empty "To be completed by" cell yields no dueDate (the observed case)', () => {
    const emptyDue = dieRow.replace(',31/07/2026,', ',,');
    const out = parseMangoWorkOrdersCsv([HEADER, emptyDue].join('\n'));
    expect(out.length).toBe(1);
    expect(out[0].dueDate).toBeUndefined();
  });
});
