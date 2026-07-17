import { LumaICalScraper } from './LumaICalScraper.js';

/**
 * LumaPendingEventsScraper — reverse Luma signup flow.
 *
 * The integrations-luma-process-registration edge function queues signup
 * notification emails it can't match to an event as
 * integrations_luma_pending_registrations rows with status 'no_event'.
 * This scraper drains that queue from the other side:
 *
 *   1. For queued luma_event_ids whose event ALREADY exists (created by a
 *      calendar scraper, CSV import, or manually), replay the stored email
 *      back through the registration edge function so the person is attached.
 *   2. For luma_event_ids with no event, fetch the public event page
 *      (https://luma.com/event/<evt-id> 301s to the event's slug URL) and
 *      save it through the normal pipeline — the scraper row's
 *      content_category / default_publish_state config decides categorisation
 *      and Content Inbox triage, same as every other scraper.
 *   3. Replay the queued registrations for the events just created.
 *
 * Event pages are fetched over PLAIN HTTP and __NEXT_DATA__ is parsed from
 * the HTML — no browser. Headless-Chromium navigation to luma.com times out
 * from the production cluster (verified 2026-07-15: puppeteer networkidle2
 * fails while a plain fetch of the same URL returns the full page), and
 * everything this scraper needs lives in the server-rendered JSON anyway.
 *
 * Unlike calendar scrapers this never skips past/today events: a queued row
 * means a real person registered, so the event is always worth ingesting —
 * the registration history matters even if the date has passed.
 *
 * Soft dependency: if the luma integration module (and thus the pending
 * registrations table) isn't installed, the run is a clean no-op.
 */
export class LumaPendingEventsScraper extends LumaICalScraper {
  constructor(config, globalConfig) {
    super(config, globalConfig);
    this.replayStats = { replayed: 0, replayFailed: 0 };
    this.refreshStats = { refreshed: 0 };
    // Plain-HTTP fetches are cheap; a short politeness delay is enough.
    this.pageFetchDelay = 1000;
  }

  async scrape() {
    console.log(`🎯 Starting ${this.config.name} — events for queued Luma signups...`);
    this.events = [];
    if (typeof this.stats.found !== 'number') this.stats.found = 0;
    if (typeof this.stats.skipped !== 'number') this.stats.skipped = 0;
    if (typeof this.stats.failed !== 'number') this.stats.failed = 0;

    const supabase = this.globalConfig?.supabase;
    if (!supabase) {
      console.warn('⚠️ No service-role Supabase client in globalConfig — cannot run');
      return [];
    }

    const { data: pendingRows, error: pendErr } = await supabase
      .from('integrations_luma_pending_registrations')
      .select('id, luma_event_id, matched_email, user_name, email_from, email_to, email_subject, raw_email_data')
      .eq('status', 'no_event')
      .order('created_at', { ascending: true })
      .limit(500);

    if (pendErr) {
      // Table absent (luma module not installed) or unreadable — skip the
      // queue phases; the refresh pass below still runs.
      console.log(`ℹ️ Pending Luma registrations unavailable (${pendErr.message}) — no queue work`);
    }
    const queuedRows = pendErr ? [] : (pendingRows || []);
    if (!queuedRows.length) {
      console.log('✅ No queued Luma signups awaiting an event');
      await this.refreshStaleEvents(supabase);
      console.log(`📊 Stats: 0 events scraped, ${this.refreshStats.refreshed} events refreshed`);
      return this.events;
    }

    const ids = [...new Set(queuedRows.map((r) => r.luma_event_id).filter(Boolean))];
    console.log(`📬 ${queuedRows.length} queued signups across ${ids.length} Luma events`);

    // Which of these events already exist? (created since the email arrived —
    // by a calendar scraper, CSV import, or manually)
    const existingIds = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const { data: existing } = await supabase
        .from('events')
        .select('luma_event_id')
        .in('luma_event_id', ids.slice(i, i + 100));
      for (const row of existing || []) existingIds.add(row.luma_event_id);
    }

    // Phase 1: replay signups whose event already exists.
    await this.replayPendingRegistrations(
      supabase,
      queuedRows.filter((r) => existingIds.has(r.luma_event_id))
    );

    // Phase 2: scrape the events that don't exist yet.
    const maxPerRun = this.config?.config?.maxEventsPerRun ?? 20;
    const toScrape = ids.filter((id) => !existingIds.has(id));
    if (toScrape.length > maxPerRun) {
      console.log(`⚠️ ${toScrape.length} events queued; scraping first ${maxPerRun} this run (rest next run)`);
    }

