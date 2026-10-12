import { supabase } from '@/lib/supabase';

// Discount code interface matching the events_discount_codes table
export interface DiscountCode {
  id?: string;
  code: string;
  event_id: string | null; // events.id (uuid)
  discount_id?: string | null;
  source?: string | null;
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

// Discount claimant interface (from events_discount_interactions)
export interface DiscountClaimant {
  email?: string | null;
  customer_cio_id: string | null;
  offer_id: string;
  offer_status: string;
  offer_referrer?: string | null;
  timestamp: string;
  created_at?: string;
  updated_at?: string;
}

// Discount codes stats for an event
export interface DiscountCodesStats {
  total: number;
  available: number;
  claimed: number;
}

const PAGE_SIZE = 1000;

// Service class for discount operations.
// Every eventId parameter here is the event uuid (events.id), which is what
// events_discount_codes.event_id holds, not the short text events.event_id.
export class DiscountService {

  /**
   * All codes for an event, paginated past the 1000 row limit
   */
  private static async fetchCodesForEvent<T>(eventId: string, columns: string): Promise<{ data: T[]; error: any }> {
    let rows: T[] = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data, error } = await supabase
        .from('events_discount_codes')
        .select(columns)
        .eq('event_id', eventId)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        return { data: rows, error };
      }
      if (data && data.length > 0) {
        rows = rows.concat(data as unknown as T[]);
        from += PAGE_SIZE;
        hasMore = data.length === PAGE_SIZE;
      } else {
        hasMore = false;
      }
    }
    return { data: rows, error: null };
  }

  /**
   * Get discount codes statistics for a specific event
   */
  static async getDiscountCodesStats(eventId: string): Promise<DiscountCodesStats> {
    try {
      const { data, error } = await this.fetchCodesForEvent<{ issued: boolean }>(eventId, 'issued');

      if (error) {
        console.error('Error fetching discount codes stats:', error);
        return { total: 0, available: 0, claimed: 0 };
      }

      const total = data?.length || 0;
      const claimed = data?.filter(code => code.issued).length || 0;
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

      const { data, error } = await supabase
        .from('events_discount_codes')
        .select('event_id, issued')
        .in('event_id', eventIds);

      if (error) {
        console.error('Error fetching discount codes stats:', error);
        return statsMap;
      }

      // Count codes per event
      const eventCounts = new Map<string, { total: number; claimed: number }>();
      data?.forEach(code => {
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
      });

      return statsMap;

    } catch (error) {
      console.error('Unexpected error fetching discount codes stats:', error);
      return new Map<string, DiscountCodesStats>();
    }
  }

  /**
   * Get claimant count for a specific offer
   */
  static async getClaimantCount(offerSlug: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('events_discount_interactions')
        .select('customer_cio_id', { count: 'exact', head: true })
        .eq('offer_id', offerSlug)
        .eq('offer_status', 'accepted');

      if (error) {
        console.error('Error getting claimant count:', error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      console.error('Unexpected error getting claimant count:', error);
      return 0;
    }
  }

  /**
   * Get sold-out count for a specific offer
   * These are customers who requested codes but codes were sold out
   */
  static async getSoldOutCount(offerSlug: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('events_discount_interactions')
        .select('customer_cio_id', { count: 'exact', head: true })
        .eq('offer_id', offerSlug)
        .eq('offer_status', 'sold-out');

      if (error) {
        console.error('Error getting sold-out count:', error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      console.error('Unexpected error getting sold-out count:', error);
      return 0;
    }
  }

  /**
   * Get claimant counts for multiple offers
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

      // Get all accepted interactions for these offers
      const { data, error } = await supabase
        .from('events_discount_interactions')
        .select('offer_id, email, customer_cio_id')
        .in('offer_id', offerSlugs)
        .eq('offer_status', 'accepted');

      if (error) {
        console.error('Error fetching claimant counts:', error);
        return counts;
      }

      // Count unique claimants per offer
      const offerClaimants = new Map<string, Set<string>>();
      data?.forEach(interaction => {
        if (!offerClaimants.has(interaction.offer_id)) {
          offerClaimants.set(interaction.offer_id, new Set());
        }
        const identity = interaction.email ? interaction.email.toLowerCase() : interaction.customer_cio_id;
        if (identity) offerClaimants.get(interaction.offer_id)?.add(identity);
      });

      // Convert to counts
      offerClaimants.forEach((claimants, offerId) => {
        counts.set(offerId, claimants.size);
      });

      return counts;

    } catch (error) {
      console.error('Unexpected error fetching claimant counts:', error);
      return new Map<string, number>();
    }
  }

  /**
   * Get all discount codes for a specific event
   */
  static async getDiscountCodesForEvent(eventId: string): Promise<DiscountCode[]> {
    try {
      const { data, error } = await supabase
        .from('events_discount_codes')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching discount codes:', error);
        return [];
      }

      return data || [];

    } catch (error) {
      console.error('Unexpected error fetching discount codes:', error);
      return [];
    }
  }

  /**
   * Get claimants for a specific offer (from events_discount_interactions)
   * This returns enriched customer profiles from the database.
   * Interactions are matched to people by email, or by Customer.io id when a
   * row has no email (migrated rows may carry either).
   */
  static async getClaimantsForOffer(offerSlug: string): Promise<any[]> {
    try {
      // Get all customers who accepted this discount offer
      let interactions: Array<{ email: string | null; customer_cio_id: string | null; timestamp: string }> = [];
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_interactions')
          .select('email, customer_cio_id, timestamp')
          .eq('offer_id', offerSlug)
          .eq('offer_status', 'accepted')
          .order('timestamp', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);

        if (error) {
          console.error('Error getting claimants:', error);
          return [];
        }
        if (data && data.length > 0) {
          interactions = interactions.concat(data);
          from += PAGE_SIZE;
          hasMore = data.length === PAGE_SIZE;
        } else {
          hasMore = false;
        }
      }

      if (interactions.length === 0) {
        return [];
      }

      // Unique identities (in case there are duplicate entries)
      const emails = [...new Set(interactions.map(i => i.email?.toLowerCase()).filter((e): e is string => !!e))];
      const cioIds = [...new Set(
        interactions.filter(i => !i.email && i.customer_cio_id).map(i => i.customer_cio_id as string)
      )];

      // Fetch customer data from the database in batches
      const BATCH_SIZE = 500;
      const customers: any[] = [];
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const { data, error: customerError } = await supabase
          .from('people')
          .select('*')
          .in('email', emails.slice(i, i + BATCH_SIZE));
        if (customerError) {
          console.error('Error fetching customer data:', customerError);
          continue;
        }
        customers.push(...(data || []));
      }
      for (let i = 0; i < cioIds.length; i += BATCH_SIZE) {
        const { data, error: customerError } = await supabase
          .from('people')
          .select('*')
          .in('cio_id', cioIds.slice(i, i + BATCH_SIZE));
        if (customerError) {
          console.error('Error fetching customer data:', customerError);
          continue;
        }
        customers.push(...(data || []));
      }

      // Map customer data to profiles
      const seen = new Set<string>();
      const profiles = customers.filter(customer => {
        const key = String(customer.id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(customer => ({
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

      // Claimants with no people row still appear, with the interaction's email
      const foundEmails = new Set(profiles.map(p => (p.email || '').toLowerCase()));
      emails.forEach(email => {
        if (!foundEmails.has(email)) {
          profiles.push({ email, first_name: undefined, last_name: undefined, job_title: undefined, company: undefined, linkedin_url: undefined, city: undefined, country: undefined, continent: undefined, cio_id: null, id: null });
        }
      });

      return profiles;

    } catch (error) {
      console.error('Unexpected error getting claimants:', error);
      return [];
    }
  }

  /**
   * Upload discount codes for a specific event
   * @param eventId - The event uuid (events.id) to associate codes with
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
      const { data, error } = await this.fetchCodesForEvent<{ issued: boolean; registered: boolean; attended: boolean }>(
        eventId,
        'issued, registered, attended'
      );

      if (error) {
        console.error('Error fetching registration/attendance stats:', error);
        return { total: 0, issued: 0, registered: 0, attended: 0 };
      }

      const total = data?.length || 0;
      const issued = data?.filter(code => code.issued).length || 0;
      const registered = data?.filter(code => code.registered).length || 0;
      const attended = data?.filter(code => code.attended).length || 0;

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
      // Get all discount codes with their status
      const { data: codes, error: codesError } = await this.fetchCodesForEvent<{
        code: string;
        issued: boolean;
        issued_to: string | null;
        registered: boolean;
        attended: boolean;
      }>(eventId, 'code, issued, issued_to, registered, attended');

      if (codesError || !codes) {
        console.error('Error fetching codes:', codesError);
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
