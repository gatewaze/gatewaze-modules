# BigQuery

Google BigQuery integration for analytics queries, materialized views, and data warehouse operations. This module provides a secure proxy Edge Function that lets the admin application execute BigQuery queries, browse datasets, inspect table schemas, and materialize query results into destination tables.

## How It Works

The module deploys a single Supabase Edge Function (`integrations-bigquery-proxy`) that acts as a secure proxy between the Gatewaze application and Google BigQuery. The proxy authenticates requests via a bearer token, handles Google OAuth JWT-based authentication using a GCP service account, and routes requests to five endpoints:

- **`/execute`** (POST) -- Run a SELECT query against BigQuery with optional named parameters. Results are transformed from BigQuery's row format into JSON objects. Query executions are logged to `bigquery_query_logs` with duration, rows returned, and bytes processed.

- **`/materialize`** (POST) -- Write query results into a destination BigQuery table using WRITE_TRUNCATE mode. Accepts either a saved query ID (looked up from `bigquery_saved_queries`) or an inline SQL + destination table. Materialization runs are logged to `bigquery_materialization_logs`.

- **`/datasets`** (GET) -- List all datasets in the configured BigQuery project.

- **`/tables`** (GET) -- List tables in a specific dataset, including row counts and sizes.

- **`/schema`** (GET) -- Get the column schema for a specific table (field names, types, modes, descriptions).

The proxy includes SQL validation that blocks dangerous keywords (DROP, DELETE, TRUNCATE, ALTER, etc.) and requires queries to start with SELECT or WITH. For materialization operations, INSERT/UPDATE/MERGE/CREATE are additionally permitted. All queries are capped at 10,000 result rows.

## Configuration

Platform credentials are configured via environment variables on the Edge Function:

| Setting | Description |
|---------|-------------|
| `BIGQUERY_PROJECT_ID` | Google Cloud project ID |
| `BIGQUERY_CREDENTIALS_JSON` | GCP service account credentials JSON |
| `BIGQUERY_LOCATION` | BigQuery location (default: `US`) |
| `GW_API_BEARER` | Bearer token for authenticating proxy requests |

## Features

- **bigquery** -- Core BigQuery integration and query execution
- **bigquery.proxy** -- Secure proxy endpoint for all BigQuery operations
- Execute read-only SQL queries with parameterized inputs
- Materialize query results into BigQuery destination tables
- Browse datasets, tables, and column schemas
- SQL injection protection with keyword blocking
- Query execution and materialization audit logging
- Google OAuth JWT authentication with service account credentials
- Results capped at 10,000 rows with metadata (bytes processed, cache hit, duration)

## Dependencies

None.
