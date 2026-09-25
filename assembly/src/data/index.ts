/**
 * Composition root for the data layer: pick a source from configuration.
 *   VITE_DATA_SOURCE = "mock" (default) | "planning-csv"
 */

import type { DataSource } from './DataSource';
import { MockSource } from './mock/MockSource';
import { PlanningCsvSource } from './csv/PlanningCsvSource';

export type DataSourceKind = 'mock' | 'planning-csv';

export function createDataSource(
  kind: DataSourceKind = (import.meta.env.VITE_DATA_SOURCE as DataSourceKind) ??
    (import.meta.env.VITE_BACKEND === 'sharepoint' || import.meta.env.VITE_SHAREPOINT_SITE_URL ? 'planning-csv' : 'mock'),
): DataSource {
  switch (kind) {
    case 'planning-csv':
      return new PlanningCsvSource();
    case 'mock':
    default:
      return new MockSource();
  }
}

export type { DataSource } from './DataSource';
