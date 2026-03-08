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

    let mut schemas: Vec<SchemaNode> = Vec::new();

    for row in rows {
        let schema_name: String = row.get(0);
        let table_name: String = row.get(1);
        let table_type: String = row.get(2);
        let column_name: String = row.get(3);
        let data_type: String = row.get(4);
        let is_nullable: String = row.get(5);
        let default_value: Option<String> = row.get(6);

        let schema_index = match schemas.iter().position(|schema| schema.name == schema_name) {
            Some(index) => index,
            None => {
                schemas.push(SchemaNode {
                    name: schema_name.clone(),
                    tables: Vec::new(),
                });
                schemas.len() - 1
            }
        };

        let tables = &mut schemas[schema_index].tables;
        let table_index = match tables.iter().position(|table| table.name == table_name) {
            Some(index) => index,
            None => {
                tables.push(TableNode {
                    name: table_name.clone(),
                    table_type,
                    columns: Vec::new(),
                });
                tables.len() - 1
            }
        };

        tables[table_index].columns.push(ColumnNode {
            name: column_name,
            data_type,
            nullable: is_nullable == "YES",
            default_value,
        });
    }

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
    let messages = client
        .simple_query(sql)
        .map_err(|error| format!("query failed: {error}"))?;

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
