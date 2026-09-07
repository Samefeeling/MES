import { describe, expect, it } from 'vitest';
import {
  buildImpwDraft,
  describeImpwApiFailure,
  describeMangoAuthFailure,
  detectImpwFindings,
  foldBreakdowns,
  impwApiPayload,
  impwDepartmentOf,
  impwEndpoint,
  impwDraftIssues,
  impwFindingKey,
  impwIsoToFormDate,
  impwOccurrenceDate,
  impwOccurrenceIso,
  impwPlainText,
  impwTicketRef,
  missingImpwFields,
  overlongImpwFields,
  parseImpwCreated,
  parseImpwOptions,
  suggestImpwDepartment,
  yieldPctOf,
  EMPTY_IMPW_SITE,
  EMPTY_OPTION,
  IMPW_DESCRIPTION_MAX,
  type ImpwDraft,
  type ImpwFinding,
  type ImpwSiteConfig,
  type ImpwSlice,
} from '../src/core/impw';
import { rec } from './helpers';

const RULES = { yieldTarget: 95, rejectPerShiftMax: 5 };

/** A clean shift on 1600T unless the test says otherwise. */
function slice(partial: Partial<ImpwSlice> = {}): ImpwSlice {
  const base: ImpwSlice = {
    machineCode: '1600T',
    machineName: 'Injection 1600T',
    shiftId: '2026-08-26-Night',
    output: 1000,
    reject: 2,
    yieldPct: 99.8,
    breakdownHrs: 0,
    breakdowns: [],
    jobNumbers: ['SFM507205'],
  };
  return { ...base, ...partial };
}

/** The plant's answers, as they look once the first ticket has been filed:
 *  three names that exist in Mango, and two picks out of Mango's own lists. */
const SITE: ImpwSiteConfig = {
  region: 'QLD',
  branch: 'Wacol',
  other: 'Precision Moulding',
  typeOfImprovement: { id: 'toi-1', name: 'Corrective Action' },
  coordinator: { id: 'co-1', name: 'Felicity Kidwell' },
};

