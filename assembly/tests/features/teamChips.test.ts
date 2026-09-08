import { describe, expect, it } from 'vitest';
import { crewPickerStatus } from '@/features/assembly/TeamChips';

describe('employee picker status', () => {
  it('shows a safe leading gap and the next order on separate lines', () => {
    expect(
      crewPickerStatus(
        {
          fromDay: '2026-09-02',
          toDayExclusive: '2026-09-03',
          nextJobIds: ['ASM8001'],
        },
        ['ASM8001'],
        'Upholsterer',
      ),
    ).toEqual({
      primary: 'Free to 15:30 2/9',
      secondary: 'Then ASM8001',
      tone: 'free',
    });
  });

  it('shows an immediate commitment as busy', () => {
    expect(crewPickerStatus(null, ['ASM8005'], 'Assembler')).toEqual({
      primary: 'On ASM8005',
      secondary: null,
      tone: 'busy',
    });
  });

  it('shows when the employee is free for the full order', () => {
    expect(
      crewPickerStatus(
        {
          fromDay: '2026-09-02',
          toDayExclusive: null,
          nextJobIds: [],
        },
        [],
        'Sewer',
      ),
    ).toEqual({
      primary: 'Free for full order',
      secondary: 'Sewer',
      tone: 'free',
    });
  });
});
