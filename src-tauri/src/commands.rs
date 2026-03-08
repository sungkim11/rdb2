use tauri::{AppHandle, State};

use crate::models::{AppSnapshot, ConnectionInput, QueryResult, SavedConnection};
use crate::state::AppState;
use crate::{postgres, storage};

fn snapshot(app: &AppHandle, state: &State<'_, AppState>) -> Result<AppSnapshot, String> {
    let saved_connections = storage::load_connections(app)?;
    let active_connection = state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))?
        .clone();

    let database_tree = match active_connection.as_ref() {
        Some(connection) => postgres::fetch_tree(connection)?,
        None => Vec::new(),
    };

    Ok(AppSnapshot {
        saved_connections,
        active_connection: active_connection.as_ref().map(Into::into),
        database_tree,
    })
}

#[tauri::command]
pub fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    snapshot(&app, &state)
}

#[tauri::command]
pub fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    connection: ConnectionInput,
    save: bool,
) -> Result<AppSnapshot, String> {
    let connection = SavedConnection::from(connection);
    postgres::test_connection(&connection)?;

    if save {
        let mut saved = storage::load_connections(&app)?;
        match saved.iter().position(|entry| entry.id == connection.id) {
            Some(index) => saved[index] = connection.clone(),
            None => saved.push(connection.clone()),
        }
        storage::save_connections(&app, &saved)?;
    }

    *state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))? = Some(connection);

    snapshot(&app, &state)
}

#[tauri::command]
pub fn activate_saved_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<AppSnapshot, String> {
    let saved = storage::load_connections(&app)?;
    let connection = saved
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| String::from("saved connection not found"))?;

    postgres::test_connection(&connection)?;

    *state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))? = Some(connection);

    snapshot(&app, &state)
}

#[tauri::command]
pub fn delete_saved_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<AppSnapshot, String> {
    let mut saved = storage::load_connections(&app)?;
    saved.retain(|entry| entry.id != id);
    storage::save_connections(&app, &saved)?;

    let mut active = state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))?;
    if active
        .as_ref()
        .is_some_and(|connection| connection.id == id)
    {
        *active = None;
    }
    drop(active);

    snapshot(&app, &state)
}

#[tauri::command]
pub fn disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    *state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))? = None;
    snapshot(&app, &state)
}

#[tauri::command]
pub fn run_query(
    state: State<'_, AppState>,
    sql: String,
    limit: Option<usize>,
) -> Result<QueryResult, String> {
    let connection = state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))?
        .clone()
        .ok_or_else(|| String::from("no active database connection"))?;

    postgres::run_query(&connection, &sql, limit.unwrap_or(500))
}

#[tauri::command]
pub fn preview_table(
    state: State<'_, AppState>,
    schema: String,
    table: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<QueryResult, String> {
    let connection = state
        .active_connection
        .lock()
        .map_err(|_| String::from("failed to acquire active connection state"))?
        .clone()
        .ok_or_else(|| String::from("no active database connection"))?;

    postgres::preview_table(
        &connection,
        &schema,
        &table,
        limit.unwrap_or(200),
        offset.unwrap_or(0),
    )
}
