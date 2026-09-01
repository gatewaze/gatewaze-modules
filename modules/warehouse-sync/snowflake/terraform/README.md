# Snowflake provisioning (Terraform)

Provisions the warehouse-sync destination: a `GATEWAZE_INGEST` database
(`RAW`/`STAGING`/`OPERATIONS`), a loading warehouse, least-privilege roles, the
`SVC_GATEWAZE_CDC` service account (key-pair), a network policy, and the grants.
Parameterised by `var.platform` (default `GATEWAZE`).

Two uses:
- **Trial account** — you own `ACCOUNTADMIN`, so `terraform apply` creates it all;
  prove the pipeline end-to-end.
- **LF account** — the CloudOps hand-off: the exact object set to create (they
  adapt names/roles to the datalake conventions). At the LF, engineers don't
  create databases/warehouses/roles directly, so this is a spec + review artifact.

## Apply on the trial

```bash
cd snowflake/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in org/account/user + key + IPs
export SNOWFLAKE_TOKEN="$(cat ~/.sf/test_pat.txt)"   # PAT auth
export SNOWFLAKE_AUTHENTICATOR=PROGRAMMATIC_ACCESS_TOKEN
terraform init && terraform plan && terraform apply
```

> **Bootstrap note (trial PATs):** a trial account requires a **network policy**
> before a PAT authenticates at all — a chicken-and-egg, since this Terraform is
> what creates the policy. Create a bootstrap policy once in Snowsight (browser
> auth isn't gated) allowing your IP, then Terraform can run and take over
> management. See the network-policy SQL in the pipeline notes.

## Provider auth

The `snowflake` provider version pins the exact auth attributes. This config
passes `organization_name` + `account_name` + `user` + `role`; supply the secret
via env (`SNOWFLAKE_TOKEN` for a PAT, or `SNOWFLAKE_PRIVATE_KEY_PATH` for
key-pair). Adjust the provider block to your provider version if attribute names
differ.

## Key-pair for the service account

Generate the CDC service-account key-pair (Airbyte's Snowflake destination uses
the private key):
```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out svc_gatewaze_cdc.p8 -nocrypt
openssl rsa -in svc_gatewaze_cdc.p8 -pubout -out svc_gatewaze_cdc.pub
```
Put the **public** key body (strip header/footer + newlines) in
`svc_cdc_public_key`; keep the private key in the secret store for Airbyte.
