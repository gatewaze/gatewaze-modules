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
 *   2. For luma_event_ids with no event, scrape the public event page
 *      (https://luma.com/event/<evt-id> 301s to the event's slug URL) and
 *      save it through the normal pipeline — the scraper row's
 *      content_category / default_publish_state config decides categorisation
 *      and Content Inbox triage, same as every other scraper.
 *   3. Replay the queued registrations for the events just created.
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
      // Table absent (luma module not installed) or unreadable — clean no-op.
      console.log(`ℹ️ Pending Luma registrations unavailable (${pendErr.message}) — nothing to do`);
      return [];
    }
    if (!pendingRows?.length) {
      console.log('✅ No queued Luma signups awaiting an event');
      return [];
    }

    const ids = [...new Set(pendingRows.map((r) => r.luma_event_id).filter(Boolean))];
    console.log(`📬 ${pendingRows.length} queued signups across ${ids.length} Luma events`);

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
      pendingRows.filter((r) => existingIds.has(r.luma_event_id))
    );

    // Phase 2: scrape the events that don't exist yet.
    const maxPerRun = this.config?.config?.maxEventsPerRun ?? 20;
    const toScrape = ids.filter((id) => !existingIds.has(id));
    if (toScrape.length > maxPerRun) {
      console.log(`⚠️ ${toScrape.length} events queued; scraping first ${maxPerRun} this run (rest next run)`);
    }

    const scrapedIds = [];
    if (toScrape.length > 0) {
      await this.initialize();
      try {
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
            const pageData = await this.fetchEventPageData(probeLink);
            const parsedEvent = this.buildEventFromPageData(lumaEventId, probeLink, pageData);

            if (!parsedEvent) {
              this.stats.failed++;
              // Page rendered but carries no event object — the event was
              // deleted or is private. Mark its queued rows failed so they
              // aren't retried forever; admins can reset status to retry.
              if (pageData?.pageContent) {
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
            if (this.isBrowserDeadError(error)) {
              console.error(`❌ Browser is dead, aborting scrape: ${error.message}`);
              throw error;
            }
            console.warn(`⚠️ Failed to scrape ${lumaEventId}: ${error.message}`);
            this.stats.failed++;
          }
        }
      } finally {
        await this.cleanup();
      }
    }

    // Phase 3: replay signups for the events we just created (streaming saves
    // are already in the DB; batch-fallback events get replayed next run).
    await this.replayPendingRegistrations(
      supabase,
      pendingRows.filter((r) => scrapedIds.includes(r.luma_event_id))
    );

    console.log(
      `📊 Stats: ${this.stats.found} events scraped, ${this.stats.failed} failed, ` +
      `${this.replayStats.replayed} registrations attached, ${this.replayStats.replayFailed} replay failures`
    );
    return this.events;
  }

  /**
   * Build a parsedEvent (same shape as LumaICalScraper.parseICalEvent) from
   * the event page alone. The full event object lives in __NEXT_DATA__ at
   * pageProps.initialData.data.event: name, start_at, end_at plus the
   * location/timezone/cover fields fetchEventPageData already distils into
   * pageData.lumaData.
   */
  buildEventFromPageData(lumaEventId, probeLink, pageData) {
    const eventObj = pageData?.lumaPageData?.pageProps?.initialData?.data?.event;
    if (!eventObj?.name || !eventObj?.start_at) return null;

    const lumaData = pageData.lumaData || {};
    const eventName = eventObj.name;

    // Prefer the resolved public slug URL over the /event/<evt-id> probe link.
    let eventLink = probeLink;
    try {
      const current = this.page?.url();
      if (current && /^https:\/\/(lu\.ma|luma\.com)\//.test(current)) eventLink = current;
    } catch { /* page gone — keep probe link */ }

    let coordinates = null;
    let eventLocation = null;
    if (lumaData.latitude && lumaData.longitude) {
      coordinates = { lat: lumaData.latitude, lng: lumaData.longitude };
      eventLocation = `${lumaData.latitude},${lumaData.longitude}`;
    }

    let eventCity = lumaData.city || null;
    let eventRegion = lumaData.region || null;
    const isVirtual = pageData.isVirtual || lumaData.locationType === 'online';
    if (isVirtual && !eventCity && !eventRegion) {
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
