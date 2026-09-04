// SETUP: mkdir -p "app/api/stripe/webhook" && code "app/api/stripe/webhook/route.ts"
//
// Stripe webhook — the source of truth for subscription money.
//
// Local testing (needs the Stripe CLI, running in its own terminal):
//   stripe login
//   stripe listen --forward-to localhost:3000/api/stripe/webhook
// Copy the whsec_... it prints into .env.local as STRIPE_WEBHOOK_SECRET.

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import {
  upsertSubscription,
  subscriptionIdFromInvoice,
  invoicePeriod,
} from "@/lib/subscriptions";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();

  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Not configured" }, { status: 400 });
  }
  if (!sig) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (e) {
    console.error("Bad webhook signature:", e);
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }

  console.log("Stripe webhook:", event.type);

  try {
    // ---- Subscription just started (fires right after Checkout) ----
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.mode === "subscription" && session.subscription) {
        const subId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;

        const stripeSub = await stripe.subscriptions.retrieve(subId);
        const invoiceId =
          typeof session.invoice === "string"
            ? session.invoice
            : session.invoice?.id;
        const invoice = invoiceId
          ? await stripe.invoices.retrieve(invoiceId)
          : null;
        const result = await upsertSubscription(stripeSub, {
          amountPence: invoice?.amount_paid ?? session.amount_total ?? 0,
          ref: String(
            (invoice as (Stripe.Invoice & { payment_intent?: string }) | null)
              ?.payment_intent ?? invoice?.id ?? session.id
          ),
          ...(invoice ? invoicePeriod(invoice) : {}),
        });
        console.log("Subscription set up:", result);
      }
    }

    // ---- Later billing cycles ----
    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = subscriptionIdFromInvoice(invoice);

      if (!subId) {
        console.log("invoice.paid with no subscription — ignoring");
        return NextResponse.json({ received: true });
      }

      const stripeSub = await stripe.subscriptions.retrieve(subId);
      const result = await upsertSubscription(stripeSub, {
        amountPence: invoice.amount_paid ?? 0,
        ref: String(
          (invoice as { payment_intent?: string }).payment_intent ?? invoice.id
        ),
        ...invoicePeriod(invoice),
      });
      console.log("Subscription cycle billed:", result);
    }

    // ---- Payment failed ----
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = subscriptionIdFromInvoice(invoice);
      if (subId) {
        await admin
          .from("subscriptions")
          .update({ status: "past_due" })
          .eq("stripe_subscription_id", subId);
      }
    }

    // ---- Cancelled ----
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      await admin
        .from("subscriptions")
        .update({ status: "cancelled" })
        .eq("stripe_subscription_id", sub.id);
    }

    return NextResponse.json({ received: true });
  } catch (e) {
    console.error("Webhook handling failed:", e);
    // 200 so Stripe doesn't retry forever on a bug in our code.
    return NextResponse.json({ received: true, error: true });
  }
}
