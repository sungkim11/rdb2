use std::collections::HashMap;
use std::time::Instant;

use postgres::{Client, NoTls, SimpleQueryMessage};

use crate::models::{ColumnNode, QueryResult, SavedConnection, SchemaNode, TableNode};

pub fn test_connection(connection: &SavedConnection) -> Result<(), String> {
    let mut client = connect(connection)?;
    client
        .simple_query("select 1")
        .map_err(|error| format!("connection test failed: {error}"))?;
    Ok(())
}

pub fn fetch_tree(connection: &SavedConnection) -> Result<Vec<SchemaNode>, String> {
    let mut client = connect(connection)?;
    let rows = client
        .query(
            "select t.table_schema, t.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable, c.column_default \
             from information_schema.tables t \
             join information_schema.columns c \
               on c.table_schema = t.table_schema and c.table_name = t.table_name \
             where t.table_schema not in ('pg_catalog', 'information_schema') \
             order by t.table_schema, t.table_name, c.ordinal_position",
            &[],
        )
        .map_err(|error| format!("failed to load database tree: {error}"))?;

    // Use HashMaps for O(1) lookups instead of linear scans.
    let mut schema_order: Vec<String> = Vec::new();
    let mut schema_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut table_map: HashMap<(String, String), TableNode> = HashMap::new();

    for row in rows {
        let schema_name: String = row.get(0);
        let table_name: String = row.get(1);
        let table_type: String = row.get(2);
        let column_name: String = row.get(3);
        let data_type: String = row.get(4);
        let is_nullable: String = row.get(5);
        let default_value: Option<String> = row.get(6);

        let table_names = schema_map.entry(schema_name.clone()).or_insert_with(|| {
            schema_order.push(schema_name.clone());
            Vec::new()
        });

        let key = (schema_name, table_name.clone());
        let table_node = table_map.entry(key).or_insert_with(|| {
            table_names.push(table_name.clone());
            TableNode {
                name: table_name,
                table_type,
                columns: Vec::new(),
            }
        });

        table_node.columns.push(ColumnNode {
            name: column_name,
            data_type,
            nullable: is_nullable == "YES",
            default_value,
        });
    }

    let schemas = schema_order
        .into_iter()
        .map(|schema_name| {
            let table_names = schema_map.remove(&schema_name).unwrap_or_default();
            let tables = table_names
                .into_iter()
                .filter_map(|table_name| {
                    table_map.remove(&(schema_name.clone(), table_name))
                })
                .collect();
            SchemaNode {
                name: schema_name,
                tables,
            }
        })
        .collect();

    Ok(schemas)
}

pub fn preview_table(
    connection: &SavedConnection,
    schema: &str,
    table: &str,
    limit: usize,
    offset: usize,
) -> Result<QueryResult, String> {
    let sql = format!(
        "select * from {}.{} limit {} offset {}",
        quote_identifier(schema),
        quote_identifier(table),
        limit,
        offset,
    );
    run_query(connection, &sql, limit)
}

pub fn run_query(
    connection: &SavedConnection,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    let mut client = connect(connection)?;
    let started = Instant::now();

    // Request limit+1 rows so we can detect truncation without fetching everything.
    let fetch_limit = limit + 1;
    let limited_sql = format!(
        "SELECT * FROM ({}) AS _rdb2_sub LIMIT {}",
        sql.trim().trim_end_matches(';'),
        fetch_limit
    );

    let messages = client
        .simple_query(&limited_sql)
        .map_err(|error| {
            // If wrapping fails (e.g. non-SELECT statement), fall back to raw execution.
            // We return the error here; the fallback is handled below.
            format!("{error}")
        });

    // If the wrapped query fails, try the original SQL directly (for DDL/DML statements).
    let messages = match messages {
        Ok(msgs) => msgs,
        Err(_) => {
            let mut client = connect(connection)?;
            client
                .simple_query(sql)
                .map_err(|error| format!("query failed: {error}"))?
        }
    };

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut truncated = false;
    let mut notice = None;
    let mut command_tags: Vec<String> = Vec::new();

    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row
                        .columns()
                        .iter()
                        .map(|column| column.name().to_string())
                        .collect();
                }

                if rows.len() < limit {
                    let mut rendered = Vec::with_capacity(row.len());
                    for index in 0..row.len() {
                        rendered.push(row.get(index).unwrap_or("NULL").to_string());
                    }
                    rows.push(rendered);
                } else {
                    truncated = true;
                }
            }
            SimpleQueryMessage::CommandComplete(count) => {
                command_tags.push(format!("{count}"));
            }
            _ => {}
        }
    }

    if truncated {
        notice = Some(format!("Showing the first {limit} rows."));
    } else if rows.is_empty() && !command_tags.is_empty() {
        notice = Some(command_tags.join(" | "));
    }

    Ok(QueryResult {
        columns,
        row_count: rows.len(),
        rows,
        truncated,
        execution_time_ms: started.elapsed().as_millis(),
        notice,
    })
}

fn connect(connection: &SavedConnection) -> Result<Client, String> {
    Client::connect(&connection.connection_string(), NoTls)
        .map_err(|error| format!("failed to connect to postgres: {error}"))
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
