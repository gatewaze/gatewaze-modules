import type { GatewazeModule } from '@gatewaze/shared';

const stripePaymentsModule: GatewazeModule = {
  id: 'stripe-payments',
  type: 'integration',
  visibility: 'public',
  name: 'Stripe Payments',
  description: 'Accept payments for events via Stripe',
  version: '1.0.0',
  features: ['payments'],

  adminRoutes: [
    {
      path: 'payments',
      component: () => import('./admin/pages/customers'),
      requiredFeature: 'payments',
      guard: 'admin',
    },
    {
      path: 'payments/customers',
      component: () => import('./admin/pages/customers'),
      requiredFeature: 'payments',
      guard: 'admin',
    },
    {
      path: 'payments/products',
      component: () => import('./admin/pages/products'),
      requiredFeature: 'payments',
      guard: 'admin',
    },
    {
      path: 'payments/invoices',
      component: () => import('./admin/pages/invoices'),
      requiredFeature: 'payments',
      guard: 'admin',
    },
    {
      path: 'payments/transactions',
      component: () => import('./admin/pages/transactions'),
      requiredFeature: 'payments',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/payments',
      label: 'Payments',
      icon: 'CreditCard',
      requiredFeature: 'payments',
      parentGroup: 'admin',
      order: 32,
    },
  ],

  edgeFunctions: [
    'stripe-webhook',
    'create-event-payment',
  ],

  migrations: [
    'migrations/001_stripe_tables.sql',
  ],

  configSchema: {
    STRIPE_SECRET_KEY: {
      key: 'STRIPE_SECRET_KEY',
      type: 'secret',
      required: true,
      description: 'Stripe secret API key',
    },
    STRIPE_WEBHOOK_SECRET: {
      key: 'STRIPE_WEBHOOK_SECRET',
      type: 'secret',
      required: true,
      description: 'Stripe webhook signing secret',
    },
    STRIPE_PUBLISHABLE_KEY: {
      key: 'STRIPE_PUBLISHABLE_KEY',
      type: 'string',
      required: true,
      description: 'Stripe publishable key for frontend',
    },
  },
};

export default stripePaymentsModule;