describe('detectImpwFindings', () => {
  it('raises nothing for a clean shift', () => {
    expect(detectImpwFindings([slice()], RULES)).toEqual([]);
  });

  it('raises on any breakdown at all', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 0.5 })], RULES);
    expect(found).toHaveLength(1);
    expect(found[0].triggers).toEqual(['breakdown']);
    expect(found[0].reasons[0]).toContain('0.5 h lost');
  });

  it('names the breakdown causes in the reason', () => {
    const found = detectImpwFindings(
      [
        slice({
          breakdownHrs: 2,
          breakdowns: [
            { code: 'MEC-02', label: 'Ejector jam', owner: 'Maintenance', hours: 2, note: '' },
          ],
        }),
      ],
      RULES,
    );
    expect(found[0].reasons[0]).toContain('MEC-02 Ejector jam');
  });

  it('raises when yield is below the target', () => {
    const found = detectImpwFindings([slice({ output: 900, reject: 100, yieldPct: 90 })], RULES);
    expect(found[0].triggers).toContain('yield');
    expect(found[0].reasons.some((r) => r.includes('90%') && r.includes('95%'))).toBe(true);
  });

  it('leaves a shift exactly on the yield target alone', () => {
    expect(detectImpwFindings([slice({ output: 95, reject: 5, yieldPct: 95 })], RULES)).toEqual([]);
  });

  it('never reads an empty shift as a yield miss', () => {
    // yieldPct defaults to 100 with no pieces, but guard it explicitly: a
    // press that never ran has not missed anything.
    const empty = slice({ output: 0, reject: 0, yieldPct: 0 });
    expect(detectImpwFindings([empty], RULES)).toEqual([]);
  });

  it('raises above the per-shift reject allowance, not at it', () => {
    expect(detectImpwFindings([slice({ reject: 5, yieldPct: 99 })], RULES)).toEqual([]);
    const over = detectImpwFindings([slice({ reject: 6, yieldPct: 99 })], RULES);
    expect(over[0].triggers).toEqual(['reject']);
    expect(over[0].reasons[0]).toContain('6 rejects');
  });

  it('uses the caller thresholds, so a tuned KPI colour tunes the trigger', () => {
    const s = slice({ output: 96, reject: 4, yieldPct: 96 });
    expect(detectImpwFindings([s], RULES)).toEqual([]);
    expect(detectImpwFindings([s], { yieldTarget: 98, rejectPerShiftMax: 5 })[0].triggers).toEqual([
      'yield',
    ]);
    expect(detectImpwFindings([s], { yieldTarget: 95, rejectPerShiftMax: 3 })[0].triggers).toEqual([
      'reject',
    ]);
  });

  it('gives one finding per shift no matter how many rules it broke', () => {
    const found = detectImpwFindings(
      [slice({ output: 800, reject: 200, yieldPct: 80, breakdownHrs: 1 })],
      RULES,
    );
    expect(found).toHaveLength(1);
    expect(found[0].triggers).toEqual(['breakdown', 'yield', 'reject']);
    expect(found[0].reasons).toHaveLength(3);
  });

  it('keys a finding by machine and shift', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES);
    expect(found[0].key).toBe(impwFindingKey('1600T', '2026-08-26-Night'));
    expect(found[0].key).toBe('1600T|2026-08-26-Night');
  });

  it('never merges two machines on the same shift', () => {
    const found = detectImpwFindings(
      [slice({ breakdownHrs: 1 }), slice({ machineCode: '550T', breakdownHrs: 1 })],
      RULES,
    );
    expect(found.map((f) => f.machineCode).sort()).toEqual(['1600T', '550T']);
  });

  it('ranks a breakdown and a quality miss on one scale — shift lost', () => {
    // Half the shift gone (0.5) outranks a 10% scrap rate (0.1), even
    // though that shift is 20× over the reject allowance. Ranking on the
    // overshoot instead would put every quality finding on top for ever.
    const found = detectImpwFindings(
      [
        slice({
          machineCode: 'A',
          shiftId: '2026-08-26-Day',
          output: 900,
          reject: 100,
          yieldPct: 90,
        }),
        slice({ machineCode: 'B', shiftId: '2026-08-26-Day', breakdownHrs: 4 }),
      ],
      RULES,
    );
    expect(found.map((f) => f.machineCode)).toEqual(['B', 'A']);
    expect(found[0].severity).toBeCloseTo(0.5, 4);
    expect(found[1].severity).toBeCloseTo(0.1, 4);
  });

  it('sinks a shift raised only by the flat reject allowance', () => {
    // 6 rejects in 10,000 pieces breaks the per-shift rule and must still
    // be raised — but it is not what the meeting opens first.
    const found = detectImpwFindings(
      [
        slice({ machineCode: 'A', output: 9994, reject: 6, yieldPct: 99.9 }),
        slice({ machineCode: 'B', breakdownHrs: 0.5 }),
      ],
      RULES,
    );
    expect(found.map((f) => f.machineCode)).toEqual(['B', 'A']);
    expect(found[1].triggers).toEqual(['reject']);
  });

  it('breaks a severity tie on the newest shift', () => {
    const found = detectImpwFindings(
      [
        slice({ machineCode: 'A', shiftId: '2026-08-24-Day', breakdownHrs: 1 }),
        slice({ machineCode: 'B', shiftId: '2026-08-26-Day', breakdownHrs: 1 }),
      ],
      RULES,
    );
    expect(found.map((f) => f.shiftId)).toEqual(['2026-08-26-Day', '2026-08-24-Day']);
  });
});

describe('yieldPctOf', () => {
  it('is Good ÷ (Good + Reject)', () => {
    expect(yieldPctOf(900, 100)).toBe(90);
    expect(yieldPctOf(999, 1)).toBe(99.9);
  });

  it('is 100 for a shift with no pieces', () => {
    expect(yieldPctOf(0, 0)).toBe(100);
  });
});

