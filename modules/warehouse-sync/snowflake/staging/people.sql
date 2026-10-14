-- GENERATED from manifest/appendix-a.yaml (brand=gatewaze, manifest v1) — DO NOT EDIT BY HAND.
-- STAGING.people DDL (§7.2). Contract columns appended.
-- Regenerate: pnpm --filter @gatewaze-modules/warehouse-sync generate:sql

CREATE TABLE IF NOT EXISTS GATEWAZE_INGEST.STAGING.people (
  "id" STRING NOT NULL,
  "email" STRING,
  "email_sha256" STRING,
  "lfid" STRING,
  "lfx_user_id" STRING,
  "auth_user_id" STRING,
  "full_name" STRING,
  "first_name" STRING,
  "last_name" STRING,
  "contact_kind" STRING,
  "company" STRING,
  "title" STRING,
  "country" STRING,
  "city" STRING,
  "attributes" VARIANT,
  "created_at" TIMESTAMP_NTZ,
  "updated_at" TIMESTAMP_NTZ,
  "_synced_at" TIMESTAMP_NTZ NOT NULL,
  "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "deleted_at" TIMESTAMP_NTZ,
  PRIMARY KEY ("id")
);

-- GENERATED from manifest/appendix-a.yaml (brand=gatewaze, manifest v1) — DO NOT EDIT BY HAND.
-- STAGING.people — current-state contract (§7.2). Refresh cadence: 15 min (§6).
-- Regenerate: pnpm --filter @gatewaze-modules/warehouse-sync generate:sql

MERGE INTO GATEWAZE_INGEST.STAGING.people AS tgt
USING (
  SELECT
    src."id"::STRING AS "id",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."email") AS "email",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."lfid") AS "lfid",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."lfx_user_id") AS "lfx_user_id",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."auth_user_id"::STRING) AS "auth_user_id",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."full_name") AS "full_name",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."first_name") AS "first_name",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."last_name") AS "last_name",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."contact_kind") AS "contact_kind",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."company") AS "company",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."title") AS "title",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."country") AS "country",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."city") AS "city",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."attributes") AS "attributes",
    CONVERT_TIMEZONE('UTC', src."created_at")::TIMESTAMP_NTZ AS "created_at",
    CONVERT_TIMEZONE('UTC', src."updated_at")::TIMESTAMP_NTZ AS "updated_at",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, LOWER(SHA2(LOWER(TRIM(src."email")), 256))) AS "email_sha256",
    CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS "_synced_at",
    (src."_ab_cdc_deleted_at" IS NOT NULL) AS "is_deleted",
    CONVERT_TIMEZONE('UTC', src."_ab_cdc_deleted_at")::TIMESTAMP_NTZ AS "deleted_at"
  FROM GATEWAZE_INGEST.RAW.people AS src
) AS src2
ON tgt."id" = src2."id"
WHEN MATCHED AND (src2."updated_at" > tgt."updated_at" OR src2."is_deleted" <> tgt."is_deleted") THEN
  UPDATE SET
    tgt."id" = src2."id",
    tgt."email" = src2."email",
    tgt."lfid" = src2."lfid",
    tgt."lfx_user_id" = src2."lfx_user_id",
    tgt."auth_user_id" = src2."auth_user_id",
    tgt."full_name" = src2."full_name",
    tgt."first_name" = src2."first_name",
    tgt."last_name" = src2."last_name",
    tgt."contact_kind" = src2."contact_kind",
    tgt."company" = src2."company",
    tgt."title" = src2."title",
    tgt."country" = src2."country",
    tgt."city" = src2."city",
    tgt."attributes" = src2."attributes",
    tgt."created_at" = src2."created_at",
    tgt."updated_at" = src2."updated_at",
    tgt."email_sha256" = src2."email_sha256",
    tgt."_synced_at" = src2."_synced_at",
    tgt."is_deleted" = src2."is_deleted",
    tgt."deleted_at" = src2."deleted_at"
WHEN NOT MATCHED THEN
  INSERT ("id", "email", "lfid", "lfx_user_id", "auth_user_id", "full_name", "first_name", "last_name", "contact_kind", "company", "title", "country", "city", "attributes", "created_at", "updated_at", "email_sha256", "_synced_at", "is_deleted", "deleted_at")
  VALUES (src2."id", src2."email", src2."lfid", src2."lfx_user_id", src2."auth_user_id", src2."full_name", src2."first_name", src2."last_name", src2."contact_kind", src2."company", src2."title", src2."country", src2."city", src2."attributes", src2."created_at", src2."updated_at", src2."email_sha256", src2."_synced_at", src2."is_deleted", src2."deleted_at");
