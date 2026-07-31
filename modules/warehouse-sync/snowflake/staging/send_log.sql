-- STAGING.send_log — current-state contract (§7.2). HARD delete → tombstone
-- rows with nulled identifiers (§7.2.1, §8.3). Large fact: 30-min incremental
-- MERGE cadence (§6). RAW is Airbyte's Snowflake destination (Option B): a
-- delete is signalled by a non-null _ab_cdc_deleted_at (§7.1; see lib/sql-gen.ts
-- AIRBYTE_RAW_META).
USE ROLE AAIF_STAGING_ROLE;
USE DATABASE AAIF;

CREATE TABLE IF NOT EXISTS AAIF.STAGING.send_log (
  "id"           STRING NOT NULL,
  "person_id"    STRING,
  "email"        STRING,
  "email_sha256" STRING,
  "message_id"   STRING,
  "send_kind"    STRING,
  "source_id"    STRING,
  "status"       STRING,
  "provider"     STRING,
  "sent_at"      TIMESTAMP_NTZ,
  "created_at"   TIMESTAMP_NTZ,
  "updated_at"   TIMESTAMP_NTZ,
  "_synced_at"   TIMESTAMP_NTZ NOT NULL,
  "is_deleted"   BOOLEAN NOT NULL DEFAULT FALSE,
  "deleted_at"   TIMESTAMP_NTZ,
  PRIMARY KEY ("id")
);

MERGE INTO AAIF.STAGING.send_log AS tgt
USING (
  SELECT
    src."id"::STRING AS "id",
    src."person_id"::STRING AS "person_id",
    -- Direct identifiers NULLed on the tombstone (GDPR erasure, §7.2.1/§8.3):
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL, src."email") AS "email",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL), NULL,
        LOWER(SHA2(LOWER(TRIM(src."email")), 256))) AS "email_sha256",
    src."message_id" AS "message_id",
    src."send_kind" AS "send_kind",
    src."source_id"::STRING AS "source_id",
    src."status" AS "status",
    src."provider" AS "provider",
    CONVERT_TIMEZONE('UTC', src."sent_at")::TIMESTAMP_NTZ AS "sent_at",
    CONVERT_TIMEZONE('UTC', src."created_at")::TIMESTAMP_NTZ AS "created_at",
    CONVERT_TIMEZONE('UTC', src."updated_at")::TIMESTAMP_NTZ AS "updated_at",
    CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS "_synced_at",
    (src."_ab_cdc_deleted_at" IS NOT NULL) AS "is_deleted",
    IFF((src."_ab_cdc_deleted_at" IS NOT NULL),
        CONVERT_TIMEZONE('UTC', src."_ab_cdc_deleted_at")::TIMESTAMP_NTZ, NULL) AS "deleted_at"
  FROM AAIF.RAW.send_log AS src
) AS src2
ON tgt."id" = src2."id"
WHEN MATCHED AND (src2."updated_at" > tgt."updated_at" OR src2."is_deleted" <> tgt."is_deleted") THEN
  UPDATE SET
    tgt."person_id" = src2."person_id",
    tgt."email" = src2."email",
    tgt."email_sha256" = src2."email_sha256",
    tgt."message_id" = src2."message_id",
    tgt."send_kind" = src2."send_kind",
    tgt."source_id" = src2."source_id",
    tgt."status" = src2."status",
    tgt."provider" = src2."provider",
    tgt."sent_at" = src2."sent_at",
    tgt."created_at" = src2."created_at",
    tgt."updated_at" = src2."updated_at",
    tgt."_synced_at" = src2."_synced_at",
    tgt."is_deleted" = src2."is_deleted",
    tgt."deleted_at" = src2."deleted_at"
WHEN NOT MATCHED THEN
  INSERT ("id", "person_id", "email", "email_sha256", "message_id", "send_kind",
          "source_id", "status", "provider", "sent_at", "created_at", "updated_at",
          "_synced_at", "is_deleted", "deleted_at")
  VALUES (src2."id", src2."person_id", src2."email", src2."email_sha256", src2."message_id", src2."send_kind",
          src2."source_id", src2."status", src2."provider", src2."sent_at", src2."created_at", src2."updated_at",
          src2."_synced_at", src2."is_deleted", src2."deleted_at");
