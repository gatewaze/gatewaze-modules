# =============================================================================
# Snowflake provisioning for the AAIF relational replica (spec §9).
#
# This is the REFERENCE definition. In production these objects are contributed
# into the LF's `lfx-snowflake-terraform` repo (service account into
# service_accounts.tf, per the `lfx-snowflake-access` skill), NOT applied from
# this module directly. Kept here as reviewable, version-controlled code so the
# warehouse side stays in lockstep with the source side.
#
# Least privilege (§9.1): connector writes RAW only; transforms own STAGING +
# OPERATIONS; analysts read STAGING only; a break-glass role is the sole reader
# of unmasked PII in RAW.
# =============================================================================

terraform {
  required_providers {
    snowflake = {
      source  = "Snowflake-Labs/snowflake"
      version = "~> 0.94"
    }
  }
}

variable "brand" {
  description = "Brand code; database is upper(brand). AAIF is the first brand."
  type        = string
  default     = "aaif"
}

locals {
  db = upper(var.brand) # e.g. AAIF
}

# ── Database + medallion schemas (§6, §9.1) ──────────────────────────────────
resource "snowflake_database" "brand" {
  name    = local.db
  comment = "Relational replica of ${var.brand} Supabase public schema (spec-supabase-to-snowflake-pipeline.md)."
}

resource "snowflake_schema" "raw" {
  database = snowflake_database.brand.name
  name     = "RAW"
  comment  = "Connector-owned 1:1 replica of public.*. Never hand-edited (§6)."
}

resource "snowflake_schema" "staging" {
  database = snowflake_database.brand.name
  name     = "STAGING"
  comment  = "Typed, UTC, PII-masked, delete-aware current-state contract (§7.2)."
}

resource "snowflake_schema" "marts" {
  database = snowflake_database.brand.name
  name     = "MARTS"
  comment  = "Conformed business models. Out of scope for this spec (§6)."
}

resource "snowflake_schema" "operations" {
  database = snowflake_database.brand.name
  name     = "OPERATIONS"
  comment  = "Connector status, reconciliation results, test outputs, tombstone-purge task (§9.1)."
}

# ── Loading warehouse (§9.1) — isolated so ingestion cost is attributable ────
resource "snowflake_warehouse" "loading" {
  name                = "${local.db}_LOADING_WH"
  warehouse_size      = "XSMALL"
  auto_suspend        = 60
  auto_resume         = true
  initially_suspended = true
  comment             = "CDC ingestion + STAGING transforms. Cost guardrail ≤ 5 credits/day steady-state (§12.4)."
}

# ── Roles (§9.1) ─────────────────────────────────────────────────────────────
resource "snowflake_role" "cdc" {
  name    = "${local.db}_CDC_ROLE"
  comment = "Connector role: CREATE/INSERT/UPDATE/DELETE on RAW only."
}

resource "snowflake_role" "staging" {
  name    = "${local.db}_STAGING_ROLE"
  comment = "Transforms + tests: create/modify tables in STAGING + OPERATIONS."
}

resource "snowflake_role" "analyst" {
  name    = "${local.db}_ANALYST_ROLE"
  comment = "SELECT on STAGING (and MARTS later) only. No RAW. Sees masked PII."
}

resource "snowflake_role" "pii_breakglass" {
  name    = "${local.db}_PII_BREAKGLASS_ROLE"
  comment = "Sole reader of unmasked PII (RAW / STAGING). Time-bound via LF ticketing; audited via QUERY_HISTORY (§9.1)."
}

# ── Service account for the connector (§9.1) ─────────────────────────────────
# NOTE: in lfx-snowflake-terraform this becomes an entry in service_accounts.tf.
# Key-pair auth preferred; the public key is injected from the LF secret store.
resource "snowflake_user" "svc_cdc" {
  name         = "SVC_${local.db}_CDC"
  default_role = snowflake_role.cdc.name
  default_warehouse = snowflake_warehouse.loading.name
  comment      = "CDC connector service account (§9.1). Key-pair auth via rsa_public_key."
  # rsa_public_key = var.svc_cdc_public_key   # supply from secret store
}

resource "snowflake_grant_account_role" "svc_cdc_role" {
  role_name = snowflake_role.cdc.name
  user_name = snowflake_user.svc_cdc.name
}

