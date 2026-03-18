import type { GatewazeModule } from '@gatewaze/shared';

const cohortsModule: GatewazeModule = {
  id: 'cohorts',
  type: 'feature',
  visibility: 'public',
  name: 'Cohorts',
  description: 'Manage cohort-based learning programs with sessions, enrollments, resources, and instructors',
  version: '1.0.0',
  features: [
    'cohorts',
    'cohorts.sessions',
    'cohorts.enrollments',
    'cohorts.resources',
    'cohorts.instructors',
  ],

  edgeFunctions: [
    'cohorts-create-payment',
    'cohorts-interest',
    'cohorts-signup',
  ],

  migrations: [
    'migrations/001_cohorts_tables.sql',
  ],

  adminRoutes: [
    { path: 'cohorts', component: () => import('./admin/pages/index'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/enrollments', component: () => import('./admin/pages/enrollments'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/manage', component: () => import('./admin/pages/manage'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/:cohortId/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/:cohortId', component: () => import('./admin/pages/detail'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/:cohortId/resources', component: () => import('./admin/pages/resources'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/:cohortId/sessions', component: () => import('./admin/pages/sessions'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/instructors', component: () => import('./admin/pages/instructors'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/instructors/:id', component: () => import('./admin/pages/instructor-detail'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/instructors/:instructorId/cohorts/:cohortId/resources', component: () => import('./admin/pages/resources'), requiredFeature: 'cohorts', guard: 'none' },
    { path: 'cohorts/instructors/:instructorId/cohorts/:cohortId/sessions', component: () => import('./admin/pages/sessions'), requiredFeature: 'cohorts', guard: 'none' },
  ],

  adminNavItems: [
    { path: '/cohorts', label: 'Cohorts', icon: 'Users', requiredFeature: 'cohorts', order: 15 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[cohorts] Module installed');
  },

  onEnable: async () => {
    console.log('[cohorts] Module enabled');
  },

  onDisable: async () => {
    console.log('[cohorts] Module disabled');
  },
};

export default cohortsModule;
