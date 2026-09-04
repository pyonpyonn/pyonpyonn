import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id");
  const target = new URL("/account/tip/success", req.nextUrl.origin);
  if (!sessionId) {
    target.searchParams.set("error", "missing_session");
    return NextResponse.redirect(target);
  }

  try {
    const ssr = await createServerClient();
    const { data: { user } } = await ssr.auth.getUser();
    if (!user) return NextResponse.redirect(new URL("/login", req.nextUrl.origin));

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
    const pi = session.payment_intent as Stripe.PaymentIntent;
    const bookingId = pi.metadata?.booking_id;
    if (pi.status !== "succeeded" || !bookingId) throw new Error("Tip is not paid");

    const { data: booking } = await admin
      .from("bookings")
      .select("customer_id, provider_id")
      .eq("id", bookingId)
      .maybeSingle();
    if (!booking || booking.customer_id !== user.id) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const { data: existing } = await admin
      .from("payments")
      .select("id")
      .eq("stripe_payment_ref", pi.id)
      .maybeSingle();
    if (!existing) {
      const { error } = await admin.from("payments").insert({
        booking_id: bookingId,
        kind: "tip",
        gross_amount: pi.amount / 100,
        split_breakdown: { provider: pi.amount / 100 },
        stripe_payment_ref: pi.id,
        status: "succeeded",
      });
      if (error) throw error;

      if (booking.provider_id) {
        const { data: provider } = await admin
          .from("providers")
          .select("profile_id")
          .eq("id", booking.provider_id)
          .maybeSingle();
        if (provider?.profile_id) {
          await admin.from("notifications").insert({
            user_id: provider.profile_id,
            title: `You received a £${(pi.amount / 100).toFixed(2)} tip`,
            body: "A client added a tip for your work. It's all yours.",
            href: "/worker/earnings",
          });
        }
      }
    }

    target.searchParams.set("session_id", sessionId);
    target.searchParams.set("saved", "1");
    return NextResponse.redirect(target);
  } catch (error) {
    console.error("Tip finalisation failed:", error);
    target.searchParams.set("session_id", sessionId);
    target.searchParams.set("error", "finalize_failed");
    return NextResponse.redirect(target);
  }
}
