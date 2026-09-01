# =============================================================================
# warehouse-sync — Snowflake provisioning (Gatewaze ingest source).
#
# Parameterised by var.platform (default GATEWAZE) so it's a reusable module
# AND the concrete CloudOps hand-off. Applies cleanly to a trial account (you own
# ACCOUNTADMIN) and documents exactly what CloudOps needs to create in the LF
# account (they adapt names to the datalake's conventions).
#
# Object set (§9): one ingest database (brand-per-instance, single tenant), a
# loading warehouse, least-privilege roles, a CDC service account (key-pair), a
# network policy, and the grants. STAGING/OPERATIONS schemas are included so the
# full RAW→STAGING medallion can be proven on the trial; in the LF account the
# downstream modelling may instead be your dbt into ANALYTICS (see the
# provisioning request).
# =============================================================================

terraform {
  required_providers {
    snowflake = {
      source  = "Snowflake-Labs/snowflake"
      version = "~> 0.94"
    }
  }
}

# Auth: on the trial, a key-pair or PAT for a role that can create account
# objects (ACCOUNTADMIN/SYSADMIN). Configure via TF_VAR_* / provider env vars;
# never commit credentials.
provider "snowflake" {
  organization_name = var.organization_name
  account_name      = var.account_name
  user              = var.tf_user
  role              = var.tf_role # ACCOUNTADMIN on the trial
  # authenticator / private_key / token supplied via environment (see README).
}

locals {
  p        = upper(var.platform)          # GATEWAZE
  db       = "${local.p}_INGEST"          # GATEWAZE_INGEST
  wh       = "${local.p}_LOADING_WH"
  svc      = "SVC_${local.p}_CDC"
  role_cdc = "${local.p}_CDC_ROLE"
  role_stg = "${local.p}_STAGING_ROLE"
  role_ro  = "${local.p}_ANALYST_ROLE"
  role_pii = "${local.p}_PII_BREAKGLASS_ROLE"
}

# ── Ingest database + schemas (§6) ───────────────────────────────────────────
resource "snowflake_database" "ingest" {
  name    = local.db
  comment = "${var.platform} relational replica landing (Airbyte CDC). warehouse-sync module."
}

resource "snowflake_schema" "raw" {
  database = snowflake_database.ingest.name
  name     = "RAW"
  comment  = "Connector-owned 1:1 replica. Airbyte writes here; never hand-edited."
}

resource "snowflake_schema" "staging" {
  database = snowflake_database.ingest.name
  name     = "STAGING"
  comment  = "Typed, UTC, PII-masked, delete-aware current-state contract (§7.2)."
}

resource "snowflake_schema" "operations" {
  database = snowflake_database.ingest.name
  name     = "OPERATIONS"
  comment  = "Reconciliation, test outputs, tombstone-purge task (§9.1)."
}

# ── Loading warehouse (§9.1) ─────────────────────────────────────────────────
resource "snowflake_warehouse" "loading" {
  name                = local.wh
  warehouse_size      = "XSMALL"
  auto_suspend        = 60
  auto_resume         = true
  initially_suspended = true
  comment             = "Ingest + STAGING transforms. Cost guardrail ≤ 5 credits/day (§12.4)."
}

# ── Roles (§9.1) ─────────────────────────────────────────────────────────────
resource "snowflake_role" "cdc"     { name = local.role_cdc, comment = "Airbyte connector: write RAW only." }
resource "snowflake_role" "staging" { name = local.role_stg, comment = "Transforms + tests: STAGING/OPERATIONS." }
resource "snowflake_role" "analyst" { name = local.role_ro,  comment = "SELECT on STAGING only; masked PII; no RAW." }
resource "snowflake_role" "pii"     { name = local.role_pii, comment = "Sole reader of unmasked PII; time-bound." }

# ── CDC service account (key-pair) ───────────────────────────────────────────
resource "snowflake_user" "svc_cdc" {
  name              = local.svc
  default_role      = snowflake_role.cdc.name
  default_warehouse = snowflake_warehouse.loading.name
  rsa_public_key    = var.svc_cdc_public_key # PEM body, no header/footer; from the secret store
  comment           = "${var.platform} CDC connector (Airbyte) service account."
}

