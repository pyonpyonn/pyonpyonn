// SETUP: mkdir -p "app/api/subscribe" && code "app/api/subscribe/route.ts"
//
// Start a 3-month recurring subscription (monthly billing).
// Payment collects to the PLATFORM, because one payment has to split several
// ways — cleaner, therapist, margin and membership fee. Providers are paid by
// transfer as each visit is completed.

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import {
  APPOINTMENT_WINDOW_MESSAGE,
  appointmentFitsWindow,
} from "@/lib/appointmentWindow";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CONTRACT_MONTHS = 3;

export async function POST(req: NextRequest) {
  try {
    const { packageId, postcode, slot } = await req.json();

    const ssr = await createServerClient();
    const {
      data: { user },
    } = await ssr.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { error: "Please log in to subscribe." },
        { status: 401 }
      );
    }

    const { data: pkg } = await admin
      .from("packages")
      .select(
        "id, name, price, billing_type, visits_per_month, duration_minutes",
      )
      .eq("id", packageId ?? "")
      .eq("active", true)
      .maybeSingle();

    if (!pkg || pkg.billing_type !== "monthly") {
      return NextResponse.json(
        { error: "That isn't a monthly plan." },
        { status: 400 }
      );
    }
    if (!postcode) {
      return NextResponse.json(
        { error: "We need your postcode." },
        { status: 400 }
      );
    }

    // First visit sets the recurring day and time.
    const first = slot ? new Date(slot) : null;
    if (!first || !appointmentFitsWindow(first, pkg.duration_minutes ?? 120)) {
      return NextResponse.json(
        { error: APPOINTMENT_WINDOW_MESSAGE },
        { status: 400 },
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email ?? undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(Number(pkg.price) * 100),
            recurring: { interval: "month" },
            product_data: {
              name: `${pkg.name} — monthly membership`,
              description: `${CONTRACT_MONTHS}-month minimum term. ${
                pkg.visits_per_month ?? 2
              } visits a month.`,
            },
          },
        },
      ],
      subscription_data: {
        metadata: {
          customer_id: user.id,
          package_id: pkg.id,
          postcode: String(postcode),
          first_slot: first ? first.toISOString() : "",
          weekday: first ? String(first.getDay()) : "",
          hour: first ? String(first.getHours()) : "",
          contract_months: String(CONTRACT_MONTHS),
        },
      },
      success_url: `${req.nextUrl.origin}/account?subscribed=1`,
      cancel_url: `${req.nextUrl.origin}/subscribe?canceled=1`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't start subscription";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
