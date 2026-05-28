import { BaseScraper } from './BaseScraper.js';

/**
 * LumaHostEnricher — Tier 1 of the event-host enrichment plan.
 *
 * Picks event_hosts rows that still have gaps after Tier 0 (bio/regex parsing
 * of what __NEXT_DATA__ already gave us) AND have a Luma profile URL we can
 * visit. For each, navigates to `lu.ma/user/<slug>` with the existing
 * Puppeteer setup and pulls richer data from the profile's __NEXT_DATA__
 * than the event page ever exposes.
 *
 * Deliberately bounded:
 *   - `maxHosts` cap per run (default 50) so one run can't monopolise the worker.
 *   - Only hosts with a `luma_profile_url` AND at least one missing enrichment
 *     field (company / linkedin_url / website_url) are considered.
 *   - Skips hosts whose `enrichment_tried_at` is recent — we don't keep
 *     hammering profiles that Luma genuinely didn't have data for.
 *
 * Config (ScraperEditorModal):
 *   - maxHosts      number  — max hosts per run (10–200, default 50)
 *   - retryAfterDays number — re-try previously-failed enrichments after N days (default 30)
 *   - onlyActiveHosts boolean — only enrich hosts linked to at least one event (default true)
 */
export class LumaHostEnricher extends BaseScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    // Headless Puppeteer; polite delay between profile fetches.
    this.config.headless = true;
    this.pageFetchDelay = 1500;
  }

  /**
   * Detect errors that mean the puppeteer browser/page is gone — there's no
   * point retrying these against the same dead Chromium. Mirrors
   * LumaICalScraper.isBrowserDeadError so we can bail out of a host's event
   * loop cleanly instead of marking 50 events as "failed" individually.
   */
  isBrowserDeadError(error) {
    const msg = (error?.message || String(error || '')).toLowerCase();
    return msg.includes('detached frame')
        || msg.includes('target closed')
        || msg.includes('session closed')
        || msg.includes('protocol error')
        || msg.includes('browser has disconnected')
        || msg.includes('connection closed');
  }

  validateConfig() {
    const cfg = this.config?.config || {};
    const n = parseInt(cfg.maxHosts ?? '50');
    if (Number.isFinite(n) && (n < 10 || n > 200)) {
      throw new Error('Config error: maxHosts must be between 10 and 200');
    }
  }

  async scrape() {
    this.validateConfig();

    const cfg = this.config?.config || {};
    const maxHosts = parseInt(cfg.maxHosts ?? '50');
    const retryAfterDays = parseInt(cfg.retryAfterDays ?? '30');
    const onlyActive = cfg.onlyActiveHosts !== false;
    // New: pull each host's full event history from their profile.
    const processHostEvents = cfg.processHostEvents !== false; // default ON
    const maxEventsPerHost = Math.max(1, Math.min(200, parseInt(cfg.maxEventsPerHost ?? '50')));
    // Rotate through hosts to keep their event lists fresh even after
    // enrichment fields are filled in.
    const eventsScanRetryDays = parseInt(cfg.eventsScanRetryDays ?? '14');

    const supabase = this.globalConfig?.supabase;
    if (!supabase) {
      console.warn('⚠️ No Supabase client — cannot run LumaHostEnricher');
      return [];
    }

    // Candidate rule: has a Luma profile URL, AND either:
    //   (a) is missing at least one enrichment field AND we haven't recently
    //       failed to enrich it, OR
    //   (b) processHostEvents=true AND we haven't scanned their events in N days.
    // We intentionally OR these so a host with full enrichment fields still
    // comes up periodically to refresh their events list.
    const enrichRetryCutoff = new Date(Date.now() - retryAfterDays * 24 * 60 * 60 * 1000).toISOString();
    const eventsRetryCutoff = new Date(Date.now() - eventsScanRetryDays * 24 * 60 * 60 * 1000).toISOString();

    // Rotation order: prefer hosts we've never event-scanned (NULLS FIRST on
    // events_scanned_at when we're in event-scan mode), else oldest scan first.
    // When processHostEvents is OFF, fall back to the original
    // enrichment_tried_at rotation.
    const orderColumn = processHostEvents ? 'events_scanned_at' : 'enrichment_tried_at';

    let query = supabase
      .from('event_hosts')
      .select('id, name, luma_user_id, luma_profile_url, company, linkedin_url, website_url, bio, enrichment_tried_at, events_scanned_at, is_company')
      .not('luma_profile_url', 'is', null)
      .eq('is_company', false); // never enrich company rows — we don't do outreach to them

    if (processHostEvents) {
      // Either due for enrichment OR due for event-scan.
      query = query.or(
        `events_scanned_at.is.null,events_scanned_at.lt.${eventsRetryCutoff},` +
        `and(or(company.is.null,linkedin_url.is.null,website_url.is.null),` +
            `or(enrichment_tried_at.is.null,enrichment_tried_at.lt.${enrichRetryCutoff}))`
      );
    } else {
      // Original behavior: only hosts needing enrichment.
      query = query
        .or('company.is.null,linkedin_url.is.null,website_url.is.null')
        .or(`enrichment_tried_at.is.null,enrichment_tried_at.lt.${enrichRetryCutoff}`);
    }

    query = query
      .order(orderColumn, { ascending: true, nullsFirst: true })
      .limit(maxHosts);

    const { data: candidates, error } = await query;
    if (error) throw new Error(`Failed to fetch candidates: ${error.message}`);

    let candidateHosts = candidates || [];

    // onlyActive: further restrict to hosts that are actually linked to an
    // event. Enriching a row nobody's asked about wastes queries.
    if (onlyActive && candidateHosts.length > 0) {
      const ids = candidateHosts.map((h) => h.id);
      const { data: linked } = await supabase
        .from('event_host_events')
        .select('host_id')
        .in('host_id', ids);
      const activeSet = new Set((linked || []).map((r) => r.host_id));
      candidateHosts = candidateHosts.filter((h) => activeSet.has(h.id));
    }

    console.log(`🔎 LumaHostEnricher: ${candidateHosts.length} candidates to enrich (max ${maxHosts})`);

    if (candidateHosts.length === 0) {
      this.stats.total = 0;
      return [];
    }

    await this.initialize();

    let enrichedCount = 0;
    let failedCount = 0;
    let unchangedCount = 0;
    let eventsDiscovered = 0;
    let eventsSaved = 0;
    let eventsFailed = 0;
    const scannedAt = new Date().toISOString();

    try {
      for (let i = 0; i < candidateHosts.length; i++) {
        const host = candidateHosts[i];
        try {
          if (i > 0) await new Promise((r) => setTimeout(r, this.pageFetchDelay));

          console.log(`📄 [${i + 1}/${candidateHosts.length}] Fetching ${host.luma_profile_url} for ${host.name}`);
          const profile = await this.fetchProfilePageData(host.luma_profile_url);

          const updates = {
            enrichment_tried_at: scannedAt,
            enrichment_source: 'luma_profile',
          };

          if (!host.company && profile.company) updates.company = profile.company;
          if (!host.linkedin_url && profile.linkedin_url) updates.linkedin_url = profile.linkedin_url;
          if (!host.website_url && profile.website_url) updates.website_url = profile.website_url;
          if (!host.bio && profile.bio) updates.bio = profile.bio;
          if (profile.job_title && !host.company) updates.job_title = profile.job_title;

          // Brave Search fallback: if profile scrape yielded no LinkedIn AND
          // we still don't have one, try a web search. Requires BRAVE_SEARCH_API_KEY.
          // Only runs when there's real upside — skip if LinkedIn is already set.
          const stillNeedsLinkedIn = !host.linkedin_url && !updates.linkedin_url;
          if (stillNeedsLinkedIn && process.env.BRAVE_SEARCH_API_KEY) {
            const searchResult = await this.searchLinkedIn(host.name, await this.getHostPrimaryCity(supabase, host.id));
            if (searchResult?.linkedinUrl) {
              updates.linkedin_url = searchResult.linkedinUrl;
              if (!host.company && searchResult.company) updates.company = searchResult.company;
              updates.enrichment_source = 'luma_profile+brave_search';
              console.log(`   🔍 Brave Search found LinkedIn for ${host.name}: ${searchResult.linkedinUrl}`);
            }
          }

          const changed = Object.keys(updates).filter((k) => k !== 'enrichment_tried_at' && k !== 'enrichment_source').length > 0;

          await supabase.from('event_hosts').update(updates).eq('id', host.id);

          if (changed) {
            enrichedCount++;
            const added = Object.keys(updates).filter((k) => !['enrichment_tried_at', 'enrichment_source'].includes(k));
            console.log(`   ✅ Enriched ${host.name}: filled ${added.join(', ')}`);
          } else {
            unchangedCount++;
            console.log(`   ↳ No new data for ${host.name}`);
          }

          // ----- new: process the host's event history -----
          if (processHostEvents && Array.isArray(profile.events) && profile.events.length > 0) {
            const candidateEvents = profile.events.slice(0, maxEventsPerHost);
            const newEvents = await this.filterToNewEvents(supabase, candidateEvents);
            eventsDiscovered += newEvents.length;
            const skipped = candidateEvents.length - newEvents.length;
            console.log(`   📅 ${candidateEvents.length} events on profile (${skipped} already in DB, ${newEvents.length} new)`);

            for (let j = 0; j < newEvents.length; j++) {
              const ev = newEvents[j];
              try {
                await new Promise((r) => setTimeout(r, this.pageFetchDelay));
                const pageData = await this.fetchEventPageQuick(ev.url);
                await this.saveDiscoveredEvent(supabase, host, ev, pageData);
                eventsSaved++;
                console.log(`      ✅ [${j + 1}/${newEvents.length}] ${pageData?.name || ev.title || ev.url}`);
              } catch (evErr) {
                eventsFailed++;
                console.warn(`      ⚠️ Event fetch failed (${ev.url}): ${evErr.message}`);
                // Browser-dead errors shouldn't be silently swallowed — abort
                // the rest of this host's events but let the outer loop move on.
                if (this.isBrowserDeadError && this.isBrowserDeadError(evErr)) throw evErr;
              }
            }

            // Mark as scanned regardless of whether we saved anything new.
            await supabase.from('event_hosts')
              .update({ events_scanned_at: scannedAt })
              .eq('id', host.id);
          }
        } catch (err) {
          failedCount++;
          console.warn(`   ⚠️ Failed for ${host.name}: ${err.message}`);
          // Still mark tried so we don't retry in tight loop
          try {
            await supabase.from('event_hosts')
              .update({ enrichment_tried_at: scannedAt, enrichment_source: 'luma_profile_failed' })
              .eq('id', host.id);
          } catch {}
        }
      }

      this.stats.total = candidateHosts.length;
      this.stats.processed = enrichedCount;
      this.stats.skipped = unchangedCount;
      this.stats.failed = failedCount;
      this.stats.eventsDiscovered = eventsDiscovered;
      this.stats.eventsSaved = eventsSaved;
      this.stats.eventsFailed = eventsFailed;

      console.log(`\n📊 LumaHostEnricher done:`);
      console.log(`   Hosts: ${enrichedCount} enriched, ${unchangedCount} unchanged, ${failedCount} failed`);
      if (processHostEvents) {
        console.log(`   Events: ${eventsDiscovered} discovered, ${eventsSaved} saved, ${eventsFailed} failed`);
      }
    } finally {
      await this.cleanup();
    }

    // This scraper produces no events — purely a mutator on event_hosts.
    return [];
  }

  // Pull the host's most-common event city from the leaderboard view so we
  // can narrow Brave Search queries. Narrowing by city avoids false matches
  // against same-named people in other places.
  async getHostPrimaryCity(supabase, hostId) {
    try {
      const { data } = await supabase
        .from('event_hosts_leaderboard')
        .select('primary_city')
        .eq('host_id', hostId)
        .maybeSingle();
      return data?.primary_city || null;
    } catch {
      return null;
    }
  }

  // Brave Search fallback: find a likely LinkedIn profile for the person.
  // Query shape: `"<name>" "<city>" site:linkedin.com/in`. Returns { linkedinUrl, company }
  // or null. Uses the first result whose URL is a linkedin.com/in/* profile —
  // companies and fake matches live at linkedin.com/company/* so this guard
  // filters them out.
  async searchLinkedIn(name, city) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey || !name) return null;

    const q = city
      ? `"${name}" "${city}" site:linkedin.com/in`
      : `"${name}" site:linkedin.com/in`;

    try {
      const params = new URLSearchParams({
        q,
        count: '5',
        search_lang: 'en',
        text_format: 'raw',
      });
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
      });
      if (!res.ok) {
        console.warn(`   ⚠️ Brave Search ${res.status} for "${name}"`);
        return null;
      }
      const data = await res.json();
      const results = data?.web?.results || [];
      for (const r of results) {
        const url = r.url || '';
        if (!/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(url)) continue;
        // Extract company from description/title — typical LinkedIn titles
        // look like "Name - Title - Company | LinkedIn".
        let company = null;
        const title = (r.title || '').replace(/\s*\|\s*LinkedIn$/i, '');
        // "Name - Title at Company" / "Name - Title - Company"
        const atMatch = title.match(/\s(?:at|@)\s+(.+?)$/i);
        const dashMatch = title.match(/^.+?\s[-—]\s.+?\s[-—]\s(.+?)$/);
        if (atMatch) company = atMatch[1].trim();
        else if (dashMatch) company = dashMatch[1].trim();
        return { linkedinUrl: url.split('?')[0], company };
      }
      return null;
    } catch (err) {
      console.warn(`   ⚠️ Brave Search failed for "${name}": ${err.message}`);
      return null;
    }
  }

  // Navigate to a Luma profile page and extract the fields we care about
  // from __NEXT_DATA__. Profile pages carry a more complete user object
  // than event pages, AND a list of events the user is hosting / has hosted.
  async fetchProfilePageData(profileUrl) {
    if (!this.page) throw new Error('Browser not initialised');

    await this.page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    const result = await this.page.evaluate(() => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;
      try {
        const data = JSON.parse(script.textContent);

        // Walk the common shapes Luma has used over time.
        const pp = data?.props?.pageProps ?? {};
        const userCandidates = [
          pp.initialData?.data?.user,
          pp.data?.user,
          pp.user,
          pp.initialData?.data,
          pp.data,
        ].filter(Boolean);
        const user = userCandidates[0] || null;

        // Events appear under a few keys depending on the page revision.
        // Each event entry typically has { api_id, name, url|slug, start_at, end_at, cover_url, ... }.
        const eventBuckets = [
          pp.initialData?.data?.upcoming_events,
          pp.initialData?.data?.past_events,
          pp.initialData?.data?.hosting_events,
          pp.initialData?.data?.events,
          pp.data?.upcoming_events,
          pp.data?.past_events,
          pp.data?.hosting_events,
          pp.data?.events,
          pp.upcoming_events,
          pp.past_events,
          pp.events,
        ].filter(Array.isArray);
        const eventsRaw = eventBuckets.flat();

        return { user, eventsRaw };
      } catch {
        return null;
      }
    });

    if (!result) return { events: [] };
    const { user: raw, eventsRaw } = result;

    // ---- field extraction (unchanged) ----
    const bio = raw?.bio || raw?.bio_short || null;
    let company = null;
    let jobTitle = null;
    if (bio) {
      const m = bio.match(/^(.+?)\s+(?:at|@)\s+(.+?)\.?$/i);
      if (m && m[1].length <= 80 && m[2].length <= 80) {
        jobTitle = m[1].trim();
        company = m[2].trim();
      }
    }
    const linkedinUrl = raw?.linkedin_handle
      ? (raw.linkedin_handle.startsWith('http')
        ? raw.linkedin_handle
        : `https://www.linkedin.com/${raw.linkedin_handle.replace(/^\/+/, '')}`)
      : null;

    // ---- normalise events list ----
    // Each item we care about: { lumaEventId, url, title, startAt, endAt, coverUrl }.
    // Dedupe by api_id, then by url.
    const seenIds = new Set();
    const seenUrls = new Set();
    const events = [];
    for (const e of (eventsRaw ?? [])) {
      // Different shapes: top-level event, or { event: {...}, role: 'host' }
      const ev = e?.event ?? e ?? null;
      if (!ev) continue;
      const lumaEventId = ev.api_id || ev.id || null;
      if (lumaEventId && seenIds.has(lumaEventId)) continue;

      // URL: prefer ev.url, else build from slug.
      let url = ev.url || ev.event_url || null;
      if (!url && ev.slug) url = `https://lu.ma/${ev.slug}`;
      if (!url) continue;
      // Normalise — drop trailing slash + query.
      try {
        const u = new URL(url);
        u.search = '';
        url = u.toString().replace(/\/$/, '');
      } catch {}
      if (seenUrls.has(url)) continue;

      events.push({
        lumaEventId,
        url,
        title: ev.name || ev.title || null,
        startAt: ev.start_at || ev.startAt || null,
        endAt: ev.end_at || ev.endAt || null,
        coverUrl: ev.cover_url || ev.coverUrl || null,
        role: e?.role || null,  // 'host' | 'co-host' | undefined
      });
      if (lumaEventId) seenIds.add(lumaEventId);
      seenUrls.add(url);
    }

    return {
      bio,
      company,
      job_title: jobTitle,
      linkedin_url: linkedinUrl,
      website_url: raw?.website || null,
      events,
    };
  }

  // ---------------------------------------------------------------------
  // Event-discovery helpers
  // ---------------------------------------------------------------------

  /**
   * Filter a host's profile-event list down to events not already in our
   * `events` table. Dedupes on luma_event_id first (most reliable), then
   * event_link as a fallback.
   */
  async filterToNewEvents(supabase, profileEvents) {
    if (!profileEvents || profileEvents.length === 0) return [];

    const lumaIds = profileEvents.map((e) => e.lumaEventId).filter(Boolean);
    const urls = profileEvents.map((e) => e.url).filter(Boolean);

    const seen = new Set();
    if (lumaIds.length) {
      const { data } = await supabase
        .from('events')
        .select('luma_event_id')
        .in('luma_event_id', lumaIds);
      for (const r of (data || [])) seen.add(`id:${r.luma_event_id}`);
    }
    if (urls.length) {
      const { data } = await supabase
        .from('events')
        .select('event_link')
        .in('event_link', urls);
      for (const r of (data || [])) seen.add(`url:${r.event_link}`);
    }

    return profileEvents.filter((e) => {
      if (e.lumaEventId && seen.has(`id:${e.lumaEventId}`)) return false;
      if (e.url && seen.has(`url:${e.url}`)) return false;
      return true;
    });
  }

  /**
   * Visit a single event page (reuses this.page) and extract the same
   * shape LumaICalScraper produces from __NEXT_DATA__ + DOM. Uses the
   * existing fetchEventPageData logic by importing the LumaICalScraper
   * helpers — but to avoid coupling, we inline a slim version here.
   */
  async fetchEventPageQuick(eventUrl) {
    if (!this.page) throw new Error('Browser not initialised');

    await this.page.goto(eventUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    return this.page.evaluate(() => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;
      try {
        const data = JSON.parse(script.textContent);
        const pp = data?.props?.pageProps ?? {};
        const ev = pp.initialData?.data?.event
                || pp.data?.event
                || pp.event
                || null;
        if (!ev) return null;

        const cover = document.querySelector('.cover-image img')?.getAttribute('src') || null;
        const body  = document.body?.innerText || '';

        return {
          lumaEventId: ev.api_id || ev.id || null,
          name: ev.name || null,
          description: ev.description || ev.description_short || null,
          startAt: ev.start_at || null,
          endAt: ev.end_at || null,
          timezone: ev.timezone || null,
          coverUrl: ev.cover_url || cover,
          city: ev.geo_city || ev.city || null,
          countryCode: ev.geo_country || ev.country || null,
          venue: ev.geo_address_full || ev.venue || null,
          latitude: ev.geo_latitude || null,
          longitude: ev.geo_longitude || null,
          slug: ev.slug || null,
          pageContent: body.slice(0, 5000),
        };
      } catch {
        return null;
      }
    });
  }

  /**
   * Save a discovered event via the streaming pipeline. Uses
   * globalConfig.saveEvent (same path LumaICalScraper uses) so the event
   * flows through cleaning, geocoding, triage, and content-keywords.
   */
  async saveDiscoveredEvent(supabase, host, profileEvent, pageData) {
    const eventObj = {
      eventTitle: pageData?.name || profileEvent.title || 'Untitled',
      eventDescription: pageData?.description || null,
      eventStart: pageData?.startAt || profileEvent.startAt || null,
      eventEnd: pageData?.endAt || profileEvent.endAt || null,
      eventTimezone: pageData?.timezone || 'UTC',
      eventCity: pageData?.city || null,
      eventCountryCode: pageData?.countryCode || null,
      venueAddress: pageData?.venue || null,
      eventLink: profileEvent.url,
      eventLogo: pageData?.coverUrl || profileEvent.coverUrl || null,
      eventType: 'in-person',
      eventTopics: [],
      sourceType: 'luma_host_profile',
      sourceDetails: {
        discovered_via_host_id: host.id,
        discovered_via_host_name: host.name,
        luma_user_id: host.luma_user_id,
        luma_event_id: pageData?.lumaEventId || profileEvent.lumaEventId,
      },
      eventSourceName: host.name,
      lumaEventId: pageData?.lumaEventId || profileEvent.lumaEventId,
    };

    let savedRow = null;
    if (typeof this.globalConfig?.saveEvent === 'function') {
      savedRow = await this.globalConfig.saveEvent(eventObj);
    } else {
      // Fallback: direct insert (no triage / category enrichment, but the
      // content_category trigger + content-keywords trigger will still fire).
      const { data: inserted } = await supabase
        .from('events')
        .insert({
          event_title: eventObj.eventTitle,
          event_description: eventObj.eventDescription,
          event_start: eventObj.eventStart,
          event_end: eventObj.eventEnd,
          event_timezone: eventObj.eventTimezone,
          event_city: eventObj.eventCity,
          event_country_code: eventObj.eventCountryCode,
          venue_address: eventObj.venueAddress,
          event_link: eventObj.eventLink,
          event_logo: eventObj.eventLogo,
          event_type: eventObj.eventType,
          source_type: eventObj.sourceType,
          source_details: eventObj.sourceDetails,
          event_source_name: eventObj.eventSourceName,
          luma_event_id: eventObj.lumaEventId,
        })
        .select('id')
        .single();
      savedRow = inserted;
    }

    // Link the host to the (newly-saved or pre-existing) event.
    if (savedRow?.id || eventObj.lumaEventId) {
      const linkRow = {
        host_id: host.id,
        source_event_id: eventObj.lumaEventId || null,
        gatewaze_event_id: savedRow?.id || null,
        event_title: eventObj.eventTitle,
        event_url: eventObj.eventLink,
        event_start_at: eventObj.eventStart,
        role: profileEvent.role || 'host',
      };
      // ON CONFLICT semantics aren't trivial without a unique constraint;
      // best-effort upsert via select-then-insert.
      const { data: existing } = await supabase
        .from('event_host_events')
        .select('id')
        .eq('host_id', host.id)
        .eq('event_url', eventObj.eventLink)
        .maybeSingle();
      if (!existing) {
        await supabase.from('event_host_events').insert(linkRow);
      } else if (savedRow?.id) {
        await supabase.from('event_host_events')
          .update({ gatewaze_event_id: savedRow.id })
          .eq('id', existing.id);
      }
    }

    return savedRow;
  }
}
