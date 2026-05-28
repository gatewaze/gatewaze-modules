import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.11.0?target=deno'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')!
const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')

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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
}

/**
 * Stripe Webhook Handler
 * Syncs data from Stripe to Supabase tables
 *
 * NEW DATA MODEL:
 * - Products/Prices: No account_id (shared catalog per database)
 * - Stripe Customers: Nullable account_id (for manual assignment)
 * - Invoices: Linked to stripe_customer
 * - Transactions: Have email for auto-linking to accounts
 *
 * Note: Each brand has its own Supabase database
 *
 * Supported webhook events:
 * - customer.created, customer.updated, customer.deleted
 * - product.created, product.updated, product.deleted
 * - price.created, price.updated, price.deleted
 * - invoice.created, invoice.updated, invoice.finalized, invoice.paid
 * - payment_intent.succeeded, payment_intent.payment_failed, payment_intent.created
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
    const body = await req.text()
    const signature = req.headers.get('stripe-signature')

    // Verify webhook signature
    let event: Stripe.Event
    if (stripeWebhookSecret && signature) {
      try {
        event = await stripe.webhooks.constructEventAsync(
          body,
          signature,
          stripeWebhookSecret
        )
      } catch (err) {
        console.error('Webhook signature verification failed:', err)
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    } else {
      // If no webhook secret is configured, parse the body directly (not recommended for production)
      event = JSON.parse(body)
    }

    console.log('Processing Stripe webhook:', event.type, event.id)

    // Route to appropriate handler based on event type
    switch (event.type) {
      // Customer events
      case 'customer.created':
      case 'customer.updated':
        await handleCustomer(event.data.object as Stripe.Customer)
        break
      case 'customer.deleted':
        await handleCustomerDeleted(event.data.object as Stripe.Customer)
        break

      // Product events
      case 'product.created':
      case 'product.updated':
        await handleProduct(event.data.object as Stripe.Product)
        break
      case 'product.deleted':
        await handleProductDeleted(event.data.object as Stripe.Product)
        break

      // Price events
      case 'price.created':
      case 'price.updated':
        await handlePrice(event.data.object as Stripe.Price)
        break
      case 'price.deleted':
        await handlePriceDeleted(event.data.object as Stripe.Price)
        break

      // Invoice events
      case 'invoice.created':
      case 'invoice.updated':
      case 'invoice.finalized':
      case 'invoice.paid':
        await handleInvoice(event.data.object as Stripe.Invoice)
        break

      // Payment Intent events
      case 'payment_intent.created':
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        await handlePaymentIntent(event.data.object as Stripe.PaymentIntent)
        break

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(
      JSON.stringify({ received: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error processing webhook:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

// ============================================================================
// HANDLER FUNCTIONS
// ============================================================================

async function handleCustomer(customer: Stripe.Customer) {
  // Customers have nullable account_id (for manual assignment later)
  // No metadata required
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
    console.error('Error upserting customer:', error)
    throw error
  }

  console.log(`Customer ${customer.id} synced successfully`)
}

async function handleCustomerDeleted(customer: Stripe.Customer) {
  const { error } = await supabase
    .from('payments_stripe_customers')
    .update({ is_active: false })
    .eq('stripe_customer_id', customer.id)

  if (error) {
    console.error('Error deleting customer:', error)
    throw error
  }

  console.log(`Customer ${customer.id} marked as inactive`)
}

async function handleProduct(product: Stripe.Product) {
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
    console.error('Error upserting product:', error)
    throw error
  }

  console.log(`Product ${product.id} synced successfully`)
}

async function handleProductDeleted(product: Stripe.Product) {
  const { error } = await supabase
    .from('payments_stripe_products')
    .update({ active: false })
    .eq('stripe_product_id', product.id)

  if (error) {
    console.error('Error deleting product:', error)
    throw error
  }

  console.log(`Product ${product.id} marked as inactive`)
}

async function handlePrice(price: Stripe.Price) {
  // Prices have no account_id (shared catalog per database)
  // Find the product_id from our database
  const { data: product } = await supabase
    .from('payments_stripe_products')
    .select('id')
    .eq('stripe_product_id', typeof price.product === 'string' ? price.product : price.product.id)
    .single()

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
    console.error('Error upserting price:', error)
    throw error
  }

  console.log(`Price ${price.id} synced successfully`)
}

async function handlePriceDeleted(price: Stripe.Price) {
  const { error } = await supabase
    .from('payments_stripe_prices')
    .update({ active: false })
    .eq('stripe_price_id', price.id)

  if (error) {
    console.error('Error deleting price:', error)
    throw error
  }

  console.log(`Price ${price.id} marked as inactive`)
}

async function handleInvoice(invoice: Stripe.Invoice) {
  // Invoices are linked to stripe_customer
  // Find customer_id from our database
  const { data: customer } = await supabase
    .from('payments_stripe_customers')
    .select('id')
    .eq('stripe_customer_id', typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id)
    .single()

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
    console.error('Error upserting invoice:', error)
    throw error
  }

  console.log(`Invoice ${invoice.id} synced successfully`)
}

async function handlePaymentIntent(paymentIntent: Stripe.PaymentIntent) {
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
    console.error('Error upserting payment intent:', error)
    throw error
  }

  if (account && email) {
    console.log(`PaymentIntent ${paymentIntent.id} synced and auto-linked to account via email: ${email}`)
  } else {
    console.log(`PaymentIntent ${paymentIntent.id} synced successfully`)
  }
}
