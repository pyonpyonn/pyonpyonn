// Tip a provider after a completed visit. 100% goes to them.
// Save at: app/api/tip/route.ts

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { bookingId, amount } = await req.json();
    const pence = Math.round(Number(amount) * 100);

    if (!bookingId || !pence || pence < 100) {
      return NextResponse.json(
        { error: "Choose a tip of at least £1." },
        { status: 400 }
      );
    }

    const ssr = await createServerClient();
    const {
      data: { user },
    } = await ssr.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Please log in." }, { status: 401 });
    }

    // The booking must be the customer's, and completed.
    const { data: booking } = await admin
      .from("bookings")
      .select("id, customer_id, provider_id, status")
      .eq("id", bookingId)
      .maybeSingle();

    if (!booking || booking.customer_id !== user.id) {
      return NextResponse.json({ error: "Booking not found." }, { status: 404 });
    }
    if (booking.status !== "completed") {
      return NextResponse.json(
        { error: "You can tip once the visit is complete." },
        { status: 400 }
      );
    }
    if (!booking.provider_id) {
      return NextResponse.json(
        { error: "No provider on this booking." },
        { status: 400 }
      );
    }

    const { data: prov } = await admin
      .from("providers")
      .select("stripe_account_id")
      .eq("id", booking.provider_id)
      .maybeSingle();

    const destination =
      prov?.stripe_account_id ?? process.env.PROVIDER_TEST_ACCOUNT!;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email ?? undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: pence,
            product_data: {
              name: "Tip for your provider",
              description: "Goes entirely to the person who did the work.",
            },
          },
        },
      ],
      payment_intent_data: {
        // No application fee — the provider gets all of it.
        transfer_data: { destination },
        metadata: { kind: "tip", booking_id: bookingId },
      },
      success_url: `${req.nextUrl.origin}/api/tip/finalize?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.nextUrl.origin}/account`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't start the tip";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
