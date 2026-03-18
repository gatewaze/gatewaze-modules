import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  AcademicCapIcon,
  UserGroupIcon,
  UsersIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CohortService, EnrollmentStats } from '@/lib/cohorts';

export default function CohortsOverview() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<EnrollmentStats | null>(null);
  const [activeInstructorCount, setActiveInstructorCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
    loadInstructorCount();
  }, []);

  const loadStats = async () => {
    setLoading(true);
    try {
      const { data, error } = await CohortService.getEnrollmentStats();
      if (error) throw error;
      setStats(data);
    } catch (error: any) {
      console.error('Error loading stats:', error);
      toast.error('Failed to load statistics');
    } finally {
      setLoading(false);
    }
  };

  const loadInstructorCount = async () => {
    try {
      const { data, error } = await CohortService.getInstructors();
      if (error) throw error;
      const activeCount = data.filter(i => i.is_active).length;
      setActiveInstructorCount(activeCount);
    } catch (error: any) {
      console.error('Error loading instructor count:', error);
    }
  };

  const sections = [
    {
      title: 'Instructors',
      description: 'Manage instructor profiles and assignments',
      icon: UsersIcon,
      iconColor: 'text-purple-600',
      iconBg: 'bg-purple-100 dark:bg-purple-900/20',
      stats: [
        { label: 'Active Instructors', value: activeInstructorCount },
        { label: 'Total Cohorts Taught', value: stats?.active_cohorts || 0 },
      ],
      actions: [
        {
          label: 'View All Instructors',
          onClick: () => navigate('/cohorts/instructors'),
          primary: true,
        },
      ],
    },
    {
      title: 'Cohorts',
      description: 'Create and manage cohort programs',
      icon: AcademicCapIcon,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100 dark:bg-blue-900/20',
      stats: [
        { label: 'Active Cohorts', value: stats?.active_cohorts || 0 },
        { label: 'Total Students', value: stats?.total_students || 0 },
      ],
      actions: [
        {
          label: 'View All Cohorts',
          onClick: () => navigate('/cohorts/manage'),
          primary: true,
        },
      ],
    },
    {
      title: 'Enrollments',
      description: 'View all cohort enrollments and revenue',
      icon: UserGroupIcon,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100 dark:bg-green-900/20',
      stats: [
        { label: 'Total Enrollments', value: stats?.total_enrollments || 0 },
        { label: 'Pending Payments', value: stats?.pending_payments || 0 },
      ],
      actions: [
        {
          label: 'View All Enrollments',
          onClick: () => navigate('/cohorts/enrollments'),
          primary: true,
        },
      ],
    },
  ];

  if (loading) {
    return (
      <Page title="Cohorts">
        <div className="flex justify-center items-center py-12">
          <LoadingSpinner size="large" />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Cohorts">
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Cohorts Management
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Manage instructors, cohorts, and student enrollments
          </p>
        </div>

        {/* Main Sections */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {sections.map((section, index) => (
            <Card key={index} className="p-6 hover:shadow-lg transition-shadow">
              {/* Icon & Title */}
              <div className="flex items-start gap-4 mb-6">
                <div className={`p-3 rounded-lg ${section.iconBg}`}>
                  <section.icon className={`h-8 w-8 ${section.iconColor}`} />
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                    {section.title}
                  </h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {section.description}
                  </p>
                </div>
              </div>

              {/* Stats */}
              <div className="space-y-3 mb-6">
                {section.stats.map((stat, statIdx) => (
                  <div key={statIdx} className="flex justify-between items-center">
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {stat.label}
                    </span>
                    <span className="text-lg font-semibold text-gray-900 dark:text-white">
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="space-y-2">
                {section.actions.map((action, actionIdx) => (
                  <Button
                    key={actionIdx}
                    variant={action.primary ? 'primary' : 'secondary'}
                    onClick={action.onClick}
                    className="w-full flex items-center justify-center gap-2"
                  >
                    {action.icon && <action.icon className="h-5 w-5" />}
                    {action.label}
                    {!action.icon && <ChevronRightIcon className="h-4 w-4" />}
                  </Button>
                ))}
              </div>
            </Card>
          ))}
        </div>

        {/* Quick Stats Overview */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Overview
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Total Enrollments</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                {stats?.total_enrollments || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Active Cohorts</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                {stats?.active_cohorts || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Total Students</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                {stats?.total_students || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Total Revenue</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                ${((stats?.total_revenue_cents || 0) / 100).toLocaleString()}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </Page>
  );
}
