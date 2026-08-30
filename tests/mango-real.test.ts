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

  it('parses the real yyyy/mm/dd slash date the export actually writes', () => {
    // The synced CSV writes dates as yyyy/mm/dd with slashes ("2026/07/31",
    // "2025/10/10") — NOT dd/mm/yyyy. This is the exact format the F12
    // diagnostic surfaced; every date returned null before it was handled.
    const ymdRow = dieRow.replace(',31/07/2026,', ',2026/07/31,');
    const out = parseMangoWorkOrdersCsv([HEADER, ymdRow].join('\n'));
    expect(out.length).toBe(1);
    expect(out[0].dueDate).toBe('2026-07-31');

    const oct = dieRow.replace(',31/07/2026,', ',2025/10/10,');
    const out2 = parseMangoWorkOrdersCsv([HEADER, oct].join('\n'));
    expect(out2[0].dueDate).toBe('2025-10-10');
  });

  it('survives a stray/unbalanced quote in an unquoted field (no column desync)', () => {
    // A lone " in free text — an inch mark ("6\" wear") or a mis-typed
    // quote in Brief Description — must NOT flip the parser into quote mode
    // and swallow the commas that follow. Before the field-start rule this
    // desynced every column after it, blanking "To be completed by".
    const strayQuote =
      'MWO 02200,,3,Stage 1 Coordinator Assessing,AU - Die 171 Podium Seat,Sprue gate 6" wear on parting line,Karl Stevens,3/07/2026,Resero - Minto,31/07/2026,2. Breakdown,,3/07/2026,7,AM,Day,,"",Minto (AU),Moulding,Karl Stevens,,,,,,';
    const out = parseMangoWorkOrdersCsv([HEADER, strayQuote].join('\n'));
    expect(out.length).toBe(1);
    expect(out[0].dieNumber).toBe('171');
    expect(out[0].description).toBe('Sprue gate 6" wear on parting line');
    expect(out[0].requestedBy).toBe('Karl Stevens'); // column 6 still aligned
    expect(out[0].dueDate).toBe('2026-07-31'); // column 9 survived
  });
});
