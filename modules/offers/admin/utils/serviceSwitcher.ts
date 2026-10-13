/**
 * Service Switcher
 *
 * Ported from gatewaze-admin, where it chose between event-based, segment-only
 * and hybrid tracking. The hybrid and segment-only modes read Customer.io
 * segment mirrors (customer_segments / customer_segment_memberships), which
 * this platform does not have. The interaction tables
 * (integrations_offer_interactions, events_discount_interactions,
 * events_competition_interactions) hold the migrated history and every new
 * interaction, so tracking here is always event-based.
 *
 * HybridOfferService no longer reads segments: it answers WHO and WHEN from
 * the interaction tables, paginated past the 1000 row limit, deduplicated by
 * email, with account filtering. It is therefore the event-based offer service
 * used here. OfferService (the original event-based service) is kept for its
 * types but reads at most 1000 rows, keys people by Customer.io id only (which
 * migrated rows may not have), and ignores the account filter, which would
 * show account users every offer.
 *
 * Imported by the offers, discounts and competitions admin pages as
 * `@/utils/serviceSwitcher`.
 */

import { supabase } from '@/lib/supabase';
import { HybridOfferService, type OfferSummary } from './hybridOfferService';
import { DiscountService } from '@/utils/discountService';

export const TRACKING_MODE = 'event-based' as const;

// Re-export the OfferSummary type
export type { OfferSummary };

export const ActiveOfferService = HybridOfferService;

export const ActiveDiscountService = DiscountService;

// Direct export of HybridOfferService for components that need its specific methods
export const ActiveHybridOfferService = HybridOfferService;

/**
 * Helper to log which service is being used (useful for debugging)
 */
export function getTrackingMode(): string {
  return TRACKING_MODE;
}

const PAGE_SIZE = 1000;

/**
 * Competition service wrapper (event-based, from events_competition_interactions)
 */
export class ActiveCompetitionService {
  /**
   * Get entry count (unique entrants) for a competition
   */
  static async getEntryCount(competitionSlug: string): Promise<number> {
    try {
      const entrants = await this.getAcceptedInteractions(competitionSlug);
      const unique = new Set(
        entrants
          .map(i => (i.email ? i.email.toLowerCase() : i.customer_cio_id))
          .filter(Boolean)
      );
      return unique.size;
    } catch (error) {
      console.error('Unexpected error getting competition entry count:', error);
      return 0;
    }
  }

  /**
   * Get all entrants for a competition
   */
  static async getEntrantsForCompetition(competitionSlug: string): Promise<any[]> {
    try {
      const interactions = await this.getAcceptedInteractions(competitionSlug);
      if (interactions.length === 0) {
        return [];
      }

      const emails = [...new Set(interactions.map(i => i.email?.toLowerCase()).filter((e): e is string => !!e))];
      const cioIds = [...new Set(
        interactions.filter(i => !i.email && i.customer_cio_id).map(i => i.customer_cio_id as string)
      )];

      const people: any[] = [];
      const BATCH_SIZE = 500;
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const { data, error } = await supabase
          .from('people')
          .select('id, email, cio_id, attributes')
          .in('email', emails.slice(i, i + BATCH_SIZE));
        if (error) {
          console.error('Error fetching entrant people by email:', error);
          continue;
        }
        people.push(...(data || []));
      }
      for (let i = 0; i < cioIds.length; i += BATCH_SIZE) {
        const { data, error } = await supabase
          .from('people')
          .select('id, email, cio_id, attributes')
          .in('cio_id', cioIds.slice(i, i + BATCH_SIZE));
        if (error) {
          console.error('Error fetching entrant people by cio_id:', error);
          continue;
        }
        people.push(...(data || []));
      }

      const profiles = new Map<string, any>();
      people.forEach(person => {
        const key = (person.email || person.cio_id || '').toLowerCase();
        if (!key || profiles.has(key)) return;
        profiles.set(key, {
          email: person.email || person.cio_id,
          first_name: person.attributes?.first_name,
          last_name: person.attributes?.last_name,
          job_title: person.attributes?.job_title,
          company: person.attributes?.company,
          linkedin_url: person.attributes?.linkedin_url,
          city: person.attributes?.city,
          country: person.attributes?.country,
          continent: person.attributes?.continent,
          cio_id: person.cio_id,
          id: person.id
        });
      });

      // Entrants with no people row still count, with the interaction's email
      emails.forEach(email => {
        if (!profiles.has(email)) {
          profiles.set(email, { email, cio_id: null, id: null });
        }
      });

      return Array.from(profiles.values());
    } catch (error) {
      console.error('Unexpected error getting competition entrants:', error);
      return [];
    }
  }

  /**
   * Get entry timeline for a competition, grouped by minute
   */
  static async getEntryTimeline(competitionSlug: string): Promise<Array<{ date: string; count: number; cumulative: number }>> {
    try {
      const data = await this.getAcceptedInteractions(competitionSlug);

      if (data.length === 0) {
        return [];
      }

      // Group by 1-minute intervals
      const groupedByInterval = data.reduce((acc: { [key: string]: number }, interaction) => {
        if (interaction.timestamp) {
          const timestamp = new Date(interaction.timestamp);
          // Round down to nearest minute
          timestamp.setSeconds(0, 0);
          const intervalKey = timestamp.toISOString();
          acc[intervalKey] = (acc[intervalKey] || 0) + 1;
        }
        return acc;
      }, {});

      // Convert to timeline array with cumulative count
      const sortedIntervals = Object.keys(groupedByInterval).sort();
      let cumulative = 0;
      return sortedIntervals.map(interval => {
        cumulative += groupedByInterval[interval];
        return {
          date: interval,
          count: groupedByInterval[interval],
          cumulative
        };
      });
    } catch (error) {
      console.error('Error loading entry timeline:', error);
      return [];
    }
  }

  /**
   * All accepted interactions for an offer slug, oldest first, paginated past
   * the 1000 row limit. Reads the interaction table that matches the slug
   * prefix, as the original app did.
   */
  private static async getAcceptedInteractions(
    offerSlug: string
  ): Promise<Array<{ email: string | null; customer_cio_id: string | null; timestamp: string }>> {
    let tableName: string;
    if (offerSlug.startsWith('win-')) {
      tableName = 'events_competition_interactions';
    } else if (offerSlug.startsWith('discount-') || offerSlug.startsWith('free-tickets-')) {
      tableName = 'events_discount_interactions';
    } else {
      tableName = 'integrations_offer_interactions';
    }

    let rows: Array<{ email: string | null; customer_cio_id: string | null; timestamp: string }> = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from(tableName)
        .select('email, customer_cio_id, timestamp')
        .eq('offer_id', offerSlug)
        .eq('offer_status', 'accepted')
        .order('timestamp', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error('Error loading competition interactions:', error);
        break;
      }

      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        rows = rows.concat(data);
        offset += PAGE_SIZE;
        hasMore = data.length === PAGE_SIZE;
      }
    }

    return rows;
  }
}
