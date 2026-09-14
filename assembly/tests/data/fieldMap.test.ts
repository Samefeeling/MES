import { describe, it, expect } from 'vitest';
import { readableFields, writableFields } from '@/data/sharepoint/fieldMap';
import { parseOperators } from '@/data/sharepoint/operator.parser';

describe('imported SharePoint columns', () => {
  const fields = [
    { Title: 'Title', InternalName: 'Title' },
    { Title: 'PreferName', InternalName: 'field_1' },
    { Title: 'Skills', InternalName: 'field_2' },
    { Title: 'Date', InternalName: 'field_3' },
  ];
  it('reads preferred names and skills while preserving the employee ID', () => {
    const row = readableFields({ id: '17', Title: 'Full Legal Name', field_1: 'Tom', field_2: { results: ['UPL-CUT', 'Table'] } }, fields);
    const result = parseOperators([row]);
    expect(result.errors).toEqual([]);
    expect(result.values[0]).toMatchObject({ id: '17', name: 'Tom', skills: ['UPL_CUT_SEW', 'TABLE'] });
  });
  it('falls back to Title for an empty preferred name', () => {
    expect(parseOperators([{ id: '17', PreferName: ' ', Title: 'Tom' }]).values[0]?.name).toBe('Tom');
  });
  it('writes dates to the real internal column without dropping data', () => {
    expect(writableFields({ Title: 'SFM1', Date: '2026-09-10' }, fields)).toEqual({ Title: 'SFM1', field_3: '2026-09-10' });
  });
  it('rejects a missing or ambiguous field rather than sending a partial write', () => {
    expect(() => writableFields({ StartDate: '2026-09-10' }, fields)).toThrow('Missing');
    expect(() => writableFields({ Date: '2026-09-10' }, [...fields, { Title: 'Date', InternalName: 'field_4' }])).toThrow('Ambiguous');
  });
  it('does not replace an existing internal field with a display alias', () => {
    expect(readableFields({ Title: 'Full Name', field_1: 'Tom' }, [{ Title: 'Title', InternalName: 'field_1' }]).Title).toBe('Full Name');
  });
});
