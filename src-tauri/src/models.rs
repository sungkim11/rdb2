use serde::{Deserialize, Serialize};

/// Escape a value for use in a libpq key=value connection string.
/// Single quotes are used to wrap values containing spaces or special characters,
/// and backslashes/single quotes within are escaped.
fn escape_libpq_value(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return value.to_string();
    }
    let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
}

impl SavedConnection {
    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            format!("{}@{}", self.user, self.host)
        } else {
            self.name.clone()
        }
    }

    pub fn connection_string(&self) -> String {
        format!(
            "host={} port={} user={} password={} dbname={} connect_timeout=5",
            escape_libpq_value(&self.host),
            self.port,
            escape_libpq_value(&self.user),
            escape_libpq_value(&self.password),
            escape_libpq_value(&self.database),
        )
    }
}

impl From<ConnectionInput> for SavedConnection {
    fn from(value: ConnectionInput) -> Self {
        Self {
            id: value.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: value.name,
            host: value.host,
            port: value.port,
            user: value.user,
            password: value.password,
            database: value.database,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConnectionSummary {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
}

impl From<&SavedConnection> for ActiveConnectionSummary {
    fn from(value: &SavedConnection) -> Self {
        Self {
            id: value.id.clone(),
            label: value.label(),
            host: value.host.clone(),
            port: value.port,
            database: value.database.clone(),
            user: value.user.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnNode {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNode {
    pub name: String,
    pub table_type: String,
    pub columns: Vec<ColumnNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<TableNode>,
}

/// Connection info sent to the renderer — password stripped.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
}

impl From<&SavedConnection> for SafeSavedConnection {
    fn from(value: &SavedConnection) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            host: value.host.clone(),
            port: value.port,
            user: value.user.clone(),
            database: value.database.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub saved_connections: Vec<SafeSavedConnection>,
    pub active_connection: Option<ActiveConnectionSummary>,
    pub database_tree: Vec<SchemaNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlResult {
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub truncated: bool,
    pub execution_time_ms: u128,
    pub notice: Option<String>,
}
