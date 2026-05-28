/**
 * Cohort service for admin operations
 * Uses authenticated Supabase client with admin role
 * Admin access is controlled by RLS policies that check for admin role
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { PeopleAvatarService } from '@/utils/peopleAvatarService';
import type {
  CohortEnrollment,
  Cohort,
  InstructorProfile,
  EnrollmentStats,
  CohortResource,
  LiveSession,
  StudentProgress,
} from './types';

export class CohortService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Get all cohort enrollments with optional filters
   * Fetches enrollments and manually joins customer/cohort data
   */
  async getEnrollments(filters?: {
    cohort_id?: string;
    payment_status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: CohortEnrollment[]; total: number; error: any }> {
    // First, fetch enrollments
    let query = this.supabase
      .from('cohorts_enrollments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (filters?.cohort_id) {
      query = query.eq('cohort_id', filters.cohort_id);
    }

    if (filters?.payment_status) {
      query = query.eq('payment_status', filters.payment_status);
    }

    if (filters?.limit) {
      query = query.limit(filters.limit);
    }

    if (filters?.offset) {
      query = query.range(filters.offset, filters.offset + (filters.limit || 50) - 1);
    }

    const { data: enrollmentsData, error, count } = await query;

    if (error) {
      return { data: [], total: 0, error };
    }

    if (!enrollmentsData || enrollmentsData.length === 0) {
      return { data: [], total: 0, error: null };
    }

    // Get unique customer IDs and cohort IDs
    const customerIds = [...new Set(enrollmentsData.map(e => e.person_id).filter(Boolean))];
    const cohortIds = [...new Set(enrollmentsData.map(e => e.cohort_id).filter(Boolean))];

    // Fetch customers
    const customersMap = new Map();
    if (customerIds.length > 0) {
      const { data: customers } = await this.supabase
        .from('people')
        .select('id, email, attributes')
        .in('id', customerIds);

      customers?.forEach(c => customersMap.set(c.id, c));
    }

    // Fetch cohorts with instructor info
    const cohortsMap = new Map();
    if (cohortIds.length > 0) {
      const { data: cohorts } = await this.supabase
        .from('cohorts')
        .select(`
          id,
          title,
          cohorts_instructor_profiles!cohorts_instructor_id_fkey (
            email,
            customers!cohorts_instructor_profiles_customer_id_fkey (
              attributes
            )
          )
        `)
        .in('id', cohortIds);

      cohorts?.forEach(c => cohortsMap.set(c.id, c));
    }

    // Transform enrollments with joined data
    const enrollments = enrollmentsData.map((enrollment: any) => {
      const customer = customersMap.get(enrollment.person_id);
      const cohort = cohortsMap.get(enrollment.cohort_id);
      const instructor = (cohort as any)?.cohorts_instructor_profiles;
      const instructorCustomer = instructor?.customers;

      const customerFirstName = customer?.attributes?.first_name || '';
      const customerLastName = customer?.attributes?.last_name || '';
      const customer_name = `${customerFirstName} ${customerLastName}`.trim() || customer?.email || '';

      const instructorFirstName = instructorCustomer?.attributes?.first_name || '';
      const instructorLastName = instructorCustomer?.attributes?.last_name || '';
      const instructor_name = `${instructorFirstName} ${instructorLastName}`.trim() || instructor?.email || '';

      return {
        ...enrollment,
        customer_name,
        customer_email: customer?.email,
        customer_company: customer?.attributes?.company,
        cohort_title: cohort?.title,
        instructor_name,
      };
    });

    return {
      data: enrollments as CohortEnrollment[],
      total: count || 0,
      error: null,
    };
  }

  /**
   * Get a single enrollment by ID
   */
  async getEnrollment(id: string): Promise<{ data: CohortEnrollment | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_enrollments')
      .select('*')
      .eq('id', id)
      .single();

    return { data: data as CohortEnrollment | null, error };
  }

  /**
   * Get all cohorts with optional filters
   */
  async getCohorts(filters?: {
    is_active?: boolean;
    limit?: number;
  }): Promise<{ data: Cohort[]; error: any }> {
    let query = this.supabase
      .from('cohorts')
      .select(`
        *,
        cohorts_instructor_profiles!cohorts_instructor_id_fkey (
          id,
          email,
          customers!cohorts_instructor_profiles_customer_id_fkey (
            attributes
          )
        )
      `)
      .order('start_date', { ascending: false });

    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }

    if (filters?.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;

    if (error) {
      return { data: [], error };
    }

    // Transform data to flatten instructor info
    const cohorts = (data || []).map((cohort: any) => {
      const instructor = cohort.cohorts_instructor_profiles;
      const customer = instructor?.customers;
      const firstName = customer?.attributes?.first_name || '';
      const lastName = customer?.attributes?.last_name || '';
      const instructor_name = `${firstName} ${lastName}`.trim() || instructor?.email || '';

      return {
        ...cohort,
        instructor_name,
        instructor_email: instructor?.email,
        cohorts_instructor_profiles: undefined,
      };
    });

    return {
      data: cohorts as Cohort[],
      error: null,
    };
  }

  /**
   * Get a single cohort by ID
   */
  async getCohort(id: string): Promise<{ data: Cohort | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts')
      .select(`
        *,
        cohorts_instructor_profiles!cohorts_instructor_id_fkey (
          id,
          email,
          customers!cohorts_instructor_profiles_customer_id_fkey (
            attributes
          )
        )
      `)
      .eq('id', id)
      .single();

    if (error || !data) {
      return { data: null, error };
    }

    // Transform data to flatten instructor info
    const instructor = (data as any).cohorts_instructor_profiles;
    const customer = instructor?.customers;
    const firstName = customer?.attributes?.first_name || '';
    const lastName = customer?.attributes?.last_name || '';
    const instructor_name = `${firstName} ${lastName}`.trim() || instructor?.email || '';

    return {
      data: {
        ...data,
        instructor_name,
        instructor_email: instructor?.email,
        cohorts_instructor_profiles: undefined,
      } as Cohort,
      error: null,
    };
  }

  /**
   * Create a new cohort
   */
  async createCohort(cohort: Partial<Cohort>): Promise<{ data: Cohort | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts')
      .insert([cohort])
      .select()
      .single();

    return { data: data as Cohort | null, error };
  }

  /**
   * Update an existing cohort
   */
  async updateCohort(id: string, updates: Partial<Cohort>): Promise<{ data: Cohort | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    return { data: data as Cohort | null, error };
  }

  /**
   * Get instructor profiles with customer data joined
   */
  async getInstructors(): Promise<{ data: InstructorProfile[]; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_instructor_profiles')
      .select(`
        *,
        customers!cohorts_instructor_profiles_customer_id_fkey (
          id,
          email,
          attributes,
          avatar_storage_path
        )
      `)
      .order('email', { ascending: true });

    if (error) {
      return { data: [], error };
    }

    // Transform the data to flatten customer info
    const instructors = (data || []).map((profile: any) => {
      const customer = profile.customers;
      const firstName = customer?.attributes?.first_name || '';
      const lastName = customer?.attributes?.last_name || '';
      const instructor_name = `${firstName} ${lastName}`.trim() || customer?.email || '';

      // Convert storage path to public URL
      const avatar_url = customer?.avatar_storage_path
        ? PeopleAvatarService.getAvatarPublicUrl(customer.avatar_storage_path)
        : null;

      return {
        ...profile,
        instructor_name,
        first_name: firstName,
        last_name: lastName,
        avatar_url,
        customers: undefined, // Remove the nested object
      };
    });

    return {
      data: instructors as InstructorProfile[],
      error: null,
    };
  }

  /**
   * Create instructor profile from customer
   */
  async createInstructor(
    customerCioId: string,
    instructorData: Partial<InstructorProfile>
  ): Promise<{ data: InstructorProfile | null; error: any }> {
    // First, get the person_id from the cio_id
    const { data: customer, error: customerError } = await this.supabase
      .from('people')
      .select('id, email, attributes, avatar_storage_path')
      .eq('cio_id', customerCioId)
      .single();

    if (customerError || !customer) {
      return { data: null, error: customerError || new Error('Customer not found') };
    }

    const { data, error } = await this.supabase
      .from('cohorts_instructor_profiles')
      .insert([{
        ...instructorData,
        person_id: customer.id,
        customer_cio_id: customerCioId,
      }])
      .select()
      .single();

    if (error || !data) {
      return { data: null, error };
    }

    // Return with customer data joined
    const firstName = customer.attributes?.first_name || '';
    const lastName = customer.attributes?.last_name || '';
    const instructor_name = `${firstName} ${lastName}`.trim() || customer.email || '';

    // Convert storage path to public URL
    const avatar_url = customer.avatar_storage_path
      ? PeopleAvatarService.getAvatarPublicUrl(customer.avatar_storage_path)
      : null;

    return {
      data: {
        ...data,
        instructor_name,
        first_name: firstName,
        last_name: lastName,
        avatar_url,
      } as InstructorProfile,
      error: null,
    };
  }

  /**
   * Update instructor profile
   */
  async updateInstructor(
    id: string,
    updates: Partial<InstructorProfile>
  ): Promise<{ data: InstructorProfile | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_instructor_profiles')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    return { data: data as InstructorProfile | null, error };
  }

  /**
   * Get instructor by ID with customer data joined
   */
  async getInstructor(id: string): Promise<{ data: InstructorProfile | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_instructor_profiles')
      .select(`
        *,
        customers!cohorts_instructor_profiles_customer_id_fkey (
          id,
          email,
          attributes,
          avatar_storage_path
        )
      `)
      .eq('id', id)
      .single();

    if (error || !data) {
      return { data: null, error };
    }

    // Transform the data to flatten customer info
    const customer = (data as any).customers;
    const firstName = customer?.attributes?.first_name || '';
    const lastName = customer?.attributes?.last_name || '';
    const instructor_name = `${firstName} ${lastName}`.trim() || customer?.email || '';

    // Convert storage path to public URL
    const avatar_url = customer?.avatar_storage_path
      ? PeopleAvatarService.getAvatarPublicUrl(customer.avatar_storage_path)
      : null;

    return {
      data: {
        ...data,
        instructor_name,
        first_name: firstName,
        last_name: lastName,
        avatar_url,
        customers: undefined,
      } as InstructorProfile,
      error: null,
    };
  }

  /**
   * Get instructor by customer CIO ID
   */
  async getInstructorByCustomerId(customerCioId: string): Promise<{ data: InstructorProfile | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_instructor_profiles')
      .select('*')
      .eq('customer_cio_id', customerCioId)
      .single();

    return { data: data as InstructorProfile | null, error };
  }

  /**
   * Delete instructor profile (does not delete customer or auth user)
   */
  async deleteInstructor(id: string): Promise<{ error: any }> {
    const { error } = await this.supabase
      .from('cohorts_instructor_profiles')
      .delete()
      .eq('id', id);

    return { error };
  }

  /**
   * Get cohorts for an instructor by instructor profile ID
   */
  async getInstructorCohorts(instructorProfileId: string): Promise<{ data: Cohort[]; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts')
      .select(`
        *,
        cohorts_instructor_profiles!cohorts_instructor_id_fkey (
          id,
          email,
          customers!cohorts_instructor_profiles_customer_id_fkey (
            attributes
          )
        )
      `)
      .eq('instructor_id', instructorProfileId)
      .order('start_date', { ascending: false });

    if (error) {
      return { data: [], error };
    }

    // Transform data to flatten instructor info
    const cohorts = (data || []).map((cohort: any) => {
      const instructor = cohort.cohorts_instructor_profiles;
      const customer = instructor?.customers;
      const firstName = customer?.attributes?.first_name || '';
      const lastName = customer?.attributes?.last_name || '';
      const instructor_name = `${firstName} ${lastName}`.trim() || instructor?.email || '';

      return {
        ...cohort,
        instructor_name,
        instructor_email: instructor?.email,
        cohorts_instructor_profiles: undefined,
      };
    });

    return {
      data: cohorts as Cohort[],
      error: null,
    };
  }

  /**
   * Get enrollment statistics
   */
  async getEnrollmentStats(): Promise<{ data: EnrollmentStats | null; error: any }> {
    try {
      // Get all enrollments with person_id for unique student count
      const { data: enrollments, error: enrollmentsError } = await this.supabase
        .from('cohorts_enrollments')
        .select('payment_status, amount_cents, person_id');

      if (enrollmentsError) throw enrollmentsError;

      // Get active cohorts count
      const { count: activeCohorts, error: cohortsError } = await this.supabase
        .from('cohorts')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true);

      if (cohortsError) throw cohortsError;

      // Calculate stats - use person_id for unique student count
      const completedEnrollments = enrollments?.filter(e => e.payment_status === 'completed') || [];
      const uniqueCustomerIds = new Set(completedEnrollments.map(e => e.person_id).filter(Boolean));

      const stats: EnrollmentStats = {
        total_enrollments: enrollments?.length || 0,
        total_revenue_cents: enrollments?.reduce((sum, e) => sum + (e.amount_cents || 0), 0) || 0,
        pending_payments: enrollments?.filter(e => e.payment_status === 'pending').length || 0,
        completed_payments: completedEnrollments.length,
        active_cohorts: activeCohorts || 0,
        total_students: uniqueCustomerIds.size,
      };

      return { data: stats, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  /**
   * Get resources for a cohort
   */
  async getCohortResources(cohortId: string): Promise<{ data: CohortResource[]; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_resources')
      .select('*')
      .eq('cohort_id', cohortId)
      .order('week_number', { ascending: true });

    return {
      data: data as CohortResource[] || [],
      error,
    };
  }

  /**
   * Get live sessions for a cohort
   */
  async getLiveSessions(cohortId: string): Promise<{ data: LiveSession[]; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_live_sessions')
      .select('*')
      .eq('cohort_id', cohortId)
      .order('session_date', { ascending: true});

    return {
      data: data as LiveSession[] || [],
      error,
    };
  }

  /**
   * Create a new cohort resource
   */
  async createResource(resource: Partial<CohortResource>): Promise<{ data: CohortResource | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_resources')
      .insert([resource])
      .select()
      .single();

    return { data: data as CohortResource | null, error };
  }

  /**
   * Update a cohort resource
   */
  async updateResource(id: string, updates: Partial<CohortResource>): Promise<{ data: CohortResource | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_resources')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    return { data: data as CohortResource | null, error };
  }

  /**
   * Delete a cohort resource
   */
  async deleteResource(id: string): Promise<{ error: any }> {
    const { error } = await this.supabase
      .from('cohorts_resources')
      .delete()
      .eq('id', id);

    return { error };
  }

  /**
   * Create a new live session
   */
  async createSession(session: Partial<LiveSession>): Promise<{ data: LiveSession | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_live_sessions')
      .insert([session])
      .select()
      .single();

    return { data: data as LiveSession | null, error };
  }

  /**
   * Update a live session
   */
  async updateSession(id: string, updates: Partial<LiveSession>): Promise<{ data: LiveSession | null; error: any }> {
    const { data, error } = await this.supabase
      .from('cohorts_live_sessions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    return { data: data as LiveSession | null, error };
  }

  /**
   * Delete a live session
   */
  async deleteSession(id: string): Promise<{ error: any }> {
    const { error } = await this.supabase
      .from('cohorts_live_sessions')
      .delete()
      .eq('id', id);

    return { error };
  }

  /**
   * Get student progress for a cohort
   * Returns enrolled students with their completion status
   */
  async getStudentProgress(cohortId: string): Promise<{ data: StudentProgress[]; error: any }> {
    try {
      // Get total weeks for this cohort
      const { data: weeks, error: weeksError } = await this.supabase
        .from('cohorts_weeks')
        .select('week_number')
        .eq('cohort_id', cohortId);

      if (weeksError) throw weeksError;

      const totalWeeks = weeks?.length || 0;

      // Get all completed enrollments for this cohort
      const { data: enrollments, error: enrollmentsError } = await this.supabase
        .from('cohorts_enrollments')
        .select('person_id, user_id')
        .eq('cohort_id', cohortId)
        .eq('payment_status', 'completed');

      if (enrollmentsError) throw enrollmentsError;

      if (!enrollments || enrollments.length === 0) {
        return { data: [], error: null };
      }

      // Get customer details
      const customerIds = [...new Set(enrollments.map(e => e.person_id).filter(Boolean))];
      const customersMap = new Map();

      if (customerIds.length > 0) {
        const { data: customers } = await this.supabase
          .from('people')
          .select('id, email, attributes, auth_user_id')
          .in('id', customerIds);

        customers?.forEach(c => customersMap.set(c.id, c));
      }

      // Get user_ids from enrollments or from customers' auth_user_id
      const userIds = enrollments
        .map(e => {
          if (e.user_id) return e.user_id;
          const customer = customersMap.get(e.person_id);
          return customer?.auth_user_id;
        })
        .filter(Boolean);

      // Get progress data for all users in this cohort
      const progressMap = new Map<string, { weeks: number[]; lastActivity?: string }>();

      if (userIds.length > 0) {
        const { data: progressData } = await this.supabase
          .from('cohorts_user_progress')
          .select('user_id, module_week, completed_at')
          .eq('cohort_id', cohortId)
          .in('user_id', userIds);

        // Group progress by user
        progressData?.forEach(p => {
          const existing = progressMap.get(p.user_id) || { weeks: [], lastActivity: undefined };
          existing.weeks.push(p.module_week);
          if (!existing.lastActivity || p.completed_at > existing.lastActivity) {
            existing.lastActivity = p.completed_at;
          }
          progressMap.set(p.user_id, existing);
        });
      }

      // Build the result
      const studentProgress: StudentProgress[] = enrollments.map(enrollment => {
        const customer = customersMap.get(enrollment.person_id);
        const userId = enrollment.user_id || customer?.auth_user_id;
        const progress = userId ? progressMap.get(userId) : undefined;
        const completedWeeks = progress?.weeks || [];

        const firstName = customer?.attributes?.first_name || '';
        const lastName = customer?.attributes?.last_name || '';
        const customerName = `${firstName} ${lastName}`.trim() || customer?.email || 'Unknown';

        return {
          user_id: userId || '',
          person_id: enrollment.person_id,
          customer_name: customerName,
          customer_email: customer?.email || '',
          completed_weeks: completedWeeks.sort((a, b) => a - b),
          total_weeks: totalWeeks,
          progress_percentage: totalWeeks > 0 ? Math.round((completedWeeks.length / totalWeeks) * 100) : 0,
          last_activity: progress?.lastActivity,
        };
      });

      // Sort by progress percentage descending, then by name
      studentProgress.sort((a, b) => {
        if (b.progress_percentage !== a.progress_percentage) {
          return b.progress_percentage - a.progress_percentage;
        }
        return a.customer_name.localeCompare(b.customer_name);
      });

      return { data: studentProgress, error: null };
    } catch (error) {
      return { data: [], error };
    }
  }
}
