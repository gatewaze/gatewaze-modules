import { supabase } from '@/lib/supabase';
import { SegmentMappingService } from './segmentMappingService';

// Discount code interface matching the discount_codes table
export interface DiscountCode {
  id?: string;
  code: string;
  event_id: string;
  issued: boolean;
  issued_to?: string | null;
  issued_at?: string | null;
  registered?: boolean;
  registered_at?: string | null;
  attended?: boolean;
  attended_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// Discount codes stats for an event
export interface DiscountCodesStats {
  total: number;
  available: number;
  claimed: number;
}

/**
 * Service class for discount operations using Customer.io segment membership data
 * This replaces the event-based tracking with more accurate segment membership counts
 */
export class DiscountServiceV2 {

  /**
   * Get discount codes statistics for a specific event
   * Note: Code inventory management still uses the discount_codes table
   */
  static async getDiscountCodesStats(eventId: string): Promise<DiscountCodesStats> {
    try {
      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let allData: Array<{ issued: boolean }> = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('issued')
          .eq('event_id', eventId)
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error fetching discount codes stats:', error);
          break;
        }

        if (data && data.length > 0) {
          allData = allData.concat(data);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      const total = allData.length;
      const claimed = allData.filter(code => code.issued).length;
      const available = total - claimed;

      return { total, available, claimed };

    } catch (error) {
      console.error('Unexpected error fetching discount codes stats:', error);
      return { total: 0, available: 0, claimed: 0 };
    }
  }

  /**
   * Get discount codes stats for multiple events
   */
  static async getDiscountCodesStatsForEvents(eventIds: string[]): Promise<Map<string, DiscountCodesStats>> {
    try {
      const statsMap = new Map<string, DiscountCodesStats>();

      // Initialize all counts to 0
      eventIds.forEach(eventId => {
        statsMap.set(eventId, { total: 0, available: 0, claimed: 0 });
      });

      if (eventIds.length === 0) {
        return statsMap;
      }

      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let allData: Array<{ event_id: string; issued: boolean }> = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('event_id, issued')
          .in('event_id', eventIds)
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error fetching discount codes stats:', error);
          break;
        }

        if (data && data.length > 0) {
          allData = allData.concat(data);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      console.log(`Fetched ${allData.length} discount codes for ${eventIds.length} events`);

      // Count codes per event
      const eventCounts = new Map<string, { total: number; claimed: number }>();
      allData.forEach(code => {
        const current = eventCounts.get(code.event_id) || { total: 0, claimed: 0 };
        current.total++;
        if (code.issued) {
          current.claimed++;
        }
        eventCounts.set(code.event_id, current);
      });

      // Convert to stats format
      eventCounts.forEach((counts, eventId) => {
        statsMap.set(eventId, {
          total: counts.total,
          available: counts.total - counts.claimed,
          claimed: counts.claimed
        });
        console.log(`Event ${eventId}: ${counts.claimed} claimed of ${counts.total} total`);
      });

      return statsMap;

    } catch (error) {
      console.error('Unexpected error fetching discount codes stats:', error);
      return new Map<string, DiscountCodesStats>();
    }
  }

  /**
   * Get claimant count for a specific offer using segment membership
   */
  static async getClaimantCount(offerSlug: string): Promise<number> {
    try {
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerSlug);

      if (!segmentId) {
        console.log(`No segment found for discount offer: ${offerSlug}`);
        return 0;
      }

      return await SegmentMappingService.getSegmentMemberCount(segmentId);
    } catch (error) {
      console.error('Unexpected error getting claimant count:', error);
      return 0;
    }
  }

  /**
   * Get sold-out count for a specific offer
   * Note: With segment-based tracking, we may not have "sold-out" status
   * This would need to be tracked separately in Customer.io as a different segment
   */
  static async getSoldOutCount(offerSlug: string): Promise<number> {
    try {
      // Look for a "Sold Out" segment for this offer
      const soldOutSegmentName = `Offer // ${offerSlug} // Sold-Out`;

      const { data, error } = await supabase
        .from('segments')
        .select('cio_segment_id')
        .eq('name', soldOutSegmentName)
        .single();

      if (error || !data) {
        // No sold-out segment exists, return 0
        return 0;
      }

      return await SegmentMappingService.getSegmentMemberCount(data.cio_segment_id);
    } catch (error) {
      console.error('Unexpected error getting sold-out count:', error);
      return 0;
    }
  }

