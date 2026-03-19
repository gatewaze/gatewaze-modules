/**
 * Cohorts module exports
 */

import { supabase } from '@/lib/supabase';
import { CohortService as CohortServiceClass } from './service';

export * from './types';
export { CohortServiceClass };

// Export a singleton instance for convenience
export const CohortService = new CohortServiceClass(supabase);