describe('foldBreakdowns', () => {
  const slot = (
    statusCode: string,
    bdIssue = '',
    extra: { bdCause?: string; mangoTicket?: string } = {},
  ): ReturnType<typeof rec> =>
    rec({ jobNumber: 'J1', slotIndex: 0, statusCode: statusCode as '', bdIssue, ...extra });

  it('counts B slots only — smoko is not a breakdown', () => {
    const folded = foldBreakdowns(
      [slot('M'), slot('M'), slot('R'), slot('D'), slot('B', 'MEC-02')],
      0.5,
    );
    expect(folded).toHaveLength(1);
    expect(folded[0].code).toBe('MEC-02');
    expect(folded[0].hours).toBe(0.5);
  });

  it('folds repeated slots of one cause into its total hours', () => {
    const folded = foldBreakdowns(
      [slot('B', 'HYD-04'), slot('B', 'HYD-04'), slot('B', 'HYD-04')],
      0.5,
    );
    expect(folded).toEqual([
      expect.objectContaining({ code: 'HYD-04', hours: 1.5, owner: 'Maintenance' }),
    ]);
  });

  it('resolves the cause text and owner from the taxonomy', () => {
    const folded = foldBreakdowns([slot('B', 'TOOL-02')], 0.5);
    expect(folded[0].label).toBe('Mould damage (cavity / core / insert)');
    expect(folded[0].owner).toBe('Toolroom');
  });

  it('parks an uncoded breakdown on OTH-99 rather than losing the hours', () => {
    const folded = foldBreakdowns([slot('B', '')], 0.5);
    expect(folded[0].code).toBe('OTH-99');
    expect(folded[0].hours).toBe(0.5);
    // OTH-99's taxonomy owner is "—", which is no owner at all.
    expect(folded[0].owner).toBe('');
  });

  it("keeps what the operator wrote when it adds to the code", () => {
    const folded = foldBreakdowns(
      [slot('B', 'ELE-02'), slot('B', 'ELE-02', { bdCause: 'Drive tripped on start, 3rd time' })],
      0.5,
    );
    expect(folded[0].note).toBe('Drive tripped on start, 3rd time');
  });

  it('drops a cause that only repeats the taxonomy text', () => {
    // BDCause is pre-filled from the taxonomy unless the operator types
    // over it, so keeping it would print the same sentence twice.
    const folded = foldBreakdowns(
      [slot('B', 'ELE-02', { bdCause: 'Motor fault (drive / pump motor)' })],
      0.5,
    );
    expect(folded[0].note).toBe('');
  });

  it('still reads the OTH-99 free text off legacy rows', () => {
    // Before BDCause existed the free text was written to MangoTicket —
    // which, despite the name, never held a Mango work-order number.
    const folded = foldBreakdowns(
      [slot('B', 'OTH-99', { mangoTicket: 'Smell from the cooling unit' })],
      0.5,
    );
    expect(folded[0].note).toBe('Smell from the cooling unit');
  });

  it('sorts the causes by hours lost', () => {
    const folded = foldBreakdowns(
      [slot('B', 'ELE-02'), slot('B', 'HYD-04'), slot('B', 'HYD-04')],
      0.5,
    );
    expect(folded.map((b) => b.code)).toEqual(['HYD-04', 'ELE-02']);
  });
});

describe('impwOccurrenceDate', () => {
  it('is dd/mm/yyyy', () => {
    expect(impwOccurrenceDate('2026-08-26-Day')).toBe('26/08/2026');
  });

  it("uses a Night shift's start date, which is what the ShiftId carries", () => {
    expect(impwOccurrenceDate('2026-08-26-Night')).toBe('26/08/2026');
  });

  it('is empty for an unparseable id', () => {
    expect(impwOccurrenceDate('rubbish')).toBe('');
  });
});

