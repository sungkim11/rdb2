use serde::{Deserialize, Serialize};

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
            self.host, self.port, self.user, self.password, self.database
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub saved_connections: Vec<SavedConnection>,
    pub active_connection: Option<ActiveConnectionSummary>,
    pub database_tree: Vec<SchemaNode>,
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
