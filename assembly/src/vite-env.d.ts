/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: 'mock' | 'planning-csv' | 'excel';
  readonly VITE_SHAREPOINT_SITE_URL?: string;
  readonly VITE_SHAREPOINT_FILE_PATH?: string;
  readonly VITE_GRAPH_TOKEN?: string;
  readonly VITE_PERSIST_API_URL?: string;
  readonly VITE_REFRESH_INTERVAL_MINUTES?: string;
  /** The order export — a plain URL, else a path in the SharePoint drive. */
  readonly VITE_PLANNING_CSV_URL?: string;
  readonly VITE_PLANNING_CSV_PATH?: string;
  /** The material-link export, which carries the dependency chain. */
  readonly VITE_JOB_MATERIAL_CSV_URL?: string;
  readonly VITE_JOB_MATERIAL_CSV_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
