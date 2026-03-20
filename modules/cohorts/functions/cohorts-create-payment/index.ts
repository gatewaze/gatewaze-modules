import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { cohortTitle, cohortId, startDate, endDate, instructorName, attendeeInfo, amount, stripeMode } = await req.json();

    // Initialize Supabase client with service role key to bypass RLS
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Determine which Stripe key to use based on the cohort's stripe_mode setting
    // stripeMode is passed from the frontend (fetched from cohort record)
    // Defaults to 'test' for safety if not specified
    const useTestMode = stripeMode !== 'live';
    const stripeKey = useTestMode
      ? (Deno.env.get("STRIPE_TEST_SECRET_KEY") || Deno.env.get("STRIPE_SECRET_KEY") || "")
      : (Deno.env.get("STRIPE_LIVE_SECRET_KEY") || Deno.env.get("STRIPE_SECRET_KEY") || "");

    console.log("Creating cohort payment for:", {
      cohortTitle,
      cohortId,
      instructor: instructorName,
      attendee: attendeeInfo.email,
      amount,
      stripeMode: useTestMode ? "TEST" : "LIVE"
    });

    // Initialize Stripe with the appropriate key
    const stripe = new Stripe(stripeKey, {
      apiVersion: "2023-10-16",
    });

    // Look up or create person in our database
    let supabasePersonId: number | null = null;

    // First check if person exists by email
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id')
      .eq('email', attendeeInfo.email)
      .single();

    if (existingPerson) {
      supabasePersonId = existingPerson.id;
      console.log("Found existing Supabase person:", supabasePersonId);

      // Check for existing enrollment for this cohort
      const { data: existingEnrollment, error: enrollmentCheckError } = await supabase
        .from('cohorts_enrollments')
        .select('id, payment_status, stripe_session_id')
        .eq('cohort_id', cohortId)
        .eq('person_id', supabasePersonId)
        .single();

      if (existingEnrollment && !enrollmentCheckError) {
        if (existingEnrollment.payment_status === 'completed') {
          // Already enrolled and paid
          console.log("Person already enrolled in this cohort:", existingEnrollment.id);
          return new Response(JSON.stringify({
            error: 'You are already enrolled in this cohort.',
            alreadyEnrolled: true
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
          });
        } else if (existingEnrollment.payment_status === 'pending') {
          // Has a pending enrollment - we'll update it with a new Stripe session below
          console.log("Found pending enrollment, will create new checkout session:", existingEnrollment.id);
        }
      }
    } else {
      // Create new person in our database
      const { data: newPerson, error: personError } = await supabase
        .from('people')
        .insert({
          email: attendeeInfo.email,
          attributes: {
            first_name: attendeeInfo.name?.split(' ')[0] || '',
            last_name: attendeeInfo.name?.split(' ').slice(1).join(' ') || '',
            company: attendeeInfo.company || '',
            phone: attendeeInfo.phone || '',
          }
        })
        .select('id')
        .single();

      if (personError) {
        console.error("Error creating person:", personError);
      } else {
        supabasePersonId = newPerson.id;
        console.log("Created new Supabase person:", supabasePersonId);
      }
    }

    // Check if Stripe customer already exists
    const customers = await stripe.customers.list({
      email: attendeeInfo.email,
      limit: 1
    });

    let stripeCustomerId;
    if (customers.data.length > 0) {
      stripeCustomerId = customers.data[0].id;
      console.log("Found existing Stripe customer:", stripeCustomerId);
    } else {
      // Create new Stripe customer
      const customer = await stripe.customers.create({
        email: attendeeInfo.email,
        name: attendeeInfo.name,
        phone: attendeeInfo.phone || undefined,
        metadata: {
          company: attendeeInfo.company || "",
          cohort: cohortTitle,
          cohort_id: cohortId,
          start_date: startDate,
          end_date: endDate,
          instructor: instructorName,
          supabase_person_id: supabasePersonId?.toString() || ""
        }
      });
      stripeCustomerId = customer.id;
      console.log("Created new Stripe customer:", stripeCustomerId);
    }

    // Create checkout session for one-time payment
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${cohortTitle} - Cohort Enrollment`,
              description: `Enrollment for ${cohortTitle} cohort with ${instructorName}, starting ${startDate}`,
            },
            unit_amount: amount, // Amount in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment", // One-time payment
      success_url: `${req.headers.get("origin")}/cohort-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.get("origin")}/cohort/${cohortId}`,
      metadata: {
        cohort_id: cohortId,
        supabase_person_id: supabasePersonId?.toString() || "",
        attendee_email: attendeeInfo.email,
      }
    });

    console.log("Created checkout session:", session.id);

    // Store or update enrollment information in Supabase
    if (supabasePersonId) {
      // Check if there's an existing pending enrollment to update
      const { data: existingPendingEnrollment } = await supabase
        .from('cohorts_enrollments')
        .select('id')
        .eq('cohort_id', cohortId)
        .eq('person_id', supabasePersonId)
        .eq('payment_status', 'pending')
        .single();

      if (existingPendingEnrollment) {
        // Update existing pending enrollment with new Stripe session
        const { data: enrollmentData, error: enrollmentError } = await supabase
          .from('cohorts_enrollments')
          .update({
            amount_cents: amount,
            stripe_session_id: session.id,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingPendingEnrollment.id)
          .select()
          .single();

        if (enrollmentError) {
          console.error("Error updating enrollment:", enrollmentError);
        } else {
          console.log("Updated existing enrollment:", enrollmentData);
        }
      } else {
        // Create new enrollment
        const { data: enrollmentData, error: enrollmentError } = await supabase
          .from('cohorts_enrollments')
          .insert({
            cohort_id: cohortId,
            person_id: supabasePersonId,
            amount_cents: amount,
            stripe_session_id: session.id,
            payment_status: 'pending'
          })
          .select()
          .single();

        if (enrollmentError) {
          console.error("Error storing enrollment:", enrollmentError);
          // Continue with payment flow even if database storage fails
        } else {
          console.log("Stored new enrollment data:", enrollmentData);
        }
      }
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Cohort payment error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
