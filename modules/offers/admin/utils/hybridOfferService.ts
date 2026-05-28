import { supabase } from '@/lib/supabase';
import { SegmentMappingService } from './segmentMappingService';
import { SegmentInteractionReconciler } from './segmentInteractionReconciler';

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
 * Hybrid Offer Service that combines:
 * 1. Segment membership as source of truth for WHO accepted
 * 2. Interaction tables for WHEN they accepted (timestamps)
 *
 * This provides accurate counts from segments while maintaining timeline data
 */
export class HybridOfferService {

  /**
   * Get all unique offers with statistics
   * Combines segments AND offer_interactions table (for API submissions)
   * Deduplicates by offer_id
   * @param accountIds Optional array of account IDs to filter by. If provided, only offers belonging to these accounts are returned.
   */
  static async getAllOffers(accountIds?: string[]): Promise<OfferSummary[]> {
    try {
      const offerSummariesMap = new Map<string, OfferSummary>();

      // 1. Get offers from segments - fetch BOTH "Accepted" and "Completed" segments
      // "Completed" takes priority over "Accepted" for counts
      const { data: allSegments, error } = await supabase
        .from('segments')
        .select('name, cio_segment_id, updated_at')
        .or('name.like.Offer // % // Accepted,name.like.Offer // % // Completed')
        .order('name');

      if (error) {
        console.error('Error fetching offer segments:', error);
      }

      if (allSegments && allSegments.length > 0) {
        // Parse segments and group by offer ID
        // Track both Accepted and Completed segments for each offer
        const offerSegmentsMap = new Map<string, {
          acceptedSegmentId?: number;
          completedSegmentId?: number;
          lastSyncedAt?: string;
        }>();

        allSegments.forEach(segment => {
          const acceptedMatch = segment.name.match(/^Offer \/\/ (.+) \/\/ Accepted$/);
          const completedMatch = segment.name.match(/^Offer \/\/ (.+) \/\/ Completed$/);

          if (acceptedMatch) {
            const offerId = acceptedMatch[1];
            const existing = offerSegmentsMap.get(offerId) || {};
            offerSegmentsMap.set(offerId, {
              ...existing,
              acceptedSegmentId: segment.cio_segment_id,
              lastSyncedAt: existing.lastSyncedAt || segment.updated_at
            });
          } else if (completedMatch) {
            const offerId = completedMatch[1];
            const existing = offerSegmentsMap.get(offerId) || {};
            offerSegmentsMap.set(offerId, {
              ...existing,
              completedSegmentId: segment.cio_segment_id,
              lastSyncedAt: segment.updated_at || existing.lastSyncedAt
            });
          }
        });

        // For each offer, prefer Completed segment over Accepted
        const segmentData: Array<{ offerId: string; segmentId: number; lastSyncedAt?: string }> = [];
        offerSegmentsMap.forEach((segments, offerId) => {
          // Prefer Completed segment if available, otherwise use Accepted
          const segmentId = segments.completedSegmentId || segments.acceptedSegmentId;
          if (segmentId) {
            segmentData.push({
              offerId,
              segmentId,
              lastSyncedAt: segments.lastSyncedAt
            });
          }
        });

        // Batch fetch all segment member counts at once
        const segmentIds = segmentData.map(item => item.segmentId);
        const memberCounts = await SegmentMappingService.getSegmentMemberCounts(segmentIds);

        // Batch fetch timeline data for all offers
        const offerIds = segmentData.map(item => item.offerId);
        const timelineDataMap = await this.getOfferTimelineDataBatch(offerIds);

        // Fetch account information for all offers
        const accountDataMap = await this.getAccountDataForOffers(offerIds);

        // Build offer summaries from segments
        segmentData.forEach(({ offerId, segmentId, lastSyncedAt }) => {
          const memberCount = memberCounts.get(segmentId) || 0;
          const timelineData = timelineDataMap.get(offerId) || { first: null, last: null };
          const accountData = accountDataMap.get(offerId) || { accountId: null, accountName: null };

          offerSummariesMap.set(offerId, {
            offer_id: offerId,
            total_interactions: memberCount,
            accepted_count: memberCount,
            viewed_count: 0,
            first_interaction: timelineData.first || lastSyncedAt || new Date().toISOString(),
            last_interaction: timelineData.last || lastSyncedAt || new Date().toISOString(),
            account_id: accountData.accountId,
            account_name: accountData.accountName
          });
        });
      }

      // 2. Also get offers from offer_interactions table (API submissions)
      // This catches offers that don't have a segment yet
      // Query for both 'accepted' and 'completed' statuses since some offers use 'completed'
      // Use pagination to avoid Supabase's 1000 row limit
      const PAGE_SIZE = 1000;
      let allInteractionOffers: Array<{ offer_id: string; email: string; timestamp: string; offer_status: string }> = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data: interactionPage, error: interactionError } = await supabase
          .from('integrations_offer_interactions')
          .select('offer_id, email, timestamp, offer_status')
          .in('offer_status', ['accepted', 'completed'])
          .range(offset, offset + PAGE_SIZE - 1);

        if (interactionError) {
          console.error('Error fetching offer_interactions:', interactionError);
          break;
        }

        if (!interactionPage || interactionPage.length === 0) {
          hasMore = false;
        } else {
          allInteractionOffers = allInteractionOffers.concat(interactionPage);
          offset += PAGE_SIZE;
          hasMore = interactionPage.length === PAGE_SIZE;
        }
      }

