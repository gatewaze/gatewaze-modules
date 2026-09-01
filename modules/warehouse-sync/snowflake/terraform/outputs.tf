output "database" {
  description = "Ingest landing database name."
  value       = snowflake_database.ingest.name
}

output "loading_warehouse" {
  description = "Warehouse the connector + transforms run on."
  value       = snowflake_warehouse.loading.name
}

output "cdc_service_account" {
  description = "Service account the connector authenticates as."
  value       = snowflake_user.svc_cdc.name
}

output "roles" {
  description = "Provisioned least-privilege roles (§9.1)."
  value = {
    cdc            = snowflake_role.cdc.name
    staging        = snowflake_role.staging.name
    analyst        = snowflake_role.analyst.name
    pii_breakglass = snowflake_role.pii.name
  }
}
