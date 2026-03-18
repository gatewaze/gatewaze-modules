import { supabase } from '@/lib/supabase';
import { SegmentMappingService } from './segmentMappingService';

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

/**
 * Service class for offer operations using Customer.io segment membership data
 * This replaces the event-based tracking with more accurate segment membership counts
 */
export class OfferServiceV2 {

  /**
   * Get all unique offers that have corresponding segments
   * Returns a list of offers with their statistics from segment membership
   * @param _accountIds Optional array of account IDs to filter by (not implemented in this version)
   */
  static async getAllOffers(_accountIds?: string[]): Promise<OfferSummary[]> {
    try {
      // First, get all segments that match the offer pattern
      const { data: segments, error } = await supabase
        .from('segments')
        .select('name, cio_segment_id, last_synced_at')
        .like('name', 'Offer // % // Accepted')
        .order('name');

      if (error) {
        console.error('Error fetching offer segments:', error);
        return [];
      }

      if (!segments || segments.length === 0) {
        return [];
      }

      // Extract offer IDs from segment names and get counts
      const offerSummaries: OfferSummary[] = [];
      const segmentIds = segments.map(s => s.cio_segment_id);

      // Get member counts for all segments in one query
      const memberCounts = await SegmentMappingService.getSegmentMemberCounts(segmentIds);

      for (const segment of segments) {
        // Extract offer ID from segment name "Offer // {offerId} // Accepted"
        const match = segment.name.match(/^Offer \/\/ (.+) \/\/ Accepted$/);
        if (!match) continue;

        const offerId = match[1];
        const acceptedCount = memberCounts.get(segment.cio_segment_id) || 0;

        // For segment-based data, we only have accepted counts
        // We'll use the segment's last sync time as the last interaction
        offerSummaries.push({
          offer_id: offerId,
          total_interactions: acceptedCount, // In segment-based tracking, we only track accepted
          accepted_count: acceptedCount,
          viewed_count: 0, // Viewed count not available in segment data
          first_interaction: segment.last_synced_at || new Date().toISOString(),
          last_interaction: segment.last_synced_at || new Date().toISOString()
        });
      }

      // Sort by offer_id for consistent ordering
      offerSummaries.sort((a, b) => a.offer_id.localeCompare(b.offer_id));

      return offerSummaries;

    } catch (error) {
      console.error('Unexpected error fetching offers:', error);
      return [];
    }
  }

