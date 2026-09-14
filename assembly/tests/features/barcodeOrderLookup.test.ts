import { describe, expect, it } from 'vitest';
import { findBarcodeJobId } from '@/features/assembly/BarcodeOrderLookup';

describe('barcode order lookup', () => {
  const jobs = ['ASM8001', '018140-1-1'];

  it('matches scanner text case-insensitively', () => {
    expect(findBarcodeJobId('asm8001\r\n', jobs)).toBe('ASM8001');
  });

  it('accepts common labelled barcode payloads', () => {
    expect(findBarcodeJobId('JOB:018140-1-1', jobs)).toBe('018140-1-1');
    expect(findBarcodeJobId('ORDER=ASM8001;QTY=12', jobs)).toBe('ASM8001');
  });

  it('does not open a partial or unknown order', () => {
    expect(findBarcodeJobId('ASM800', jobs)).toBeNull();
    expect(findBarcodeJobId('', jobs)).toBeNull();
  });
});
