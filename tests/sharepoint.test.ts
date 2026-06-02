import { describe, it, expect } from 'vitest';
import {
  canSyncPlanning,
  parsePlanningCsv,
  SharePointDataLayer,
  toServerRelativePath,
} from '../src/dal/sharepoint';
import { MemoryDataLayer } from '../src/dal/memory';

describe('SharePoint DAL surface', () => {
  it('canSyncPlanning duck-typed gate', () => {
    const sp = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/foo',
    });
    expect(canSyncPlanning(sp)).toBe(true);
    expect(canSyncPlanning(new MemoryDataLayer(new Date(2026, 0, 1)))).toBe(false);
  });

  it('accepts the string siteUrl shorthand for backwards compat', () => {
    const sp = new SharePointDataLayer('https://example.sharepoint.com/sites/foo');
    expect(sp).toBeInstanceOf(SharePointDataLayer);
  });

  it('syncPlanningFromExcel fails fast when graphToken is not configured', async () => {
    const sp = new SharePointDataLayer({
      siteUrl: 'https://example.sharepoint.com/sites/foo',
    });
    await expect(sp.syncPlanningFromExcel()).rejects.toThrow(/graphToken/);
  });
});

describe('parsePlanningCsv', () => {
  it('parses headers + rows with the expected Epicor column names', () => {
    const csv =
      'JobHead_JobNum,JobHead_PartNum,JobHead_PartDescription,Calculated_RemainingQty,JobHead_StartDate,JobHead_ReqDueDate,Calculated_RemaingLaborHrs,JobOper_ProdStandard\n' +
      'J100,P1,"Widget, large",250,2026-06-02T07:00:00,2026-06-05T15:00:00,8.5,30\n' +
      'J101,P2,Bolt,0,,,0,0\n';
    const out = parsePlanningCsv(csv);
    expect(out).toHaveLength(2);
    expect(out[0].jobNumber).toBe('J100');
    expect(out[0].partNumber).toBe('P1');
    expect(out[0].partDescription).toBe('Widget, large');
    expect(out[0].jobRequired).toBe(250);
    expect(out[0].duration).toBe(8.5);
    expect(out[0].qtyPerHr).toBe(30);
    expect(out[0].plannedStart).not.toBe('');
    expect(out[1].jobNumber).toBe('J101');
    expect(out[1].plannedStart).toBe('');
  });

  it('skips empty rows and ignores a UTF-8 BOM', () => {
    const csv = '﻿JobHead_JobNum,JobHead_PartNum\n\nJ200,P9\n';
    const out = parsePlanningCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0].jobNumber).toBe('J200');
    expect(out[0].partNumber).toBe('P9');
  });

  it('handles AU date format from PS default culture', () => {
    const csv =
      'JobHead_JobNum,JobHead_StartDate,JobHead_ReqDueDate,Calculated_RemaingLaborHrs\n' +
      'J300,02/06/2026 7:00 am,05/06/2026 3:00 pm,4\n';
    const out = parsePlanningCsv(csv);
    expect(out[0].jobNumber).toBe('J300');
    // Parsed as local 2026-06-02 07:00 → ISO with local offset
    expect(out[0].plannedStart).toMatch(/2026-06-0[12]T/);
  });
});

describe('toServerRelativePath', () => {
  it('passes a clean server-relative path through unchanged', () => {
    expect(toServerRelativePath('/sites/X/Shared Documents/A.csv')).toBe(
      '/sites/X/Shared Documents/A.csv',
    );
  });
  it('decodes %20 to spaces', () => {
    expect(
      toServerRelativePath('/sites/X/Shared%20Documents/General/Data/A.csv'),
    ).toBe('/sites/X/Shared Documents/General/Data/A.csv');
  });
  it('extracts the path from a full https URL', () => {
    expect(
      toServerRelativePath(
        'https://tenant.sharepoint.com/sites/X/Shared%20Documents/A.csv',
      ),
    ).toBe('/sites/X/Shared Documents/A.csv');
  });
  it('strips query strings (e.g. ?d=… from SP web links)', () => {
    expect(
      toServerRelativePath(
        'https://tenant.sharepoint.com/sites/X/Shared%20Documents/A.csv?d=abc',
      ),
    ).toBe('/sites/X/Shared Documents/A.csv');
  });
  it('adds a leading slash if missing', () => {
    expect(toServerRelativePath('sites/X/Y.csv')).toBe('/sites/X/Y.csv');
  });
  it('returns empty when given empty', () => {
    expect(toServerRelativePath('')).toBe('');
    expect(toServerRelativePath('   ')).toBe('');
  });
});