describe('impwOccurrenceIso', () => {
  it("is the shift's own start instant, not midnight", () => {
    // A Night shift's ShiftId carries its START date and it begins at 23:00,
    // so dating it 00:00 would file a Tuesday-night stoppage as Tuesday
    // morning. Compared against a locally-built Date so the assertion holds
    // in any site timezone.
    expect(impwOccurrenceIso('2026-08-26-Night')).toBe(
      new Date(2026, 7, 26, 23, 0, 0, 0).toISOString(),
    );
    expect(impwOccurrenceIso('2026-08-26-Day')).toBe(
      new Date(2026, 7, 26, 7, 0, 0, 0).toISOString(),
    );
    expect(impwOccurrenceIso('2026-08-26-Afternoon')).toBe(
      new Date(2026, 7, 26, 15, 0, 0, 0).toISOString(),
    );
  });

  it('is ISO 8601 UTC, which is what the API takes — not the form’s dd/mm/yyyy', () => {
    expect(impwOccurrenceIso('2026-08-26-Day')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('is empty for an unparseable id', () => {
    expect(impwOccurrenceIso('rubbish')).toBe('');
  });

  it('converts back to the form’s date for the paste-in path', () => {
    expect(impwIsoToFormDate(impwOccurrenceIso('2026-08-26-Night'))).toBe('26/08/2026');
    expect(impwIsoToFormDate('')).toBe('');
    expect(impwIsoToFormDate('not a date')).toBe('');
  });
});

describe('buildImpwDraft', () => {
  const finding = (partial: Partial<ImpwSlice> = {}): ImpwFinding =>
    detectImpwFindings([slice(partial)], RULES)[0];

  const raiser = { name: 'Christopher King', email: 'ck@example.com' };

  it('fills every required field when the site answers are known', () => {
    const d = buildImpwDraft(finding({ breakdownHrs: 2 }), raiser, SITE);
    expect(missingImpwFields(d)).toEqual([]);
    expect(impwDraftIssues(d)).toEqual([]);
  });

  it('lists exactly the blank site answers as missing, never inventing one', () => {
    // Type of Improvement and Coordinator only exist inside the tenant, so
    // PMD asks Mango for them rather than guessing a plausible value.
    const d = buildImpwDraft(finding({ breakdownHrs: 2 }), raiser, EMPTY_IMPW_SITE);
    expect(missingImpwFields(d)).toEqual(['Type of Improvement', 'Coordinator']);
  });

  it('takes Name from the signed-in user and flags a missing one', () => {
    expect(buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).originatorName).toBe(
      'Christopher King',
    );
    const anon = buildImpwDraft(finding({ breakdownHrs: 1 }), { name: '' }, SITE);
    expect(missingImpwFields(anon)).toContain('Name');
  });

  it('carries the coordinator through as the id-and-name pair Mango issued', () => {
    const d = buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE);
    expect(d.coordinator).toEqual({ id: 'co-1', name: 'Felicity Kidwell' });
    expect(d.typeOfImprovement).toEqual({ id: 'toi-1', name: 'Corrective Action' });
  });

  it('dates the ticket from the shift', () => {
    expect(buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).improvementDate).toBe(
      new Date(2026, 7, 26, 23, 0, 0, 0).toISOString(),
    );
  });

  it('leads Brief Description with the press — Mango lists tickets by it', () => {
    const d = buildImpwDraft(finding({ output: 900, reject: 100, yieldPct: 90 }), raiser, SITE);
    expect(d.description.startsWith('1600T Night shift 26/08/2026 — ')).toBe(true);
    expect(d.description).toContain('Yield 90%');
  });

  it('keeps Brief Description inside the API’s 255-character cap', () => {
    const wordy = finding({
      breakdownHrs: 3,
      breakdowns: Array.from({ length: 8 }, (_, i) => ({
        code: `MEC-0${i}`,
        label: 'A very long breakdown cause description that runs on and on',
        owner: 'Maintenance',
        hours: 0.5,
        note: '',
      })),
    });
    const d = buildImpwDraft(wordy, raiser, SITE);
    expect(IMPW_DESCRIPTION_MAX).toBe(255);
    expect(d.description.length).toBeLessThanOrEqual(255);
    expect(overlongImpwFields(d)).toEqual([]);
  });

  it('keeps Details inside the API’s 4096-character cap', () => {
    const wordy = finding({
      breakdownHrs: 8,
      breakdowns: Array.from({ length: 60 }, (_, i) => ({
        code: `MEC-${i}`,
        label: 'A very long breakdown cause description that runs on and on and on',
        owner: 'Maintenance',
        hours: 0.1,
        note: 'The operator wrote a great deal about this one, at some length',
      })),
    });
    const d = buildImpwDraft(wordy, raiser, SITE);
    expect(d.improvementDetails.length).toBeLessThanOrEqual(4096);
    expect(overlongImpwFields(d)).toEqual([]);
  });

  it('reduces a taxonomy owner to one Mango department', () => {
    // "Operator → Maintenance" is an escalation path and "Maintenance /
    // Setter" a shared job; Mango's Department is one existing name.
    expect(impwDepartmentOf('Operator → Maintenance')).toBe('Maintenance');
    expect(impwDepartmentOf('Maintenance / Setter')).toBe('Maintenance');
    expect(impwDepartmentOf('Setter / Maintenance')).toBe('Setter');
    expect(impwDepartmentOf('Toolroom')).toBe('Toolroom');
    expect(impwDepartmentOf('')).toBe('');
  });

  it('routes a breakdown to the department that owns the biggest cause', () => {
    const f = finding({
      breakdownHrs: 2.5,
      breakdowns: [
        { code: 'ELE-02', label: 'Motor fault', owner: 'Maintenance', hours: 0.5, note: '' },
        { code: 'TOOL-02', label: 'Mould damage', owner: 'Toolroom', hours: 2, note: '' },
      ],
    });
    expect(suggestImpwDepartment(f)).toBe('Toolroom');
    expect(buildImpwDraft(f, raiser, SITE).department).toBe('Toolroom');
  });

  it('routes a quality-only finding to Production', () => {
    const f = finding({ output: 900, reject: 100, yieldPct: 90 });
    expect(suggestImpwDepartment(f)).toBe('Production');
  });

  it('names the press inside Details — the API has no Plant/Equipment to put it in', () => {
    expect(
      buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).improvementDetails,
    ).toContain('Plant/Equipment: 1600T (Injection 1600T)');
  });

  it("carries the operator's own words into the ticket body", () => {
    const d = buildImpwDraft(
      finding({
        breakdownHrs: 1,
        breakdowns: [
          {
            code: 'ELE-02',
            label: 'Motor fault',
            owner: 'Maintenance',
            hours: 1,
            note: 'Drive tripped on start, 3rd time this week',
          },
        ],
      }),
      raiser,
      SITE,
    );
    expect(d.improvementDetails).toContain('Operator: Drive tripped on start, 3rd time this week');
  });

  it('writes a body that stands on its own away from the dashboard', () => {
    const d = buildImpwDraft(
      finding({ output: 900, reject: 100, yieldPct: 90, breakdownHrs: 1.5 }),
      raiser,
      SITE,
    );
    const body = d.improvementDetails;
    expect(body).toContain('1600T');
    expect(body).toContain('2026-08-26-Night');
    expect(body).toContain('SFM507205');
    expect(body).toContain('900 pcs');
    expect(body).toContain('100 pcs');
    expect(body).toContain('90%');
    expect(body).toContain('1.5 h');
    // The risk and the provenance have no fields of their own on the API,
    // so they have to survive here or not at all.
    expect(body).toContain('Risk:');
    expect(body).toContain('Christopher King');
    expect(body).toContain('PMD_Production');
  });
});

