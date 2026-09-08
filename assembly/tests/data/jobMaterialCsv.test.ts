/**
 * The `JobMaterialReq.csv` adapter — the export that says what each order
 * consumes, and so which orders have to wait for which.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { parseJobMaterialCsv } from '@/data/csv/materialReq.parser';

const sample = readFileSync(
  fileURLToPath(new URL('../fixtures/jobMaterialReq.sample.csv', import.meta.url)),
  'utf8',
);

const HEAD = 'JobMtl_JobNum,JobHead_PartNum,JobMtl_PartNum';

describe('parseJobMaterialCsv', () => {
  it('reads the consuming order, its part and the component', () => {
    const { values, errors } = parseJobMaterialCsv(sample);

    expect(errors).toEqual([]);
    expect(values).toHaveLength(5);
    expect(values[0]).toMatchObject({
      jobNum: '018140-1-1',
      parentPart: 'CSSL01436',
      childPart: 'V11694',
      requiredQty: 30,
    });
  });

  it('keeps the two PartNum columns apart', () => {
    // Both end in `PartNum`, and header matching strips the `JobHead_`
    // prefix — the parent must not end up pointing at the component column.
    const { values } = parseJobMaterialCsv(sample);
    for (const link of values) {
      expect(String(link.parentPart)).not.toBe(String(link.childPart));
    }
  });

  it('reads a hand-tidied file with plain column names', () => {
    const { values, errors } = parseJobMaterialCsv(
      'JobNum,PartNum,MtlPartNum,QtyPer\nASM1,CHAIR,SHELL,2\n',
    );
    expect(errors).toEqual([]);
    expect(values[0]).toMatchObject({
      jobNum: 'ASM1',
      parentPart: 'CHAIR',
      childPart: 'SHELL',
      requiredQty: 2,
    });
  });

  it('works without the parent part column at all', () => {
    const { values, errors } = parseJobMaterialCsv(
      'JobMtl_JobNum,JobMtl_PartNum\nASM1,SHELL\n',
    );
    expect(errors).toEqual([]);
    expect(String(values[0].childPart)).toBe('SHELL');
    expect(String(values[0].parentPart)).toBe('');
  });

  it('refuses a file with only one part column', () => {
    // A bare `PartNum` cannot say which end of the link it is, so it is never
    // taken for the component — guessing would invent dependencies.
    const { values, errors } = parseJobMaterialCsv('JobNum,PartNum\nASM1,SHELL\n');
    expect(values).toEqual([]);
    expect(errors[0]).toMatch(/JobMtl_PartNum/);
  });

  it('names the column it wanted when one is absent', () => {
    const { values, errors } = parseJobMaterialCsv('PartNum,MtlPartNum\nA,B\n');
    expect(values).toEqual([]);
    expect(errors[0]).toMatch(/JobMtl_JobNum/);
    expect(errors[0]).toMatch(/Headers found/);
  });

  it('collapses a pair repeated by an operation join', () => {
    const { values } = parseJobMaterialCsv(
      `${HEAD}\nASM1,CHAIR,SHELL\nASM1,CHAIR,SHELL\nASM1,CHAIR,COVER\n`,
    );
    expect(values.map((v) => String(v.childPart))).toEqual(['SHELL', 'COVER']);
  });

  it('skips a spacer row but reports a half-filled one', () => {
    const { values, errors } = parseJobMaterialCsv(
      `${HEAD}\nASM1,CHAIR,SHELL\n,,\nASM2,CHAIR,\n`,
    );
    expect(values).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/row 4/);
  });

  it('leaves the quantity null when the export has no such column', () => {
    const { values } = parseJobMaterialCsv(`${HEAD}\nASM1,CHAIR,SHELL\n`);
    expect(values[0].requiredQty).toBeNull();
  });

  it('says so when the file is empty or holds no usable rows', () => {
    expect(parseJobMaterialCsv('').errors[0]).toMatch(/empty/);
    expect(parseJobMaterialCsv(`${HEAD}\n`).errors[0]).toMatch(/no usable/);
  });
});
