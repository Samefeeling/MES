import { describe, expect, it } from 'vitest';

import { parseHandover } from '../src/core/handover';

describe('parseHandover (4M)', () => {
  it('returns the 4M shape for an empty / missing note', () => {
    expect(parseHandover('')).toEqual({
      machine: '',
      mold: '',
      material: '',
      method: '',
    });
    expect(parseHandover(null)).toEqual({
      machine: '',
      mold: '',
      material: '',
      method: '',
    });
  });

  it('parses the canonical JSON shape', () => {
    const json = JSON.stringify({
      machine: 'gate worn',
      mold: 'slide #2 sticky',
      material: 'lot 4477',
      method: 'cycle +0.3s',
    });
    expect(parseHandover(json)).toEqual({
      machine: 'gate worn',
      mold: 'slide #2 sticky',
      material: 'lot 4477',
      method: 'cycle +0.3s',
    });
  });

  it('discards legacy people/plant keys from pre-4M rows', () => {
    // Before the 4M rename the JSON had {people,plant,machine,material}.
    // The new parser must not let those legacy keys leak into the
    // operator UI (there is no slot for them) and must default the new
    // mold/method fields to empty.
    const legacy = JSON.stringify({
      people: 'Joe off sick',
      plant: 'air dryer noisy',
      machine: 'press OK',
      material: 'PA66 lot 9',
    });
    const h = parseHandover(legacy);
    expect(h).toEqual({
      machine: 'press OK',
      mold: '',
      material: 'PA66 lot 9',
      method: '',
    });
    expect(Object.keys(h).sort()).toEqual([
      'machine',
      'material',
      'method',
      'mold',
    ]);
  });

  it('parses the labelled-text shape (Machine: …\\nMold: …)', () => {
    const txt = 'Machine: press OK\nMold: slide sticky\nMaterial: lot 9\nMethod: cycle +0.3s';
    expect(parseHandover(txt)).toEqual({
      machine: 'press OK',
      mold: 'slide sticky',
      material: 'lot 9',
      method: 'cycle +0.3s',
    });
  });

  it('falls back to Method for free-form plain text so nothing is lost', () => {
    expect(parseHandover('Check robot grip on day shift')).toEqual({
      machine: '',
      mold: '',
      material: '',
      method: 'Check robot grip on day shift',
    });
  });
});