describe('IMPW validation', () => {
  const blank = (): ImpwDraft => ({
    description: '',
    typeOfImprovement: { ...EMPTY_OPTION },
    originatorName: '',
    improvementDate: '',
    improvementDetails: '',
    region: '',
    branch: '',
    department: '',
    other: '',
    coordinator: { ...EMPTY_OPTION },
  });

  it('requires exactly the six fields the API documents as required', () => {
    expect(missingImpwFields(blank())).toEqual([
      'Brief Description',
      'Type of Improvement',
      'Name',
      'Date of occurrence',
      'Details of Improvement and/or Proposed Action',
      'Coordinator',
    ]);
  });

  it('leaves the four placement fields optional, because the API does', () => {
    // The web form stars Region, Branch and Other; the API's own parameter
    // table says each "can leave it blank". The API is what PMD posts to.
    const missing = missingImpwFields(blank());
    for (const label of ['Region', 'Branch', 'Department', 'Other']) {
      expect(missing).not.toContain(label);
    }
  });

  it('demands Mango’s own id for the API but takes a typed name for pasting', () => {
    // A name typed by hand is not a valid API pick — Mango matches on the
    // id it issued. A person pasting into the web form picks from its own
    // dropdown, so there the name is all that is needed.
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const d: ImpwDraft = {
      ...buildImpwDraft(found, { name: 'CK' }, SITE),
      typeOfImprovement: { id: '', name: 'Customer Contact' },
    };
    expect(missingImpwFields(d, 'api')).toEqual(['Type of Improvement']);
    expect(missingImpwFields(d, 'paste')).toEqual([]);
  });

  it('treats whitespace as blank', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const d = buildImpwDraft(found, { name: '   ' }, SITE);
    expect(missingImpwFields(d)).toEqual(['Name']);
  });

  it('reports an over-long capped field', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const d = { ...buildImpwDraft(found, { name: 'A' }, SITE), branch: 'x'.repeat(300) };
    expect(overlongImpwFields(d)).toEqual(['Branch (max 255)']);
    expect(impwDraftIssues(d)).toEqual(['Too long: Branch (max 255)']);
  });
});

