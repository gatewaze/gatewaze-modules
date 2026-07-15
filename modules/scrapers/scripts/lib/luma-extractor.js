/**
 * Luma host + speaker extraction.
 *
 * Hosts come from the structured `__NEXT_DATA__` on the event page — no AI needed.
 * Speakers are extracted from the event description HTML using Claude Sonnet,
 * because speaker/talk info on Luma is freeform prose inside the description.
 *
 * This module is called by LumaICalScraper and LumaSearchScraper after each
 * event page is fetched. It writes to:
 *   - event_hosts + event_host_events (always, if tables exist)
 *   - speakers + event_speakers + talks (only if the event-speakers module is enabled)
 */

// Anthropic SDK is loaded lazily so this module can be imported in
// runtime contexts that don't have the package installed (e.g. the API
// process when only host extraction is needed). Speaker extraction is
// the only path that requires it; if it's missing or unconfigured,
// extractSpeakersFromHtml() returns an empty array.
let anthropic = null;
let anthropicLoadAttempted = false;
let anthropicLoadFailed = false;
async function getAnthropicClient() {
  if (anthropic) return anthropic;
  if (anthropicLoadFailed) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!anthropicLoadAttempted) {
    anthropicLoadAttempted = true;
    try {
      const mod = await import('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod.Anthropic;
      anthropic = new Anthropic({ apiKey });
    } catch (err) {
      anthropicLoadFailed = true;
      console.warn('[luma-extractor] @anthropic-ai/sdk unavailable — speaker extraction disabled:', err?.message ?? err);
      return null;
    }
  }
  return anthropic;
}

// Cache whether the event-speakers module is enabled. Checked once per process.
let speakerModuleEnabled = null;
async function isSpeakerModuleEnabled(supabase) {
  if (speakerModuleEnabled !== null) return speakerModuleEnabled;
  try {
    const { data } = await supabase
      .from('installed_modules')
      .select('id, status')
      .eq('id', 'event-speakers')
      .maybeSingle();
    speakerModuleEnabled = !!data && data.status === 'enabled';
  } catch {
    speakerModuleEnabled = false;
  }
  return speakerModuleEnabled;
}

// ============================================================================
// HOST EXTRACTION (from structured __NEXT_DATA__)
// ============================================================================

/**
 * Extract host records from a Luma event page's __NEXT_DATA__.
 * @param {object} lumaPageData - the full __NEXT_DATA__ JSON
 * @returns {Array<{name, email, avatar_url, luma_user_id, bio, role}>}
 */
export function extractHostsFromLumaData(lumaPageData) {
  const hosts = [];
  const seen = new Set();

  // Support both shapes: raw __NEXT_DATA__ (`props.pageProps.initialData.data`)
  // AND the trimmed shape the scrapers actually persist (`pageProps.initialData.data`
  // — the top-level `props` wrapper is stripped in fetchEventPageData to drop
  // user-specific fields). The DB version is what upsertHosts receives.
  const data = lumaPageData?.props?.pageProps?.initialData?.data
    || lumaPageData?.props?.pageProps?.data
    || lumaPageData?.pageProps?.initialData?.data
    || lumaPageData?.pageProps?.data;
  if (!data) return hosts;

  // Shared transform — pulls every field we care about from a Luma host
  // object, including the ones we previously threw away: website, LinkedIn
  // handle, Twitter handle. These are what Tier 0 of the enrichment plan
  // persists directly onto event_hosts.
  const buildHost = (h, position) => ({
    luma_user_id: h.api_id || h.user_api_id,
    name: h.name || '',
    avatar_url: h.avatar_url || null,
    luma_username: h.username || null,
    luma_profile_url: h.username ? `https://lu.ma/user/${h.username}` : null,
    bio: h.bio_short || h.bio || null,
    website: h.website || null,
    linkedin_handle: h.linkedin_handle || null,
    twitter_handle: h.twitter_handle || null,
    instagram_handle: h.instagram_handle || null,
    is_company: detectIsCompany(h),
    role: 'host',
    position,
  });

  // hosts[] — primary organizer list. Position determines credit in the
  // leaderboard view (1/position weighting).
  let position = 0;
  if (Array.isArray(data.hosts)) {
    for (const h of data.hosts) {
      const id = h.api_id || h.user_api_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      position++;
      hosts.push(buildHost(h, position));
    }
  }

  const hostInfo = data.host_info;
  if (hostInfo && Array.isArray(hostInfo.hosts)) {
    for (const h of hostInfo.hosts) {
      const id = h.api_id || h.user_api_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      position++;
      hosts.push(buildHost(h, position));
    }
  }

  return hosts.filter((h) => h.name);
}

