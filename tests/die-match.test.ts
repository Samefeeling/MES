import { describe, expect, it } from 'vitest';
import { descriptionStem, isHotStampPart, matchNewParts } from '../src/core/die-match';
import type { ProductDieColor } from '../src/types';

const row = (partNumber: string, dieNumber: string, name = '', hex = '', extra: Partial<ProductDieColor> = {}): ProductDieColor => ({
  partNumber,
  dieNumber,
  name,
  hex,
  category: 'Seating',
  die: `${dieNumber} tool`,
  coRun: true,
  ...extra,
});

const known = [
  row('VB-NAVY', 'D-247', 'Navy', '#1e3a8a'),
  row('VB-GG', 'D-247', 'Grey Green', '#6b8e7f'),
  row('VA-NAVY', 'D-300', 'Navy', '#1e3a8a', { category: 'Arms' }),
  row('VS-RED', 'D-410', 'Red', '#b91c1c'),
  row('VS2-RED', 'D-411', 'Red', '#b91c1c'),
  row('NODESC', 'D-500', 'Blue'),
];
const desc = new Map([
  ['VB-NAVY', 'Viva Backrest Navy'],
  ['VB-GG', 'Viva Backrest Grey Green'],
  ['VA-NAVY', 'Viva Armrest Navy'],
  ['VS-RED', 'Viva Seat Red'],
  ['VS2-RED', 'Viva Seat Red'],
]);

describe('a new part onto its die by description', () => {
  it('takes off the colour — a known one whole, else the last word', () => {
    const colours = [['GREY', 'GREEN'], ['NAVY']];
    expect(descriptionStem('Viva Backrest Grey Green', colours)).toEqual({ stem: 'VIVA BACKREST', colour: ['GREY', 'GREEN'] });
    expect(descriptionStem('Viva Backrest Charcoal', colours)).toEqual({ stem: 'VIVA BACKREST', colour: ['CHARCOAL'] });
    // Too little left to say which tool it is.
    expect(descriptionStem('Lid Black', colours)).toBeNull();
  });

  it('places a new colour on the die its siblings run on', () => {
    const { matches, misses } = matchNewParts(
      [{ partNumber: 'VB-CHAR', description: 'Viva Backrest Charcoal' }, { partNumber: 'VB-GG2', description: 'VIVA BACKREST grey green' }],
      known,
      desc,
    );
    expect(misses).toEqual([]);
    expect(matches[0]).toMatchObject({
      partNumber: 'VB-CHAR',
      dieNumber: 'D-247',
      die: 'D-247 tool',
      category: 'Seating',
      name: 'Charcoal',
      hex: '',
      coRun: false,
    });
    expect(matches[0].siblings.sort()).toEqual(['VB-GG', 'VB-NAVY']);
    // A colour the list knows keeps its name and its hex.
    expect(matches[1]).toMatchObject({ dieNumber: 'D-247', name: 'Grey Green', hex: '#6b8e7f' });
  });

  it('does not guess between dies, or without a likeness', () => {
    const { matches, misses } = matchNewParts(
      [
        { partNumber: 'VS-BLK', description: 'Viva Seat Black' },
        { partNumber: 'TBL-BLK', description: 'Table Top Black' },
        { partNumber: 'X', description: '' },
        { partNumber: 'NEW-BLUE', description: 'Mystery Part Blue' },
      ],
      known,
      desc,
    );
    expect(matches).toEqual([]);
    expect(misses).toEqual([
      { partNumber: 'VS-BLK', description: 'Viva Seat Black', reason: 'several-dies', dies: ['D-410', 'D-411'] },
      { partNumber: 'TBL-BLK', description: 'Table Top Black', reason: 'no-similar', dies: [] },
      { partNumber: 'X', description: '', reason: 'no-description', dies: [] },
      // NODESC has no description anywhere, so nothing is like it.
      { partNumber: 'NEW-BLUE', description: 'Mystery Part Blue', reason: 'no-similar', dies: [] },
    ]);
  });

  it('knows a hot-stamped chair by its description', () => {
    expect(isHotStampPart('Postura Plus Linking Chair - 460h - Blue\n\nHot Stamp: Back of Backrest\nStamp Foil Colour: White')).toBe(true);
    expect(isHotStampPart('Hot Stamp for Postura Plus Sled Stool - Warm Grey frame - 750h - Blue')).toBe(true);
    expect(isHotStampPart('HOTSTAMP Postura Max Chair')).toBe(true);
    expect(isHotStampPart('Postura Max Chair - recycled plastics - Size 3 - 350h - Slate')).toBe(false);
    expect(isHotStampPart('Stamped Bracket Black')).toBe(false);
  });

  it('keeps arms and backs apart', () => {
    const { matches } = matchNewParts([{ partNumber: 'VA-RED', description: 'Viva Armrest Red' }], known, desc);
    expect(matches[0]).toMatchObject({ dieNumber: 'D-300', category: 'Arms', hex: '#b91c1c', name: 'Red' });
  });
});