      if (allInteractionOffers.length > 0) {
        // Group by offer_id AND offer_status separately
        // This ensures we only count emails for the correct status (matching detail page logic)
        const offerGroups = allInteractionOffers.reduce((acc, item) => {
          if (!acc[item.offer_id]) {
            acc[item.offer_id] = {
              acceptedEmails: new Set<string>(),
              completedEmails: new Set<string>(),
              timestamps: [] as string[]
            };
          }
          if (item.email) {
            if (item.offer_status === 'completed') {
              acc[item.offer_id].completedEmails.add(item.email.toLowerCase());
            } else {
              acc[item.offer_id].acceptedEmails.add(item.email.toLowerCase());
            }
          }
          if (item.timestamp) {
            acc[item.offer_id].timestamps.push(item.timestamp);
          }
          return acc;
        }, {} as Record<string, { acceptedEmails: Set<string>; completedEmails: Set<string>; timestamps: string[] }>);

        // For each offer in interactions, merge with existing or add new
        // Use 'completed' count if available (matches detail page logic which prefers Completed segment)
        Object.entries(offerGroups).forEach(([offerId, groupData]) => {
          const existingSummary = offerSummariesMap.get(offerId);

          // Prefer completed count if available, otherwise use accepted count
          // This matches the detail page logic which uses getBestSegmentForOffer
          const emailCount = groupData.completedEmails.size > 0
            ? groupData.completedEmails.size
            : groupData.acceptedEmails.size;

          if (existingSummary) {
            // Merge: always prefer interaction count since that's what the detail page shows
            // The interaction table contains the actual records that users see in the table
            const sortedTimestamps = groupData.timestamps.sort();

            // Always use interaction count when available - this ensures dashboard matches detail page
            if (emailCount > 0) {
              existingSummary.accepted_count = emailCount;
              existingSummary.total_interactions = emailCount;
            }

            if (sortedTimestamps.length > 0) {
              const firstInteraction = sortedTimestamps[0];
              const lastInteraction = sortedTimestamps[sortedTimestamps.length - 1];

              // Update timeline if interaction data is better
              if (!existingSummary.first_interaction || firstInteraction < existingSummary.first_interaction) {
                existingSummary.first_interaction = firstInteraction;
              }
              if (!existingSummary.last_interaction || lastInteraction > existingSummary.last_interaction) {
                existingSummary.last_interaction = lastInteraction;
              }
            }
          } else {
            // New offer from API submissions only
            const sortedTimestamps = groupData.timestamps.sort();
            offerSummariesMap.set(offerId, {
              offer_id: offerId,
              total_interactions: emailCount,
              accepted_count: emailCount,
              viewed_count: 0,
              first_interaction: sortedTimestamps[0] || new Date().toISOString(),
              last_interaction: sortedTimestamps[sortedTimestamps.length - 1] || new Date().toISOString(),
              account_id: null,
              account_name: null
            });
          }
        });
      }

      // Convert map to array and sort
      let offerSummaries = Array.from(offerSummariesMap.values());
      offerSummaries.sort((a, b) => a.offer_id.localeCompare(b.offer_id));

      // Apply account filtering if accountIds are provided
      if (accountIds && accountIds.length > 0) {
        offerSummaries = offerSummaries.filter(offer =>
          offer.account_id && accountIds.includes(offer.account_id)
        );
      }