  /**
   * Get a single offer by ID using segment membership data
   */
  static async getOfferById(offerId: string): Promise<OfferSummary | null> {
    try {
      // Get the segment ID for this offer
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerId);

      if (!segmentId) {
        console.log(`No segment found for offer: ${offerId}`);
        return null;
      }

      // Get the member count
      const acceptedCount = await SegmentMappingService.getSegmentMemberCount(segmentId);

      // Get segment info for timestamps
      const { data: segment, error } = await supabase
        .from('segments')
        .select('last_synced_at')
        .eq('cio_segment_id', segmentId)
        .single();

      if (error) {
        console.error('Error fetching segment info:', error);
      }

      return {
        offer_id: offerId,
        total_interactions: acceptedCount,
        accepted_count: acceptedCount,
        viewed_count: 0, // Not available in segment data
        first_interaction: segment?.last_synced_at || new Date().toISOString(),
        last_interaction: segment?.last_synced_at || new Date().toISOString()
      };

    } catch (error) {
      console.error('Unexpected error fetching offer:', error);
      return null;
    }
  }

  /**
   * Get accepted count for a specific offer using segment membership
   */
  static async getAcceptedCount(offerSlug: string): Promise<number> {
    try {
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerSlug);

      if (!segmentId) {
        console.log(`No segment found for offer: ${offerSlug}`);
        return 0;
      }

      return await SegmentMappingService.getSegmentMemberCount(segmentId);
    } catch (error) {
      console.error('Unexpected error getting accepted count:', error);
      return 0;
    }
  }

  /**
   * Get accepted counts for multiple offers using segment membership
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

      // Get segment IDs for all offers
      const segmentMap = await SegmentMappingService.getSegmentIdsForOffers(offerSlugs);

      // Get member counts for all segments
      const segmentIds = Array.from(segmentMap.values());
      const memberCounts = await SegmentMappingService.getSegmentMemberCounts(segmentIds);

      // Map back to offer IDs
      segmentMap.forEach((segmentId, offerId) => {
        const count = memberCounts.get(segmentId) || 0;
        counts.set(offerId, count);
      });

      return counts;

    } catch (error) {
      console.error('Unexpected error fetching accepted counts:', error);
      return new Map<string, number>();
    }
  }

  /**
   * Get all customers who accepted a specific offer using segment membership
   * This returns enriched customer profiles from the database
   */
  static async getAcceptedForOffer(offerSlug: string): Promise<any[]> {
    try {
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerSlug);

      if (!segmentId) {
        console.log(`No segment found for offer: ${offerSlug}`);
        return [];
      }

      // Get all member CIO IDs from segment membership
      const cioIds = await SegmentMappingService.getSegmentMembers(segmentId);

      if (cioIds.length === 0) {
        return [];
      }

      // Fetch customer data from the database in batches to avoid query size limits
      const BATCH_SIZE = 500;
      const allCustomers: any[] = [];

      for (let i = 0; i < cioIds.length; i += BATCH_SIZE) {
        const batch = cioIds.slice(i, i + BATCH_SIZE);

        const { data: customers, error: customerError } = await supabase
          .from('people')
          .select('*')
          .in('cio_id', batch);

        if (customerError) {
          console.error('Error fetching customer batch:', customerError);
          continue;
        }

        if (customers) {
          allCustomers.push(...customers);
        }
      }

      // Map customer data to profiles
      const profiles = allCustomers.map(customer => ({
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
      }));

      return profiles;

    } catch (error) {
      console.error('Unexpected error getting accepted customers:', error);
      return [];
    }
  }

  /**
   * Get timeline data for accepted offer interactions
   * Note: With segment-based tracking, we don't have granular timestamp data
   * This method returns a simplified timeline based on segment sync times
   */
  static async getAcceptedTimeline(offerSlug: string): Promise<Array<{ date: string; count: number; cumulative: number }>> {
    try {
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerSlug);

      if (!segmentId) {
        console.log(`No segment found for offer: ${offerSlug}`);
        return [];
      }

      // Get the current member count
      const memberCount = await SegmentMappingService.getSegmentMemberCount(segmentId);

      // Get segment info for the last sync time
      const { data: segment, error } = await supabase
        .from('segments')
        .select('last_synced_at')
        .eq('cio_segment_id', segmentId)
        .single();

      if (error || !segment?.last_synced_at) {
        console.error('Error fetching segment info:', error);
        return [];
      }

      // Return a simple timeline with the current count at the last sync time
      // Note: This is less granular than event-based tracking but more accurate
      return [{
        date: segment.last_synced_at,
        count: memberCount,
        cumulative: memberCount
      }];

    } catch (error) {
      console.error('Error loading accepted timeline:', error);
      return [];
    }
  }

  /**
   * Migrate from event-based to segment-based tracking
   * This method helps identify offers that need segment creation in Customer.io
   */
  static async identifyOffersNeedingSegments(): Promise<string[]> {
    try {
      // Get all unique offer IDs from the interaction table
      const { data: interactions, error: interactionError } = await supabase
        .from('integrations_offer_interactions')
        .select('offer_id')
        .eq('offer_status', 'accepted');

      if (interactionError) {
        console.error('Error fetching interaction offers:', interactionError);
        return [];
      }

      const interactionOfferIds = new Set(interactions?.map(i => i.offer_id) || []);

      // Get all offer segments
      const { data: segments, error: segmentError } = await supabase
        .from('segments')
        .select('name')
        .like('name', 'Offer // % // Accepted');

      if (segmentError) {
        console.error('Error fetching segments:', segmentError);
        return [];
      }

      const segmentOfferIds = new Set<string>();
      segments?.forEach(segment => {
        const match = segment.name.match(/^Offer \/\/ (.+) \/\/ Accepted$/);
        if (match) {
          segmentOfferIds.add(match[1]);
        }
      });

      // Find offers that have interactions but no segment
      const offersNeedingSegments = Array.from(interactionOfferIds).filter(
        offerId => !segmentOfferIds.has(offerId)
      );

      return offersNeedingSegments;

    } catch (error) {
      console.error('Error identifying offers needing segments:', error);
      return [];
    }
  }
}