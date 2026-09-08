/**
 * Order-to-order material links from `JobMaterialReq.csv`, the second Epicor
 * BAQ export. This is what tells the board that a chair cannot be assembled
 * before its shell has been moulded and its cover sewn.
 *
 * Sample (headers abbreviated):
 *   JobMtl_JobNum   JobHead_PartNum   JobMtl_PartNum   JobMtl_RequiredQty
 *   ASM80010        PDSC-FA747        PDSC00747U       30
 *   ASM80010        PDSC-FA747        G11881000        30
 *
 * Read as: order ASM80010 builds part PDSC-FA747 and needs PDSC00747U and
 * G11881000 to do it. Turning those components into predecessor *orders* is
 * `engine/assembly/dependencies` — this file only reads the rows.
 *
 * Columns are matched by header name, as in `planning.parser`. The `JobHead_`
 * prefix is stripped during matching but `JobMtl_` is not, so the parent and
 * child part columns stay apart even though both end in `PartNum`.
 */

import { JobId, PartId } from '@/domain/ids';
import type { JobMaterialLink } from '@/domain/types';
import { mapHeaders, parseCsv, type CsvRow } from '@/lib/csv';
import type { ParseOutcome } from '@/data/excel/parsers/types';

type Field = 'jobNum' | 'parentPart' | 'childPart' | 'requiredQty';

/**
 * Accepted header spellings per field, most specific first.
 *
 * `childPart` has to be tried against its `JobMtl_` spelling before any bare
 * `PartNum`, or a tidied file would point both part fields at one column.
 */
const ALIASES: Record<Field, readonly string[]> = {
  jobNum: ['JobMtl_JobNum', 'MtlJobNum', 'JobNum', 'Job'],
  parentPart: ['JobHead_PartNum', 'ParentPart', 'AssemblyPart', 'PartNum'],
  childPart: [
    'JobMtl_PartNum',
    'MtlPartNum',
    'ComponentPart',
    'ChildPart',
    'MaterialPart',
  ],
  requiredQty: [
    'JobMtl_RequiredQty',
    'RequiredQty',
    'JobMtl_QtyPer',
    'QtyPer',
    'ReqQty',
  ],
};

const cell = (row: CsvRow, at: number | undefined): string =>
  at === undefined ? '' : (row[at] ?? '').trim();

const num = (v: string): number | null => {
  if (v === '') return null;
  const n = Number(v.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Parse the text of `JobMaterialReq.csv` into order-to-order material links. */
export function parseJobMaterialCsv(
  text: string,
): ParseOutcome<JobMaterialLink> {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { values: [], errors: ['JobMaterialReq.csv is empty'] };
  }

  const header = rows[0];
  const col = mapHeaders<Field>(header, ALIASES);

  // The component column is never matched by a bare `PartNum`: one part column
  // cannot say which end of a link it is, and guessing would invent
  // dependencies out of nothing. Better to say what is missing.
  const missing = (['jobNum', 'childPart'] as const).filter(
    (f) => col[f] === undefined,
  );
  if (missing.length > 0) {
    const wanted = { jobNum: 'JobMtl_JobNum', childPart: 'JobMtl_PartNum' };
    return {
      values: [],
      errors: [
        `JobMaterialReq.csv: no column for ${missing
          .map((f) => wanted[f])
          .join(' or ')}. Headers found: ${header.join(', ')}`,
      ],
    };
  }

  const errors: string[] = [];
  const values: JobMaterialLink[] = [];
  // One row per component is the norm, but a BAQ with an operation join
  // repeats them; the pair is all the dependency needs.
  const seen = new Set<string>();

  rows.slice(1).forEach((row, i) => {
    const jobNum = cell(row, col.jobNum);
    const childPart = cell(row, col.childPart);
    if (!jobNum && !childPart) return; // spacer / totals row
    if (!jobNum || !childPart) {
      errors.push(
        `JobMaterialReq.csv row ${i + 2}: needs both a job number and a ` +
          'component part',
      );
      return;
    }

    const key = `${jobNum} ${childPart}`;
    if (seen.has(key)) return;
    seen.add(key);

    values.push({
      jobNum: JobId(jobNum),
      // The parent part is a cross-check against the order export rather than
      // something the schedule needs, so a file without it still works.
      parentPart: PartId(cell(row, col.parentPart) || ''),
      childPart: PartId(childPart),
      requiredQty: num(cell(row, col.requiredQty)),
    });
  });

  if (values.length === 0) {
    errors.push('JobMaterialReq.csv held no usable material lines');
  }
  return { values, errors };
}