# ── Warehouse usage ──────────────────────────────────────────────────────────
resource "snowflake_grant_privileges_to_account_role" "wh_cdc" {
  account_role_name = snowflake_role.cdc.name
  privileges        = ["USAGE"]
  on_account_object {
    object_type = "WAREHOUSE"
    object_name = snowflake_warehouse.loading.name
  }
}

resource "snowflake_grant_privileges_to_account_role" "wh_staging" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["USAGE"]
  on_account_object {
    object_type = "WAREHOUSE"
    object_name = snowflake_warehouse.loading.name
  }
}

# ── Database usage (all working roles) ───────────────────────────────────────
resource "snowflake_grant_privileges_to_account_role" "db_usage" {
  for_each          = toset([snowflake_role.cdc.name, snowflake_role.staging.name, snowflake_role.analyst.name, snowflake_role.pii_breakglass.name])
  account_role_name = each.value
  privileges        = ["USAGE"]
  on_account_object {
    object_type = "DATABASE"
    object_name = snowflake_database.brand.name
  }
}

# ── RAW: connector writes; staging reads; break-glass reads unmasked ─────────
resource "snowflake_grant_privileges_to_account_role" "raw_cdc" {
  account_role_name = snowflake_role.cdc.name
  privileges        = ["USAGE", "CREATE TABLE", "CREATE VIEW"]
  on_schema {
    schema_name = "\"${local.db}\".\"RAW\""
  }
}

resource "snowflake_grant_privileges_to_account_role" "raw_staging_read" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["USAGE"]
  on_schema {
    schema_name = "\"${local.db}\".\"RAW\""
  }
}

# Future-grants so new RAW tables are automatically readable by the transform
# role (which needs RAW to build STAGING) — but NOT by analysts.
resource "snowflake_grant_privileges_to_account_role" "raw_future_select_staging" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["SELECT"]
  on_schema_object {
    future {
      object_type_plural = "TABLES"
      in_schema          = "\"${local.db}\".\"RAW\""
    }
  }
}

resource "snowflake_grant_privileges_to_account_role" "raw_future_select_breakglass" {
  account_role_name = snowflake_role.pii_breakglass.name
  privileges        = ["SELECT"]
  on_schema_object {
    future {
      object_type_plural = "TABLES"
      in_schema          = "\"${local.db}\".\"RAW\""
    }
  }
}

# ── STAGING: transforms own it; analysts + break-glass read ──────────────────
resource "snowflake_grant_privileges_to_account_role" "staging_owner" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["USAGE", "CREATE TABLE", "CREATE VIEW", "CREATE MASKING POLICY", "CREATE TASK"]
  on_schema {
    schema_name = "\"${local.db}\".\"STAGING\""
  }
}

resource "snowflake_grant_privileges_to_account_role" "staging_analyst_usage" {
  for_each          = toset([snowflake_role.analyst.name, snowflake_role.pii_breakglass.name])
  account_role_name = each.value
  privileges        = ["USAGE"]
  on_schema {
    schema_name = "\"${local.db}\".\"STAGING\""
  }
}

resource "snowflake_grant_privileges_to_account_role" "staging_future_select_analyst" {
  for_each          = toset([snowflake_role.analyst.name, snowflake_role.pii_breakglass.name])
  account_role_name = each.value
  privileges        = ["SELECT"]
  on_schema_object {
    future {
      object_type_plural = "TABLES"
      in_schema          = "\"${local.db}\".\"STAGING\""
    }
  }
}

# ── OPERATIONS: transforms own it (tests + tombstone-purge task) ─────────────
resource "snowflake_grant_privileges_to_account_role" "operations_owner" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["USAGE", "CREATE TABLE", "CREATE VIEW", "CREATE TASK"]
  on_schema {
    schema_name = "\"${local.db}\".\"OPERATIONS\""
  }
}

# EXECUTE TASK is an account-level privilege required to run scheduled tasks
# (the tombstone-purge + test tasks, §7.2.1, §12.3).
resource "snowflake_grant_privileges_to_account_role" "staging_execute_task" {
  account_role_name = snowflake_role.staging.name
  privileges        = ["EXECUTE TASK"]
  on_account {}
}
