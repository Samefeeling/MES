import { describe, expect, it } from 'vitest';
import { formatDay, formatShortDay, fromDayKey } from '@/lib/time';

describe('Australian display dates', () => {
  it.each([
    ['2026-09-07', '07/09/2026', '07/09'],
    ['2026-02-03', '03/02/2026', '03/02'],
    ['2028-02-29', '29/02/2028', '29/02'],
    ['2026-12-31', '31/12/2026', '31/12'],
  ])('keeps local calendar day and day/month order for %s', (key, full, short) => {
    const date = fromDayKey(key);
    expect(formatDay(date)).toBe(full);
    expect(formatShortDay(date)).toBe(short);
  });
});