    const scrapedIds = [];
    const streamingSave = typeof this.globalConfig?.saveEvent === 'function';
    for (const lumaEventId of toScrape.slice(0, maxPerRun)) {
      if (this.isShutdownRequested()) {
        console.log(`📴 Shutdown requested, stopping after ${scrapedIds.length} events`);
        break;
      }
      if (this.pageFetchDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pageFetchDelay));
      }

      // The /event/<evt-id> path 301s to the event's public slug page.
      const probeLink = `https://luma.com/event/${lumaEventId}`;
      try {
        const pageData = await this.fetchEventPageHttp(probeLink);
        const parsedEvent = this.buildEventFromPageData(lumaEventId, pageData);

        if (!parsedEvent) {
          this.stats.failed++;
          // Page rendered but carries no event object — the event was
          // deleted or is private. Mark its queued rows failed so they
          // aren't retried forever; admins can reset status to retry.
          if (pageData?.htmlLoaded) {
            await supabase
              .from('integrations_luma_pending_registrations')
              .update({
                status: 'failed',
                error_message: 'Luma event page has no event data (deleted or private event?)',
              })
              .eq('status', 'no_event')
              .eq('luma_event_id', lumaEventId);
            console.warn(`❌ ${lumaEventId}: page has no event data — queued rows marked failed`);
          } else {
            console.warn(`⚠️ ${lumaEventId}: page fetch failed — will retry next run`);
          }
          continue;
        }

        this.stats.found++;
        if (streamingSave) {
          try {
            await this.globalConfig.saveEvent(parsedEvent);
            scrapedIds.push(lumaEventId);
          } catch (saveErr) {
            console.warn(`⚠️ Streaming save failed for "${parsedEvent.eventTitle}": ${saveErr.message}`);
            this.events.push(parsedEvent);
          }
        } else {
          this.events.push(parsedEvent);
        }
      } catch (error) {
        console.warn(`⚠️ Failed to scrape ${lumaEventId}: ${error.message}`);
        this.stats.failed++;
      }
    }

    // Phase 3: replay signups for the events we just created (streaming saves
    // are already in the DB; batch-fallback events get replayed next run).
    await this.replayPendingRegistrations(
      supabase,
      queuedRows.filter((r) => scrapedIds.includes(r.luma_event_id))
    );

    // Phase 4: refresh stale Luma counts / page data for events people are
    // actually registering for, so the admin "Luma guests" stat tracks the
    // live event page instead of freezing at creation time.
    await this.refreshStaleEvents(supabase);

    console.log(
      `📊 Stats: ${this.stats.found} events scraped, ${this.stats.failed} failed, ` +
      `${this.replayStats.replayed} registrations attached, ${this.replayStats.replayFailed} replay failures, ` +
      `${this.refreshStats.refreshed} events refreshed`
    );
    return this.events;
  }

  /**
   * Re-scrape the event pages of registration-bearing Luma events whose
   * counts are stale, feeding them through the normal save pipeline — which
   * updates luma_guest_count / luma_ticket_count / page data on existing
   * events without touching publish_state.
   *
   * Each event is refreshed at most once per refreshStaleHours (default 24h
   * — i.e. daily), up to maxRefreshPerRun per run (default 15), so the
   * hourly schedule spreads the work and no event page is hammered.
   */
  async refreshStaleEvents(supabase) {
    const cfg = this.config?.config || {};
    const maxRefresh = cfg.maxRefreshPerRun ?? 15;
    const staleHours = cfg.refreshStaleHours ?? 24;
    if (maxRefresh <= 0) return;
    if (typeof this.globalConfig?.saveEvent !== 'function') {
      console.log('ℹ️ No saveEvent pipeline available — skipping refresh pass');
      return;
    }

    const staleCutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();
    const recencyCutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

    // Candidates: Luma events that started within the last 7 days or are
    // upcoming, whose counts have never been synced or are stale.
    const { data: candidates, error: candErr } = await supabase
      .from('events')
      .select('id, luma_event_id, event_title, luma_counts_updated_at')
      .not('luma_event_id', 'is', null)
      .gte('event_start', recencyCutoff)
      .or(`luma_counts_updated_at.is.null,luma_counts_updated_at.lt.${staleCutoff}`)
      .order('luma_counts_updated_at', { ascending: true, nullsFirst: true })
      .limit(100);
    if (candErr || !candidates?.length) {
      if (candErr) console.warn(`⚠️ Refresh candidate query failed: ${candErr.message}`);
      return;
    }

    // Only refresh events that actually have registrations — that's where
    // the counts are looked at.
    const { data: regRows } = await supabase
      .from('events_registrations')
      .select('event_id')
      .in('event_id', candidates.map((e) => e.id));
    const withRegs = new Set((regRows || []).map((r) => r.event_id));
    const toRefresh = candidates.filter((e) => withRegs.has(e.id)).slice(0, maxRefresh);
    if (!toRefresh.length) return;

    console.log(`🔄 Refreshing ${toRefresh.length} registration-bearing Luma events (stale > ${staleHours}h)`);
    for (const ev of toRefresh) {
      if (this.isShutdownRequested()) break;
      if (this.pageFetchDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pageFetchDelay));
      }
      try {
        const pageData = await this.fetchEventPageHttp(`https://luma.com/event/${ev.luma_event_id}`);
        const parsedEvent = this.buildEventFromPageData(ev.luma_event_id, pageData);
        if (!parsedEvent) {
          // Page gone or private now — leave the stored event untouched;
          // stamp the sync time so a dead page isn't retried every run.
          await supabase
            .from('events')
            .update({ luma_counts_updated_at: new Date().toISOString() })
            .eq('id', ev.id);
          console.warn(`⚠️ Refresh skipped for "${ev.event_title}" — no event data on page`);
          continue;
        }
        await this.globalConfig.saveEvent(parsedEvent);
        this.refreshStats.refreshed++;
      } catch (err) {
        console.warn(`⚠️ Refresh failed for "${ev.event_title}": ${err.message}`);
      }
    }
  }

  /**
   * Fetch a Luma event page over plain HTTP and extract __NEXT_DATA__.
   * Returns { htmlLoaded, finalUrl, coverImageUrl, pageContent, isVirtual,
   * lumaData, lumaPageData } — the same distilled shape the browser-based
   * LumaICalScraper.fetchEventPageData produces, minus the browser.
   */
  async fetchEventPageHttp(eventLink) {
    const empty = {
      htmlLoaded: false, finalUrl: eventLink, coverImageUrl: null,
      pageContent: '', isVirtual: false, lumaData: null, lumaPageData: null,
    };

    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        res = await fetch(eventLink, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn(`⚠️ HTTP fetch failed for ${eventLink}: ${err.message}`);
      return empty;
    }

    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${eventLink}`);
      return empty;
    }

    const html = await res.text();
    const finalUrl = res.url || eventLink;
    console.log(`🌐 Fetched ${finalUrl} (${html.length} bytes)`);

    const nextDataMatch = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
    );

    let lumaData = null;
    let lumaPageData = null;
    let isVirtual = false;
    let coverImageUrl = null;

    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        if (data?.props?.pageProps) {
          lumaPageData = { buildId: data.buildId, pageProps: { ...data.props.pageProps } };
          delete lumaPageData.pageProps.initialUserData;
        }
        const initialData = data?.props?.pageProps?.initialData?.data;
        const eventData = initialData?.event;
        if (eventData) {
          lumaData = {
            lumaEventId: eventData.api_id || initialData.api_id,
            timezone: eventData.timezone,
            coverUrl: eventData.cover_url,
            latitude: eventData.coordinate?.latitude,
            longitude: eventData.coordinate?.longitude,
            city: eventData.geo_address_info?.city,
            country: eventData.geo_address_info?.country,
            countryCode: eventData.geo_address_info?.country_code,
            region: eventData.geo_address_info?.region,
            venueAddress: eventData.geo_address_info?.address,
            fullAddress: eventData.geo_address_info?.full_address,
            shortAddress: eventData.geo_address_info?.short_address,
            locationType: eventData.location_type, // 'offline' or 'online'
          };
          isVirtual = eventData.location_type === 'online';
          coverImageUrl = eventData.cover_url || null;
        }
      } catch (err) {
        console.warn(`⚠️ Failed to parse __NEXT_DATA__ for ${finalUrl}: ${err.message}`);
      }
    }

    // Crude text extraction for topic matching (browser version used
    // document.body.innerText).
    const pageContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 5000);

    return { htmlLoaded: true, finalUrl, coverImageUrl, pageContent, isVirtual, lumaData, lumaPageData };
  }

  /**
   * Build a parsedEvent (same shape as LumaICalScraper.parseICalEvent) from
   * the event page alone. The full event object lives in __NEXT_DATA__ at
   * pageProps.initialData.data.event: name, start_at, end_at plus the
   * location/timezone/cover fields fetchEventPageHttp distils into
   * pageData.lumaData.
   */
  buildEventFromPageData(lumaEventId, pageData) {
    const eventObj = pageData?.lumaPageData?.pageProps?.initialData?.data?.event;
    if (!eventObj?.name || !eventObj?.start_at) return null;

    const lumaData = pageData.lumaData || {};
    const eventName = eventObj.name;

    // Prefer the resolved public slug URL over the /event/<evt-id> probe link.
    const eventLink = /^https:\/\/(lu\.ma|luma\.com)\//.test(pageData.finalUrl || '')
      ? pageData.finalUrl
      : `https://luma.com/event/${lumaEventId}`;

    let coordinates = null;
    let eventLocation = null;
    if (lumaData.latitude && lumaData.longitude) {
      coordinates = { lat: lumaData.latitude, lng: lumaData.longitude };
      eventLocation = `${lumaData.latitude},${lumaData.longitude}`;
    }

    let eventCity = lumaData.city || null;
    let eventRegion = lumaData.region || null;
    if (pageData.isVirtual && !eventCity && !eventRegion) {
      eventCity = 'online';
      eventRegion = 'on';
    }

    return {
      name: eventName,
      eventTitle: eventName,
      url: eventLink,
      event_link: eventLink,
      eventId: null, // generated by the save pipeline
      lumaEventId,
      sourceEventId: lumaEventId,
      eventStart: eventObj.start_at || null,
      eventEnd: eventObj.end_at || null,
      eventLocation,
      eventCity,
      eventCountry: lumaData.country || null,
      eventCountryCode: lumaData.countryCode || null,
      eventRegion,
      venueAddress: lumaData.fullAddress || lumaData.venueAddress || null,
      coordinates,
      eventTimezone: lumaData.timezone || eventObj.timezone || 'UTC',
      eventType: this.detectEventType(eventName),
      scraperName: this.config.name,
      scrapedAt: new Date().toISOString(),
      description: '',
      organizer: null,
      coverImageUrl: pageData.coverImageUrl || null,
      pageContent: pageData.pageContent || '',
      lumaPageData: pageData.lumaPageData || null,
      account: this.config.account || null,
    };
  }

  /**
   * Re-send each queued signup's stored email through the
   * integrations-luma-process-registration edge function (its JSON body path).
   * The event now exists, so the function runs its normal create-registration
   * flow and updates the pending row itself — this stays the single code path
   * for Luma registrations.
   */
  async replayPendingRegistrations(supabase, rows) {
    if (!rows?.length) return;

    const replayable = rows.filter((r) => r.matched_email);
    const unreplayable = rows.filter((r) => !r.matched_email);
    if (unreplayable.length) {
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({ status: 'failed', error_message: 'No registrant email stored — cannot replay' })
        .in('id', unreplayable.map((r) => r.id));
      console.warn(`⚠️ ${unreplayable.length} queued signups have no registrant email — marked failed`);
    }
    if (!replayable.length) return;

    console.log(`🔁 Replaying ${replayable.length} queued signups through the registration pipeline...`);
    for (const row of replayable) {
      if (this.isShutdownRequested()) break;
      try {
        // Fall back to a minimal synthetic body if the raw email wasn't
        // stored: first line = name (so extractUserName strategy 1 matches),
        // manage URL carries the evt- id, replyTo carries the email.
        const text = row.raw_email_data?.text
          || `${row.user_name || 'Unknown'}\nregistered for your event\n\nhttps://luma.com/event/manage/${row.luma_event_id}/guests`;
        const { data, error } = await supabase.functions.invoke(
          'integrations-luma-process-registration',
          {
            body: {
              from: row.email_from || 'Luma <notifications@luma.com>',
              to: row.email_to || '',
              subject: row.email_subject || '',
              text,
              html: '',
              envelope: '',
              headers: row.raw_email_data?.headers || '',
              sender_ip: '',
              replyTo: row.matched_email,
            },
          }
        );
        if (error || data?.success === false) {
          this.replayStats.replayFailed++;
          console.warn(`⚠️ Replay failed for ${row.matched_email} @ ${row.luma_event_id}: ${error?.message || data?.error}`);
        } else {
          this.replayStats.replayed++;
          console.log(`✅ Attached ${row.matched_email} → ${row.luma_event_id} (${data?.action})`);
        }
      } catch (err) {
        this.replayStats.replayFailed++;
        console.warn(`⚠️ Replay error for ${row.matched_email} @ ${row.luma_event_id}: ${err.message}`);
      }
    }
  }
}

export default LumaPendingEventsScraper;
