# dbt option for STAGING transforms

The spec (§6, open Q13) allows the STAGING layer to be built by **dbt** or by
**Snowflake tasks**; the default is tables + incremental `MERGE`. The canonical
SQL under `../staging` and `../operations` is dbt-agnostic and runs as-is via
tasks or `snowsql`.

If Phase 0 picks dbt, model each `../staging/<table>.sql` as an **incremental**
model:

```sql
{{ config(materialized='incremental', unique_key='id', incremental_strategy='merge') }}
```

and port the daily/weekly assertions in `../operations/tests_*.sql` to dbt
tests / `dbt build`. Keep the STAGING object names identical so downstream
consumers are unaffected across a tasks↔dbt switch (§15 consumer stability).

Whichever runner is chosen:

- STAGING models are **tables** refreshed on a cadence (core 15 min, large facts
  30 min — §6), not views (views only for small reference tables).
- Each model run is **atomic per target** (`MERGE`): a failed run leaves the
  prior table intact — stale but consistent (§6).
- The masking policies (`../staging/masking_policies.sql`) and the
  tombstone-purge task (`../operations/operations_ddl.sql`) are managed
  separately from the model runs.
