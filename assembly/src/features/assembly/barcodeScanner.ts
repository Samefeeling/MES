/** Recognize a keyboard-wedge scanner burst without treating normal typing as a scan. */
export function createBarcodeBuffer(onScan: (value: string) => void) {
  let value = '';
  let lastAt = 0;
  const reset = () => { value = ''; lastAt = 0; };
  return {
    reset,
    push(key: string, at: number, blocked = false): boolean {
      if (blocked) { reset(); return false; }
      if (value && (at - lastAt > 80 || at < lastAt)) reset();
      if (key === 'Enter' || key === 'Tab') {
        const scan = value;
        reset();
        if (scan.length < 3) return false;
        onScan(scan);
        return true;
      }
      // Shift is emitted by scanners when typing uppercase letters.
      if (key === 'Shift') return false;
      if (key.length !== 1 || value.length >= 256) {
        reset();
        return false;
      }
      value += key;
      lastAt = at;
      return false;
    },
  };
}
