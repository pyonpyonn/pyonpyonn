// Stripe Connect checkout — creates a payment that auto-splits.
// Save at: app/api/checkout/route.ts
// Needs in .env.local: STRIPE_SECRET_KEY, PROVIDER_TEST_ACCOUNT,
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import {
  APPOINTMENT_WINDOW_MESSAGE,
  appointmentFitsWindow,
} from "@/lib/appointmentWindow";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Service role — for promo lookups and usage counts.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { packageId, postcode, request, slot, promoCode } = await req.json();
    if (!packageId) {
      return NextResponse.json({ error: "Missing packageId" }, { status: 400 });
    }

    // Get the REAL price from the database — never trust the browser for money.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!
    );
    const { data: pkg, error } = await supabase
      .from("packages")
      .select("name, price, duration_minutes")
      .eq("id", packageId)
      .eq("active", true)
      .single();

    if (error || !pkg) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }
    if (!slot || !appointmentFitsWindow(slot, pkg.duration_minutes ?? 120)) {
      return NextResponse.json(
        { error: APPOINTMENT_WINDOW_MESSAGE },
        { status: 400 },
      );
    }

    const gross = Math.round(Number(pkg.price) * 100); // amount in pence

    // Who's booking? Used to prefill their email on Stripe's checkout.
    const ssr = await createServerClient();
    const {
      data: { user },
    } = await ssr.auth.getUser();

    // ---- PLACEHOLDER split — REPLACE with the client's SIGNED numbers ----
    // Per-visit model: the platform takes a margin, the provider keeps the rest.
    // (No membership fee here — providers pay a one-off £150 joining fee.)
    const PLATFORM_MARGIN_RATE = 0.2; // 20% platform margin
    // ---------------------------------------------------------------------
    const platformFeeFull = Math.round(gross * PLATFORM_MARGIN_RATE);
    const providerAmount = gross - platformFeeFull; // auto-sent to the provider

    // ---- Promo code (validated server-side; discount comes out of margin) ----
    let discount = 0;
    let appliedCode: string | null = null;
    if (promoCode) {
      const clean = String(promoCode).trim().toUpperCase();
      const { data: promo } = await supabaseAdmin
        .from("promo_codes")
        .select("code, percent_off, amount_off, active, expires_at, max_uses, uses")
        .eq("code", clean)
        .maybeSingle();

      const usable =
        promo &&
        promo.active &&
        (!promo.expires_at || new Date(promo.expires_at) >= new Date()) &&
        (promo.max_uses === null || promo.uses < promo.max_uses);

      if (usable) {
        const raw = promo!.percent_off
          ? Math.round((gross * promo!.percent_off) / 100)
          : Math.round(Number(promo!.amount_off ?? 0) * 100);
        discount = Math.max(0, Math.min(raw, platformFeeFull));
        if (discount > 0) {
          appliedCode = promo!.code;
          await supabaseAdmin
            .from("promo_codes")
            .update({ uses: (promo!.uses ?? 0) + 1 })
            .eq("code", promo!.code);
        }
      }
    }

    const chargeAmount = gross - discount;
    const platformFee = platformFeeFull - discount;

    if (platformFee >= gross) {
      return NextResponse.json({ error: "Split misconfigured" }, { status: 500 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user?.email ?? undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: chargeAmount,
            product_data: {
              name: `${pkg.name} — one visit${
                appliedCode ? ` (${appliedCode} applied)` : ""
              }`,
            },
          },
        },
      ],
      payment_intent_data: {
        // Authorise now, capture when the job is completed (like Wecasa).
        capture_method: "manual",
        // This is the split: platform keeps `application_fee_amount`,
        // Stripe transfers the rest to the connected provider account.
        application_fee_amount: platformFee,
        transfer_data: { destination: process.env.PROVIDER_TEST_ACCOUNT! },
        metadata: {
          package: pkg.name,
          package_id: packageId,
          postcode: postcode ?? "",
          request: (request ?? "").slice(0, 480),
          slot: slot ?? "",
          provider_amount: String(providerAmount),
          platform_margin: String(platformFee),
          promo_code: appliedCode ?? "",
          discount: String(discount),
        },
      },
      success_url: `${req.nextUrl.origin}/api/book/finalize?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.nextUrl.origin}/book?canceled=1`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Checkout failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
