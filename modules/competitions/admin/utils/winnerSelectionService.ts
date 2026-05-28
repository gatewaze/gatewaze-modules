// Winner selection service for Customer.io segments

import { getApiConfig } from '@/config/brands';

// The baseUrl already doesn't have /api suffix, so we can use it directly
const API_BASE = `${getApiConfig().baseUrl}/api/customerio`;

export interface PersonProfile {
  cio_id: string;
  id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  job_title?: string;
  linkedin_url?: string;
  city?: string;
  country?: string;
  continent?: string;
  created_at?: number;
}

export interface WinnerResult {
  winner: PersonProfile;
  totalEntries: number;
  segmentName: string;
  competition: string;
}

class WinnerSelectionService {
  private createSegmentName(offerSlug: string): string {
    return `Offer // ${offerSlug} // Accepted`;
  }

  async getSegmentPeople(segmentId: string): Promise<PersonProfile[]> {
    try {
      console.log(`Fetching all customers from segment ${segmentId}...`);

      const url = `${API_BASE}/segments/${segmentId}/customers`;

      const response: Response = await fetch(url, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch segment customers: ${response.status}`);
      }

      const data: any = await response.json();
      const customers = data.customers || [];

      console.log(`✅ Total customers fetched: ${customers.length}`);
      return customers;
    } catch (error) {
      console.error('Error fetching segment customers:', error);
      throw error;
    }
  }

  async getPersonDetails(cioId: string): Promise<PersonProfile> {
    try {
      console.log(`Fetching full details for customer ${cioId}...`);

      const response = await fetch(`${API_BASE}/customers/${cioId}/details`, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch customer details: ${response.status}`);
      }

      const data = await response.json();
      console.log(`Customer details response:`, data);
      return data;
    } catch (error) {
      console.error('Error fetching customer details:', error);
      throw error;
    }
  }

  async findSegmentId(offerSlug: string): Promise<string | null> {
    try {
      const response = await fetch(`${API_BASE}/segments`);
      if (!response.ok) {
        throw new Error('Failed to fetch segments');
      }

      const data = await response.json();
      const segmentName = this.createSegmentName(offerSlug);

      const segment = data.segments?.find((s: any) => s.name === segmentName);
      return segment?.id || null;
    } catch (error) {
      console.error('Error finding segment ID:', error);
      return null;
    }
  }

  async selectRandomWinner(offerSlug: string, competitionTitle: string): Promise<WinnerResult> {
    try {
      console.log(`Selecting random winner for: ${competitionTitle}`);

      // Find the segment ID
      const segmentId = await this.findSegmentId(offerSlug);
      if (!segmentId) {
        throw new Error(`Segment not found for offer: ${offerSlug}`);
      }

      // Get all customers in the segment
      const customers = await this.getSegmentPeople(segmentId);
      if (customers.length === 0) {
        throw new Error('No customers found in segment');
      }

      // Select random winner
      const randomIndex = Math.floor(Math.random() * customers.length);
      const winner = customers[randomIndex];

      console.log(`🏆 Winner selected: ${winner.email} (${randomIndex + 1} of ${customers.length})`);

      return {
        winner,
        totalEntries: customers.length,
        segmentName: this.createSegmentName(offerSlug),
        competition: competitionTitle
      };
    } catch (error) {
      console.error('Error selecting winner:', error);
      throw error;
    }
  }
}

export const winnerSelectionService = new WinnerSelectionService();