describe('Mango API contract', () => {
  const draft = (): ImpwDraft =>
    buildImpwDraft(
      detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0],
      { name: 'CK' },
      SITE,
    );

  it('joins the base and path without doubling or dropping the slash', () => {
    expect(impwEndpoint('https://api.mangolive.com', '/api/v4/improvement')).toBe(
      'https://api.mangolive.com/api/v4/improvement',
    );
    expect(impwEndpoint('https://api.mangolive.com/', 'api/auth/authenticate')).toBe(
      'https://api.mangolive.com/api/auth/authenticate',
    );
    // Mango's paths must not end with a slash or whitespace.
    expect(impwEndpoint(' https://api.mangolive.com// ', '//api/v4/improvement/ ')).toBe(
      'https://api.mangolive.com/api/v4/improvement',
    );
  });

  it('sends exactly the ten fields the API documents, and nothing else', () => {
    // The web form asks for 26 things. Anything extra here would be a field
    // Mango ignores at best and 422s at worst.
    expect(Object.keys(impwApiPayload(draft())).sort()).toEqual([
      'branch',
      'coordinator',
      'department',
      'description',
      'improvementDate',
      'improvementDetails',
      'originatorName',
      'other',
      'region',
      'typeOfImprovement',
    ]);
  });

  it('sends the two option fields as {id, name} objects', () => {
    const p = impwApiPayload(draft());
    expect(p.typeOfImprovement).toEqual({ id: 'toi-1', name: 'Corrective Action' });
    expect(p.coordinator).toEqual({ id: 'co-1', name: 'Felicity Kidwell' });
  });

  it('sends the date as ISO 8601 UTC', () => {
    expect(String(impwApiPayload(draft()).improvementDate)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('omits a blank placement field rather than asking Mango to match an empty name', () => {
    const p = impwApiPayload({ ...draft(), region: '', other: '   ' });
    expect(p).not.toHaveProperty('region');
    expect(p).not.toHaveProperty('other');
    expect(p.branch).toBe('Wacol');
  });

  it('reads back the created ticket the way the API documents it', () => {
    const c = parseImpwCreated({
      id: 'GfuUaXy',
      formTitle: 'Improvement',
      abbreviation: 'IMP',
      number: '0123',
    });
    expect(c).toEqual({
      id: 'GfuUaXy',
      formTitle: 'Improvement',
      abbreviation: 'IMP',
      number: '0123',
    });
    expect(impwTicketRef(c)).toBe('IMP 0123');
  });

  it('still names the ticket when Mango returns only part of it', () => {
    expect(impwTicketRef(parseImpwCreated({ number: '0123' }))).toBe('0123');
    expect(impwTicketRef(parseImpwCreated({ id: 'abc' }))).toBe('abc');
    expect(impwTicketRef(parseImpwCreated(null))).toBe('');
    expect(impwTicketRef(parseImpwCreated('created'))).toBe('');
  });

  it('reads the tenant option lists and drops anything unusable', () => {
    const body = {
      typeOfImprovement: [
        { id: 'b', name: 'Customer complaint' },
        { id: 'a', name: 'Audit finding' },
        { id: '', name: 'No id' },
        { name: 'Name only' },
        null,
        'nonsense',
      ],
      coordinator: [{ id: 'c1', name: 'Felicity Kidwell' }],
    };
    expect(parseImpwOptions(body, 'typeOfImprovement')).toEqual([
      { id: 'a', name: 'Audit finding' },
      { id: 'b', name: 'Customer complaint' },
    ]);
    expect(parseImpwOptions(body, 'coordinator')).toEqual([{ id: 'c1', name: 'Felicity Kidwell' }]);
    expect(parseImpwOptions(null, 'coordinator')).toEqual([]);
    expect(parseImpwOptions({ coordinator: 'nope' }, 'coordinator')).toEqual([]);
  });

  it('turns a failure into an instruction, not a status code', () => {
    expect(describeImpwApiFailure(0, '')).toMatch(/could not reach mango/i);
    expect(describeImpwApiFailure(0, '')).toMatch(/CORS/);
    expect(describeImpwApiFailure(401, '')).toMatch(/Mango connection/);
    expect(describeImpwApiFailure(404, '')).toMatch(/API address/);
    expect(describeImpwApiFailure(503, '')).toMatch(/not the ticket/i);
  });

  it('tells a 422 what it almost always is — a name Mango does not have', () => {
    const msg = describeImpwApiFailure(422, '');
    expect(msg).toMatch(/Region, Branch, Department and Other/);
    expect(msg).toMatch(/already exists in Mango/);
  });

  it('says a failed sign-in is the account, not the ticket', () => {
    const msg = describeMangoAuthFailure(400, '{"message":"Username or password is incorrect"}');
    expect(msg).toMatch(/username and password/i);
    // An ordinary Mango login is not automatically an API login, and that
    // is the second thing to check when the password is definitely right.
    expect(msg).toMatch(/API access/);
    expect(msg).toContain('Username or password is incorrect');
    expect(describeMangoAuthFailure(0, '')).toMatch(/could not reach mango/i);
  });

  it("quotes Mango's own words so a rejected field can be found", () => {
    expect(describeImpwApiFailure(422, '{"error":"region is not a valid option"}')).toContain(
      'region is not a valid option',
    );
  });

  it('truncates a runaway error body instead of pasting a page into a toast', () => {
    const msg = describeImpwApiFailure(400, 'x'.repeat(5000));
    expect(msg.length).toBeLessThan(400);
  });
});

describe('impwPlainText', () => {
  it('labels the fields the way the web form does, for pasting in by hand', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const text = impwPlainText(buildImpwDraft(found, { name: 'CK' }, SITE));
    expect(text.startsWith('IMPW — Improvement Workflow')).toBe(true);
    expect(text).toContain('Brief Description *');
    expect(text).toContain('Type of Improvement *: Corrective Action');
    expect(text).toContain('Name *: CK');
    // The form takes dd/mm/yyyy even though the API takes ISO.
    expect(text).toContain('Date of occurrence *: 26/08/2026');
    expect(text).toContain('Coordinator *: Felicity Kidwell');
    expect(text).toContain('Region: QLD');
    expect(text).toContain('Branch: Wacol');
  });

  it('never leaks an id into text a person retypes', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const text = impwPlainText(buildImpwDraft(found, { name: 'CK' }, SITE));
    expect(text).not.toContain('toi-1');
    expect(text).not.toContain('co-1');
  });
});
