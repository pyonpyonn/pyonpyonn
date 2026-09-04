 // Provider joining fee — one-off £150 to the platform.
// Save at: app/api/provider-join/route.ts

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ---- The one-off joining fee. Change here if the client's figure differs. ----
const JOINING_FEE = 15000; // £150.00 in pence
// -----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Please log in first." }, { status: 401 });
    }

    const { data: prov } = await supabase
      .from("providers")
      .select("id, joining_fee_paid")
      .eq("profile_id", user.id)
      .maybeSingle();

    if (!prov) {
      return NextResponse.json(
        { error: "This account isn't set up as a provider." },
        { status: 400 }
      );
    }

    if (prov.joining_fee_paid) {
      return NextResponse.json({ alreadyPaid: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email ?? undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: JOINING_FEE,
            product_data: {
              name: "Opulence Bliss — provider joining fee",
              description: "One-off registration fee. Paid once, not recurring.",
            },
          },
        },
      ],
      // Straight to the platform — no split on this one.
      metadata: { provider_id: prov.id, kind: "provider_joining_fee" },
      success_url: `${req.nextUrl.origin}/worker/join/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.nextUrl.origin}/worker`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not start payment";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}