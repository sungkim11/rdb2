use std::collections::HashMap;
use std::time::Instant;

use postgres::{Client, NoTls, SimpleQueryMessage};

fn format_pg_error(error: &postgres::Error) -> String {
    if let Some(db) = error.as_db_error() {
        let mut msg = format!("{}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            msg.push_str(&format!("\nDetail: {detail}"));
        }
        if let Some(hint) = db.hint() {
            msg.push_str(&format!("\nHint: {hint}"));
        }
        msg
    } else {
        format!("{error}")
    }
}

use crate::models::{ColumnNode, QueryResult, SavedConnection, SchemaNode, TableNode};

pub fn test_connection(connection: &SavedConnection) -> Result<(), String> {
    let mut client = connect(connection)?;
    client
        .simple_query("select 1")
        .map_err(|error| format!("connection test failed: {}", format_pg_error(&error)))?;
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
        .map_err(|error| format!("failed to load database tree: {}", format_pg_error(&error)))?;

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
        .map_err(|error| format_pg_error(&error));

    // If the wrapped query fails, try the original SQL directly (for DDL/DML statements).
    let messages = match messages {
        Ok(msgs) => msgs,
        Err(wrapped_err) => {
            let mut client = connect(connection)?;
            client
                .simple_query(sql)
                .map_err(|error| format!("{}\n\n(wrapped query also failed: {wrapped_err})", format_pg_error(&error)))?
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

pub fn get_table_ddl(
    connection: &SavedConnection,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let mut client = connect(connection)?;

    let oid_row = client
        .query_one(
            "SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .map_err(|e| format!("table not found: {}", format_pg_error(&e)))?;
    let table_oid: u32 = oid_row.get(0);

    // Columns with types, defaults, not-null
    let col_rows = client
        .query(
            "SELECT a.attname, \
                    format_type(a.atttypid, a.atttypmod) AS data_type, \
                    a.attnotnull, \
                    pg_get_expr(d.adbin, d.adrelid) AS default_expr \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&table_oid],
        )
        .map_err(|e| format!("failed to load columns: {}", format_pg_error(&e)))?;

    let mut col_defs: Vec<String> = Vec::new();
    let mut max_name_len: usize = 0;

    // First pass: determine max column name length for alignment
    let mut col_data: Vec<(String, String, bool, Option<String>)> = Vec::new();
    for row in &col_rows {
        let name: String = row.get(0);
        let dtype: String = row.get(1);
        let notnull: bool = row.get(2);
        let default_expr: Option<String> = row.get(3);
        if name.len() > max_name_len {
            max_name_len = name.len();
        }
        col_data.push((name, dtype, notnull, default_expr));
    }

    for (name, dtype, notnull, default_expr) in &col_data {
        // Detect serial types
        let is_serial = default_expr
            .as_ref()
            .is_some_and(|d| d.starts_with("nextval("));

        let display_type = if is_serial {
            match dtype.as_str() {
                "bigint" => "bigserial".to_string(),
                "smallint" => "smallserial".to_string(),
                _ => "serial".to_string(),
            }
        } else {
            dtype.clone()
        };

        let mut parts = format!("    {:<width$} {}", name, display_type, width = max_name_len);

        if !is_serial {
            if let Some(def) = default_expr {
                parts.push_str(&format!(" default {def}"));
            }
        }

        if *notnull && !is_serial {
            parts.push_str(" not null");
        }

        col_defs.push(parts);
    }

    // Primary key constraint
    let pk_rows = client
        .query(
            "SELECT array_agg(a.attname ORDER BY x.n) \
             FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid \
             JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, n) \
               ON a.attnum = x.attnum \
             WHERE i.indrelid = $1 AND i.indisprimary \
             GROUP BY i.indexrelid",
            &[&table_oid],
        )
        .map_err(|e| format!("failed to load primary key: {}", format_pg_error(&e)))?;

    if let Some(pk_row) = pk_rows.first() {
        let pk_cols: Vec<String> = pk_row.get(0);
        col_defs.push(format!(
            "    constraint {}_pkey primary key ({})",
            table,
            pk_cols.join(", ")
        ));
    }

    let mut ddl = format!(
        "create table {}.{}\n(\n{}\n);",
        quote_identifier(schema),
        quote_identifier(table),
        col_defs.join(",\n")
    );

    // Table owner
    let owner_rows = client
        .query(
            "SELECT pg_catalog.pg_get_userbyid(c.relowner) \
             FROM pg_class c WHERE c.oid = $1",
            &[&table_oid],
        )
        .map_err(|e| format!("failed to load owner: {}", format_pg_error(&e)))?;

    if let Some(owner_row) = owner_rows.first() {
        let owner: String = owner_row.get(0);
        ddl.push_str(&format!(
            "\n\nalter table {}.{}\n    owner to {};",
            quote_identifier(schema),
            quote_identifier(table),
            quote_identifier(&owner)
        ));
    }

    Ok(ddl)
}

pub fn export_parquet(
    connection: &SavedConnection,
    schema: &str,
    table: &str,
    path: &str,
) -> Result<usize, String> {
    use arrow_array::{ArrayRef, StringArray, RecordBatch};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use std::fs::File;
    use std::sync::Arc;

    let mut client = connect(connection)?;
    let sql = format!(
        "SELECT * FROM {}.{}",
        quote_identifier(schema),
        quote_identifier(table),
    );

    let rows = client
        .simple_query(&sql)
        .map_err(|e| format!("query failed: {}", format_pg_error(&e)))?;

    // Collect column names from the first row
    let mut columns: Vec<String> = Vec::new();
    let mut data_rows: Vec<Vec<String>> = Vec::new();

    for message in &rows {
        match message {
            postgres::SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                let mut vals = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    vals.push(row.get(i).unwrap_or("").to_string());
                }
                data_rows.push(vals);
            }
            _ => {}
        }
    }

    let row_count = data_rows.len();

    // Build Arrow schema (all string columns for simplicity)
    let fields: Vec<Field> = columns
        .iter()
        .map(|name| Field::new(name, DataType::Utf8, true))
        .collect();
    let arrow_schema = Arc::new(Schema::new(fields));

    // Build columnar arrays
    let arrays: Vec<ArrayRef> = (0..columns.len())
        .map(|col_idx| {
            let values: Vec<Option<&str>> = data_rows
                .iter()
                .map(|row| row.get(col_idx).map(|s| s.as_str()))
                .collect();
            Arc::new(StringArray::from(values)) as ArrayRef
        })
        .collect();

    let batch = RecordBatch::try_new(arrow_schema.clone(), arrays)
        .map_err(|e| format!("failed to create record batch: {e}"))?;

    let file = File::create(path).map_err(|e| format!("failed to create file: {e}"))?;
    let mut writer = ArrowWriter::try_new(file, arrow_schema, None)
        .map_err(|e| format!("failed to create parquet writer: {e}"))?;

    writer
        .write(&batch)
        .map_err(|e| format!("failed to write parquet: {e}"))?;
    writer
        .close()
        .map_err(|e| format!("failed to close parquet writer: {e}"))?;

    Ok(row_count)
}

fn connect(connection: &SavedConnection) -> Result<Client, String> {
    Client::connect(&connection.connection_string(), NoTls)
        .map_err(|error| format!("failed to connect to postgres: {}", format_pg_error(&error)))
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
