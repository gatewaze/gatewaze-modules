# Inputs for the AAIF relational-replica Snowflake provisioning (§9).
# When contributing into lfx-snowflake-terraform, map these onto that repo's
# module variables / naming conventions.

variable "svc_cdc_public_key" {
  description = "RSA public key (PEM body, no header/footer) for SVC_<DB>_CDC key-pair auth. Injected from the LF secret store (§13); never committed."
  type        = string
  default     = ""
  sensitive   = true
}

variable "network_policy_name" {
  description = "Optional Snowflake network policy restricting ingress by IP (§9.1 network policy). Empty = none."
  type        = string
  default     = ""
}

variable "analyst_role_grants" {
  description = "Account roles that should inherit <DB>_ANALYST_ROLE (e.g. an LF analyst functional role). Wire via snowflake_grant_account_role in an environment overlay."
  type        = list(string)
  default     = []
}
