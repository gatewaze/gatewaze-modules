# Gatewaze — data model for foundations & projects

Design for extending the platform (Supabase) schema so a single **Gatewaze**
instance models the LF's **foundation → project** hierarchy, and for how that
lands in Snowflake so it joins the LF datalake's existing org/project dimensions.

This is a **design proposal** — these source tables don't exist in Supabase yet;
it's the target the warehouse-sync manifest is built toward. Identifier names
marked `-- LFX?` need confirming against LFX's canonical scheme (see the
provisioning-request question 6).

## Principles
- **Single instance.** No per-tenant schemas — one Gatewaze platform whose
  top-level tenancy unit is a **foundation**.
- **Mirror LFX's hierarchy.** In LFX everything is a "project" with a type and a
  parent; a *foundation* is a top-level project. We model `foundations` and
  `projects` explicitly (clearer for the community platform) but carry the LFX
  identifiers so the two reconcile.
- **Carry LFX keys everywhere.** Every foundation/project row carries the LFX
  **SFID** (Salesforce 18-char) + LFX **project UUID**; every person carries the
  **LFID / LFX user id**. These are the join keys into `ANALYTICS.*_ORGANIZATION_
  DASHBOARD`, the individual dimension, and the Segment stream (`USER_ID = lfid`).

## New source tables (Supabase `public`)

```sql
-- Top-level tenancy: an LF foundation (e.g. CNCF, LF AI & Data, OpenSSF).
CREATE TABLE public.foundations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lfx_project_sfid  text UNIQUE,          -- LFX Salesforce ID (foundation)          -- LFX?
  lfx_project_id    uuid,                 -- LFX project-service UUID                 -- LFX?
  name              text NOT NULL,
  slug              text UNIQUE NOT NULL,
  status            text NOT NULL DEFAULT 'active'   -- active | archived
                     CHECK (status IN ('active','archived')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A project (or sub-project) under a foundation.
CREATE TABLE public.projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  foundation_id      uuid NOT NULL REFERENCES public.foundations(id),
  parent_project_id  uuid REFERENCES public.projects(id),   -- null = top-level project
  lfx_project_sfid   text UNIQUE,          -- LFX Salesforce ID (project)             -- LFX?
  lfx_project_id     uuid,                 -- LFX project-service UUID                 -- LFX?
  name               text NOT NULL,
  slug               text NOT NULL,
  status             text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (foundation_id, slug)
);

-- Community association of a person to a project (membership / role).
CREATE TABLE public.project_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES public.people(id),
  project_id    uuid NOT NULL REFERENCES public.projects(id),
  role          text NOT NULL DEFAULT 'member'      -- member | maintainer | contributor | staff | committee
                 CHECK (role IN ('member','maintainer','contributor','staff','committee')),
  status        text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','inactive')),
  joined_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, project_id, role)
);
CREATE INDEX ON public.project_memberships (project_id, status);
CREATE INDEX ON public.project_memberships (person_id);
```

## Changes to existing tables

```sql
-- people: surface the LFX identity as first-class columns (today lfid_sub lives
-- inside attributes jsonb; lift it so it's a clean join key, not masked jsonb).
ALTER TABLE public.people ADD COLUMN lfid           text;   -- LFID username        -- LFX?
ALTER TABLE public.people ADD COLUMN lfx_user_id    text;   -- LFX Unify user id    -- LFX?
-- (auth_user_id → auth.users already exists and maps to the Segment supabase_user_id trait)

-- events / content / sends: scope each to a project (and thereby a foundation).
ALTER TABLE public.events              ADD COLUMN project_id uuid REFERENCES public.projects(id);
-- content items, newsletter editions, resources, blog posts, etc.:
ALTER TABLE public.<content_tables>    ADD COLUMN project_id uuid REFERENCES public.projects(id);
```

`foundation_id` is derivable via `projects.foundation_id`, so we scope on
`project_id` and let the warehouse roll up to foundation.

## How it lands in Snowflake (warehouse-sync)

RAW mirrors the above 1:1 into `GATEWAZE_INGEST`. STAGING conforms it to a
star that carries the LFX keys so it joins the LF datalake:

| STAGING model | Grain | LFX conformance keys |
|---|---|---|
| `dim_foundation` | one row per foundation | `lfx_project_sfid`, `lfx_project_id` |
| `dim_project` | one row per project (+ `foundation_sfid`, `parent_project_sfid`) | `lfx_project_sfid`, `lfx_project_id` |
| `dim_person` | one row per person | `lfx_user_id`, `lfid`, `auth_user_id`, `email_sha256` |
| `fact_membership` | person × project | person + project keys |
| `fact_event` / `fact_registration` | event / registration | `project_sfid`, person keys |
| `fact_send` / `fact_engagement` | send / interaction | `project_sfid`, person keys |

Join surfaces this unlocks (all intra-account, `XMB01974`):
- **People → LF individuals + Segment:** `dim_person.lfx_user_id` ↔ the LF
  individual dimension; `= SEGMENT_INGEST.<src>.IDENTIFIES.USER_ID` (lfid) and the
  `SUPABASE_USER_ID` trait ↔ `auth_user_id`.
- **Projects/foundations → LF org dimensions:** `lfx_project_sfid` ↔
  `ANALYTICS.*_ORGANIZATION_DASHBOARD` / project dimensions.

## Manifest impact (Appendix A)
Add `foundations`, `projects`, `project_memberships` to the allow-list; add
`project_id` to `events`/content tables; surface `people.lfid` + `people.lfx_user_id`
as `join_key` columns (non-PII). These are added as **planned** entries until the
Supabase migrations land — the pipeline is designed for them now so nothing is
retrofitted later.

## Open confirmations
1. LFX's canonical identifiers — is it SFID + project UUID for foundations/
   projects, and LFX Unify user id + LFID for people? (provisioning Q6)
2. Whether a foundation should be modelled as its own table or as a top-level
   row in a unified `projects` table (LFX's own model) — the above keeps them
   separate for platform clarity but reconciles via the LFX keys.
3. Which existing content tables get `project_id` scoping.
