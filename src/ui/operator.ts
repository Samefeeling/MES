// The Operator sheet. Its parts live in ./operator/ — state, the shift's
// data, the markup, the dialogs — and this is the door the rest of the app
// (and the tests) come in by.

// Re-exported so existing importers (Trace view, tests) can keep pulling
// these from ./operator while the canonical definitions live in core.
export {
  hoursUnavailableFor,
  jobLeftPiecesFor,
  shiftTargetFor,
  SHIFT_TARGET_WARNING_RATIO,
  totalGoodExceedsShiftTarget,
} from '../core/targets';
export { loadSavedOperatorView, loadDeviceMachine } from './operator/state';
export { clampDispZoom, fitDispZoom } from './operator/zoom';
export {
  manualOrderDropdownVisible,
  operatorOrderStartVisible,
  operatorPlanningOrderVisible,
} from './operator/sheet';
export { rosterNames, otherShiftNames, initials, qcCellPresentation } from './operator/view';
export { renderOperator, operatorPollTick } from './operator/index';
