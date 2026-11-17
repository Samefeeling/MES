/**
 * A press changeover is drawn on the order before it, with an arrow down to
 * the order it changes over to.
 */
import { describe, expect, it } from 'vitest';
import { changeArrowPath } from '@/features/assembly/DependencyArrows';
import { changeShortLabel } from '@/engine/assembly/pressPlan';
import type { PressChange } from '@/domain/types';

const box = (left: number, top: number, right: number, bottom: number) => ({ id: 'x', left, top, right, bottom });

describe('the arrow from a changeover to the next order', () => {
  it('drops straight down onto the next bar when it starts where the change ends', () => {
    // Change 100–110 on the row at 10–30; next bar from 110 on the row below.
    expect(changeArrowPath(box(100, 11, 110, 29), box(110, 42, 200, 60))).toBe('M 113 29 V 41');
  });

  it('drops to the next bar and runs into its start when the plan left a gap', () => {
    expect(changeArrowPath(box(100, 11, 110, 29), box(150, 42, 200, 60))).toBe('M 110 29 V 51 H 149');
  });

  it('lands on the bar even where it starts a hair before the change ends', () => {
    expect(changeArrowPath(box(100, 11, 120, 29), box(112, 42, 200, 60))).toBe('M 120 29 V 41');
  });

  it('draws nothing to an order that is not below it', () => {
    expect(changeArrowPath(box(100, 40, 110, 58), box(110, 10, 200, 28))).toBe('');
  });
});

describe('what a changeover says at the end of the bar', () => {
  const change = (over: Partial<PressChange>): PressChange => ({
    kind: 'die',
    hours: 4,
    fromJob: 'A',
    toJob: 'B',
    fromDie: '174',
    toDie: '296',
    fromColor: 'Dark grey',
    toColor: 'Black',
    ...over,
  });

  it('names the dies, the colours or the sizes either side', () => {
    expect(changeShortLabel(change({}))).toBe('Die 174 → Die 296');
    expect(changeShortLabel(change({ kind: 'colour' }))).toBe('Dark grey → Black');
    expect(changeShortLabel(change({ kind: 'insert', fromSize: '460h', toSize: 'size4' }))).toBe('460h → Size 4');
    expect(changeShortLabel(change({ kind: 'insert', fromSize: '380h|size3', toSize: null }))).toBe('380h Size 3 → no size');
  });

  it('says why it is a die change when neither die is known', () => {
    expect(changeShortLabel(change({ fromDie: null, toDie: null }))).toBe('die not on PMD_ProductDieColor');
    expect(changeShortLabel(change({ toDie: null }))).toBe('Die 174 → Die ?');
    expect(changeShortLabel(change({ kind: 'colour', fromColor: null, toColor: null }))).toBe('colour not on PMD_ProductDieColor');
  });
});
