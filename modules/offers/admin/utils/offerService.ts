import { supabase } from '@/lib/supabase';

// Offer interaction interface matching the offer_interactions table
export interface OfferInteraction {
  customer_cio_id: string;
  offer_id: string;
  offer_status: string;
  offer_referrer?: string | null;
  timestamp: string;
  created_at?: string;
  updated_at?: string;
}

// Offer summary interface for listing offers
export interface OfferSummary {
  offer_id: string;
  total_interactions: number;
  accepted_count: number;
  viewed_count: number;
  first_interaction: string;
  last_interaction: string;
  account_id?: string | null;
  account_name?: string | null;
}

// Service class for offer operations
export class OfferService {

  /**
   * Get all unique offers from offer_interactions table
   * Returns a list of offers with their statistics
   * @param _accountIds Optional array of account IDs to filter by (not implemented in this version)
   */
  static async getAllOffers(_accountIds?: string[]): Promise<OfferSummary[]> {
    try {
      // Get all interactions
      const { data: interactions, error } = await supabase
        .from('integrations_offer_interactions')
        .select('offer_id, offer_status, timestamp, customer_cio_id')
        .order('timestamp', { ascending: false });

      if (error) {
        console.error('Error fetching offers:', error);
        return [];
      }

      if (!interactions || interactions.length === 0) {
        return [];
      }

      // Group by offer_id and calculate statistics
      const offerMap = new Map<string, {
        total: number;
        accepted: Set<string>;
        viewed: Set<string>;
        timestamps: string[];
      }>();

      interactions.forEach(interaction => {
        if (!offerMap.has(interaction.offer_id)) {
          offerMap.set(interaction.offer_id, {
            total: 0,
            accepted: new Set(),
            viewed: new Set(),
            timestamps: []
          });
        }

        const offer = offerMap.get(interaction.offer_id)!;
        offer.total++;
        offer.timestamps.push(interaction.timestamp);

        if (interaction.offer_status === 'accepted') {
          offer.accepted.add(interaction.customer_cio_id || '');
        } else if (interaction.offer_status === 'viewed') {
          offer.viewed.add(interaction.customer_cio_id || '');
        }
      });

      // Convert to array of OfferSummary
      const offers: OfferSummary[] = [];
      offerMap.forEach((stats, offer_id) => {
        const sortedTimestamps = stats.timestamps.sort();
        offers.push({
          offer_id,
          total_interactions: stats.total,
          accepted_count: stats.accepted.size,
          viewed_count: stats.viewed.size,
          first_interaction: sortedTimestamps[0],
          last_interaction: sortedTimestamps[sortedTimestamps.length - 1]
        });
      });

      // Sort by last interaction date (most recent first)
      offers.sort((a, b) =>
        new Date(b.last_interaction).getTime() - new Date(a.last_interaction).getTime()
      );

      return offers;

    } catch (error) {
      console.error('Unexpected error fetching offers:', error);
      return [];
    }
  }

  /**
   * Get a single offer by ID
   */
  static async getOfferById(offerId: string): Promise<OfferSummary | null> {
    try {
      const { data: interactions, error } = await supabase
        .from('integrations_offer_interactions')
        .select('offer_id, offer_status, timestamp, customer_cio_id')
        .eq('offer_id', offerId);

      if (error) {
        console.error('Error fetching offer:', error);
        return null;
      }

      if (!interactions || interactions.length === 0) {
        return null;
      }

      const accepted = new Set<string>();
      const viewed = new Set<string>();
      const timestamps: string[] = [];

      interactions.forEach(interaction => {
        timestamps.push(interaction.timestamp);
        if (interaction.offer_status === 'accepted') {
          accepted.add(interaction.customer_cio_id);
        } else if (interaction.offer_status === 'viewed') {
          viewed.add(interaction.customer_cio_id);
        }
      });

      const sortedTimestamps = timestamps.sort();

      return {
        offer_id: offerId,
        total_interactions: interactions.length,
        accepted_count: accepted.size,
        viewed_count: viewed.size,
        first_interaction: sortedTimestamps[0],
        last_interaction: sortedTimestamps[sortedTimestamps.length - 1]
      };

    } catch (error) {
      console.error('Unexpected error fetching offer:', error);
      return null;
    }
  }

