import type { AppSnapshot, ConnectionInput, DdlResult, QueryResult } from '@/lib/types';

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === 'undefined') {
    throw new Error('Tauri commands are only available in the desktop app runtime.');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export const tauriApi = {
  bootstrap: () => invokeCommand<AppSnapshot>('bootstrap'),
  connect: (connection: ConnectionInput, save: boolean) =>
    invokeCommand<AppSnapshot>('connect', { connection, save }),
  activateSavedConnection: (id: string) =>
    invokeCommand<AppSnapshot>('activate_saved_connection', { id }),
  deleteSavedConnection: (id: string) =>
    invokeCommand<AppSnapshot>('delete_saved_connection', { id }),
  disconnect: () => invokeCommand<AppSnapshot>('disconnect'),
  runQuery: (sql: string, limit = 500) =>
    invokeCommand<QueryResult>('run_query', { sql, limit }),
  previewTable: (schema: string, table: string, limit = 200, offset = 0) =>
    invokeCommand<QueryResult>('preview_table', { schema, table, limit, offset }),
  getTableDdl: (schema: string, table: string) =>
    invokeCommand<DdlResult>('get_table_ddl', { schema, table }),
  exportParquet: (schema: string, table: string, path: string) =>
    invokeCommand<number>('export_parquet', { schema, table, path }),
};
