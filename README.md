# rdb2

`rdb2` is a desktop-first Postgres client built with Tauri, Rust, Next.js, Tailwind CSS, and TypeScript.

The target is the same general workflow as `rdb`, but with a cleaner architecture:

- `src-tauri`: native backend, Postgres commands, persistence
- `src/app`: desktop UI shell built with Next.js App Router
- Tailwind-based UI with a split-pane database client layout

## Current scope

This first cut includes:

- Saved PostgreSQL connections
- Connect / disconnect flows
- Database tree browser for schemas, tables, and columns
- SQL editor and query execution
- Table preview from the schema tree
- Tauri command bridge with Rust-managed connection state

Parquet and CSV support are intentionally deferred.

## Expected stack

- Rust 1.94+
- Node.js 24+
- npm 11+
- Tauri 2.x CLI

## Local development

Install dependencies first:

```bash
npm install
cargo install tauri-cli
```

Run the frontend only:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run tauri dev
```

## Project structure

- `package.json`: frontend workspace and scripts
- `src/app`: Next.js routes and global styles
- `src/components`: client UI components
- `src/lib`: frontend types and Tauri bridge helpers
- `src-tauri/src`: Rust backend and Tauri commands
- `src-tauri/tauri.conf.json`: Tauri desktop configuration

## Next steps

1. Add connection secrets storage and edit-in-place flows.
2. Replace the textarea SQL editor with a richer editor component.
3. Add tabs, result history, and schema-aware query assistance.
4. Add Parquet / CSV support through a separate data-source layer.
