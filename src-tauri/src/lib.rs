pub mod commands;
pub mod models;
pub mod postgres;
pub mod state;
pub mod storage;

use crate::commands::{
    activate_saved_connection, bootstrap, connect, delete_saved_connection, disconnect,
    preview_table, run_query,
};
use crate::state::AppState;

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            connect,
            activate_saved_connection,
            delete_saved_connection,
            disconnect,
            run_query,
            preview_table,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run rdb2 tauri application");
}
