use std::sync::Mutex;

use crate::models::SavedConnection;

#[derive(Default)]
pub struct AppState {
    pub active_connection: Mutex<Option<SavedConnection>>,
}
