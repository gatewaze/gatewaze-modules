# Inputs for the warehouse-sync Snowflake provisioning (§9).
# On the trial you own ACCOUNTADMIN, so `terraform apply` creates everything.
# For the LF account this doubles as the CloudOps spec (they adapt names to the
# datalake's conventions).

variable "platform" {
  description = "Name prefix for all objects. Database = <platform>_INGEST, service account = SVC_<platform>_CDC, etc."
  type        = string
  default     = "GATEWAZE"
}

# ── Provider connection (supply via TF_VAR_* or a tfvars file; never commit) ──
variable "organization_name" {
  description = "Snowflake organization name (e.g. YKRDQJL)."
  type        = string
}

variable "account_name" {
  description = "Snowflake account name (e.g. QJ53915). Together: <org>-<account>."
  type        = string
}

variable "tf_user" {
  description = "User Terraform authenticates as (e.g. your trial login, or a provisioning service account)."
  type        = string
}

variable "tf_role" {
  description = "Role Terraform runs under — must be able to create databases/warehouses/roles/users. ACCOUNTADMIN on the trial."
  type        = string
  default     = "ACCOUNTADMIN"
}

# ── CDC service account key-pair ──────────────────────────────────────────────
variable "svc_cdc_public_key" {
  description = "RSA public key (PEM body, no header/footer) for SVC_<platform>_CDC key-pair auth. Airbyte's Snowflake destination uses the matching private key. From the secret store; never committed."
  type        = string
  sensitive   = true
}

# ── Network policy (§9.1 / trial PAT requirement) ────────────────────────────
variable "allowed_ips" {
  description = "IPs allowed to connect (operator machine + Airbyte cluster egress). Required on trial accounts for PAT auth. Empty = no network policy created."
  type        = list(string)
  default     = []
}
