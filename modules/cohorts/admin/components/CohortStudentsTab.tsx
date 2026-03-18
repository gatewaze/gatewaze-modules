import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { TrashIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import { CheckCircleIcon as CheckCircleSolidIcon } from '@heroicons/react/24/solid';
import { Card, Badge, ConfirmModal } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Cohort, CohortEnrollment, StudentProgress } from '@/lib/cohorts/types';
import { CohortService } from '@/lib/cohorts';
import { supabase } from '@/lib/supabase';

interface CohortStudentsTabProps {
  cohort: Cohort;
}

export function CohortStudentsTab({ cohort }: CohortStudentsTabProps) {
  const [enrollments, setEnrollments] = useState<CohortEnrollment[]>([]);
  const [studentProgress, setStudentProgress] = useState<StudentProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [enrollmentToDelete, setEnrollmentToDelete] = useState<CohortEnrollment | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    loadData();
  }, [cohort.id]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load enrollments and progress in parallel
      const [enrollmentsResult, progressResult] = await Promise.all([
        CohortService.getEnrollments({ cohort_id: cohort.id }),
        CohortService.getStudentProgress(cohort.id),
      ]);

      if (enrollmentsResult.error) throw enrollmentsResult.error;
      if (progressResult.error) throw progressResult.error;

      setEnrollments(enrollmentsResult.data);
      setStudentProgress(progressResult.data);
    } catch (error: any) {
      console.error('Error loading data:', error);
      toast.error('Failed to load student data');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'success';
      case 'pending':
        return 'warning';
      case 'failed':
        return 'danger';
      case 'refunded':
        return 'secondary';
      default:
        return 'neutral';
    }
  };

  const getProgressColor = (percentage: number) => {
    if (percentage === 100) return 'bg-green-500';
    if (percentage >= 50) return 'bg-blue-500';
    if (percentage > 0) return 'bg-yellow-500';
    return 'bg-gray-300 dark:bg-gray-600';
  };

  const handleDeleteClick = (enrollment: CohortEnrollment) => {
    setEnrollmentToDelete(enrollment);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!enrollmentToDelete) return;

    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from('cohorts_enrollments')
        .delete()
        .eq('id', enrollmentToDelete.id);

      if (error) throw error;

      // Remove from local state
      setEnrollments(prev => prev.filter(e => e.id !== enrollmentToDelete.id));
      toast.success(`Enrollment for ${enrollmentToDelete.customer_name || enrollmentToDelete.customer_email} has been deleted`);
      setDeleteModalOpen(false);
      setEnrollmentToDelete(null);
    } catch (error: any) {
      console.error('Error deleting enrollment:', error);
      toast.error('Failed to delete enrollment');
    } finally {
      setIsDeleting(false);
    }
  };

  // Create a map of person_id to progress for quick lookup
  const progressMap = new Map(studentProgress.map(p => [p.person_id, p]));

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <LoadingSpinner size="large" />
      </div>
    );
  }

  const completedEnrollments = enrollments.filter(e => e.payment_status === 'completed');
  const pendingEnrollments = enrollments.filter(e => e.payment_status === 'pending');

  // Calculate average progress
  const avgProgress = studentProgress.length > 0
    ? Math.round(studentProgress.reduce((sum, p) => sum + p.progress_percentage, 0) / studentProgress.length)
    : 0;

  const totalWeeks = studentProgress[0]?.total_weeks || 0;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">Total Enrolled</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {completedEnrollments.length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">Pending</p>
          <p className="text-2xl font-bold text-yellow-600">
            {pendingEnrollments.length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">Avg Progress</p>
          <p className="text-2xl font-bold text-blue-600">
            {avgProgress}%
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">Revenue</p>
          <p className="text-2xl font-bold text-green-600">
            {formatCurrency(
              completedEnrollments.reduce((sum, e) => sum + e.amount_cents, 0)
            )}
          </p>
        </Card>
      </div>

      {/* Enrollments List */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            Enrolled Students ({enrollments.length})
          </h3>
        </div>

        {enrollments.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No enrollments yet for this cohort.
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {enrollments.map((enrollment) => {
              const progress = progressMap.get(enrollment.person_id);

              return (
                <div
                  key={enrollment.id}
                  className="p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">
                            {enrollment.customer_name || 'Unknown'}
                          </p>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {enrollment.customer_email}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      {/* Progress indicator for completed enrollments */}
                      {enrollment.payment_status === 'completed' && progress && totalWeeks > 0 && (
                        <div className="flex items-center gap-2">
                          <div className="flex gap-1">
                            {Array.from({ length: totalWeeks }, (_, i) => {
                              const weekNum = i + 1;
                              const isCompleted = progress.completed_weeks.includes(weekNum);
                              return (
                                <div
                                  key={weekNum}
                                  className="relative group"
                                  title={`Week ${weekNum}${isCompleted ? ' - Completed' : ''}`}
                                >
                                  {isCompleted ? (
                                    <CheckCircleSolidIcon className="w-5 h-5 text-green-500" />
                                  ) : (
                                    <CheckCircleIcon className="w-5 h-5 text-gray-300 dark:text-gray-600" />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <span className="text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[3rem] text-right">
                            {progress.progress_percentage}%
                          </span>
                        </div>
                      )}

                      <div className="text-right">
                        <p className="font-medium text-gray-900 dark:text-white">
                          {formatCurrency(enrollment.amount_cents)}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {formatDate(enrollment.created_at)}
                        </p>
                      </div>
                      <Badge color={getStatusColor(enrollment.payment_status) as any}>
                        {enrollment.payment_status}
                      </Badge>
                      <button
                        onClick={() => handleDeleteClick(enrollment)}
                        className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        title="Delete enrollment"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Progress bar for completed enrollments */}
                  {enrollment.payment_status === 'completed' && progress && totalWeeks > 0 && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                        <span>{progress.completed_weeks.length} of {totalWeeks} weeks completed</span>
                        {progress.last_activity && (
                          <span>Last activity: {formatDate(progress.last_activity)}</span>
                        )}
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all ${getProgressColor(progress.progress_percentage)}`}
                          style={{ width: `${progress.progress_percentage}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => {
          setDeleteModalOpen(false);
          setEnrollmentToDelete(null);
        }}
        onConfirm={handleDeleteConfirm}
        title="Delete Enrollment"
        message={
          enrollmentToDelete
            ? `Are you sure you want to delete the enrollment for "${enrollmentToDelete.customer_name || enrollmentToDelete.customer_email}"? ${
                enrollmentToDelete.payment_status === 'completed'
                  ? 'This student has already paid - you may need to process a refund separately.'
                  : 'This will remove their pending enrollment.'
              }`
            : ''
        }
        confirmText={isDeleting ? "Deleting..." : "Delete"}
        confirmColor="red"
      />
    </div>
  );
}
