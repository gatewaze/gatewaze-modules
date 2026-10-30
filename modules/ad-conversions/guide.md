# Ad Conversions

Server-side conversion events for Meta (Facebook/Instagram), Reddit and LinkedIn ad campaigns. When a registration is created, the module sends a conversion to each configured platform's Conversions API with a hashed email and, where the click came through the Gatewaze tracking redirect, the platform's click id, IP and user agent. This gives attribution without relying on tags the registration page (for example Luma) cannot load.

## How it works

1. **Click capture.** An ad lands on the portal redirect `/e/<event slug>?fbclid=…` (or `rdt_cid`, `li_fat_id`, plus UTMs). The portal writes a row to `integrations_ad_tracking_sessions` (event-tracking module) and redirects to the event's registration link with `utm_source={platform}__{session_id}`. Luma stores that as the guest's `custom_source`, which comes back to us in the manager notification email, the webhook and the guest CSV.
2. **Registration.** Every registration path (Luma email, Luma webhook, Luma CSV, portal form) inserts into `events_registrations`. The Luma paths store the session id and the raw `utm_source` in `registration_metadata`.
3. **Dispatch.** The `send_conversion_on_registration` trigger (migration 001) fires after each insert and posts `{registrationId}` to the `integrations-send-conversion` edge function through pg_net. It skips cancelled rows and registrations older than 7 days (a backfilled CSV is not a fresh conversion).
4. **Matching.** The dispatcher finds the tracking session in three tiers: the session id from the registration metadata, then SHA-256 email plus event, then a session for the same event in the last 30 minutes that was not redirected off site.
5. **Consent.** A matched session carries the visitor's marketing consent (`tracking_consent`, `consented_platforms`). If the session records a refusal or no consent, nothing is sent for that registration, not even the hashed email. With consent, session data (click id, cookies, IP, user agent) goes only to the platforms the visitor consented to. A registration with no session at all is sent as a hashed email only, which is the same signal as the warehouse export of registrations.
6. **Sending.** For each platform with an active config, the dispatcher calls the platform function. With a matched session, a platform is only sent when its own click id is present. Each attempt is written to `integrations_conversion_log` with the response.

Edge functions: `integrations-send-conversion` (dispatcher), `integrations-send-meta-conversion`, `integrations-send-reddit-conversion`, `integrations-send-linkedin-conversion`. All four require `Authorization: Bearer <service-role key>`; the trigger and the dispatcher supply it.

## Setup on an instance

The trigger is a no-op until it can reach the edge functions. Store the Supabase URL and the service-role key in Vault once per instance (SQL, as a superuser):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'gw_supabase_url');
select vault.create_secret('<service role key>', 'gw_service_role_key');
```

`app.supabase_url` / `app.service_role_key` database settings are honoured as a fallback. pg_net must be enabled (`create extension pg_net`).

Deploy the four edge functions (nothing in CI deploys edge functions).

## Platform credentials

Credentials live in `ad_platform_configs`. Super admins manage rows in the admin Tracking tab; the edge functions read them with the service role through `get_ad_platform_config`. A row is scoped to an event (`event_id`), an account (`account_id`) or the whole brand (both null); resolution is event, then account, then brand. Environment variables on the edge functions are the last fallback.

| Platform | `credentials` keys | Env fallback |
|---|---|---|
| meta | `pixel_id`, `access_token`, `test_event_code?` | `META_PIXEL_ID`, `META_ACCESS_TOKEN`, `META_TEST_EVENT_CODE` |
| reddit | `pixel_id`, `access_token`, `test_mode?` | `REDDIT_PIXEL_ID`, `REDDIT_ACCESS_TOKEN`, `REDDIT_TEST_MODE` |
| linkedin | `conversion_id` (rule id or `urn:lla:llaPartnerConversion:<id>`), `access_token`, `purchase_conversion_id?`, `api_version?` (YYYYMM) | `LINKEDIN_CONVERSION_ID`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PURCHASE_CONVERSION_ID`, `LINKEDIN_API_VERSION` |

Brand-wide example:

```sql
insert into ad_platform_configs (brand_id, platform, credentials)
values ('aaif', 'linkedin', '{"conversion_id": "123456", "access_token": "…"}');
```

LinkedIn notes: the conversion rule must have `conversionMethod = CONVERSIONS_API` and be associated with the campaigns; the OAuth token needs `rw_conversions` and `r_ads` and expires after 60 days, so rotate it. LinkedIn rejects events older than 90 days; Meta's window is 7 days.

## Checking it is working

```sql
-- was the dispatch queued and answered?
select id, status_code, left(content::text, 200) from net._http_response order by id desc limit 5;
-- what was sent, and what the platform said
select platform, event_name, status, http_status, error_message, created_at
from integrations_conversion_log order by created_at desc limit 20;
-- sessions that converted
select session_id, status, matched_via, conversions_sent from integrations_ad_tracking_sessions
where status = 'converted' order by updated_at desc limit 20;
```

## Features

- **ad-conversions** -- Dispatch and tracking session matching
- **ad-conversions.meta** -- Meta Conversions API (hashed email, fbc/fbp, Lead or Purchase)
- **ad-conversions.reddit** -- Reddit Conversions API (hashed email, rdt_cid, _rdt_uuid, SignUp or Purchase)
- **ad-conversions.linkedin** -- LinkedIn Conversions API (SHA256 email, li_fat_id, IP, optional purchase rule)

## Dependencies

- **events** -- registrations
- **event-tracking** -- `integrations_ad_tracking_sessions` and `integrations_conversion_log`