describe('the new-part check against the memory DAL', async () => {
  const { MemoryDataLayer } = await import('../src/dal/memory');
  const { syncNewPartDies } = await import('../src/ui/die-sync');

  const setup = async () => {
    const dal = new MemoryDataLayer();
    const planning = (dal as unknown as { planning: import('../src/types').PlanningOrder[] }).planning;
    const colours = await dal.listProductDieColors();
    // A registered part with a die, and a description Planning.csv gives it.
    const sibling = planning.find(
      (o) => o.partDescription.trim().split(/\s+/).length >= 3 && colours.some((c) => c.partNumber === o.partNumber && c.dieNumber),
    )!;
    const die = colours.find((c) => c.partNumber === sibling.partNumber)!.dieNumber;
    const stem = sibling.partDescription.trim().split(/\s+/).slice(0, -1).join(' ');
    planning.push({ ...sibling, id: 9999, jobNumber: 'SFM999999', partNumber: 'NEW-PART-1', partDescription: `${stem} Charcoal` });
    planning.push({ ...sibling, id: 9998, jobNumber: 'SFM999998', partNumber: 'NEW-PART-2', partDescription: 'Nothing Like Anything Teal' });
    // Its siblings' description, hot-stamped: it would match the die, but has none of its own.
    planning.push({ ...sibling, id: 9997, jobNumber: 'SFM999997', partNumber: 'NEW-PART-HS', partDescription: `${stem} Charcoal\n\nHot Stamp: Back of Backrest` });
    return { dal, die };
  };

  it('adds what it can place, once, and lists the rest', async () => {
    const { dal, die } = await setup();
    const first = await syncNewPartDies(dal, { write: true });
    expect(first.added.map((m) => [m.partNumber, m.dieNumber])).toEqual([['NEW-PART-1', die]]);
    expect(first.misses.map((m) => m.partNumber)).toContain('NEW-PART-2');
    // A hot-stamped chair is neither added nor listed for a supervisor.
    expect(first.misses.map((m) => m.partNumber)).not.toContain('NEW-PART-HS');
    expect((await dal.listProductDieColors()).some((c) => c.partNumber === 'NEW-PART-HS')).toBe(false);
    expect((await dal.listProductDieColors()).find((c) => c.partNumber === 'NEW-PART-1')).toMatchObject({ dieNumber: die, name: 'Charcoal' });
    const again = await syncNewPartDies(dal, { write: true });
    expect(again.added).toEqual([]);
  });

  it('only lists them on a device that does not write', async () => {
    const { dal } = await setup();
    const r = await syncNewPartDies(dal, { write: false });
    expect(r.added).toEqual([]);
    expect(r.pending.map((m) => m.partNumber)).toEqual(['NEW-PART-1']);
    expect((await dal.listProductDieColors()).some((c) => c.partNumber === 'NEW-PART-1')).toBe(false);
  });
});