/**
 * Heuristic: is this host a company/community rather than a person?
 * We want to keep companies OUT of outreach tables — you don't email
 * a community org at a LinkedIn profile. Mirrors the rule stack in
 * migration 012 so JS-side inserts match DB-side backfill.
 */
export function detectIsCompany(host) {
  if (!host) return false;
  const name = (host.name || '').trim();
  if (!name) return false;

  // Corporate suffixes / community-style tokens
  const corpPattern = /\b(Inc\.?|LLC|Ltd\.?|Corp\.?|GmbH|S\.?A\.?|SAS|PLC|Pty|Pvt|Foundation|Labs?|Studios?|Agency|Society|Group|Network|Community|Coalition|Institute|Consortium|Federation|Council|League|Alliance)\b/i;
  if (corpPattern.test(name)) return true;

  // ALL CAPS multi-word names (e.g. "HUMAN+TECH WEEK")
  if (/^[A-Z0-9 +\-&\.]+$/.test(name) && name.length > 4 && name.includes(' ')) return true;

  // Bio in first-person-plural org voice
  const bio = (host.bio_short || host.bio || '').trim();
  if (/^\s*(we're|we are|our community|our mission)/i.test(bio)) return true;

  // No first_name/last_name AND a Luma-generated bio_short is a softer signal —
  // users without first/last are often products or brands on Luma.
  if (!host.first_name && !host.last_name && /^[a-z0-9]{2,}$/i.test(name) === false && name.length <= 3) {
    return true;
  }

  return false;
}

/**
 * Parse a Luma bio_short into { title, company } via a small rule set.
 * Covers the ~70% of bios that follow "<role> at|@ <company>" formats.
 * Returns { title: null, company: null } when no confident split is possible —
 * callers should keep the raw bio in that case. Tier 2 of the enrichment
 * plan adds a Claude fallback for the remaining long tail.
 */
export function parseBioShort(bio) {
  if (!bio || typeof bio !== 'string') return { title: null, company: null };
  const trimmed = bio.trim();

  // "Head of DevRel at Apollo GraphQL", "Engineer @ Stripe"
  const atMatch = trimmed.match(/^(.+?)\s+(?:at|@)\s+(.+?)\.?$/i);
  if (atMatch) {
    const title = atMatch[1].trim().replace(/[,.]\s*$/, '');
    const company = atMatch[2].trim().replace(/[,.]\s*$/, '');
    // Guard: if either side is suspiciously long/short, skip — we'd rather
    // leave the raw bio than assign garbage.
    if (title.length > 0 && title.length <= 80 && company.length > 0 && company.length <= 80) {
      return { title, company };
    }
  }

  // "CEO, <Company>" / "Founder, <Company>"
  const commaMatch = trimmed.match(/^(CEO|CTO|COO|CFO|CMO|Founder|Co-?founder|Head of [A-Z][a-zA-Z]+|Director of [A-Z][a-zA-Z]+|VP of [A-Z][a-zA-Z]+)\s*,\s*(.+?)\.?$/i);
  if (commaMatch) {
    return { title: commaMatch[1].trim(), company: commaMatch[2].trim() };
  }

  return { title: null, company: null };
}

/**
 * Extract guest/ticket counts from Luma __NEXT_DATA__.event.
 * Returns { guest_count, ticket_count } (both may be null when absent).
 */
export function extractLumaCountsFromLumaData(lumaPageData) {
  const data = lumaPageData?.props?.pageProps?.initialData?.data
    || lumaPageData?.props?.pageProps?.data
    || lumaPageData?.pageProps?.initialData?.data
    || lumaPageData?.pageProps?.data;
  if (!data) return { guest_count: null, ticket_count: null };
  // guest_count and ticket_count live at the data level (sibling of `event`
  // and `hosts`), not inside the event object. See Luma __NEXT_DATA__ shape.
  return {
    guest_count: typeof data.guest_count === 'number' ? data.guest_count : null,
    ticket_count: typeof data.ticket_count === 'number' ? data.ticket_count : null,
  };
}

// ============================================================================
// SPEAKER EXTRACTION (AI-driven from event description HTML)
// ============================================================================

const EXTRACTION_PROMPT = `You are an expert at extracting speaker and talk information from event descriptions.

Analyze the following event description HTML and extract all speakers and their associated talks.

For each speaker, extract:
- name: Full name of the speaker
- firstName: First name (if determinable)
- lastName: Last name (if determinable)
- company: Company or organization they work for
- jobTitle: Their job title or role
- linkedinUrl: LinkedIn profile URL if mentioned (look for linkedin.com links)
- bio: Their biographical information (if provided separately from the talk description)
- photoUrl: URL of their photo if embedded in the content (look for img tags or image URLs)
- talks: Array of talks they are presenting

For each talk, extract:
- title: The title of the talk
- synopsis: Description or synopsis of what they will present
- durationMinutes: Duration in minutes if mentioned

Important guidelines:
1. Look for patterns like "🎤 Speaker Name" or "presented by" or speaker introductions
2. Look for talk titles in bold, italics, or preceded by time slots (like "6:30 PM - Talk Title")
3. Speaker bios often come after the talk description or as a separate paragraph about the person
4. If a speaker has multiple talks, include all of them in their talks array
5. Don't include event hosts/organizers unless they are also presenting talks
6. If you can't determine first/last name split, leave those fields null but include the full name
7. Extract LinkedIn URLs from hyperlinks in the content
8. Photo URLs are typically from images.lumacdn.com

Return ONLY valid JSON in this exact format, with no additional text:
{"speakers": [{"name": "Full Name", "firstName": "First", "lastName": "Name", "company": "Company", "jobTitle": "Title", "linkedinUrl": "https://linkedin.com/in/...", "bio": "Bio", "photoUrl": "https://...", "talks": [{"title": "Talk", "synopsis": "...", "durationMinutes": 30}]}]}

If no speakers are found, return: {"speakers": []}`;

/**
 * Extract speakers from event description HTML via Claude.
 * Returns empty array if ANTHROPIC_API_KEY is not set, HTML is empty, or
 * extraction fails — we never block event ingestion on speaker extraction.
 *
 * When `costContext` is supplied (preferred path from scraper-job-handler),
 * the Claude call is routed through `callAnthropic` from @gatewaze/shared
 * which records token usage and cost into external_api_usage and enforces
 * the per-brand budget. If a hard cap is hit, BudgetExceededError is
 * caught here and we return [] (skip extraction for this event but let
 * the rest of the scrape continue) — see spec §15.4.
 */
export async function extractSpeakersFromHtml(htmlContent, eventTitle, costContext = null) {
  if (!htmlContent || htmlContent.trim().length === 0) return [];

  const client = await getAnthropicClient();
  if (!client) {
    console.log('🤖 Speaker extraction skipped (Anthropic SDK or API key unavailable)');
    return [];
  }

  const model = 'claude-sonnet-4-20250514';
  const callBody = {
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\nEvent Title: ${eventTitle}\n\nEvent Description HTML:\n${htmlContent}`,
    }],
  };

  try {
    console.log(`🤖 Extracting speakers for: ${eventTitle}`);
    let message;
    if (costContext?.supabase && costContext?.brandId) {
      const sharedCost = await import('@gatewaze/shared').catch(() => null);
      if (sharedCost?.callAnthropic) {
        try {
          message = await sharedCost.callAnthropic(
            costContext.supabase,
            {
              brand_id: costContext.brandId,
              feature: 'scraper:speaker-extraction',
              model,
              context: {
                event_id: costContext.eventId ?? null,
                scraper_id: costContext.scraperId ?? null,
              },
            },
            (anthropic) => anthropic.messages.create(callBody),
            client,
          );
        } catch (budgetErr) {
          if (budgetErr?.name === 'BudgetExceededError') {
            console.warn(
              `🤖 Speaker extraction budget exceeded for brand=${costContext.brandId}; skipping (resets ${budgetErr.resets_at})`,
            );
            return [];
          }
          throw budgetErr;
        }
      } else {
        message = await client.messages.create(callBody);
      }
    } else {
      message = await client.messages.create(callBody);
    }

    const responseText = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('⚠️ No JSON found in Claude response for speaker extraction');
      return [];
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.speakers)) return [];

    return parsed.speakers
      .filter((s) => s.name && s.name.trim())
      .map((s) => ({
        name: s.name,
        firstName: s.firstName || null,
        lastName: s.lastName || null,
        company: s.company || null,
        jobTitle: s.jobTitle || null,
        linkedinUrl: s.linkedinUrl || null,
        bio: s.bio || null,
        photoUrl: s.photoUrl || null,
        talks: Array.isArray(s.talks) ? s.talks.map((t) => ({
          title: t.title || '',
          synopsis: t.synopsis || null,
          durationMinutes: t.durationMinutes || null,
        })) : [],
      }));
  } catch (err) {
    console.warn(`⚠️ Speaker extraction failed: ${err.message}`);
    return [];
  }
}

// ============================================================================
// DB UPSERTS
// ============================================================================

/**
 * Upsert extracted hosts into event_hosts and link them to the event via
 * event_host_events. Safe to call even if the tables don't exist — failures
 * are logged but don't break event ingestion.
 */
export async function upsertHosts(supabase, hosts, eventContext) {
  if (!hosts || hosts.length === 0) return { inserted: 0, linked: 0 };
  if (!supabase) return { inserted: 0, linked: 0 };

  let inserted = 0;
  let linked = 0;

  for (const h of hosts) {
    try {
      // Tier 0 enrichment: promote every field Luma gave us + parse bio into
      // title/company via the regex ruleset. Fields that come out null fall
      // back through to the update block where we only fill blanks (never
      // overwrite admin-edited data).
      const parsed = parseBioShort(h.bio);
      const linkedinUrl = h.linkedin_handle
        ? (h.linkedin_handle.startsWith('http') ? h.linkedin_handle : `https://www.linkedin.com/${h.linkedin_handle.replace(/^\/+/, '')}`)
        : null;
      const twitterUrl = h.twitter_handle
        ? (h.twitter_handle.startsWith('http') ? h.twitter_handle : `https://x.com/${h.twitter_handle.replace(/^@/, '')}`)
        : null;

      // Upsert by luma_user_id (most reliable dedup key)
      const { data: existing } = await supabase
        .from('event_hosts')
        .select('id, name, bio, avatar_url, company, job_title, linkedin_url, twitter_url, website_url')
        .eq('luma_user_id', h.luma_user_id)
        .maybeSingle();

      let hostId;
      if (existing) {
        hostId = existing.id;
        // Light-touch update: only fill blanks. Admin edits on any of these
        // fields are preserved — we never clobber non-null values.
        const updates = {};
        if (!existing.bio && h.bio) updates.bio = h.bio;
        if (!existing.avatar_url && h.avatar_url) updates.avatar_url = h.avatar_url;
        if (!existing.company && parsed.company) updates.company = parsed.company;
        if (!existing.job_title && parsed.title) updates.job_title = parsed.title;
        if (!existing.linkedin_url && linkedinUrl) updates.linkedin_url = linkedinUrl;
        if (!existing.twitter_url && twitterUrl) updates.twitter_url = twitterUrl;
        if (!existing.website_url && h.website) updates.website_url = h.website;
        updates.last_activity_at = new Date().toISOString();
        await supabase.from('event_hosts').update(updates).eq('id', hostId);
      } else {
        const { data: newHost, error } = await supabase
          .from('event_hosts')
          .insert({
            name: h.name,
            luma_user_id: h.luma_user_id,
            luma_profile_url: h.luma_profile_url,
            avatar_url: h.avatar_url,
            bio: h.bio,
            company: parsed.company,
            job_title: parsed.title,
            linkedin_url: linkedinUrl,
            twitter_url: twitterUrl,
            website_url: h.website || null,
            is_company: h.is_company || false,
            source: 'luma',
            outreach_status: 'new',
            last_activity_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        if (error) {
          console.warn(`⚠️ Failed to insert host "${h.name}": ${error.message}`);
          continue;
        }
        hostId = newHost.id;
        inserted++;
      }

      // Link host to event. host_position drives the credit formula in the
      // leaderboard view; guest_count is denormalised here so the view doesn't
      // need a 3-table join for the common case.
      const { error: linkErr } = await supabase
        .from('event_host_events')
        .upsert({
          host_id: hostId,
          source_event_id: eventContext.sourceEventId,
          gatewaze_event_id: eventContext.gatewazeEventId || null,
          event_title: eventContext.eventTitle,
          event_url: eventContext.eventUrl,
          event_start_at: eventContext.eventStartAt,
          calendar_name: eventContext.calendarName,
          role: h.role || 'host',
          host_position: h.position || null,
          guest_count: eventContext.guestCount ?? null,
        }, { onConflict: 'host_id,source_event_id' });
      if (linkErr) {
        console.warn(`⚠️ Failed to link host "${h.name}" to event: ${linkErr.message}`);
      } else {
        linked++;
      }
    } catch (err) {
      console.warn(`⚠️ Host upsert failed for "${h.name}": ${err.message}`);
    }
  }

  return { inserted, linked };
}

/**
 * Upsert extracted speakers into `events_speaker_profiles` (the canonical
 * speaker record) and link them to the event via `events_speakers`.
 *
 * Schema notes (Gatewaze):
 *   - `events_speaker_profiles` holds name/company/bio/links. One row per person.
 *   - `events_speakers` links a profile to an event (event_uuid + speaker_id)
 *     and carries a single talk (talk_title/talk_synopsis/talk_duration_minutes).
 *     One row per (speaker, talk, event). `status = 'placeholder'` marks rows
 *     that were scraped from a page and need human review before publishing.
 *
 * Only runs if the event-speakers module is enabled.
 */
export async function upsertSpeakers(supabase, speakers, eventContext) {
  if (!speakers || speakers.length === 0) return { inserted: 0, linked: 0 };
  if (!supabase) return { inserted: 0, linked: 0 };
  if (!eventContext.gatewazeEventId) return { inserted: 0, linked: 0 };

  if (!await isSpeakerModuleEnabled(supabase)) {
    return { inserted: 0, linked: 0, skipped: 'event-speakers module not enabled' };
  }

  let inserted = 0;
  let linked = 0;

  for (const s of speakers) {
    try {
      // Dedup profile: linkedin_url > (ilike name + company)
      let existing = null;
      if (s.linkedinUrl) {
        const { data } = await supabase
          .from('events_speaker_profiles')
          .select('id, name, company, bio, avatar_url')
          .eq('linkedin_url', s.linkedinUrl)
          .maybeSingle();
        existing = data;
      }
      if (!existing) {
        const query = supabase
          .from('events_speaker_profiles')
          .select('id, name, company, bio, avatar_url')
          .ilike('name', s.name);
        if (s.company) query.ilike('company', s.company);
        else query.is('company', null);
        const { data } = await query.maybeSingle();
        existing = data;
      }

      let speakerProfileId;
      if (existing) {
        speakerProfileId = existing.id;
        const updates = {};
        if (!existing.bio && s.bio) updates.bio = s.bio;
        if (!existing.avatar_url && s.photoUrl) updates.avatar_url = s.photoUrl;
        if (Object.keys(updates).length > 0) {
          await supabase.from('events_speaker_profiles').update(updates).eq('id', speakerProfileId);
        }
      } else {
        const { data: newSp, error } = await supabase
          .from('events_speaker_profiles')
          .insert({
            name: s.name,
            title: s.jobTitle || null,
            company: s.company || null,
            bio: s.bio || null,
            avatar_url: s.photoUrl || null,
            linkedin_url: s.linkedinUrl || null,
          })
          .select('id')
          .single();
        if (error) {
          console.warn(`⚠️ Failed to insert speaker profile "${s.name}": ${error.message}`);
          continue;
        }
        speakerProfileId = newSp.id;
        inserted++;
      }

      // Link to event. If the speaker has talks, create one events_speakers row
      // per talk so each talk is addressable. If no talks, create a single
      // speaker-only row with no talk fields.
      //
      // Re-scrape convergence: the AI extraction REPHRASES talk titles between
      // runs (and sometimes extracts none), so title-keyed dedupe accreted a
      // sibling placeholder row per drift — the same speaker showed several
      // times on the portal. Placeholder rows for this (event, speaker) are
      // fetched once: the common single-talk case UPDATES the existing row in
      // place, untitled extractions never add rows next to titled ones, and
      // only genuinely new titles in multi-talk sets insert.
      const talks = Array.isArray(s.talks) && s.talks.length > 0 ? s.talks : [{ title: null, synopsis: null, durationMinutes: null }];
      const { data: existingLinks } = await supabase
        .from('events_speakers')
        .select('id, talk_title')
        .eq('event_uuid', eventContext.gatewazeEventId)
        .eq('speaker_id', speakerProfileId)
        .eq('status', 'placeholder');
      const links = existingLinks ?? [];

      if (links.length === 1 && talks.length === 1) {
        const t = talks[0];
        // Refresh the single placeholder in place; never wipe a title with an
        // empty extraction.
        if (t.title && t.title !== links[0].talk_title) {
          await supabase
            .from('events_speakers')
            .update({ talk_title: t.title, talk_synopsis: t.synopsis || null, talk_duration_minutes: t.durationMinutes || null })
            .eq('id', links[0].id);
        }
        linked++;
        continue;
      }

      for (const t of talks) {
        // Untitled extraction: only ever create the speaker-only row when the
        // speaker has NO rows at all for this event.
        if (!t.title && links.length > 0) continue;
        // Titled: skip titles we already have.
        if (t.title && links.some((l) => l.talk_title === t.title)) continue;

        const { error: linkErr } = await supabase
          .from('events_speakers')
          .insert({
            event_uuid: eventContext.gatewazeEventId,
            speaker_id: speakerProfileId,
            status: 'placeholder', // scraped via AI — needs human review before publishing
            role: 'speaker',
            talk_title: t.title || null,
            talk_synopsis: t.synopsis || null,
            talk_duration_minutes: t.durationMinutes || null,
          });
        if (!linkErr) links.push({ id: null, talk_title: t.title || null });
        if (linkErr) {
          console.warn(`⚠️ Failed to link speaker "${s.name}" to event: ${linkErr.message}`);
        } else {
          linked++;
        }
      }
    } catch (err) {
      console.warn(`⚠️ Speaker upsert failed for "${s.name}": ${err.message}`);
    }
  }

  return { inserted, linked };
}

export default {
  extractHostsFromLumaData,
  extractSpeakersFromHtml,
  upsertHosts,
  upsertSpeakers,
};