resource "snowflake_grant_account_role" "svc_cdc_role" {
  role_name = snowflake_role.cdc.name
  user_name = snowflake_user.svc_cdc.name
}

# ── Network policy (§9.1 / trial PAT requirement) ────────────────────────────
# On the trial, PAT auth REQUIRES a network policy. Also the allowlist Airbyte
# connects from. In the LF account CloudOps manages network policy separately.
resource "snowflake_network_policy" "this" {
  count           = length(var.allowed_ips) > 0 ? 1 : 0
  name            = "${local.p}_POLICY"
  allowed_ip_list = var.allowed_ips
  comment         = "warehouse-sync: operator + Airbyte-cluster egress IPs."
}

# ── Warehouse usage ──────────────────────────────────────────────────────────
resource "snowflake_grant_privileges_to_account_role" "wh_use" {
  for_each          = toset([snowflake_role.cdc.name, snowflake_role.staging.name])
  account_role_name = each.value
  privileges        = ["USAGE"]
  on_account_object {
    object_type = "WAREHOUSE"
    object_name = snowflake_warehouse.loading.name
  }
}

# ── Database usage (all working roles) ───────────────────────────────────────
resource "snowflake_grant_privileges_to_account_role" "db_use" {
  for_each          = toset([snowflake_role.cdc.name, snowflake_role.staging.name, snowflake_role.analyst.name, snowflake_role.pii.name])
  account_role_name = each.value
  privileges        = ["USAGE"]
  on_account_object {
    object_type = "DATABASE"
    object_name = snowflake_database.ingest.name
  }
}

# ── RAW: Airbyte writes (create schemas/tables + DML); staging + break-glass read
resource "snowflake_grant_privileges_to_account_role" "raw_cdc" {
  account_role_name = snowflake_role.cdc.name
  privileges        = ["USAGE", "CREATE SCHEMA", "CREATE TABLE", "CREATE VIEW"]
  on_schema { schema_name = "\"${local.db}\".\"RAW\"" }
}
resource "snowflake_grant_privileges_to_account_role" "raw_cdc_dml_future" {
  account_role_name = snowflake_role.cdc.name
  privileges        = ["INSERT", "UPDATE", "DELETE", "SELECT", "TRUNCATE"]
  on_schema_object {
    future { object_type_plural = "TABLES", in_schema = "\"${local.db}\".\"RAW\"" }
  }
}
resource "snowflake_grant_privileges_to_account_role" "raw_read_future" {
  for_each          = toset([snowflake_role.staging.name, snowflake_role.pii.name])
  account_role_name = each.value
  privileges        = ["SELECT"]
  on_schema_object {
    future { object_type_plural = "TABLES", in_schema = "\"${local.db}\".\"RAW\"" }
  }
}

# ── STAGING: transforms own it; analysts + break-glass read ──────────────────
resource "snowflake_grant_privileges_to_account_role" "staging_owner" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["USAGE", "CREATE TABLE", "CREATE VIEW", "CREATE MASKING POLICY", "CREATE TASK"]
  on_schema { schema_name = "\"${local.db}\".\"STAGING\"" }
}
resource "snowflake_grant_privileges_to_account_role" "staging_read" {
  for_each          = toset([snowflake_role.analyst.name, snowflake_role.pii.name])
  account_role_name = each.value
  privileges        = ["USAGE"]
  on_schema { schema_name = "\"${local.db}\".\"STAGING\"" }
}
resource "snowflake_grant_privileges_to_account_role" "staging_read_future" {
  for_each          = toset([snowflake_role.analyst.name, snowflake_role.pii.name])
  account_role_name = each.value
  privileges        = ["SELECT"]
  on_schema_object {
    future { object_type_plural = "TABLES", in_schema = "\"${local.db}\".\"STAGING\"" }
  }
}

# ── OPERATIONS: transforms own it ────────────────────────────────────────────
resource "snowflake_grant_privileges_to_account_role" "ops_owner" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["USAGE", "CREATE TABLE", "CREATE VIEW", "CREATE TASK"]
  on_schema { schema_name = "\"${local.db}\".\"OPERATIONS\"" }
}
resource "snowflake_grant_privileges_to_account_role" "staging_exec_task" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["EXECUTE TASK"]
  on_account {}
}
