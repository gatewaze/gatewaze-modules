import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.11.0?target=deno'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-11-20.acacia',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Stripe Manual Sync Function
 * Pulls all existing data from Stripe and syncs it to Supabase
 *
 * NEW DATA MODEL:
 * - Products/Prices: No account_id (shared catalog per database)
 * - Stripe Customers: Nullable account_id (for manual assignment)
 * - Invoices: Linked to stripe_customer
 * - Transactions: Have email for auto-linking to accounts
 *
 * Query Parameters:
 * - sync_type (optional): comma-separated list of what to sync (customers,products,prices,invoices,transactions)
 *   Default: all
 *
 * Usage:
 *   POST /stripe-sync
 *   POST /stripe-sync?sync_type=customers,products
 *
 * Note: No metadata required on Stripe objects. Each brand has its own Supabase database.
 */
Deno.serve(async (req) => {
  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    // Get parameters from query params
    const url = new URL(req.url)

    // Get sync types (default to all)
    const syncTypeParam = url.searchParams.get('sync_type') || 'all'
    const syncTypes = syncTypeParam === 'all'
      ? ['customers', 'products', 'prices', 'invoices', 'transactions']
      : syncTypeParam.split(',').map(t => t.trim())

    console.log('Starting Stripe sync')
    console.log(`Sync types: ${syncTypes.join(', ')}`)

    const results: Record<string, { synced: number; errors: number }> = {}

    // Sync Customers (no account_id - will be manually assigned later)
    if (syncTypes.includes('customers')) {
      console.log('Syncing customers...')
      results.customers = await syncCustomers()
    }

    // Sync Products (no account_id - shared catalog)
    if (syncTypes.includes('products')) {
      console.log('Syncing products...')
      results.products = await syncProducts()
    }

    // Sync Prices (depends on products)
    if (syncTypes.includes('prices')) {
      console.log('Syncing prices...')
      results.prices = await syncPrices()
    }

    // Sync Invoices (linked to stripe_customer)
    if (syncTypes.includes('invoices')) {
      console.log('Syncing invoices...')
      results.invoices = await syncInvoices()
    }

    // Sync Payment Intents (Transactions with email auto-linking)
    if (syncTypes.includes('transactions')) {
      console.log('Syncing transactions...')
      results.transactions = await syncTransactions()
    }

    console.log('Sync complete:', results)

    return new Response(
      JSON.stringify({
        success: true,
        results
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error during sync:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// ============================================================================
// SYNC FUNCTIONS
// ============================================================================

async function syncCustomers(): Promise<{ synced: number; errors: number }> {
  let synced = 0
  let errors = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const customers = await stripe.customers.list({
      limit: 100,
      starting_after: startingAfter,
    })

    for (const customer of customers.data) {
      try {
        // Customers have nullable account_id (for manual assignment)
        const { error } = await supabase
          .from('payments_stripe_customers')
          .upsert({
            stripe_customer_id: customer.id,
            account_id: null, // Manual assignment
            email: customer.email || '',
            name: customer.name || null,
            description: customer.description || null,
            phone: customer.phone || null,
            currency: customer.currency || 'usd',
            balance: customer.balance || 0,
            metadata: customer.metadata || {},
            is_active: !customer.deleted,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stripe_customer_id'
          })

        if (error) {
          console.error(`Error syncing customer ${customer.id}:`, error)
          errors++
        } else {
          synced++
        }
      } catch (err) {
        console.error(`Error syncing customer ${customer.id}:`, err)
        errors++
      }
    }

    hasMore = customers.has_more
    if (hasMore && customers.data.length > 0) {
      startingAfter = customers.data[customers.data.length - 1].id
    }
  }

  return { synced, errors }
}

async function syncProducts(): Promise<{ synced: number; errors: number }> {
  let synced = 0
  let errors = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const products = await stripe.products.list({
      limit: 100,
      starting_after: startingAfter,
    })

    for (const product of products.data) {
      try {
        // Products have no account_id (shared catalog per database)
        const { error } = await supabase
          .from('payments_stripe_products')
          .upsert({
            stripe_product_id: product.id,
            account_id: null, // Shared catalog, not account-based
            name: product.name,
            description: product.description || null,
            active: product.active,
            default_price_id: typeof product.default_price === 'string' ? product.default_price : null,
            images: product.images || [],
            metadata: product.metadata || {},
            unit_label: product.unit_label || null,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stripe_product_id'
          })

        if (error) {
          console.error(`Error syncing product ${product.id}:`, error)
          errors++
        } else {
          synced++
        }
      } catch (err) {
        console.error(`Error syncing product ${product.id}:`, err)
        errors++
      }
    }

    hasMore = products.has_more
    if (hasMore && products.data.length > 0) {
      startingAfter = products.data[products.data.length - 1].id
    }
  }

  return { synced, errors }
}

async function syncPrices(): Promise<{ synced: number; errors: number }> {
  let synced = 0
  let errors = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const prices = await stripe.prices.list({
      limit: 100,
      starting_after: startingAfter,
    })

    for (const price of prices.data) {
      try {
        // Find the product_id from our database
        const { data: product } = await supabase
          .from('payments_stripe_products')
          .select('id')
          .eq('stripe_product_id', typeof price.product === 'string' ? price.product : price.product.id)
          .single()

        // Prices have no account_id (shared catalog per database)
        const { error } = await supabase
          .from('payments_stripe_prices')
          .upsert({
            stripe_price_id: price.id,
            account_id: null, // Shared catalog, not account-based
            product_id: product?.id || null,
            stripe_product_id: typeof price.product === 'string' ? price.product : price.product.id,
            active: price.active,
            currency: price.currency,
            unit_amount: price.unit_amount || null,
            recurring_interval: price.recurring?.interval || null,
            recurring_interval_count: price.recurring?.interval_count || null,
            type: price.type,
            billing_scheme: price.billing_scheme || 'per_unit',
            metadata: price.metadata || {},
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stripe_price_id'
          })

        if (error) {
          console.error(`Error syncing price ${price.id}:`, error)
          errors++
        } else {
          synced++
        }
      } catch (err) {
        console.error(`Error syncing price ${price.id}:`, err)
        errors++
      }
    }

    hasMore = prices.has_more
    if (hasMore && prices.data.length > 0) {
      startingAfter = prices.data[prices.data.length - 1].id
    }
  }

  return { synced, errors }
}

async function syncInvoices(): Promise<{ synced: number; errors: number }> {
  let synced = 0
  let errors = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const invoices = await stripe.invoices.list({
      limit: 100,
      starting_after: startingAfter,
    })

    for (const invoice of invoices.data) {
      try {
        // Find customer_id from our database
        const { data: customer } = await supabase
          .from('payments_stripe_customers')
          .select('id')
          .eq('stripe_customer_id', typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id)
          .single()

        // Invoices are linked to stripe_customer
        const { error } = await supabase
          .from('payments_stripe_invoices')
          .upsert({
            stripe_invoice_id: invoice.id,
            account_id: null, // Not account-based
            customer_id: customer?.id || null,
            stripe_customer_id: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || '',
            invoice_number: invoice.number || null,
            status: invoice.status || 'draft',
            currency: invoice.currency,
            amount_due: invoice.amount_due,
            amount_paid: invoice.amount_paid,
            amount_remaining: invoice.amount_remaining,
            subtotal: invoice.subtotal,
            total: invoice.total,
            tax: invoice.tax || 0,
            discount_amount: invoice.total_discount_amounts?.reduce((sum, d) => sum + d.amount, 0) || 0,
            description: invoice.description || null,
            hosted_invoice_url: invoice.hosted_invoice_url || null,
            invoice_pdf: invoice.invoice_pdf || null,
            billing_reason: invoice.billing_reason || null,
            due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
            paid_at: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null,
            period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
            period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
            metadata: invoice.metadata || {},
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stripe_invoice_id'
          })

        if (error) {
          console.error(`Error syncing invoice ${invoice.id}:`, error)
          errors++
        } else {
          synced++
        }
      } catch (err) {
        console.error(`Error syncing invoice ${invoice.id}:`, err)
        errors++
      }
    }

    hasMore = invoices.has_more
    if (hasMore && invoices.data.length > 0) {
      startingAfter = invoices.data[invoices.data.length - 1].id
    }
  }

  return { synced, errors }
}

async function syncTransactions(): Promise<{ synced: number; errors: number }> {
  let synced = 0
  let errors = 0
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const paymentIntents = await stripe.paymentIntents.list({
      limit: 100,
      starting_after: startingAfter,
    })

    for (const paymentIntent of paymentIntents.data) {
      try {
        // Extract email from payment intent for auto-linking
        const email = paymentIntent.receipt_email ||
                     (paymentIntent.charges?.data?.[0]?.billing_details?.email) ||
                     null

        // Find customer_id and invoice_id from our database
        const customerPromise = paymentIntent.customer
          ? supabase
              .from('payments_stripe_customers')
              .select('id')
              .eq('stripe_customer_id', typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer.id)
              .single()
          : Promise.resolve({ data: null })

        const invoicePromise = paymentIntent.invoice
          ? supabase
              .from('payments_stripe_invoices')
              .select('id')
              .eq('stripe_invoice_id', typeof paymentIntent.invoice === 'string' ? paymentIntent.invoice : paymentIntent.invoice.id)
              .single()
          : Promise.resolve({ data: null })

        // Auto-link to account via email matching
        const accountPromise = email
          ? supabase
              .from('accounts')
              .select('id')
              .eq('contact_email', email)
              .single()
          : Promise.resolve({ data: null })

        const [{ data: customer }, { data: invoice }, { data: account }] = await Promise.all([
          customerPromise,
          invoicePromise,
          accountPromise
        ])

        // Transactions with email auto-linking
        const { error } = await supabase
          .from('payments_stripe_transactions')
          .upsert({
            stripe_payment_intent_id: paymentIntent.id,
            email: email, // For auto-linking to accounts
            account_id: account?.id || null, // Auto-linked if email matches
            customer_id: customer?.id || null,
            invoice_id: invoice?.id || null,
            stripe_customer_id: typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer?.id || null,
            stripe_invoice_id: typeof paymentIntent.invoice === 'string' ? paymentIntent.invoice : paymentIntent.invoice?.id || null,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            status: paymentIntent.status,
            payment_method_type: paymentIntent.payment_method_types?.[0] || null,
            description: paymentIntent.description || null,
            receipt_email: paymentIntent.receipt_email || null,
            metadata: paymentIntent.metadata || {},
            error_message: paymentIntent.last_payment_error?.message || null,
            succeeded_at: paymentIntent.status === 'succeeded' && paymentIntent.created
              ? new Date(paymentIntent.created * 1000).toISOString()
              : null,
            canceled_at: paymentIntent.canceled_at ? new Date(paymentIntent.canceled_at * 1000).toISOString() : null,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'stripe_payment_intent_id'
          })

        if (error) {
          console.error(`Error syncing payment intent ${paymentIntent.id}:`, error)
          errors++
        } else {
          synced++
          if (account && email) {
            console.log(`Auto-linked payment intent ${paymentIntent.id} to account via email: ${email}`)
          }
        }
      } catch (err) {
        console.error(`Error syncing payment intent ${paymentIntent.id}:`, err)
        errors++
      }
    }

    hasMore = paymentIntents.has_more
    if (hasMore && paymentIntents.data.length > 0) {
      startingAfter = paymentIntents.data[paymentIntents.data.length - 1].id
    }
  }

  return { synced, errors }
}

