-- ============================================================================
-- Module: compliance
-- Migration: 003_personal_data_registry
-- Description: Register where personal data lives across core and the open
-- source modules, and how erasure treats each table.
--
-- Entries for tables that aren't installed on a database are harmless: the
-- engine skips any table that doesn't exist. Modules outside this repo
-- register their own tables by calling compliance_register_personal_data()
-- from their migrations (guarded on to_regproc so compliance stays optional).
--
-- Choosing an action:
--   delete     rows that only describe this person (profile, subscriptions,
--              registrations, replies they sent, logs addressed to them)
--   anonymise  rows that feed shared totals or that we must keep (send logs,
--              consent evidence, payments): identifiers cleared, row kept
--   ignore     staff or configuration tables. If one ever holds the person's
--              address the plan stops for a human to review it.
--
-- sort_order: rows matched through a parent run first (10), then anonymise
-- (50), deletes (100), registrations (800), profiles (900), people (1000).
-- ============================================================================

DO $$
DECLARE
  e jsonb;
BEGIN
  FOREACH e IN ARRAY ARRAY[
    -- ── core ────────────────────────────────────────────────────────────────
    '{"table":"people","owner":"core","action":"delete","person":["id"],"email":["email"],"order":1000}',
    '{"table":"people_profiles","owner":"core","action":"delete","person":["person_id"],"profile":["id"],"order":900}',
    '{"table":"people_events","owner":"core","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"person_emails","owner":"core","action":"delete","person":["person_id"],"email":["email","canonical_email"]}',
    '{"table":"people_merge_audit","owner":"core","action":"delete","person":["survivor_id","dup_id"],"email":["dup_email"],"note":"Full copies of people rows removed by duplicate merges."}',
    '{"table":"mcp_group_members","owner":"core","action":"delete","person":["person_id"]}',
    '{"table":"mcp_person_grants","owner":"core","action":"delete","person":["person_id"]}',
    '{"table":"mcp_sessions","owner":"core","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"mcp_request_log","owner":"core","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"email_logs","owner":"core","action":"anonymise","email":["to_email"],"clear":["metadata"],"replace":{"to_email":"{erased_email}"},"order":50}',
    '{"table":"integration_events","owner":"core","action":"delete","json_email":[{"column":"payload","path":["email"]},{"column":"payload","path":["person","email"]},{"column":"payload","path":["record","email"]}],"note":"Outbound integration queue; completed rows are purged after 7 days anyway."}',
    '{"table":"admin_profiles","owner":"core","action":"ignore","email":["email"],"covers":["*"],"note":"Staff accounts. Offboard the admin user first, then erase."}',
    '{"table":"accounts","owner":"core","action":"ignore","email":["contact_email"],"covers":["*"],"note":"Organisation contact details. Replace the contact on the account, then erase."}',

    -- ── compliance ──────────────────────────────────────────────────────────
    '{"table":"compliance_consent_records","owner":"compliance","action":"anonymise","person":["person_id"],"email":["email"],"clear":["ip_address","user_agent"],"replace":{"email":"{erased_email}"},"order":50,"note":"Kept without identifiers as evidence of what consent was given and withdrawn."}',
    '{"table":"compliance_privacy_requests","owner":"compliance","action":"anonymise","person":["subject_person_id"],"covers":["subject_email","requester_email","subject_emails","subject_email_sha256"],"order":50,"note":"The request itself. Its addresses are replaced with hashes when the request completes."}',
    '{"table":"compliance_data_breach_affected_people","owner":"compliance","action":"delete","person":["person_id"]}',
    '{"table":"compliance_suppressions","owner":"compliance","action":"ignore","covers":["*"],"note":"Hashes only."}',
    '{"table":"compliance_personal_data_registry","owner":"compliance","action":"ignore","covers":["*"]}',

    -- ── events ──────────────────────────────────────────────────────────────
    '{"table":"events_registrations","owner":"events","action":"delete","person":["person_id"],"profile":["people_profile_id"],"registration":["id"],"order":800}',
    '{"table":"events_attendance","owner":"events","action":"delete","person":["person_id"],"profile":["people_profile_id"],"registration":["registration_id"],"covers":["full_name"]}',
    '{"table":"events","owner":"events","action":"ignore","covers":["*"],"note":"Event records. venue_address is a place, not a person."}',
    '{"table":"events_communication_settings","owner":"events","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"events_interest","owner":"event-interest","action":"delete","person":["person_id"],"profile":["people_profile_id"],"registration":["converted_to_registration_id"],"email":["email"]}',
    '{"table":"events_attendee_matches","owner":"attendee-matching","action":"delete","registration":["registration_a_id","registration_b_id"]}',
    '{"table":"events_match_email_settings","owner":"attendee-matching","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"events_sponsor_profiles","owner":"event-sponsors","action":"ignore","email":["contact_email"],"covers":["*"],"note":"Sponsor company contact. Replace the contact, then erase."}',
    '{"table":"events_suppliers","owner":"event-budget","action":"ignore","email":["email"],"covers":["*"],"note":"Supplier company contact. Replace the contact, then erase."}',

    -- ── event invites / seating ─────────────────────────────────────────────
    '{"table":"invite_parties","owner":"event-invites","action":"anonymise","parent":{"table":"invite_party_members","column":"id","parent_column":"party_id"},"clear":["address","address_lat","address_lng","notes"],"replace":{"name":"{erased}"},"order":10,"note":"Parties the person belonged to lose their address and name."}',
    '{"table":"event_invite_interactions","owner":"event-invites","action":"anonymise","parent":{"table":"invite_party_members","column":"party_id","parent_column":"party_id"},"clear":["ip_address","user_agent"],"order":10}',
    '{"table":"invite_party_member_events","owner":"event-invites","action":"delete","registration":["registration_id"]}',
    '{"table":"invite_party_members","owner":"event-invites","action":"delete","person":["person_id"],"email":["email"],"phone":["phone"]}',
    '{"table":"event_invites","owner":"event-invites","action":"delete","profile":["people_profile_id"],"email":["email"]}',
    '{"table":"event_invites_legacy","owner":"event-invites","action":"delete","profile":["people_profile_id"],"registration":["registration_id"],"email":["email"]}',

    -- ── calendars ───────────────────────────────────────────────────────────
    '{"table":"calendars_interactions","owner":"calendars","action":"anonymise","parent":{"table":"calendars_invites","column":"invite_id"},"clear":["ip_address","user_agent","city","country"],"order":10}',
    '{"table":"calendars_members","owner":"calendars","action":"delete","person":["person_id"],"profile":["people_profile_id"],"email":["email"]}',
    '{"table":"calendars_invites","owner":"calendars","action":"delete","profile":["people_profile_id"],"registration":["registration_id"]}',
    '{"table":"calendars_preferences","owner":"calendars","action":"delete","profile":["people_profile_id"]}',
    '{"table":"calendar_email_forwards","owner":"calendars","action":"anonymise","email":["from_address"],"email_array":["recipients"],"clear":["from_name","recipients"],"replace":{"from_address":"{erased_email}"},"covers":["to_address"],"order":50,"note":"to_address is the calendar inbox, not a person."}',
    '{"table":"calendars_blasts","owner":"calendars","action":"ignore","covers":["*"]}',

    -- ── badge scanning ──────────────────────────────────────────────────────
    '{"table":"events_badge_prints","owner":"badge-scanning","action":"delete","profile":["people_profile_id"],"registration":["event_registration_id"]}',
    '{"table":"events_qr_access_tokens","owner":"badge-scanning","action":"delete","profile":["people_profile_id"]}',
    '{"table":"events_contact_scans","owner":"badge-scanning","action":"delete","profile":["scanner_people_profile_id","scanned_people_profile_id"]}',

    -- ── competitions / discounts / offers ───────────────────────────────────
    '{"table":"events_competition_entries","owner":"competitions","action":"delete","person":["person_id"],"profile":["member_profile_id"],"email":["email"]}',
    '{"table":"events_competition_winners","owner":"competitions","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"events_competition_interactions","owner":"competitions","action":"delete","email":["email"],"cio":["customer_cio_id"]}',
    '{"table":"events_discount_codes","owner":"discounts","action":"anonymise","profile":["member_profile_id"],"email":["issued_to"],"order":50,"note":"Codes stay in the pool; only the link to the person is removed."}',
    '{"table":"events_discount_claims","owner":"discounts","action":"delete","profile":["member_profile_id"],"email":["email"]}',
    '{"table":"events_discount_interactions","owner":"discounts","action":"delete","email":["email"],"cio":["customer_cio_id"]}',
    '{"table":"integrations_offer_interactions","owner":"offers","action":"delete","email":["email"],"cio":["customer_cio_id"]}',
    '{"table":"integrations_download_logs","owner":"offers","action":"delete","person":["person_id"],"email":["email"]}',

    -- ── conversations / virtual events ──────────────────────────────────────
    '{"table":"conversations_messages","entry":"moderator","owner":"conversations","action":"anonymise","person":["deleted_by"],"order":50}',
    '{"table":"conversations_messages","owner":"conversations","action":"delete","person":["person_id"]}',
    '{"table":"conversations_participants","owner":"conversations","action":"delete","person":["person_id"]}',
    '{"table":"conversations_reactions","owner":"conversations","action":"delete","person":["person_id"]}',
    '{"table":"conversations_blocked_users","owner":"conversations","action":"delete","person":["person_id","blocked_by"]}',
    '{"table":"conversations_notifications","owner":"conversations","action":"delete","person":["recipient_id"]}',
    '{"table":"conversations_reports","owner":"conversations","action":"delete","person":["reported_by"]}',
    '{"table":"push_tokens","owner":"conversations","action":"delete","person":["person_id"]}',
    '{"table":"live_chat_messages","entry":"moderator","owner":"virtual-events","action":"anonymise","person":["deleted_by"],"order":50}',
    '{"table":"live_chat_messages","owner":"virtual-events","action":"delete","person":["person_id"]}',
    '{"table":"live_chat_reactions","owner":"virtual-events","action":"delete","person":["person_id"]}',
    '{"table":"live_chat_pinned_messages","owner":"virtual-events","action":"delete","person":["pinned_by"]}',
    '{"table":"live_chat_blocked_users","owner":"virtual-events","action":"delete","person":["person_id","blocked_by"]}',
    '{"table":"live_event_viewer_log","owner":"virtual-events","action":"delete","person":["person_id"]}',

    -- ── engagement / signals / segments / lists / forms / surveys ───────────
    '{"table":"engagement_events","owner":"engagement","action":"delete","person":["person_id"]}',
    '{"table":"engagement_member_badges","owner":"engagement","action":"delete","person":["person_id"]}',
    '{"table":"engagement_badge_eval_queue","owner":"engagement","action":"delete","person":["person_id"]}',
    '{"table":"engagement_outbox","owner":"engagement","action":"delete","person":["person_id"]}',
    '{"table":"signals_interests","owner":"signals","action":"delete","person":["person_id"]}',
    '{"table":"signals_fires","owner":"signals","action":"delete","person":["person_id"]}',
    '{"table":"signals_audience_members","owner":"signals","action":"delete","person":["person_id"]}',
    '{"table":"person_member_organizations","owner":"core","action":"delete","person":["person_id"]}',
    '{"table":"segments_memberships","owner":"segments","action":"delete","person":["person_id"]}',
    '{"table":"segments_people_memberships","owner":"segments","action":"delete","cio":["customer_cio_id"]}',
    '{"table":"segments","owner":"segments","action":"anonymise","person":["created_by_person_id"],"order":50,"note":"Segments the person saved through MCP stay, without the owner."}',
    '{"table":"list_subscriptions","owner":"lists","action":"delete","person":["person_id"],"email":["email"],"note":"Replaced by the suppression hash, which stops any re-subscription."}',
    '{"table":"list_webhook_logs","owner":"lists","action":"delete","email":["email"]}',
    '{"table":"forms_submissions","owner":"forms","action":"delete","person":["person_id"]}',
    '{"table":"surveys_submissions","owner":"surveys","action":"delete","auth":["user_id"],"email":["user_email"]}',

    -- ── scrapers / blog / cohorts ───────────────────────────────────────────
    '{"table":"events_assigned_hosts","owner":"scrapers","action":"delete","person":["person_id"]}',
    '{"table":"event_hosts","owner":"scrapers","action":"delete","email":["email"],"note":"Scraped organiser profiles."}',
    '{"table":"blog_authors","owner":"blog","action":"anonymise","person":["person_id"],"clear":["avatar_url","bio","source_url"],"replace":{"display_name":"Former contributor"},"order":50,"note":"Posts stay published under a neutral author name."}',
    '{"table":"cohorts_enrollments","owner":"cohorts","action":"anonymise","person":["person_id"],"auth":["user_id"],"order":50,"note":"Payment references are kept for financial records."}',
    '{"table":"cohorts_instructor_profiles","owner":"cohorts","action":"delete","person":["person_id"],"email":["email"],"cio":["customer_cio_id"]}',
    '{"table":"cohorts_user_progress","owner":"cohorts","action":"delete","auth":["user_id"]}',

    -- ── speakers ────────────────────────────────────────────────────────────
    '{"table":"speaker_promo_kits","owner":"event-speakers","action":"delete","parent":{"table":"events_speaker_profiles","column":"speaker_profile_id"},"order":10}',
    '{"table":"events_speakers","owner":"event-speakers","action":"delete","profile":["people_profile_id"],"parent":{"table":"events_speaker_profiles","column":"speaker_profile_id"},"order":20}',
    '{"table":"events_speaker_profiles","owner":"event-speakers","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"events_talks","owner":"event-speakers","action":"anonymise","email":["submitter_email"],"clear":["submitter_name","edit_token","confirmation_token"],"order":50,"note":"The talk stays in the published agenda without the submitter."}',
    '{"table":"speaker_presentation_reminders","owner":"event-speakers","action":"delete","email":["recipient_email"]}',
    '{"table":"speakers_merge_audit","owner":"event-speakers","action":"delete","email":["canonical_email"]}',

    -- ── event media ─────────────────────────────────────────────────────────
    '{"table":"events_media_guest_blocks","owner":"event-media","action":"delete","person":["member_id"]}',
    '{"table":"events_media_guest_claims","owner":"event-media","action":"delete","person":["member_id"]}',

    -- ── integrations ────────────────────────────────────────────────────────
    '{"table":"integrations_luma_event_registrations","owner":"luma","action":"delete","person":["created_person_id"],"profile":["created_people_profile_id"],"registration":["created_registration_id"],"email":["email"],"phone":["phone_number"]}',
    '{"table":"integrations_luma_pending_registrations","owner":"luma","action":"delete","person":["created_person_id"],"profile":["created_people_profile_id"],"registration":["created_registration_id"],"email":["matched_email","email_from"],"covers":["email_to"]}',
    '{"table":"integrations_luma_calendar_members","owner":"luma","action":"delete","email":["email"]}',
    '{"table":"integrations_gradual_pending_registrations","entry":"referrer","owner":"gradual","action":"anonymise","email":["referring_user_email"],"clear":["referring_user_id"],"order":50}',
    '{"table":"integrations_gradual_pending_registrations","owner":"gradual","action":"delete","person":["created_person_id"],"profile":["created_people_profile_id"],"registration":["created_registration_id"],"email":["user_email"]}',
    '{"table":"integrations_gradual_pending_attendance","owner":"gradual","action":"delete","email":["user_email"]}',
    '{"table":"integrations_gradual_webhook_events","owner":"gradual","action":"delete","email":["user_email"]}',
    '{"table":"integrations_slack_welcome_log","owner":"slack","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"integrations_slack_invitation_queue","owner":"slack","action":"delete","email":["email"]}',
    '{"table":"integrations_slack_notifications","owner":"slack","action":"ignore","email":["user_email"],"covers":["*"],"note":"Staff notification settings."}',
    '{"table":"integrations_slack_user_tokens","owner":"slack","action":"ignore","email":["user_email"],"covers":["*"],"note":"Staff Slack tokens."}',
    '{"table":"integrations_ad_tracking_sessions","owner":"event-tracking","action":"anonymise","registration":["matched_registration_id"],"clear":["ip_address","user_agent","click_ids"],"order":50}',
    '{"table":"integrations_conversion_log","owner":"event-tracking","action":"anonymise","registration":["registration_id"],"order":50}',
    '{"table":"google_sheets_notification_logs","owner":"google-sheets","action":"delete","json_email":[{"column":"row_data","path":["email"]},{"column":"row_data","path":["Email"]}]}',
    '{"table":"event_google_sheets_notifications","owner":"google-sheets","action":"ignore","email":["google_user_email"],"covers":["*"],"note":"Staff Google connection."}',
    '{"table":"payments_stripe_customers","owner":"stripe-payments","action":"anonymise","email":["email"],"clear":["phone","description","metadata"],"replace":{"email":"{erased_email}","name":"{erased}"},"order":50,"retain":{"reason":"Payment records","basis":"Legal obligation to keep financial records (GDPR Art. 6(1)(c), 17(3)(b))","period":"As long as tax law requires, usually 6 to 7 years. The Stripe account keeps the original."}}',
    '{"table":"payments_stripe_transactions","owner":"stripe-payments","action":"anonymise","person":["person_id"],"email":["receipt_email"],"clear":["metadata","description"],"order":50,"retain":{"reason":"Payment records","basis":"Legal obligation to keep financial records (GDPR Art. 6(1)(c), 17(3)(b))","period":"As long as tax law requires, usually 6 to 7 years."}}',

    -- ── email sending ───────────────────────────────────────────────────────
    '{"table":"email_interactions","owner":"bulk-emailing","action":"anonymise","parent":{"table":"email_send_log","column":"email_send_log_id"},"clear":["ip_address","user_agent","ip_geo_country"],"order":10,"note":"Opens and clicks stay counted, without IP or device."}',
    '{"table":"email_send_log","owner":"bulk-emailing","action":"anonymise","person":["recipient_customer_id"],"email":["recipient_email"],"clear":["content_html","template_variables","metadata","reply_to"],"replace":{"recipient_email":"{erased_email}"},"covers":["from_address"],"order":20,"note":"Send counts and delivery stats stay correct; the recipient and message body are removed."}',
    '{"table":"email_events","owner":"bulk-emailing","action":"delete","email":["email","recipient"]}',
    '{"table":"email_subscriptions","owner":"bulk-emailing","action":"delete","email":["email"]}',
    '{"table":"channel_consent","owner":"bulk-emailing","action":"delete","person":["person_id"],"email":["address"],"note":"Replaced by the suppression hash."}',
    '{"table":"bulk_send_recipients","owner":"bulk-emailing","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"email_batch_job_recipients","owner":"bulk-emailing","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"email_batch_jobs","owner":"bulk-emailing","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"notification_logs","owner":"bulk-emailing","action":"delete","person":["recipient_id"],"email":["recipient_email"]}',
    '{"table":"inbound_emails","owner":"bulk-emailing","action":"delete","email":["from_email"],"covers":["to_addresses"],"note":"to_addresses are our own inboxes."}',
    '{"table":"event_reply_messages","owner":"bulk-emailing","action":"delete","email":["to_email","to_address","from_email","from_address"],"parent":{"table":"event_replies","column":"reply_id"},"order":10}',
    '{"table":"event_replies","owner":"bulk-emailing","action":"delete","email":["from_email"]}',
    '{"table":"broadcast_send_recipients","owner":"broadcasts","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"broadcast_suppressions","owner":"broadcasts","action":"delete","email":["email"],"note":"Replaced by the suppression hash."}',
    '{"table":"broadcast_reply_messages","owner":"broadcasts","action":"delete","email":["from_address","to_address"],"parent":{"table":"broadcast_replies","column":"reply_id"},"order":10}',
    '{"table":"broadcast_replies","owner":"broadcasts","action":"delete","email":["from_email"]}',
    '{"table":"plays_send_recipients","owner":"broadcasts","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"broadcasts","owner":"broadcasts","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"broadcast_sends","owner":"broadcasts","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"newsletter_send_recipients","owner":"newsletters","action":"delete","person":["person_id"],"email":["email"]}',
    '{"table":"cio_recipient_engagement","owner":"newsletters","action":"delete","email":["recipient_email"],"cio":["cio_id"]}',
    '{"table":"newsletter_reply_messages","owner":"newsletters","action":"delete","email":["from_address","to_address"],"parent":{"table":"newsletter_replies","column":"reply_id"},"order":10}',
    '{"table":"newsletter_replies","owner":"newsletters","action":"delete","email":["from_email"]}',
    '{"table":"newsletter_sends","owner":"newsletters","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"newsletters_template_collections","owner":"newsletters","action":"ignore","covers":["*"],"note":"Sender configuration."}',
    '{"table":"send_test_arrivals","owner":"send-testing","action":"delete","email":["recipient_email"]}',
    '{"table":"sms_send_log","owner":"twilio-sms","action":"delete","phone":["to_number"]}',
    '{"table":"whatsapp_send_log","owner":"whatsapp","action":"delete","phone":["to_number"]}',

    -- ── staff and platform configuration ────────────────────────────────────
    '{"table":"host_media_signed_url_log","owner":"host-media","action":"ignore","covers":["*"],"note":"Access log for signed media links, keyed by staff user."}',
    '{"table":"custom_domains","owner":"custom-domains","action":"ignore","covers":["*"]}',
    '{"table":"ai_mcp_servers","owner":"ai","action":"ignore","covers":["*"]}',
    '{"table":"ai_use_case_templates","owner":"ai","action":"ignore","covers":["*"]}',
    '{"table":"content_triage_user_prefs","owner":"content-triage","action":"ignore","covers":["*"],"note":"Staff preferences."}',
    '{"table":"task_user_prefs","owner":"tasks","action":"ignore","covers":["*"],"note":"Staff preferences."}',
    '{"table":"se_identity_map","owner":"software-engineer","action":"ignore","covers":["*"],"note":"Staff GitHub identities."}',
    '{"table":"se_projects","owner":"software-engineer","action":"ignore","covers":["*"]}',
    '{"table":"se_runs","owner":"software-engineer","action":"ignore","covers":["*"]}',
    '{"table":"service_token_issuance","owner":"core","action":"ignore","covers":["*"],"note":"Service-to-service tokens."}'
  ]::jsonb[]
  LOOP
    PERFORM public.compliance_register_personal_data(e);
  END LOOP;
END $$;
