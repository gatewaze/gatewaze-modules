import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

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
    const { eventTitle, eventDate, attendeeInfo, amount } = await req.json();

    console.log("Creating event payment for:", {
      eventTitle,
      eventDate,
      attendee: attendeeInfo.email,
      amount
    });

    // Initialize Stripe with your secret key
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2023-10-16",
    });

    // Check if customer already exists
    const customers = await stripe.customers.list({
      email: attendeeInfo.email,
      limit: 1
    });

    let customerId;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      console.log("Found existing customer:", customerId);
    } else {
      // Create new customer
      const customer = await stripe.customers.create({
        email: attendeeInfo.email,
        name: attendeeInfo.name,
        phone: attendeeInfo.phone || undefined,
        metadata: {
          company: attendeeInfo.company || "",
          event: eventTitle,
          event_date: eventDate
        }
      });
      customerId = customer.id;
      console.log("Created new customer:", customerId);
    }

    // Create checkout session for one-time payment
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${eventTitle} - Event Ticket`,
              description: `Event ticket for ${eventTitle} on ${eventDate}`,
            },
            unit_amount: amount, // Amount in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment", // One-time payment
      success_url: `${req.headers.get("origin")}/event-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.get("origin")}/event-rsvp`,
      metadata: {
        event_title: eventTitle,
        event_date: eventDate,
        attendee_name: attendeeInfo.name,
        attendee_email: attendeeInfo.email,
        attendee_company: attendeeInfo.company || "",
        attendee_phone: attendeeInfo.phone || ""
      }
    });

    console.log("Created checkout session:", session.id);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Event payment error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
