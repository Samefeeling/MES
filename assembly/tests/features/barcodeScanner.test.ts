import { describe, expect, it } from 'vitest';
import { createBarcodeBuffer } from '@/features/assembly/barcodeScanner';

describe('page-wide barcode scanning', () => {
  const burst = (buffer: ReturnType<typeof createBarcodeBuffer>, value: string, start = 0, gap = 10) => {
    [...value].forEach((key, index) => buffer.push(key, start + index * gap));
    return start + value.length * gap;
  };
  it.each(['Enter', 'Tab'])('accepts a fast scan with %s and clears the buffer', (suffix) => {
    const seen: string[] = [];
    const buffer = createBarcodeBuffer((value) => seen.push(value));
    expect(buffer.push(suffix, burst(buffer, '018140-1-1'))).toBe(true);
    expect(buffer.push(suffix, 120)).toBe(false);
    expect(seen).toEqual(['018140-1-1']);
  });
  it('does not open an order from ordinary slow typing', () => {
    const seen: string[] = [];
    const buffer = createBarcodeBuffer((value) => seen.push(value));
    expect(buffer.push('Enter', burst(buffer, 'ASM8001', 0, 150))).toBe(false);
    expect(seen).toEqual([]);
  });
  it('ignores editing, composition, shortcuts and other blocked input', () => {
    const seen: string[] = [];
    const buffer = createBarcodeBuffer((value) => seen.push(value));
    burst(buffer, 'ASM8001');
    expect(buffer.push('Enter', 80, true)).toBe(false);
    expect(buffer.push('Enter', 90)).toBe(false);
    expect(seen).toEqual([]);
  });
  it('clears incomplete scans on focus loss and does not combine consecutive scans', () => {
    const seen: string[] = [];
    const buffer = createBarcodeBuffer((value) => seen.push(value));
    burst(buffer, 'OLD');
    buffer.reset();
    buffer.push('Enter', 40);
    buffer.push('Enter', burst(buffer, 'ASM8001', 100));
    buffer.push('Enter', burst(buffer, 'ASM8002', 200));
    expect(seen).toEqual(['ASM8001', 'ASM8002']);
  });
  it('rejects a delayed suffix and tolerates Shift', () => {
    const seen: string[] = [];
    const buffer = createBarcodeBuffer((value) => seen.push(value));
    burst(buffer, 'OLD');
    expect(buffer.push('Enter', 500)).toBe(false);
    buffer.push('Shift', 600);
    buffer.push('Enter', burst(buffer, 'NEW', 610));
    expect(seen).toEqual(['NEW']);
  });
});