      // For offers with 0 accepted count, get the actual count using getAcceptedCount
      // This ensures we use the same logic as the detail page (which queries offer_interactions correctly)
      const offersNeedingCount = offerSummaries.filter(o => o.accepted_count === 0);
      if (offersNeedingCount.length > 0) {
        const countPromises = offersNeedingCount.map(async (offer) => {
          const count = await this.getAcceptedCount(offer.offer_id);
          return { offerId: offer.offer_id, count };
        });

        const counts = await Promise.all(countPromises);
        counts.forEach(({ offerId, count }) => {
          const offer = offerSummaries.find(o => o.offer_id === offerId);
          if (offer && count > 0) {
            offer.accepted_count = count;
            offer.total_interactions = count;
          }
        });
      }

      return offerSummaries;

    } catch (error) {
      console.error('Unexpected error fetching offers:', error);
      return [];
    }
  }

  /**
   * Get a single offer by ID using hybrid approach
   * Uses "Completed" segment if available, otherwise "Accepted"
   * Also includes offer_interactions data
   */
  static async getOfferById(offerId: string): Promise<OfferSummary | null> {
    try {
      // Get the best segment (Completed if available, otherwise Accepted)
      const { segmentId, status } = await SegmentMappingService.getBestSegmentForOffer(offerId);

      // Get count using the same logic as getAcceptedCount (includes both segment and interactions)
      const acceptedCount = await this.getAcceptedCount(offerId);

      // If no segment AND no interactions, return null
      if (!segmentId && acceptedCount === 0) {
        console.log(`No segment or interactions found for offer: ${offerId}`);
        return null;
      }

      // Get timeline data from interactions using the correct status
      const timelineData = await this.getOfferTimelineData(offerId, status);

      return {
        offer_id: offerId,
        total_interactions: acceptedCount,
        accepted_count: acceptedCount,
        viewed_count: 0,
        first_interaction: timelineData.first || new Date().toISOString(),
        last_interaction: timelineData.last || new Date().toISOString()
      };

    } catch (error) {
      console.error('Unexpected error fetching offer:', error);
      return null;
    }
  }

  /**
   * Get accepted/completed count for a specific offer
   * Prefers interaction count to match what's shown in the detail page table
   * Falls back to segment membership count if no interactions exist
   */
  static async getAcceptedCount(offerSlug: string): Promise<number> {
    try {
      // Get the best segment info (Completed if available, otherwise Accepted)
      const { segmentId, status } = await SegmentMappingService.getBestSegmentForOffer(offerSlug);

      // Use 'completed' status if we're using a Completed segment, otherwise 'accepted'
      const interactionStatus = status === 'completed' ? 'completed' : 'accepted';

      // 1. First try to get count from offer_interactions table
      // This matches what the detail page shows in the members table
      // Use pagination to avoid Supabase's 1000 row limit
      const PAGE_SIZE = 1000;
      let allEmails: string[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data: interactionEmails, error: interactionError } = await supabase
          .from('integrations_offer_interactions')
          .select('email')
          .eq('offer_id', offerSlug)
          .eq('offer_status', interactionStatus)
          .range(offset, offset + PAGE_SIZE - 1);

        if (interactionError) {
          console.error('Error fetching interaction emails:', interactionError);
          break;
        }

        if (!interactionEmails || interactionEmails.length === 0) {
          hasMore = false;
        } else {
          allEmails = allEmails.concat(interactionEmails.map(e => e.email).filter(Boolean));
          offset += PAGE_SIZE;
          hasMore = interactionEmails.length === PAGE_SIZE;
        }
      }

      if (allEmails.length > 0) {
        // Deduplicate by email (case-insensitive) to match detail page logic
        const uniqueEmails = new Set(
          allEmails.map(e => e?.toLowerCase()).filter(Boolean)
        );
        return uniqueEmails.size;
      }

      // 2. Fall back to segment membership count if no interactions
      if (segmentId) {
        const segmentCount = await SegmentMappingService.getSegmentMemberCount(segmentId);
        if (segmentCount > 0) {
          return segmentCount;
        }
      }

      return 0;
    } catch (error) {
      console.error('Unexpected error getting accepted count:', error);
      return 0;
    }
  }

  /**
   * Get all customers who accepted/completed a specific offer
   * Uses "Completed" segment if available, otherwise "Accepted"
   * Also includes customers from offer_interactions table (API submissions)
   * Deduplicates by email to avoid double-counting
   */
  static async getAcceptedForOffer(offerSlug: string): Promise<any[]> {
    try {
      const profilesMap = new Map<string, any>(); // Dedupe by email

      // 1. Get customers from best segment (Completed if available, otherwise Accepted)
      const { segmentId, status } = await SegmentMappingService.getBestSegmentForOffer(offerSlug);

      if (segmentId) {
        // NOTE: Reconciliation is disabled because the offer_interactions table now requires
        // customer_id (NOT NULL) which the reconciler doesn't have access to from segment data.
        // Reconciliation should be done via a background job that can look up customer_id.
        // const reconcileStatus = await SegmentInteractionReconciler.getReconciliationStatus(offerSlug, segmentId);
        // if (reconcileStatus.pendingCount > 0) {
        //   console.log(`Reconciling ${reconcileStatus.pendingCount} missing interactions for ${offerSlug}...`);
        //   await SegmentInteractionReconciler.reconcileOfferSegment(offerSlug, segmentId);
        // }

        // Get all member CIO IDs from segment membership
        const cioIds = await SegmentMappingService.getSegmentMembers(segmentId);

        if (cioIds.length > 0) {
          // Fetch customer data in batches
          const BATCH_SIZE = 500;

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
              customers.forEach(customer => {
                const email = customer.email || customer.cio_id;
                if (email && !profilesMap.has(email.toLowerCase())) {
                  profilesMap.set(email.toLowerCase(), {
                    email,
                    first_name: customer.attributes?.first_name,
                    last_name: customer.attributes?.last_name,
                    job_title: customer.attributes?.job_title,
                    company: customer.attributes?.company,
                    linkedin_url: customer.attributes?.linkedin_url,
                    city: customer.attributes?.city,
                    country: customer.attributes?.country,
                    continent: customer.attributes?.continent,
                    location: customer.attributes?.location,
                    cio_id: customer.cio_id,
                    id: customer.id,
                    source: 'segment'
                  });
                }
              });
            }
          }
        }
      }

      // 2. Also get customers from offer_interactions table (API submissions)
      // Use 'completed' status if we're using a Completed segment, otherwise 'accepted'
      const interactionStatus = status === 'completed' ? 'completed' : 'accepted';

      // Paginate through all interactions to avoid 1000 row limit
      const PAGE_SIZE = 1000;
      let allInteractions: Array<{ email: string; customer_cio_id: string | null; customer_id: string | null; timestamp: string }> = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data: interactionPage, error: interactionError } = await supabase
          .from('integrations_offer_interactions')
          .select('email, customer_cio_id, customer_id, timestamp')
          .eq('offer_id', offerSlug)
          .eq('offer_status', interactionStatus)
          .range(offset, offset + PAGE_SIZE - 1);

        if (interactionError) {
          console.error('Error fetching offer_interactions:', interactionError);
          break;
        }

        if (!interactionPage || interactionPage.length === 0) {
          hasMore = false;
        } else {
          allInteractions = allInteractions.concat(interactionPage);
          offset += PAGE_SIZE;
          hasMore = interactionPage.length === PAGE_SIZE;
        }
      }

      const interactions = allInteractions;

      if (interactions.length > 0) {
        // Get unique emails from interactions that aren't already in the map
        const newEmails = interactions
          .filter(i => i.email && !profilesMap.has(i.email.toLowerCase()))
          .map(i => i.email);

        if (newEmails.length > 0) {
          // Fetch customer data for these emails
          const BATCH_SIZE = 500;
          for (let i = 0; i < newEmails.length; i += BATCH_SIZE) {
            const batch = newEmails.slice(i, i + BATCH_SIZE);

            const { data: customers, error: customerError } = await supabase
              .from('people')
              .select('*')
              .in('email', batch);

            if (customerError) {
              console.error('Error fetching customers by email:', customerError);
              continue;
            }

            if (customers) {
              customers.forEach(customer => {
                const email = customer.email;
                if (email && !profilesMap.has(email.toLowerCase())) {
                  profilesMap.set(email.toLowerCase(), {
                    email,
                    first_name: customer.attributes?.first_name,
                    last_name: customer.attributes?.last_name,
                    job_title: customer.attributes?.job_title,
                    company: customer.attributes?.company,
                    linkedin_url: customer.attributes?.linkedin_url,
                    city: customer.attributes?.city,
                    country: customer.attributes?.country,
                    continent: customer.attributes?.continent,
                    location: customer.attributes?.location,
                    cio_id: customer.cio_id,
                    id: customer.id,
                    source: 'api'
                  });
                }
              });
            }
          }

          // For any emails not found in customers table, add basic profile from interaction
          interactions.forEach(interaction => {
            if (interaction.email && !profilesMap.has(interaction.email.toLowerCase())) {
              profilesMap.set(interaction.email.toLowerCase(), {
                email: interaction.email,
                first_name: null,
                last_name: null,
                job_title: null,
                company: null,
                linkedin_url: null,
                city: null,
                country: null,
                continent: null,
                location: null,
                cio_id: interaction.customer_cio_id,
                id: interaction.customer_id,
                source: 'api'
              });
            }
          });
        }
      }

      const profiles = Array.from(profilesMap.values());
      console.log(`Found ${profiles.length} accepted customers for ${offerSlug} (segment: ${segmentId ? 'yes' : 'no'}, from interactions: ${interactions?.length || 0})`);

      return profiles;

    } catch (error) {
      console.error('Unexpected error getting accepted customers:', error);
      return [];
    }
  }

  /**
   * Get timeline data for accepted/completed offer interactions
   * Uses "Completed" segment if available, otherwise "Accepted"
   * Uses interaction tables for granular timestamp data
   */
  static async getAcceptedTimeline(offerSlug: string): Promise<Array<{ date: string; count: number; cumulative: number }>> {
    try {
      // Get the best segment (Completed if available, otherwise Accepted)
      const { segmentId, status } = await SegmentMappingService.getBestSegmentForOffer(offerSlug);

      // Determine which table to use based on offer_id prefix
      let tableName: string;
      if (offerSlug.startsWith('win-')) {
        tableName = 'competition_interactions';
      } else if (offerSlug.startsWith('discount-') || offerSlug.startsWith('free-tickets-')) {
        tableName = 'discount_interactions';
      } else {
        tableName = 'offer_interactions';
      }

      // Use the correct offer_status based on the segment type
      const interactionStatus = status === 'completed' ? 'completed' : 'accepted';

      // Get timeline from interactions table
      const { data, error } = await supabase
        .from(tableName)
        .select('timestamp')
        .eq('offer_id', offerSlug)
        .eq('offer_status', interactionStatus)
        .order('timestamp', { ascending: true });

      if (error) {
        console.error('Error loading accepted timeline:', error);
        return [];
      }

      if (!data || data.length === 0) {
        // If no interactions yet but we have a segment, return current segment count as a single point
        if (segmentId) {
          const currentCount = await SegmentMappingService.getSegmentMemberCount(segmentId);
          if (currentCount > 0) {
            return [{
              date: new Date().toISOString(),
              count: currentCount,
              cumulative: currentCount
            }];
          }
        }
        return [];
      }

      // Group by 1-minute intervals for granular timeline
      const groupedByInterval = data.reduce((acc: { [key: string]: number }, interaction) => {
        if (interaction.timestamp) {
          const timestamp = new Date(interaction.timestamp);
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

  /**
   * Helper to get first and last interaction timestamps for an offer
   * @param offerId The offer ID
   * @param status The offer_status to filter by ('accepted' or 'completed')
   */
  private static async getOfferTimelineData(offerId: string, status: 'accepted' | 'completed' = 'accepted'): Promise<{ first: string | null; last: string | null }> {
    try {
      // Determine which table to use based on offer_id prefix
      let tableName: string;
      if (offerId.startsWith('win-')) {
        tableName = 'competition_interactions';
      } else if (offerId.startsWith('discount-') || offerId.startsWith('free-tickets-')) {
        tableName = 'discount_interactions';
      } else {
        tableName = 'offer_interactions';
      }

      // Query the interactions table for timeline data
      const { data, error } = await supabase
        .from(tableName)
        .select('timestamp')
        .eq('offer_id', offerId)
        .eq('offer_status', status)
        .order('timestamp', { ascending: true });

      if (error || !data || data.length === 0) {
        return { first: null, last: null };
      }

      return {
        first: data[0].timestamp,
        last: data[data.length - 1].timestamp
      };

    } catch (error) {
      console.error('Error getting offer timeline data:', error);
      return { first: null, last: null };
    }
  }

  /**
   * Batch helper to get first and last interaction timestamps for multiple offers
   * This is much more efficient than calling getOfferTimelineData for each offer
   */
  private static async getOfferTimelineDataBatch(offerIds: string[]): Promise<Map<string, { first: string | null; last: string | null }>> {
    const timelineMap = new Map<string, { first: string | null; last: string | null }>();

    if (offerIds.length === 0) {
      return timelineMap;
    }

    try {
      // Group offer IDs by table type
      const competitionOffers = offerIds.filter(id => id.startsWith('win-'));
      const discountOffers = offerIds.filter(id => id.startsWith('discount-') || id.startsWith('free-tickets-'));
      const regularOffers = offerIds.filter(id =>
        !id.startsWith('win-') &&
        !id.startsWith('discount-') &&
        !id.startsWith('free-tickets-')
      );

      // Batch query each table
      const queries = [];

      if (competitionOffers.length > 0) {
        queries.push(
          supabase
            .from('events_competition_interactions')
            .select('offer_id, timestamp')
            .in('offer_id', competitionOffers)
            .eq('offer_status', 'accepted')
            .order('timestamp', { ascending: true })
        );
      }

      if (discountOffers.length > 0) {
        queries.push(
          supabase
            .from('events_discount_interactions')
            .select('offer_id, timestamp')
            .in('offer_id', discountOffers)
            .eq('offer_status', 'accepted')
            .order('timestamp', { ascending: true })
        );
      }

      if (regularOffers.length > 0) {
        queries.push(
          supabase
            .from('integrations_offer_interactions')
            .select('offer_id, timestamp')
            .in('offer_id', regularOffers)
            .eq('offer_status', 'accepted')
            .order('timestamp', { ascending: true })
        );
      }

      // Execute all queries in parallel
      const results = await Promise.all(queries);

      // Process results from all tables
      for (const result of results) {
        const { data, error } = result;

        if (error || !data) {
          console.error('Error fetching timeline data:', error);
          continue;
        }

        // Group by offer_id and get first/last timestamps
        const offerGroups = data.reduce((acc, item) => {
          if (!acc[item.offer_id]) {
            acc[item.offer_id] = [];
          }
          acc[item.offer_id].push(item.timestamp);
          return acc;
        }, {} as Record<string, string[]>);

        // Set first and last for each offer
        Object.keys(offerGroups).forEach(offerId => {
          const timestamps = offerGroups[offerId];
          if (timestamps.length > 0) {
            timelineMap.set(offerId, {
              first: timestamps[0],
              last: timestamps[timestamps.length - 1]
            });
          }
        });
      }

      // Initialize missing offers with null values
      offerIds.forEach(offerId => {
        if (!timelineMap.has(offerId)) {
          timelineMap.set(offerId, { first: null, last: null });
        }
      });

      return timelineMap;

    } catch (error) {
      console.error('Error getting batch offer timeline data:', error);
      // Initialize all offers with null values on error
      offerIds.forEach(offerId => {
        timelineMap.set(offerId, { first: null, last: null });
      });
      return timelineMap;
    }
  }

  /**
   * Batch helper to get account data for multiple offers
   * Maps offer IDs to their associated account information via events table and segment mappings
   */
  private static async getAccountDataForOffers(offerIds: string[]): Promise<Map<string, { accountId: string | null; accountName: string | null }>> {
    const accountMap = new Map<string, { accountId: string | null; accountName: string | null }>();

    if (offerIds.length === 0) {
      return accountMap;
    }

    try {
      // First, try to get account data from events table (direct mapping)
      const { data: eventData, error: eventError } = await supabase
        .from('events')
        .select(`
          offer_slug,
          account_id,
          accounts:account_id (
            name
          )
        `)
        .in('offer_slug', offerIds)
        .not('offer_slug', 'is', null);

      if (eventError) {
        console.error('Error fetching account data from events:', eventError);
      } else if (eventData) {
        eventData.forEach((row: any) => {
          if (row.offer_slug) {
            accountMap.set(row.offer_slug, {
              accountId: row.account_id || null,
              accountName: row.accounts?.name || null
            });
          }
        });
      }

      // For offers not found in events, try segment_mappings table
      const unmappedOfferIds = offerIds.filter(id => !accountMap.has(id));

      if (unmappedOfferIds.length > 0) {
        const { data: mappingData, error: mappingError } = await supabase
          .from('segments_mappings')
          .select(`
            offer_id,
            account_id,
            accounts:account_id (
              name
            )
          `)
          .in('offer_id', unmappedOfferIds)
          .not('account_id', 'is', null);

        if (mappingError) {
          console.error('Error fetching account data from segment_mappings:', mappingError);
        } else if (mappingData) {
          mappingData.forEach((row: any) => {
            if (row.offer_id) {
              accountMap.set(row.offer_id, {
                accountId: row.account_id || null,
                accountName: row.accounts?.name || null
              });
            }
          });
        }
      }

      // Initialize any remaining missing offers with null values
      offerIds.forEach(offerId => {
        if (!accountMap.has(offerId)) {
          accountMap.set(offerId, { accountId: null, accountName: null });
        }
      });

      return accountMap;

    } catch (error) {
      console.error('Error getting account data for offers:', error);
      // Initialize all offers with null values on error
      offerIds.forEach(offerId => {
        accountMap.set(offerId, { accountId: null, accountName: null });
      });
      return accountMap;
    }
  }

  /**
   * Get geographic distribution of offer accepters
   * Returns location data for mapping and visualization
   */
  static async getGeographicDistribution(offerId: string): Promise<{
    accepted: { country: string; city: string; lat: number; lng: number; count: number }[];
  }> {
    try {
      // Get all accepted customers for this offer
      const acceptedCustomers = await this.getAcceptedForOffer(offerId);

      if (acceptedCustomers.length === 0) {
        return { accepted: [] };
      }

      // Group by location coordinates
      const locationMap = new Map<string, { country: string; city: string; lat: number; lng: number; count: number }>();

      acceptedCustomers.forEach(customer => {
        // Check for location coordinates in attributes
        let lat: number | undefined;
        let lng: number | undefined;

        // Parse location field if available (format: "lat,lng")
        if (customer.location) {
          const coords = customer.location.split(',').map((coord: string) => parseFloat(coord.trim()));
          if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
            lat = coords[0];
            lng = coords[1];
          }
        }

        // Skip if no valid coordinates
        if (lat === undefined || lng === undefined) {
          return;
        }

        const key = `${lat},${lng}`;
        const existing = locationMap.get(key);

        if (existing) {
          existing.count++;
        } else {
          locationMap.set(key, {
            country: customer.country || 'Unknown',
            city: customer.city || 'Unknown',
            lat,
            lng,
            count: 1
          });
        }
      });

      const accepted = Array.from(locationMap.values())
        .sort((a, b) => b.count - a.count);

      return { accepted };

    } catch (error) {
      console.error('Error getting geographic distribution:', error);
      return { accepted: [] };
    }
  }

  /**
   * Get job title breakdown for offer accepters
   * Returns counts grouped by job title
   */
  static async getJobTitleBreakdown(offerId: string): Promise<{ title: string; count: number }[]> {
    try {
      const acceptedCustomers = await this.getAcceptedForOffer(offerId);

      if (acceptedCustomers.length === 0) {
        return [];
      }

      // Group by job title
      const titleMap = new Map<string, number>();

      acceptedCustomers.forEach(customer => {
        const title = customer.job_title || 'Unknown';
        titleMap.set(title, (titleMap.get(title) || 0) + 1);
      });

      return Array.from(titleMap.entries())
        .map(([title, count]) => ({ title, count }))
        .sort((a, b) => b.count - a.count);

    } catch (error) {
      console.error('Error getting job title breakdown:', error);
      return [];
    }
  }

  /**
   * Get company breakdown for offer accepters
   * Returns counts grouped by company
   */
  static async getCompanyBreakdown(offerId: string): Promise<{ company: string; count: number }[]> {
    try {
      const acceptedCustomers = await this.getAcceptedForOffer(offerId);

      if (acceptedCustomers.length === 0) {
        return [];
      }

      // Group by company
      const companyMap = new Map<string, number>();

      acceptedCustomers.forEach(customer => {
        const company = customer.company || 'Unknown';
        companyMap.set(company, (companyMap.get(company) || 0) + 1);
      });

      return Array.from(companyMap.entries())
        .map(([company, count]) => ({ company, count }))
        .sort((a, b) => b.count - a.count);

    } catch (error) {
      console.error('Error getting company breakdown:', error);
      return [];
    }
  }

  /**
   * Get country breakdown for offer accepters
   * Returns counts grouped by country
   */
  static async getCountryBreakdown(offerId: string): Promise<{ country: string; count: number }[]> {
    try {
      const acceptedCustomers = await this.getAcceptedForOffer(offerId);

      if (acceptedCustomers.length === 0) {
        return [];
      }

      // Group by country
      const countryMap = new Map<string, number>();

      acceptedCustomers.forEach(customer => {
        const country = customer.country || 'Unknown';
        countryMap.set(country, (countryMap.get(country) || 0) + 1);
      });

      return Array.from(countryMap.entries())
        .map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count);

    } catch (error) {
      console.error('Error getting country breakdown:', error);
      return [];
    }
  }

  /**
   * Get accepted members with their acceptance timestamps
   * Returns customer profiles with the timestamp they accepted the offer
   */
  static async getAcceptedMembersWithTimestamps(offerId: string): Promise<Array<{
    email: string;
    first_name: string | null;
    last_name: string | null;
    job_title: string | null;
    company: string | null;
    city: string | null;
    country: string | null;
    accepted_at: string;
  }>> {
    try {
      // Get the best segment (Completed if available, otherwise Accepted)
      const { status } = await SegmentMappingService.getBestSegmentForOffer(offerId);

      // Determine which table to use based on offer_id prefix
      let tableName: string;
      if (offerId.startsWith('win-')) {
        tableName = 'competition_interactions';
      } else if (offerId.startsWith('discount-') || offerId.startsWith('free-tickets-')) {
        tableName = 'discount_interactions';
      } else {
        tableName = 'offer_interactions';
      }

      // Use the correct offer_status based on the segment type
      const interactionStatus = status === 'completed' ? 'completed' : 'accepted';

      // Get all interactions with timestamps and emails using pagination
      // Supabase has a default limit of 1000 rows, so we need to paginate
      const PAGE_SIZE = 1000;
      let allInteractions: Array<{ email: string; customer_cio_id: string | null; timestamp: string }> = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data: interactions, error } = await supabase
          .from(tableName)
          .select('email, customer_cio_id, timestamp')
          .eq('offer_id', offerId)
          .eq('offer_status', interactionStatus)
          .order('timestamp', { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
          console.error('Error fetching interactions:', error);
          break;
        }

        if (!interactions || interactions.length === 0) {
          hasMore = false;
        } else {
          allInteractions = allInteractions.concat(interactions);
          offset += PAGE_SIZE;
          // If we got fewer than PAGE_SIZE results, we've reached the end
          hasMore = interactions.length === PAGE_SIZE;
        }
      }

      if (allInteractions.length === 0) {
        return [];
      }

      const interactions = allInteractions;

      // Deduplicate by email, keeping the earliest timestamp
      const emailTimestampMap = new Map<string, { email: string; cio_id: string | null; timestamp: string }>();
      interactions.forEach(interaction => {
        const email = interaction.email?.toLowerCase();
        if (email) {
          const existing = emailTimestampMap.get(email);
          if (!existing || new Date(interaction.timestamp) < new Date(existing.timestamp)) {
            emailTimestampMap.set(email, {
              email: interaction.email,
              cio_id: interaction.customer_cio_id,
              timestamp: interaction.timestamp
            });
          }
        }
      });

      // Get unique emails
      const emailData = Array.from(emailTimestampMap.values());
      const emails = emailData.map(d => d.email);

      // Fetch customer data in batches
      const BATCH_SIZE = 500;
      const customerMap = new Map<string, any>();

      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const batch = emails.slice(i, i + BATCH_SIZE);

        const { data: customers, error: customerError } = await supabase
          .from('people')
          .select('email, attributes')
          .in('email', batch);

        if (customerError) {
          console.error('Error fetching customers:', customerError);
          continue;
        }

        if (customers) {
          customers.forEach(customer => {
            if (customer.email) {
              customerMap.set(customer.email.toLowerCase(), customer);
            }
          });
        }
      }

      // Build the result array with timestamps
      const result = emailData.map(data => {
        const customer = customerMap.get(data.email.toLowerCase());
        return {
          email: data.email,
          first_name: customer?.attributes?.first_name || null,
          last_name: customer?.attributes?.last_name || null,
          job_title: customer?.attributes?.job_title || null,
          company: customer?.attributes?.company || null,
          city: customer?.attributes?.city || null,
          country: customer?.attributes?.country || null,
          accepted_at: data.timestamp
        };
      });

      // Sort by timestamp descending (most recent first)
      result.sort((a, b) => new Date(b.accepted_at).getTime() - new Date(a.accepted_at).getTime());

      return result;

    } catch (error) {
      console.error('Error getting accepted members with timestamps:', error);
      return [];
    }
  }

  /**
   * Get reconciliation status for an offer
   * Shows how many records are in sync vs pending
   */
  static async getOfferReconciliationStatus(offerId: string): Promise<{
    isReconciled: boolean;
    segmentCount: number;
    interactionCount: number;
    pendingCount: number;
    syncedCount: number;
  }> {
    try {
      const segmentId = await SegmentMappingService.getSegmentIdForOffer(offerId);

      if (!segmentId) {
        return {
          isReconciled: false,
          segmentCount: 0,
          interactionCount: 0,
          pendingCount: 0,
          syncedCount: 0
        };
      }

      const status = await SegmentInteractionReconciler.getReconciliationStatus(offerId, segmentId);

      return {
        isReconciled: status.pendingCount === 0,
        segmentCount: status.segmentCount,
        interactionCount: status.interactionCount,
        pendingCount: status.pendingCount,
        syncedCount: status.syncedCount
      };

    } catch (error) {
      console.error('Error getting reconciliation status:', error);
      return {
        isReconciled: false,
        segmentCount: 0,
        interactionCount: 0,
        pendingCount: 0,
        syncedCount: 0
      };
    }
  }
}