/** Common return shape for a lenient parser: kept rows + per-row complaints. */
export interface ParseOutcome<T> {
  values: T[];
  errors: string[];
}