  /**
   * Get accepted count for a specific offer
   */
  static async getAcceptedCount(offerSlug: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('integrations_offer_interactions')
        .select('customer_cio_id', { count: 'exact', head: true })
        .eq('offer_id', offerSlug)
        .eq('offer_status', 'accepted');

      if (error) {
        console.error('Error getting accepted count:', error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      console.error('Unexpected error getting accepted count:', error);
      return 0;
    }
  }

  /**
   * Get accepted counts for multiple offers
   */
  static async getAcceptedCountsForOffers(offerSlugs: string[]): Promise<Map<string, number>> {
    try {
      const counts = new Map<string, number>();

      // Initialize all counts to 0
      offerSlugs.forEach(offerSlug => {
        counts.set(offerSlug, 0);
      });

      if (offerSlugs.length === 0) {
        return counts;
      }

      // Get all accepted interactions for these offers
      const { data, error } = await supabase
        .from('integrations_offer_interactions')
        .select('offer_id, customer_cio_id')
        .in('offer_id', offerSlugs)
        .eq('offer_status', 'accepted');

      if (error) {
        console.error('Error fetching accepted counts:', error);
        return counts;
      }

      // Count unique acceptances per offer
      const offerAcceptances = new Map<string, Set<string>>();
      data?.forEach(interaction => {
        if (!offerAcceptances.has(interaction.offer_id)) {
          offerAcceptances.set(interaction.offer_id, new Set());
        }
        offerAcceptances.get(interaction.offer_id)?.add(interaction.customer_cio_id);
      });

      // Convert to counts
      offerAcceptances.forEach((acceptances, offerId) => {
        counts.set(offerId, acceptances.size);
      });

      return counts;

    } catch (error) {
      console.error('Unexpected error fetching accepted counts:', error);
      return new Map<string, number>();
    }
  }

  /**
   * Get all customers who accepted a specific offer (from offer_interactions)
   * This returns enriched customer profiles from the database
   */
  static async getAcceptedForOffer(offerSlug: string): Promise<any[]> {
    try {
      // Get all customers who accepted this offer
      const { data: interactions, error } = await supabase
        .from('integrations_offer_interactions')
        .select('customer_cio_id, timestamp')
        .eq('offer_id', offerSlug)
        .eq('offer_status', 'accepted')
        .order('timestamp', { ascending: true });

      if (error) {
        console.error('Error getting accepted customers:', error);
        return [];
      }

      if (!interactions || interactions.length === 0) {
        return [];
      }

      // Get unique customer IDs (in case there are duplicate entries)
      const cioIds = [...new Set(interactions.map(i => i.customer_cio_id))];

      // Fetch customer data from the database
      const { data: customers, error: customerError } = await supabase
        .from('people')
        .select('*')
        .in('cio_id', cioIds);

      if (customerError) {
        console.error('Error fetching customer data:', customerError);
        return [];
      }

      // Map customer data to profiles
      const profiles = customers?.map(customer => ({
        email: customer.email || customer.cio_id,
        first_name: customer.attributes?.first_name,
        last_name: customer.attributes?.last_name,
        job_title: customer.attributes?.job_title,
        company: customer.attributes?.company,
        linkedin_url: customer.attributes?.linkedin_url,
        city: customer.attributes?.city,
        country: customer.attributes?.country,
        continent: customer.attributes?.continent,
        cio_id: customer.cio_id,
        id: customer.id
      })) || [];

      return profiles;

    } catch (error) {
      console.error('Unexpected error getting accepted customers:', error);
      return [];
    }
  }

  /**
   * Get timeline data for accepted offer interactions
   */
  static async getAcceptedTimeline(offerSlug: string): Promise<Array<{ date: string; count: number; cumulative: number }>> {
    try {
      // Get all accepted interactions with timestamps
      const { data, error } = await supabase
        .from('integrations_offer_interactions')
        .select('timestamp')
        .eq('offer_id', offerSlug)
        .eq('offer_status', 'accepted')
        .order('timestamp', { ascending: true });

      if (error) {
        console.error('Error loading accepted timeline:', error);
        return [];
      }

      if (!data || data.length === 0) {
        return [];
      }

      // Group by 1-minute intervals
      const groupedByInterval = data.reduce((acc: { [key: string]: number }, interaction) => {
        if (interaction.timestamp) {
          const timestamp = new Date(interaction.timestamp);
          // Round down to the nearest 1-minute interval (set seconds and milliseconds to 0)
          timestamp.setSeconds(0, 0);
          const intervalKey = timestamp.toISOString();
          acc[intervalKey] = (acc[intervalKey] || 0) + 1;
        }
        return acc;
      }, {});

      // Convert to timeline array with cumulative count
      const sortedIntervals = Object.keys(groupedByInterval).sort();
      let cumulative = 0;
      const timeline = sortedIntervals.map(interval => {
        cumulative += groupedByInterval[interval];
        return {
          date: interval,
          count: groupedByInterval[interval],
          cumulative
        };
      });

      return timeline;
    } catch (error) {
      console.error('Error loading accepted timeline:', error);
      return [];
    }
  }
}
