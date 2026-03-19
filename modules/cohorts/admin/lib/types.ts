/**
 * Cohort management types for Gatewaze admin
 */

export interface CohortEnrollment {
  id: string;
  cohort_id: string;
  person_id: number;
  amount_cents: number;
  stripe_session_id?: string;
  payment_status: 'pending' | 'completed' | 'failed' | 'refunded';
  user_id?: string;
  created_at: string;
  updated_at: string;
  // Joined fields (from customers table)
  customer_name?: string;
  customer_email?: string;
  customer_company?: string;
  // Joined fields (from cohorts table)
  cohort_title?: string;
  instructor_name?: string;
}

export interface Cohort {
  id: string;
  title: string;
  description?: string;
  long_description?: string;
  instructor_id: string; // UUID - Foreign key to cohorts_instructor_profiles.id
  start_date: string;
  end_date: string;
  price_cents: number;
  original_price_cents?: number;
  max_participants?: number;
  rating?: number; // Star rating out of 5 (e.g., 4.9)
  tags?: string[]; // Array of tags
  image?: string; // URL to cohort image
  is_active: boolean;
  stripe_mode?: 'test' | 'live'; // Controls Stripe test vs live mode for payments
  google_classroom_link?: string;
  // HTML content fields for front-end sections
  modules_heading?: string;
  modules_description?: string;
  benefits_heading?: string;
  testimonials_heading?: string;
  why_heading?: string;
  why_description?: string;
  created_at: string;
  updated_at: string;
  // Joined fields (not in DB)
  instructor_name?: string;
  instructor_email?: string;
}


export interface InstructorProfile {
  id: string;
  person_id: number; // Links to people.id
  customer_cio_id: string; // Deprecated: kept for backward compatibility
  email: string; // Denormalized from customer for performance
  bio?: string;
  specialty?: string;
  rating?: number;
  total_students?: number;
  is_featured: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Joined from customers table (not in DB)
  instructor_name?: string;
  avatar_url?: string;
  first_name?: string;
  last_name?: string;
}

export interface UserProgress {
  id: string;
  user_id: string;
  cohort_id: string;
  module_week: number;
  completed_at: string;
  created_at: string;
}

export interface CohortResource {
  id: string;
  cohort_id: string;
  module_id?: number; // Links to cohorts_modules
  week_number: number; // Deprecated - use module_id
  title: string;
  description?: string;
  resource_type: 'video' | 'document' | 'link' | 'zoom' | 'slack';
  resource_url: string;
  is_member_only: boolean;
  created_at: string;
  updated_at: string;
}

export interface LiveSession {
  id: string;
  cohort_id: string;
  module_id?: number; // Links to cohorts_modules
  week_number: number; // Deprecated - use module_id
  session_title: string;
  session_date: string;
  session_end_date?: string;
  timezone?: string; // IANA timezone identifier (e.g., America/New_York)
  zoom_link?: string;
  recording_link?: string;
  created_at: string;
  updated_at: string;
}

export interface EnrollmentStats {
  total_enrollments: number;
  total_revenue_cents: number;
  pending_payments: number;
  completed_payments: number;
  active_cohorts: number;
  total_students: number;
}

export interface StudentProgress {
  user_id: string;
  person_id: number;
  customer_name: string;
  customer_email: string;
  completed_weeks: number[];
  total_weeks: number;
  progress_percentage: number;
  last_activity?: string;
}

export interface CohortWeek {
  id: string;
  cohort_id: string;
  week_number: number;
  title: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  created_at: string;
  updated_at: string;
}

export interface CohortModule {
  id: number;
  cohort_id: string;
  cohort_week_id?: string;
  week: number; // Deprecated - use cohort_week_id
  title: string;
  description: string;
  topics: string[];
  module_order: number;
  created_at: string;
  updated_at: string;
}

export interface CohortBenefit {
  id: number;
  cohort_id: string;
  benefit: string;
  display_order: number;
  benefit_order: number;
  created_at: string;
  updated_at: string;
}

export interface CohortTestimonial {
  id: number;
  cohort_id: string;
  name: string;
  role?: string;
  content: string;
  rating?: number;
  display_order: number;
  created_at: string;
  updated_at: string;
}
