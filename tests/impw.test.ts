import { describe, expect, it } from 'vitest';
import {
  buildImpwDraft,
  detectImpwFindings,
  foldBreakdowns,
  impwDepartmentOf,
  impwDraftIssues,
  impwFindingKey,
  impwOccurrenceDate,
  impwPlainText,
  missingImpwFields,
  overlongImpwFields,
  suggestImpwDepartment,
  yieldPctOf,
  EMPTY_IMPW_SITE,
  IMPW_REQUIRED,
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

const SITE: ImpwSiteConfig = {
  typeOfImprovement: 'Corrective Action',
  source: 'Internal',
  type: 'Production',
  region: 'QLD',
  branch: 'Wacol',
  other: 'Precision Moulding',
  email: 'plant@example.com',
  phone: '',
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
    const d = buildImpwDraft(finding({ breakdownHrs: 2 }), raiser, EMPTY_IMPW_SITE);
    expect(missingImpwFields(d)).toEqual([
      'Type of Improvement',
      'Source',
      'Type',
      'Region',
      'Branch',
      'Other',
    ]);
  });

  it('takes Coordinator from the signed-in user and flags a missing one', () => {
    expect(buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).coordinator).toBe(
      'Christopher King',
    );
    const anon = buildImpwDraft(finding({ breakdownHrs: 1 }), { name: '' }, SITE);
    expect(missingImpwFields(anon)).toContain('Coordinator');
  });

  it("prefers the site's own contact address over the raiser's", () => {
    expect(buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).email).toBe(
      'plant@example.com',
    );
    expect(
      buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, { ...SITE, email: '' }).email,
    ).toBe('ck@example.com');
  });

  it('dates the ticket from the shift', () => {
    expect(buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).dateOfOccurrence).toBe(
      '26/08/2026',
    );
  });

  it('leads Brief Description with the press — Mango lists tickets by it', () => {
    const d = buildImpwDraft(finding({ output: 900, reject: 100, yieldPct: 90 }), raiser, SITE);
    expect(d.briefDescription.startsWith('1600T Night shift 26/08/2026 — ')).toBe(true);
    expect(d.briefDescription).toContain('Yield 90%');
  });

  it('keeps Brief Description inside Mango’s 256-character cap', () => {
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
    expect(d.briefDescription.length).toBeLessThanOrEqual(256);
    expect(overlongImpwFields(d)).toEqual([]);
  });

  it('reduces a taxonomy owner to one Mango department', () => {
    // "Operator → Maintenance" is an escalation path and "Maintenance /
    // Setter" a shared job; Mango's Department is one pick from a list.
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

  it('names the press as Plant/Equipment the way Mango lists it', () => {
    expect(buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE).plantEquipment).toBe(
      '1600T — Injection 1600T',
    );
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
    expect(d.details).toContain('Operator: Drive tripped on start, 3rd time this week');
  });

  it('points Related documents back at the shift it came from', () => {
    const d = buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE);
    expect(d.relatedDocuments).toBe('PMD Dashboard KPI — 2026-08-26-Night — 1600T');
  });

  it('writes a body that stands on its own away from the dashboard', () => {
    const d = buildImpwDraft(
      finding({ output: 900, reject: 100, yieldPct: 90, breakdownHrs: 1.5 }),
      raiser,
      SITE,
    );
    expect(d.details).toContain('1600T');
    expect(d.details).toContain('2026-08-26-Night');
    expect(d.details).toContain('SFM507205');
    expect(d.details).toContain('900 pcs');
    expect(d.details).toContain('100 pcs');
    expect(d.details).toContain('90%');
    expect(d.details).toContain('1.5 h');
  });

  it('leaves every tick-box unticked for the coordinator to answer', () => {
    const d = buildImpwDraft(finding({ breakdownHrs: 1 }), raiser, SITE);
    expect([
      d.sendCopyToCustomer,
      d.authoritiesNotified,
      d.customerNotified,
      d.proceduresReviewed,
      d.processToBeChanged,
      d.trainingReviewed,
    ]).toEqual([false, false, false, false, false, false]);
  });
});

describe('IMPW validation', () => {
  it('covers exactly the fields Mango stars', () => {
    expect(IMPW_REQUIRED.map((f) => f.label)).toEqual([
      'Brief Description',
      'Type of Improvement',
      'Source',
      'Date of occurrence',
      'Details of Improvement and/or Proposed Action',
      'Type',
      'Region',
      'Branch',
      'Department',
      'Other',
      'Coordinator',
    ]);
  });

  it('treats whitespace as blank', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const d = buildImpwDraft(found, { name: '   ' }, SITE);
    expect(missingImpwFields(d)).toEqual(['Coordinator']);
  });

  it('reports an over-long capped field', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const d = { ...buildImpwDraft(found, { name: 'A' }, SITE), email: 'x'.repeat(300) };
    expect(overlongImpwFields(d)).toEqual(['Email (max 256)']);
    expect(impwDraftIssues(d)).toEqual(['Too long: Email (max 256)']);
  });
});

describe('impwPlainText', () => {
  it('labels every field the way Mango does and stars the required ones', () => {
    const found = detectImpwFindings([slice({ breakdownHrs: 1 })], RULES)[0];
    const text = impwPlainText(buildImpwDraft(found, { name: 'CK' }, SITE));
    expect(text.startsWith('IMPW — Improvement Workflow')).toBe(true);
    for (const f of IMPW_REQUIRED) expect(text).toContain(`${f.label} *`);
    expect(text).toContain('Plant/Equipment involved: 1600T — Injection 1600T');
    expect(text).toContain('Send copy to customer: No');
  });
});
