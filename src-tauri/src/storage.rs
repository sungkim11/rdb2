use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::models::SavedConnection;

const CONNECTIONS_FILE: &str = "connections.json";

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve config directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "failed to create config directory {}: {error}",
            dir.display()
        )
    })?;
    Ok(dir)
}

fn connections_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(CONNECTIONS_FILE))
}

pub fn load_connections(app: &AppHandle) -> Result<Vec<SavedConnection>, String> {
    let path = connections_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str::<Vec<SavedConnection>>(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn save_connections(app: &AppHandle, connections: &[SavedConnection]) -> Result<(), String> {
    let path = connections_path(app)?;
    let json = serde_json::to_string_pretty(connections)
        .map_err(|error| format!("failed to serialize connections: {error}"))?;
    fs::write(&path, json).map_err(|error| format!("failed to write {}: {error}", path.display()))
}
