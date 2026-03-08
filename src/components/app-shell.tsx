'use client';

import type { PropsWithChildren, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { isTauriRuntime, tauriApi } from '@/lib/tauri';
import type {
  ActiveConnectionSummary,
  AppSnapshot,
  ConnectionInput,
  QueryResult,
  SafeSavedConnection,
  SchemaNode,
  TableNode,
} from '@/lib/types';

const EMPTY_CONNECTION: ConnectionInput = {
  name: '',
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'postgres',
};

const QUERY_PRESETS = [
  {
    label: 'Session',
    sql: 'select current_database(), current_user, now();',
  },
  {
    label: 'Tables',
    sql: "select table_schema, table_name\nfrom information_schema.tables\nwhere table_schema not in ('pg_catalog', 'information_schema')\norder by 1, 2\nlimit 200;",
  },
  {
    label: 'Activity',
    sql: 'select pid, usename, state, query\nfrom pg_stat_activity\norder by backend_start desc\nlimit 50;',
  },
];

interface QueryHistoryEntry {
  id: string;
  title: string;
  sql: string;
  resultMeta: string;
}

type TopMenu = 'file' | 'sql' | 'view' | null;

type EditorTab = {
  id: string;
  kind: 'query' | 'table';
  title: string;
  sql: string;
  source?: { schema: string; table: string };
  sortState: SortState;
  currentPage: number;
  result: QueryResult | null;
};

type SortState = {
  columnIndex: number;
  direction: 'asc' | 'desc';
} | null;

type DragState = 'sidebar' | null;

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function makeTabId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function AppShell() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [loading, setLoading] = useState('Booting desktop shell...');
  const [error, setError] = useState<string | null>(null);
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [showSqlEditor, setShowSqlEditor] = useState(false);
  const [openMenu, setOpenMenu] = useState<TopMenu>(null);
  const [draft, setDraft] = useState<ConnectionInput>(EMPTY_CONNECTION);
  const [persistConnection, setPersistConnection] = useState(true);
  const [desktopReady, setDesktopReady] = useState(false);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([
    {
      id: 'tab-default-query',
      kind: 'query',
      title: 'sql-query.sql',
      sql: QUERY_PRESETS[0].sql,
      result: null,
      sortState: null,
      currentPage: 0,
    },
  ]);
  const [activeEditorTabId, setActiveEditorTabId] = useState('tab-default-query');
  const PAGE_SIZE = 500;
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [dragState, setDragState] = useState<DragState>(null);

  const activeEditorTab = useMemo(
    () => editorTabs.find((tab) => tab.id === activeEditorTabId) ?? editorTabs[0],
    [activeEditorTabId, editorTabs],
  );

  const databaseTree = snapshot?.databaseTree ?? [];

  const processedResult = useMemo(() => {
    const result = activeEditorTab?.result;
    if (!result) {
      return null;
    }

    const tabSort = activeEditorTab.sortState;
    const tabPage = activeEditorTab.currentPage;
    let rows = result.rows;

    if (tabSort) {
      rows = [...rows].sort((left, right) => {
        const leftValue = left[tabSort.columnIndex] ?? '';
        const rightValue = right[tabSort.columnIndex] ?? '';
        const ordered = leftValue.localeCompare(rightValue, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return tabSort.direction === 'asc' ? ordered : -ordered;
      });
    }

    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    const safePage = Math.min(tabPage, totalPages - 1);
    const pagedRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

    return {
      ...result,
      rows: pagedRows,
      rowCount: totalRows,
      totalPages,
      currentPage: safePage,
      pageStart: safePage * PAGE_SIZE,
      notice: tabSort
        ? `View rows ${totalRows} of ${result.rows.length}`
        : result.notice,
    };
  }, [activeEditorTab]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (dragState === 'sidebar') {
        setSidebarWidth(Math.min(520, Math.max(240, event.clientX)));
      }
    }

    function onPointerUp() {
      setDragState(null);
    }

    if (dragState) {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    }

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [dragState]);

  async function refresh() {
    if (!isTauriRuntime()) {
      setDesktopReady(false);
      setLoading('Browser preview mode. Launch with `npm run tauri dev` to use the backend.');
      setSnapshot({ savedConnections: [], activeConnection: null, databaseTree: [] });
      return;
    }

    try {
      setDesktopReady(true);
      setLoading('Loading workspace...');
      setError(null);
      setSnapshot(await tauriApi.bootstrap());
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Failed to load app state.');
    }
  }

  function updateActiveTab(patch: Partial<EditorTab>) {
    if (!activeEditorTab) {
      return;
    }

    setEditorTabs((current) =>
      current.map((tab) => (tab.id === activeEditorTab.id ? { ...tab, ...patch } : tab)),
    );
  }


  function openNewQueryTab(sql = QUERY_PRESETS[0].sql) {
    const id = makeTabId('query');
    setEditorTabs((current) => [
      ...current,
      {
        id,
        kind: 'query',
        title: 'sql-query.sql',
        sql,
        result: null,
        sortState: null,
        currentPage: 0,
      },
    ]);
    setActiveEditorTabId(id);
    setShowSqlEditor(true);
    setOpenMenu(null);
  }

  function openOrActivateTableTab(schema: string, table: string, sql: string, result: QueryResult) {
    const existing = editorTabs.find((tab) => tab.kind === 'table' && tab.source?.schema === schema && tab.source?.table === table);
    if (existing) {
      setEditorTabs((current) =>
        current.map((tab) =>
          tab.id === existing.id
            ? { ...tab, sql, result, title: `${schema}.${table}`, source: { schema, table }, sortState: null, currentPage: 0 }
            : tab,
        ),
      );
      setActiveEditorTabId(existing.id);
      return;
    }

    const id = makeTabId('table');
    setEditorTabs((current) => [
      ...current,
      {
        id,
        kind: 'table',
        title: `${schema}.${table}`,
        sql,
        source: { schema, table },
        result,
        sortState: null,
        currentPage: 0,
      },
    ]);
    setActiveEditorTabId(id);
  }

  function closeEditorTab(id: string) {
    setEditorTabs((current) => {
      if (current.length === 1) {
        return [
          {
            id: 'tab-default-query',
            kind: 'query',
            title: 'sql-query.sql',
            sql: QUERY_PRESETS[0].sql,
            result: null,
            sortState: null,
            currentPage: 0,
          },
        ];
      }

      const next = current.filter((tab) => tab.id !== id);
      if (activeEditorTabId === id) {
        setActiveEditorTabId(next[next.length - 1].id);
      }
      return next;
    });
  }

  function clearResultView() {
    updateActiveTab({ sortState: null, currentPage: 0 });
  }

  function toggleSort(columnIndex: number) {
    const current = activeEditorTab?.sortState ?? null;
    if (!current || current.columnIndex !== columnIndex) {
      updateActiveTab({ sortState: { columnIndex, direction: 'asc' } });
    } else if (current.direction === 'asc') {
      updateActiveTab({ sortState: { columnIndex, direction: 'desc' } });
    } else {
      updateActiveTab({ sortState: null });
    }
  }

  function exportCurrentResult() {
    if (!processedResult) {
      return;
    }

    const header = ['#', ...processedResult.columns];
    const rows = processedResult.rows.map((row, index) => [String(index + 1), ...row]);
    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
          .join(','),
      )
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeEditorTab?.title ?? 'results'}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function openNewConnectionModal() {
    setDraft(EMPTY_CONNECTION);
    setPersistConnection(true);
    setShowConnectionModal(true);
    setOpenMenu(null);
  }

  function openEditConnectionModal(connection: SafeSavedConnection) {
    setDraft({
      id: connection.id,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: '',
      database: connection.database,
    });
    setPersistConnection(true);
    setShowConnectionModal(true);
  }

  async function handleConnect() {
    try {
      setLoading(draft.id ? 'Updating saved connection...' : 'Opening database connection...');
      setError(null);
      const next = await tauriApi.connect(draft, persistConnection);
      setSnapshot(next);
      setShowConnectionModal(false);
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Connection failed.');
    }
  }

  async function handleActivate(connection: SafeSavedConnection) {
    try {
      setLoading(`Connecting to ${connection.host}...`);
      setError(null);
      const next = await tauriApi.activateSavedConnection(connection.id);
      setSnapshot(next);
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Connection failed.');
    }
  }

  async function handleDeleteConnection(connection: SafeSavedConnection) {
    try {
      setLoading(`Removing ${connection.name || connection.host}...`);
      setError(null);
      setSnapshot(await tauriApi.deleteSavedConnection(connection.id));
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  async function handleDisconnect() {
    try {
      setLoading('Closing connection...');
      setError(null);
      setSnapshot(await tauriApi.disconnect());
      setOpenMenu(null);
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Disconnect failed.');
    }
  }

  async function handleRunQuery() {
    if (!activeEditorTab) {
      return;
    }

    try {
      setLoading('Running SQL...');
      setError(null);
      const nextResult = await tauriApi.runQuery(activeEditorTab.sql, 500);
      updateActiveTab({ result: nextResult, title: summarizeSql(activeEditorTab.sql) });
      clearResultView();
      setShowSqlEditor(false);
      setOpenMenu(null);
      setQueryHistory((current) => [
        {
          id: crypto.randomUUID(),
          title: summarizeSql(activeEditorTab.sql),
          sql: activeEditorTab.sql,
          resultMeta: `${nextResult.rowCount} rows in ${nextResult.executionTimeMs} ms`,
        },
        ...current,
      ].slice(0, 12));
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Query failed.');
    }
  }

  async function handlePreviewTable(schema: string, table: string) {
    try {
      setLoading(`Loading ${schema}.${table}...`);
      setError(null);
      const nextResult = await tauriApi.previewTable(schema, table, 200, 0);
      const sql = `select *\nfrom ${schema}.${table}\nlimit 200;`;
      openOrActivateTableTab(schema, table, sql, nextResult);
      clearResultView();
      setQueryHistory((current) => [
        {
          id: crypto.randomUUID(),
          title: `${schema}.${table}`,
          sql,
          resultMeta: `preview · ${nextResult.rowCount} rows`,
        },
        ...current,
      ].slice(0, 12));
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(err instanceof Error ? err.message : 'Preview failed.');
    }
  }

  return (
    <main className="h-screen bg-[var(--bg)] text-[13px] text-[var(--text)]" onClick={() => { if (openMenu) setOpenMenu(null); }}>
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="relative flex h-9 items-center justify-between border-b border-[var(--line)] bg-[var(--bg-elevated)] px-3">
          <div className="flex min-w-0 items-center gap-4" onClick={(event) => event.stopPropagation()}>
            <div className="bg-[var(--accent)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.14em] text-white">
              rdb2
            </div>
            <div className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
              <MenuButton active={openMenu === 'file'} label="File" onClick={() => setOpenMenu((current) => (current === 'file' ? null : 'file'))} />
              <MenuButton active={openMenu === 'sql'} label="SQL" onClick={() => setOpenMenu((current) => (current === 'sql' ? null : 'sql'))} />
              <MenuButton active={openMenu === 'view'} label="View" onClick={() => setOpenMenu((current) => (current === 'view' ? null : 'view'))} />
            </div>
          </div>

          <div className="truncate text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
            {snapshot?.activeConnection ? snapshot.activeConnection.database : 'No active database'}
          </div>

          {openMenu ? (
            <div className="absolute left-16 top-9 z-10 min-w-[220px] border border-[var(--line)] bg-[#252526] shadow-[0_8px_24px_rgba(0,0,0,0.45)]" onClick={(event) => event.stopPropagation()}>
              {openMenu === 'file' ? (
                <MenuPanel>
                  <MenuItem label="New Connection" shortcut="Ctrl+N" onClick={openNewConnectionModal} />
                  <MenuItem label="New Query" shortcut="Ctrl+T" onClick={() => openNewQueryTab()} />
                </MenuPanel>
              ) : null}
              {openMenu === 'sql' ? (
                <MenuPanel>
                  <MenuItem label="Open SQL Editor" shortcut="Ctrl+L" onClick={() => { setShowSqlEditor(true); setOpenMenu(null); }} />
                  <MenuItem label="Run Active Query" shortcut="Ctrl+Enter" onClick={() => void handleRunQuery()} />
                  <MenuItem label="Disconnect" onClick={() => void handleDisconnect()} />
                </MenuPanel>
              ) : null}
              {openMenu === 'view' ? (
                <MenuPanel>
                  <MenuItem label="Clear Results" onClick={() => { clearResultView(); setOpenMenu(null); }} />
                  <MenuItem label="Export CSV" onClick={() => { exportCurrentResult(); setOpenMenu(null); }} />
                </MenuPanel>
              ) : null}
            </div>
          ) : null}
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex min-h-0 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--bg-sidebar)] text-[12px]" style={{ width: sidebarWidth }}>
            <div className="flex h-1/4 flex-col border-b border-[var(--line)]">
              <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
                <div className="font-medium text-[var(--text)]">Connections</div>
                <ToolbarIconButton onClick={openNewConnectionModal} title="New connection"><PlusIcon /></ToolbarIconButton>
              </div>
              <div className="sidebar-scroll flex-1 overflow-y-scroll px-2 py-2">
                {snapshot?.savedConnections.length ? (
                  <div>
                    {snapshot.savedConnections.map((connection) => {
                      const active = snapshot.activeConnection?.id === connection.id;
                      return (
                        <div className={classNames('group flex items-center gap-2 px-1 py-1', active && 'bg-[var(--selection)]')} key={connection.id}>
                          <ExplorerIcon><ConnectionIcon active={active} /></ExplorerIcon>
                          <button className="min-w-0 flex-1 truncate text-left text-[var(--text)]" onClick={() => void handleActivate(connection)} type="button">
                            {connection.name || `${connection.user}@${connection.host}`}
                          </button>
                          <button className="hidden text-[var(--muted)] group-hover:block" onClick={() => openEditConnectionModal(connection)} type="button">e</button>
                          <button className="hidden text-[var(--danger)] group-hover:block" onClick={() => void handleDeleteConnection(connection)} type="button">x</button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyInline message="No saved connections" />
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-1 border-b border-[var(--line)] px-2 py-1.5 text-[var(--muted)]">
                <ToolbarIconButton onClick={() => void refresh()} title="Refresh"><RefreshIcon /></ToolbarIconButton>
                <ToolbarIconButton onClick={() => setShowSqlEditor(true)} title="Open SQL editor"><PanelIcon /></ToolbarIconButton>
              </div>
              <div className="sidebar-scroll min-h-0 flex-1 overflow-y-scroll px-2 py-2">
                {snapshot?.activeConnection ? (
                  <DatabaseTree
                    connection={snapshot.activeConnection}
                    tree={databaseTree}
                    onPreview={handlePreviewTable}
                  />
                ) : (
                  <EmptyInline message="Connect to browse schema" />
                )}
              </div>
            </div>
          </aside>

          <div className="w-1 shrink-0 cursor-col-resize bg-[var(--line-soft)] hover:bg-[var(--accent)]" onPointerDown={(event) => { event.stopPropagation(); setDragState('sidebar'); }} />

          <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-editor)]">
            <div className="flex items-center border-b border-[var(--line)] bg-[var(--bg-elevated)] px-1 pt-1">
              <div className="flex min-w-0 flex-1 overflow-auto">
                {editorTabs.map((tab) => (
                  <button
                    className={classNames(
                      'group flex min-w-[160px] max-w-[360px] items-center gap-2 border-r border-[var(--line)] px-3 py-1.5 text-left',
                      tab.id === activeEditorTab?.id ? 'bg-[var(--bg-editor)] text-[var(--text-bright)]' : 'bg-[var(--bg-tab)] text-[var(--muted)]',
                    )}
                    key={tab.id}
                    onClick={() => setActiveEditorTabId(tab.id)}
                    type="button"
                  >
                    <span className="text-[11px] text-[var(--muted)]">
                      {tab.kind === 'table' ? <TableIcon /> : <QueryIcon />}
                    </span>
                    <span className="truncate font-mono text-[12px]">
                      {tab.title}
                    </span>
                    <span
                      className="ml-auto shrink-0 text-[var(--muted)] hover:text-[var(--text)]"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeEditorTab(tab.id);
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              {processedResult ? (
                <>
                  <div className="min-h-0 flex-1 overflow-scroll bg-[var(--bg-editor)]">
                    <ResultsTable
                      result={processedResult}
                      sortState={activeEditorTab?.sortState ?? null}
                      onSort={toggleSort}
                      rowOffset={processedResult.pageStart}
                    />
                  </div>
                  <div className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--line)] bg-[var(--bg-tab)] px-3 py-1.5 text-[14px] text-[var(--muted)]">
                    <button className="px-1 py-0.5 font-bold hover:text-[var(--text)] disabled:opacity-30" disabled={processedResult.currentPage === 0} onClick={() => updateActiveTab({ currentPage: 0 })} type="button">{'<<'}</button>
                    <button className="px-1 py-0.5 font-bold hover:text-[var(--text)] disabled:opacity-30" disabled={processedResult.currentPage === 0} onClick={() => updateActiveTab({ currentPage: processedResult.currentPage - 1 })} type="button">{'<'}</button>
                    <span className="font-bold">{processedResult.rowCount > 0 ? `${(processedResult.pageStart + 1).toLocaleString()}–${Math.min(processedResult.pageStart + PAGE_SIZE, processedResult.rowCount).toLocaleString()}` : '0'} of {processedResult.rowCount.toLocaleString()}</span>
                    <button className="px-1 py-0.5 font-bold hover:text-[var(--text)] disabled:opacity-30" disabled={processedResult.currentPage >= processedResult.totalPages - 1} onClick={() => updateActiveTab({ currentPage: processedResult.currentPage + 1 })} type="button">{'>'}</button>
                    <button className="px-1 py-0.5 font-bold hover:text-[var(--text)] disabled:opacity-30" disabled={processedResult.currentPage >= processedResult.totalPages - 1} onClick={() => updateActiveTab({ currentPage: processedResult.totalPages - 1 })} type="button">{'>>'}</button>
                  </div>
                </>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-editor)] p-2">
                  <WorkspaceEmpty title="No results" body="Run a query or click a table from the explorer." />
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="flex h-6 items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--bg-elevated)] px-3 text-[11px] text-[var(--muted)]">
          <div className="truncate">{loading || error || (snapshot?.activeConnection ? `Connected as ${snapshot.activeConnection.user}` : 'Waiting for a database connection.')}</div>
          <div>{error ? 'error' : snapshot?.activeConnection ? 'online' : desktopReady ? 'offline' : 'preview'}</div>
        </footer>
      </div>

      {showSqlEditor && activeEditorTab ? (
        <div className="fixed inset-0 z-20 grid place-items-center bg-[rgba(0,0,0,0.46)] p-4">
          <div className="w-full max-w-5xl border border-[var(--line)] bg-[var(--bg-elevated)]">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5">
              <div className="flex items-center gap-2 text-[12px] text-[var(--text)]">
                <span className="text-[var(--muted)]">{activeEditorTab.kind === 'table' ? <TableIcon /> : <QueryIcon />}</span>
                <span>{activeEditorTab.title}</span>
              </div>
              <div className="flex items-center gap-2">
                {QUERY_PRESETS.map((preset) => (
                  <button
                    className="border border-[var(--line)] bg-[var(--bg-input)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                    key={preset.label}
                    onClick={() => updateActiveTab({ sql: preset.sql })}
                    type="button"
                  >
                    {preset.label}
                  </button>
                ))}
                <ToolbarButton accent onClick={handleRunQuery}>Run</ToolbarButton>
                <InlineTextButton onClick={() => setShowSqlEditor(false)}>Close</InlineTextButton>
              </div>
            </div>
            <div className="p-4">
              <textarea
                className="h-[420px] w-full border border-[var(--line)] bg-[var(--bg-editor)] p-3 font-mono text-[13px] leading-6 text-[var(--text)] outline-none focus:border-[var(--accent)]"
                onChange={(event) => updateActiveTab({ sql: event.target.value })}
                spellCheck={false}
                value={activeEditorTab.sql}
              />
            </div>
          </div>
        </div>
      ) : null}

      {showConnectionModal ? (
        <div className="fixed inset-0 z-20 grid place-items-center bg-[rgba(0,0,0,0.42)] p-4">
          <div className="w-full max-w-2xl border border-[var(--line)] bg-[var(--bg-elevated)]">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
              <div className="text-sm font-medium text-[var(--text)]">{draft.id ? 'Edit connection' : 'New connection'}</div>
              <InlineTextButton onClick={() => setShowConnectionModal(false)}>Close</InlineTextButton>
            </div>
            <div className="grid gap-4 p-5 md:grid-cols-2">
              <Field label="Name"><input className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
              <Field label="Host"><input className="input" value={draft.host} onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))} /></Field>
              <Field label="Port"><input className="input" inputMode="numeric" value={String(draft.port)} onChange={(event) => setDraft((current) => ({ ...current, port: Number.parseInt(event.target.value || '5432', 10) }))} /></Field>
              <Field label="Database"><input className="input" value={draft.database} onChange={(event) => setDraft((current) => ({ ...current, database: event.target.value }))} /></Field>
              <Field label="User"><input className="input" value={draft.user} onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))} /></Field>
              <Field label="Password"><input className="input" type="password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} /></Field>
            </div>
            <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
              <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                <input checked={persistConnection} onChange={() => setPersistConnection((current) => !current)} type="checkbox" />
                Save locally
              </label>
              <div className="flex gap-2">
                <InlineTextButton onClick={() => setShowConnectionModal(false)}>Cancel</InlineTextButton>
                <ToolbarButton accent onClick={() => void handleConnect()}>{draft.id ? 'Save and connect' : 'Connect'}</ToolbarButton>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function MenuButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={classNames(
        'px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--selection)] hover:text-[var(--text)]',
        active && 'bg-[var(--selection)] text-[var(--text)]',
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function MenuPanel({ children }: PropsWithChildren) {
  return <div className="py-1 text-[12px] text-[var(--text)]">{children}</div>;
}

function MenuItem({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[var(--text)] hover:bg-[var(--selection)]"
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      {shortcut ? <span className="ml-6 text-[11px] text-[var(--muted)]">{shortcut}</span> : null}
    </button>
  );
}

function ToolbarButton({ children, disabled, accent, danger, onClick }: PropsWithChildren<{ disabled?: boolean; accent?: boolean; danger?: boolean; onClick: () => void }>) {
  return (
    <button
      className={classNames(
        'border px-2.5 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-50',
        accent
          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
          : danger
            ? 'border-[rgba(244,135,113,0.35)] text-[var(--danger)]'
            : 'border-[var(--line)] bg-[var(--bg-input)] text-[var(--text)]',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function ToolbarIconButton({ children, onClick, title }: PropsWithChildren<{ onClick: () => void; title: string }>) {
  return (
    <button className="grid h-6 w-6 place-items-center border border-transparent text-[12px] text-[var(--muted)] hover:border-[var(--line)] hover:bg-[var(--bg-input)]" onClick={onClick} title={title} type="button">
      {children}
    </button>
  );
}

function InlineTextButton({ children, onClick }: PropsWithChildren<{ onClick: () => void }>) {
  return (
    <button className="text-[12px] text-[var(--muted)] hover:text-[var(--text)]" onClick={onClick} type="button">
      {children}
    </button>
  );
}


function ExplorerIcon({ children }: PropsWithChildren) {
  return <span className="grid w-4 shrink-0 place-items-center text-[var(--muted)]">{children}</span>;
}


function Field({ label, children }: PropsWithChildren<{ label: string }>) {
  return (
    <label className="block text-sm text-[var(--muted)]">
      <div className="mb-2 text-[11px] uppercase tracking-[0.08em]">{label}</div>
      {children}
    </label>
  );
}

function EmptyInline({ message }: { message: string }) {
  return <div className="px-1 py-1 text-[var(--muted)]">{message}</div>;
}

function WorkspaceEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid min-h-[240px] place-items-center border border-dashed border-[var(--line)] bg-[rgba(255,255,255,0.02)] p-5 text-center">
      <div>
        <div className="text-sm text-[var(--text)]">{title}</div>
        <div className="mt-1 text-sm text-[var(--muted)]">{body}</div>
      </div>
    </div>
  );
}



function DatabaseTree({ connection, tree, onPreview }: { connection: ActiveConnectionSummary; tree: SchemaNode[]; onPreview: (schema: string, table: string) => Promise<void>; }) {
  const [dbOpen, setDbOpen] = useState(true);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOpenSchemas((current) => {
      const next = { ...current };
      for (const schema of tree) {
        if (!(schema.name in next)) {
          next[schema.name] = true;
        }
      }
      return next;
    });
  }, [tree]);

  return (
    <div className="overflow-auto">
      <button className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--selection)]" onClick={() => setDbOpen((c) => !c)} type="button">
        <span className="w-4 shrink-0 text-center text-[var(--muted)]">{dbOpen ? '▾' : '▸'}</span>
        <ExplorerIcon><DatabaseIcon /></ExplorerIcon>
        <span className="flex-1 truncate text-[var(--text)]">{connection.database}</span>
      </button>
      {dbOpen ? (
        <div>
          {tree.map((schema) => {
            const schemaOpen = openSchemas[schema.name] ?? true;
            return (
              <div key={schema.name}>
                <button className="flex w-full items-center gap-2 py-1 pl-8 pr-2 text-left hover:bg-[var(--selection)]" onClick={() => setOpenSchemas((current) => ({ ...current, [schema.name]: !schemaOpen }))} type="button">
                  <span className="w-4 shrink-0 text-center text-[var(--muted)]">{schemaOpen ? '▾' : '▸'}</span>
                  <ExplorerIcon><FolderIcon /></ExplorerIcon>
                  <span className="flex-1 truncate text-[var(--text)]">{schema.name}</span>
                  <span className="shrink-0 text-[var(--muted)]">{schema.tables.length}</span>
                </button>
                {schemaOpen ? (
                  <div>
                    {schema.tables.map((table) => (
                      <div className="flex items-center gap-2 pl-14 pr-2" key={`${schema.name}.${table.name}`}>
                        <ExplorerIcon><TableIcon /></ExplorerIcon>
                        <button className="flex-1 truncate py-1 text-left text-[var(--text)] hover:bg-[var(--selection)]" onClick={() => void onPreview(schema.name, table.name)} type="button">
                          {table.name}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}


function ResultsTable({
  result,
  sortState,
  onSort,
  rowOffset = 0,
}: {
  result: QueryResult;
  sortState: SortState;
  onSort: (columnIndex: number) => void;
  rowOffset?: number;
}) {
  return (
    <div className="bg-[var(--bg-editor)]">
      {result.notice ? <div className="border-b border-[var(--line)] bg-[var(--accent-soft)] px-4 py-2 text-sm text-[var(--accent)]">{result.notice}</div> : null}
      <div>
        <table className="min-w-full border-collapse font-mono text-[12px]">
          <thead className="sticky top-0 z-[1] bg-[var(--bg-tab)] text-left text-[var(--text-bright)]">
            <tr>
              <th className="w-12 border-b border-r border-[var(--line)] px-3 pt-4 pb-2 font-medium text-right">#</th>
              {result.columns.map((column, index) => (
                <th className="relative border-b border-r border-[var(--line)] px-3 pt-4 pb-2 font-medium" key={column}>
                  <div className="flex items-center gap-1">
                    <button className="flex-1 text-left" onClick={() => onSort(index)} type="button">
                      {column}
                    </button>
                    <span className="shrink-0 text-[var(--muted)]"><FilterIcon /></span>
                    <button className="inline-flex shrink-0 flex-col leading-none text-[8px] text-[var(--muted)]" onClick={() => onSort(index)} type="button">
                      <span className={sortState?.columnIndex === index && sortState.direction === 'asc' ? 'text-[var(--text-bright)]' : ''}>▲</span>
                      <span className={sortState?.columnIndex === index && sortState.direction === 'desc' ? 'text-[var(--text-bright)]' : ''}>▼</span>
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={`${rowIndex}-${row.join('|')}`}>
                <td className="border-b border-r border-[var(--line)] px-3 py-2 text-right text-[var(--muted)]">{rowOffset + rowIndex + 1}</td>
                {row.map((cell, cellIndex) => (
                  <td className="max-w-[400px] border-b border-r border-[var(--line)] px-3 py-2 text-[var(--muted)]" key={`${rowIndex}-${cellIndex}`}>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap">{cell}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IconBase({ children }: { children: ReactNode }) { return <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16">{children}</svg>; }
function PlusIcon() { return <IconBase><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></IconBase>; }
function RefreshIcon() { return <IconBase><path d="M13 5V2.5H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M13 2.5A5.5 5.5 0 1 0 14 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>; }
function PanelIcon() { return <IconBase><path d="M2.5 3.5h11v9h-11z" stroke="currentColor" strokeWidth="1.2" /><path d="M6 3.5v9" stroke="currentColor" strokeWidth="1.2" /></IconBase>; }
function ConnectionIcon({ active }: { active: boolean }) { return <IconBase><circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="8" r="2" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.1" /></IconBase>; }
function ServerIcon() { return <IconBase><rect x="3" y="2.5" width="10" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="3" y="9.5" width="10" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" /><path d="M5 4.5h.01M5 11.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></IconBase>; }
function DatabaseIcon() { return <IconBase><ellipse cx="8" cy="4" rx="4.5" ry="2" stroke="currentColor" strokeWidth="1.2" /><path d="M3.5 4v6c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4" stroke="currentColor" strokeWidth="1.2" /></IconBase>; }
function FolderIcon() { return <IconBase><path d="M2.5 5h4l1.2-1.5h5.8v8H2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></IconBase>; }
function TableIcon() { return <IconBase><rect x="2.5" y="3" width="11" height="10" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 6.5h11M2.5 10h11M6 3v10M9.8 3v10" stroke="currentColor" strokeWidth="1" /></IconBase>; }
function QueryIcon() { return <IconBase><path d="M4 4.5h8M4 8h8M4 11.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>; }
function ExportIcon() { return <IconBase><path d="M8 2.5v7M5.5 7l2.5 2.5L10.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 12.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>; }
function FilterIcon() { return <IconBase><path d="M2.5 3.5h11L9 8.5v4l-2 1.5v-5.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></IconBase>; }


function summarizeSql(sql: string) {
  const line = sql.trim().replace(/\s+/g, ' ').slice(0, 56);
  return line || 'Untitled query';
}