  /**
   * Get claimant counts for multiple offers using segment membership
   */
  static async getClaimantCountsForOffers(offerSlugs: string[]): Promise<Map<string, number>> {
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
      console.error('Unexpected error fetching claimant counts:', error);
      return new Map<string, number>();
    }
  }

  /**
   * Get all discount codes for a specific event
   * Note: This still uses the discount_codes table for inventory management
   */
  static async getDiscountCodesForEvent(eventId: string): Promise<DiscountCode[]> {
    try {
      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let allData: DiscountCode[] = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('*')
          .eq('event_id', eventId)
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error fetching discount codes:', error);
          break;
        }

        if (data && data.length > 0) {
          allData = allData.concat(data as DiscountCode[]);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      return allData;

    } catch (error) {
      console.error('Unexpected error fetching discount codes:', error);
      return [];
    }
  }

  /**
   * Get claimants for a specific offer using segment membership
   * This returns enriched customer profiles from the database
   */
  static async getClaimantsForOffer(offerSlug: string): Promise<any[]> {
    try {
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerSlug);

      if (!segmentId) {
        console.log(`No segment found for discount offer: ${offerSlug}`);
        return [];
      }

      // Get all member CIO IDs from segment membership
      const cioIds = await SegmentMappingService.getSegmentMembers(segmentId);

      if (cioIds.length === 0) {
        return [];
      }

      // Fetch customer data from the database in batches
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
      console.error('Unexpected error getting claimants:', error);
      return [];
    }
  }

  /**
   * Upload discount codes for a specific event
   * Note: This still uses the discount_codes table for inventory management
   * @param eventId - The event ID to associate codes with
   * @param codes - Array of discount code strings
   * @param onProgress - Optional callback for upload progress
   */
  static async uploadDiscountCodes(
    eventId: string,
    codes: string[],
    onProgress?: (progress: { total: number; uploaded: number; failed: number }) => void
  ): Promise<{ success: boolean; error?: string; uploaded: number; failed: number }> {
    try {
      const total = codes.length;
      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100 to avoid overwhelming the database
      const batchSize = 100;

      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);

        // Prepare batch insert data
        const insertData = batch.map(code => ({
          code: code.trim(),
          event_id: eventId,
          issued: false,
          issued_to: null,
          issued_at: null,
        }));

        // Insert batch
        const { error } = await supabase
          .from('events_discount_codes')
          .insert(insertData);

        if (error) {
          console.error('Error inserting batch:', error);
          // If batch fails, try individually to identify which codes failed
          for (const code of batch) {
            const { error: individualError } = await supabase
              .from('events_discount_codes')
              .insert({
                code: code.trim(),
                event_id: eventId,
                issued: false,
                issued_to: null,
                issued_at: null,
              });

            if (individualError) {
              console.error(`Failed to insert code ${code}:`, individualError);
              failed++;
            } else {
              uploaded++;
            }

            // Report progress
            if (onProgress) {
              onProgress({ total, uploaded, failed });
            }
          }
        } else {
          uploaded += batch.length;

          // Report progress
          if (onProgress) {
            onProgress({ total, uploaded, failed });
          }
        }
      }

      if (failed > 0) {
        return {
          success: uploaded > 0,
          uploaded,
          failed,
          error: `${failed} code(s) failed to upload (may be duplicates)`
        };
      }

      return { success: true, uploaded, failed };

    } catch (error) {
      console.error('Unexpected error uploading discount codes:', error);
      return {
        success: false,
        uploaded: 0,
        failed: codes.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate and upload "none" discount codes for tracking offer acceptances
   * @param eventId - The event ID to associate codes with
   * @param count - Number of "none" codes to generate
   * @param onProgress - Optional callback for upload progress
   */
  static async generateNoneCodes(
    eventId: string,
    count: number,
    onProgress?: (progress: { total: number; uploaded: number; failed: number }) => void
  ): Promise<{ success: boolean; error?: string; uploaded: number; failed: number }> {
    try {
      const total = count;
      let uploaded = 0;
      let failed = 0;

      // Generate unique "none" codes with timestamp and random suffix
      const codes: string[] = [];
      const timestamp = Date.now();

      for (let i = 0; i < count; i++) {
        // Generate a unique code like "NONE-1732450123-0001"
        const codeNumber = String(i + 1).padStart(4, '0');
        const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        codes.push(`NONE-${timestamp}-${codeNumber}-${randomSuffix}`);
      }

      // Process codes in batches of 100 to avoid overwhelming the database
      const batchSize = 100;

      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);

        // Prepare batch insert data
        const insertData = batch.map(code => ({
          code: code,
          event_id: eventId,
          issued: false,
          issued_to: null,
          issued_at: null,
        }));

        // Insert batch
        const { error } = await supabase
          .from('events_discount_codes')
          .insert(insertData);

        if (error) {
          console.error('Error inserting batch:', error);
          // If batch fails, try individually to identify which codes failed
          for (const code of batch) {
            const { error: individualError } = await supabase
              .from('events_discount_codes')
              .insert({
                code: code,
                event_id: eventId,
                issued: false,
                issued_to: null,
                issued_at: null,
              });

            if (individualError) {
              console.error(`Failed to insert code ${code}:`, individualError);
              failed++;
            } else {
              uploaded++;
            }

            // Report progress
            if (onProgress) {
              onProgress({ total, uploaded, failed });
            }
          }
        } else {
          uploaded += batch.length;

          // Report progress
          if (onProgress) {
            onProgress({ total, uploaded, failed });
          }
        }
      }

      if (failed > 0) {
        return {
          success: uploaded > 0,
          uploaded,
          failed,
          error: `${failed} code(s) failed to generate`
        };
      }

      return { success: true, uploaded, failed };

    } catch (error) {
      console.error('Unexpected error generating none codes:', error);
      return {
        success: false,
        uploaded: 0,
        failed: count,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Delete a discount code
   */
  static async deleteDiscountCode(codeId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('events_discount_codes')
        .delete()
        .eq('id', codeId);

      if (error) {
        console.error('Error deleting discount code:', error);
        return { success: false, error: error.message };
      }

      return { success: true };

    } catch (error) {
      console.error('Unexpected error deleting discount code:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Identify discount offers that need segments in Customer.io
   */
  static async identifyDiscountsNeedingSegments(): Promise<string[]> {
    try {
      // Get all unique offer IDs from the discount interactions table
      const { data: interactions, error: interactionError } = await supabase
        .from('events_discount_interactions')
        .select('offer_id')
        .eq('offer_status', 'accepted');

      if (interactionError) {
        console.error('Error fetching discount interactions:', interactionError);
        return [];
      }

      const interactionOfferIds = new Set(interactions?.map(i => i.offer_id) || []);

      // Get all discount segments
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
        if (match && (match[1].startsWith('discount-') || match[1].startsWith('free-tickets-'))) {
          segmentOfferIds.add(match[1]);
        }
      });

      // Find discount offers that have interactions but no segment
      const discountsNeedingSegments = Array.from(interactionOfferIds).filter(
        offerId => !segmentOfferIds.has(offerId)
      );

      return discountsNeedingSegments;

    } catch (error) {
      console.error('Error identifying discounts needing segments:', error);
      return [];
    }
  }

  /**
   * Mark discount codes as registered
   * @param eventId - The event ID
   * @param codes - Array of discount code strings to mark as registered
   * @param onProgress - Optional callback for progress updates
   */
  static async markCodesAsRegistered(
    eventId: string,
    codes: string[],
    onProgress?: (progress: { total: number; uploaded: number; failed: number }) => void
  ): Promise<{ success: boolean; error?: string; uploaded: number; failed: number }> {
    try {
      const total = codes.length;
      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100
      const batchSize = 100;

      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);

        // Update each code in the batch
        for (const code of batch) {
          const { error } = await supabase
            .from('events_discount_codes')
            .update({
              registered: true,
              registered_at: new Date().toISOString(),
            })
            .eq('event_id', eventId)
            .eq('code', code.trim());

          if (error) {
            console.error(`Failed to mark code ${code} as registered:`, error);
            failed++;
          } else {
            uploaded++;
          }

          // Report progress
          if (onProgress) {
            onProgress({ total, uploaded, failed });
          }
        }
      }

      if (failed > 0) {
        return {
          success: uploaded > 0,
          uploaded,
          failed,
          error: `${failed} code(s) failed to update (codes may not exist)`
        };
      }

      return { success: true, uploaded, failed };

    } catch (error) {
      console.error('Unexpected error marking codes as registered:', error);
      return {
        success: false,
        uploaded: 0,
        failed: codes.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Mark discount codes as attended
   * @param eventId - The event ID
   * @param codes - Array of discount code strings to mark as attended
   * @param onProgress - Optional callback for progress updates
   */
  static async markCodesAsAttended(
    eventId: string,
    codes: string[],
    onProgress?: (progress: { total: number; uploaded: number; failed: number }) => void
  ): Promise<{ success: boolean; error?: string; uploaded: number; failed: number }> {
    try {
      const total = codes.length;
      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100
      const batchSize = 100;

      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);

        // Update each code in the batch
        for (const code of batch) {
          // Note: When marking as attended, we also mark as registered if not already
          const { error } = await supabase
            .from('events_discount_codes')
            .update({
              registered: true,
              registered_at: new Date().toISOString(),
              attended: true,
              attended_at: new Date().toISOString(),
            })
            .eq('event_id', eventId)
            .eq('code', code.trim());

          if (error) {
            console.error(`Failed to mark code ${code} as attended:`, error);
            failed++;
          } else {
            uploaded++;
          }

          // Report progress
          if (onProgress) {
            onProgress({ total, uploaded, failed });
          }
        }
      }

      if (failed > 0) {
        return {
          success: uploaded > 0,
          uploaded,
          failed,
          error: `${failed} code(s) failed to update (codes may not exist)`
        };
      }

      return { success: true, uploaded, failed };

    } catch (error) {
      console.error('Unexpected error marking codes as attended:', error);
      return {
        success: false,
        uploaded: 0,
        failed: codes.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get registration and attendance statistics for discount codes
   */
  static async getRegistrationAttendanceStats(eventId: string): Promise<{
    total: number;
    issued: number;
    registered: number;
    attended: number;
  }> {
    try {
      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let allData: Array<{ issued: boolean; registered: boolean; attended: boolean }> = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('issued, registered, attended')
          .eq('event_id', eventId)
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error fetching registration/attendance stats:', error);
          break;
        }

        if (data && data.length > 0) {
          allData = allData.concat(data);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      const total = allData.length;
      const issued = allData.filter(code => code.issued).length;
      const registered = allData.filter(code => code.registered).length;
      const attended = allData.filter(code => code.attended).length;

      return { total, issued, registered, attended };

    } catch (error) {
      console.error('Unexpected error fetching registration/attendance stats:', error);
      return { total: 0, issued: 0, registered: 0, attended: 0 };
    }
  }

  /**
   * Get geographic distribution of discount codes
   */
  static async getGeographicDistribution(eventId: string): Promise<{
    claimed: { country: string; city: string; lat: number; lng: number; count: number }[];
    registered: { country: string; city: string; lat: number; lng: number; count: number }[];
    attended: { country: string; city: string; lat: number; lng: number; count: number }[];
  }> {
    try {
      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let codes: Array<{ code: string; issued: boolean; issued_to: string | null; registered: boolean; attended: boolean }> = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('code, issued, issued_to, registered, attended')
          .eq('event_id', eventId)
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error fetching codes:', error);
          break;
        }

        if (data && data.length > 0) {
          codes = codes.concat(data);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      if (!codes || codes.length === 0) {
        console.error('No codes found');
        return { claimed: [], registered: [], attended: [] };
      }

      // Get customer emails for issued codes
      const issuedEmails = codes
        .filter(code => code.issued && code.issued_to)
        .map(code => code.issued_to)
        .filter((email, index, self) => self.indexOf(email) === index); // Remove duplicates

      console.log('Issued emails count:', issuedEmails.length);
      console.log('Sample emails:', issuedEmails.slice(0, 3));

      if (issuedEmails.length === 0) {
        console.log('No issued emails found');
        return { claimed: [], registered: [], attended: [] };
      }

      // Fetch customer data with location info in batches to avoid query limits
      const batchSize = 100;
      const customers: any[] = [];

      for (let i = 0; i < issuedEmails.length; i += batchSize) {
        const batch = issuedEmails.slice(i, i + batchSize);
        const { data, error } = await supabase
          .from('people')
          .select('email, attributes')
          .in('email', batch);

        if (error) {
          console.error(`Error fetching customer batch ${i / batchSize + 1}:`, error);
          continue;
        }

        if (data) {
          customers.push(...data);
        }
      }

      if (customers.length === 0) {
        console.log('No customers found with location data');
        return { claimed: [], registered: [], attended: [] };
      }

      console.log('Fetched customers:', customers.length);
      console.log('Sample customer data:', customers[0]);

      // Create email to location mapping
      const emailToLocation = new Map<string, {
        country: string;
        city: string;
        lat?: number;
        lng?: number;
      }>();

      let locationsWithCoords = 0;
      let locationsWithoutCoords = 0;

      customers.forEach(customer => {
        if (customer.email && customer.attributes) {
          const locationData: any = {
            country: customer.attributes.country || 'Unknown',
            city: customer.attributes.city || 'Unknown'
          };

          // Parse location coordinates if available
          if (customer.attributes.location) {
            const coords = customer.attributes.location.split(',').map((coord: string) => parseFloat(coord.trim()));
            if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
              locationData.lat = coords[0];
              locationData.lng = coords[1];
              locationsWithCoords++;
            } else {
              locationsWithoutCoords++;
            }
          } else {
            locationsWithoutCoords++;
          }

          emailToLocation.set(customer.email, locationData);
        }
      });

      console.log(`Locations with coordinates: ${locationsWithCoords}`);
      console.log(`Locations without coordinates: ${locationsWithoutCoords}`);

      // Process geographic distribution for each status
      const claimedByLocation = new Map<string, { country: string; city: string; lat?: number; lng?: number; count: number }>();
      const registeredByLocation = new Map<string, { country: string; city: string; lat?: number; lng?: number; count: number }>();
      const attendedByLocation = new Map<string, { country: string; city: string; lat?: number; lng?: number; count: number }>();

      codes.forEach(code => {
        if (code.issued && code.issued_to) {
          const location = emailToLocation.get(code.issued_to);
          if (location && location.lat !== undefined && location.lng !== undefined) {
            const key = `${location.lat},${location.lng}`;

            // Claimed (issued)
            if (claimedByLocation.has(key)) {
              claimedByLocation.get(key)!.count++;
            } else {
              claimedByLocation.set(key, {
                country: location.country,
                city: location.city,
                lat: location.lat,
                lng: location.lng,
                count: 1
              });
            }

            // Registered
            if (code.registered) {
              if (registeredByLocation.has(key)) {
                registeredByLocation.get(key)!.count++;
              } else {
                registeredByLocation.set(key, {
                  country: location.country,
                  city: location.city,
                  lat: location.lat,
                  lng: location.lng,
                  count: 1
                });
              }
            }

            // Attended
            if (code.attended) {
              if (attendedByLocation.has(key)) {
                attendedByLocation.get(key)!.count++;
              } else {
                attendedByLocation.set(key, {
                  country: location.country,
                  city: location.city,
                  lat: location.lat,
                  lng: location.lng,
                  count: 1
                });
              }
            }
          }
        }
      });

      // Convert maps to arrays, sorting by count
      const claimed = Array.from(claimedByLocation.values())
        .filter(loc => loc.lat !== undefined && loc.lng !== undefined)
        .map(loc => ({
          country: loc.country,
          city: loc.city,
          lat: loc.lat!,
          lng: loc.lng!,
          count: loc.count
        }))
        .sort((a, b) => b.count - a.count);

      const registered = Array.from(registeredByLocation.values())
        .filter(loc => loc.lat !== undefined && loc.lng !== undefined)
        .map(loc => ({
          country: loc.country,
          city: loc.city,
          lat: loc.lat!,
          lng: loc.lng!,
          count: loc.count
        }))
        .sort((a, b) => b.count - a.count);

      const attended = Array.from(attendedByLocation.values())
        .filter(loc => loc.lat !== undefined && loc.lng !== undefined)
        .map(loc => ({
          country: loc.country,
          city: loc.city,
          lat: loc.lat!,
          lng: loc.lng!,
          count: loc.count
        }))
        .sort((a, b) => b.count - a.count);

      console.log('Geographic distribution results:', {
        claimedCount: claimed.length,
        registeredCount: registered.length,
        attendedCount: attended.length,
        claimedSample: claimed[0],
        registeredSample: registered[0],
        attendedSample: attended[0]
      });

      return { claimed, registered, attended };

    } catch (error) {
      console.error('Unexpected error fetching geographic distribution:', error);
      return { claimed: [], registered: [], attended: [] };
    }
  }
}