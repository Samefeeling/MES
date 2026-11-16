// The SharePoint data layer. Its parts live in ./sharepoint/ — the schema, the
// wire, reading cells and rows, the CSV extracts — and this is the door the
// rest of the app (and the tests) come in by.

// Used by trace view bd label fallback (re-exported so consumers don't
// have to dig into ../core/breakdown directly when working with codes
// surfaced from SharePoint).
export { bdLabelFor } from '../core/breakdown';
export type { SharePointFieldMap, PartialFieldMap, SharePointOptions } from './sharepoint/schema';
export { SharePointDataLayer } from './sharepoint/data-layer';
export { throttleWaitMs, fetchThroughThrottle, toServerRelativePath } from './sharepoint/http';
export {
  odataString,
  spDay,
  machineCell,
  type SiteZone,
  readSiteZone,
  readCalendarDay,
  dateOnly,
  sharePointDateTimeIso,
} from './sharepoint/values';
export {
  LIVE_STALE_GRACE_MS,
  LIVE_HARD_CAP_MS,
  shiftEndedLongAgo,
  isStaleLiveHeader,
  sanitizeBodyStrings,
} from './sharepoint/rows';
export { parsePlanningCsv, decimalHoursToHms } from './sharepoint/csv';
export { parseMangoWorkOrdersCsv, parseMangoMachineWorkOrdersCsv, parseMachinePmCsv } from './sharepoint/mango';
export { DEFAULT_ASSEMBLY_FIELDS, createAssemblyDataLayer } from './sharepoint/assembly';
