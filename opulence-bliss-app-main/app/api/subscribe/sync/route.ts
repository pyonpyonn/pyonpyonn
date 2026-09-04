// SETUP: mkdir -p "app/api/subscribe/sync" && code "app/api/subscribe/sync/route.ts"
//
// Repair / diagnostic: pull the signed-in user's subscription straight from
// Stripe and make sure it exists locally.
//
// Visit in your browser while logged in:  localhost:3000/api/subscribe/sync

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { invoicePeriod, upsertSubscription } from "@/lib/subscriptions";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function GET() {
  try {
    const ssr = await createServerClient();
    const {
      data: { user },
    } = await ssr.auth.getUser();

    if (!user?.email) {
      return NextResponse.json(
        { ok: false, error: "Log in first, then reload this page." },
        { status: 401 }
      );
    }

    // Find their Stripe customer by email
    const customers = await stripe.customers.list({
      email: user.email,
      limit: 5,
    });

    if (customers.data.length === 0) {
      return NextResponse.json({
        ok: false,
        checked_email: user.email,
        error:
          "No Stripe customer with that email. Has a subscription payment gone through?",
      });
    }

    // Newest subscription across those customers
    let newest: Stripe.Subscription | null = null;
    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: c.id,
        status: "all",
        limit: 5,
      });
      for (const s of subs.data) {
        if (!newest || s.created > newest.created) newest = s;
      }
    }

    if (!newest) {
      return NextResponse.json({
        ok: false,
        checked_email: user.email,
        error: "Found the customer but no subscriptions.",
      });
    }

    // Most recent paid invoice for it, so we can log the payment
    const invoices = await stripe.invoices.list({
      subscription: newest.id,
      status: "paid",
      limit: 1,
    });
    const inv = invoices.data[0];

    const result = await upsertSubscription(
      newest,
      inv
        ? {
            amountPence: inv.amount_paid ?? 0,
            ref: String(
              (inv as { payment_intent?: string }).payment_intent ?? inv.id
            ),
            ...invoicePeriod(inv),
          }
        : undefined
    );

    return NextResponse.json({
      ok: true,
      stripe_subscription: newest.id,
      stripe_status: newest.status,
      metadata: newest.metadata,
      local_subscription_id: result.id,
      payment_recorded: result.recorded,
      visits_created: result.created,
      next: "Now reload /account/membership",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sync failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
