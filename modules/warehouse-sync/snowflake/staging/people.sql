-- STAGING.people — current-state contract (§7.2). SOFT delete (deleted_at).
-- Canonical reference; matches lib/sql-gen.ts output for the people table.
USE ROLE AAIF_STAGING_ROLE;
USE DATABASE AAIF;

-- ── DDL (run once; the MERGE maintains it) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS AAIF.STAGING.people (
  "id"           STRING NOT NULL,
  "email"        STRING,
  "email_sha256" STRING,
  "full_name"    STRING,
  "first_name"   STRING,
  "last_name"    STRING,
  "contact_kind" STRING,
  "company"      STRING,
  "title"        STRING,
  "country"      STRING,
  "city"         STRING,
  "attributes"   VARIANT,
  "created_at"   TIMESTAMP_NTZ,
  "updated_at"   TIMESTAMP_NTZ,
  "deleted_at"   TIMESTAMP_NTZ,
  "_synced_at"   TIMESTAMP_NTZ NOT NULL,
  "is_deleted"   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("id")
);

-- ── Incremental MERGE (§7.2) ─────────────────────────────────────────────────
MERGE INTO AAIF.STAGING.people AS tgt
USING (
  SELECT
    src."id"::STRING AS "id",
    src."email" AS "email",
    LOWER(SHA2(LOWER(TRIM(src."email")), 256)) AS "email_sha256",
    src."full_name" AS "full_name",
    src."first_name" AS "first_name",
    src."last_name" AS "last_name",
    src."contact_kind" AS "contact_kind",
    src."company" AS "company",
    src."title" AS "title",
    src."country" AS "country",
    src."city" AS "city",
    src."attributes" AS "attributes",
    CONVERT_TIMEZONE('UTC', src."created_at")::TIMESTAMP_NTZ AS "created_at",
    CONVERT_TIMEZONE('UTC', src."updated_at")::TIMESTAMP_NTZ AS "updated_at",
    CONVERT_TIMEZONE('UTC', src."deleted_at")::TIMESTAMP_NTZ AS "deleted_at",
    CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS "_synced_at",
    (src."deleted_at" IS NOT NULL) AS "is_deleted"
  FROM AAIF.RAW.people AS src
) AS src2
ON tgt."id" = src2."id"
WHEN MATCHED AND (src2."updated_at" > tgt."updated_at" OR src2."is_deleted" <> tgt."is_deleted") THEN
  UPDATE SET
    tgt."email" = src2."email",
    tgt."email_sha256" = src2."email_sha256",
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
    tgt."deleted_at" = src2."deleted_at",
    tgt."_synced_at" = src2."_synced_at",
    tgt."is_deleted" = src2."is_deleted"
WHEN NOT MATCHED THEN
  INSERT ("id", "email", "email_sha256", "full_name", "first_name", "last_name",
          "contact_kind", "company", "title", "country", "city", "attributes",
          "created_at", "updated_at", "deleted_at", "_synced_at", "is_deleted")
  VALUES (src2."id", src2."email", src2."email_sha256", src2."full_name", src2."first_name", src2."last_name",
          src2."contact_kind", src2."company", src2."title", src2."country", src2."city", src2."attributes",
          src2."created_at", src2."updated_at", src2."deleted_at", src2."_synced_at", src2."is_deleted");
