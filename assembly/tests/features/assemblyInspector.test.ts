import { describe, expect, it } from 'vitest';
import { popupDate } from '@/features/assembly/AssemblyInspector';

describe('order popup date format', () => {
  it('uses fixed dd/mm/yyyy formatting', () => {
    expect(popupDate(new Date(2026, 8, 7))).toBe('07/09/2026');
    expect(popupDate(null)).toBe('—');
  });
});
