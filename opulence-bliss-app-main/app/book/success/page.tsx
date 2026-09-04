import Stripe from "stripe";

export const dynamic = "force-dynamic";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const gbp = (pence: number) => "£" + (pence / 100).toFixed(2);

export default async function Success({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; saved?: string; error?: string }>;
}) {
  const { session_id, saved, error } = await searchParams;
  let total = 0;
  let platform = 0;
  let provider = 0;
  let name = "";
  let ok = false;
  if (session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ["payment_intent"] });
      const pi = session.payment_intent as Stripe.PaymentIntent;
      ok = pi.status === "requires_capture" || pi.status === "succeeded";
      total = pi.amount;
      platform = pi.application_fee_amount ?? 0;
      provider = total - platform;
      name = pi.metadata?.package ?? "";
    } catch {
      ok = false;
    }
  }
  const persisted = saved === "1";
  return (
    <main style={{ minHeight: "100vh", background: "#FFFFFF", color: "#16202A", fontFamily: "'Nunito', system-ui, sans-serif", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ background: "#fff", border: "1px solid #EDEFF1", borderRadius: 18, padding: "40px 36px", maxWidth: 460, width: "100%" }}>
        <p style={{ textTransform: "uppercase", letterSpacing: "0.14em", fontSize: 12, fontWeight: 600, color: "#6D28D9", margin: "0 0 8px" }}>{ok ? "Payment authorised" : "Payment status"}</p>
        <h1 style={{ fontWeight: 900, fontSize: 30, margin: "0 0 6px" }}>{ok && persisted ? "You're booked" : "Couldn't confirm the booking"}</h1>
        <p style={{ color: "#7A828C", margin: "0 0 24px" }}>
          {ok && persisted
            ? `${name} — your card is held, not charged. You'll only be charged once the visit is complete.`
            : error === "finalize_failed"
              ? "Your payment was authorised, but saving the booking needs attention. Please contact support and do not pay again."
              : "We couldn't confirm the payment. Please check your account before trying again."}
        </p>
        {ok && <dl style={{ margin: 0 }}>{[["Total", gbp(total)], ["Provider will receive", gbp(provider)], ["Platform keeps (margin)", gbp(platform)]].map(([key, value]) => <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid #F1F2F4" }}><dt style={{ color: "#7A828C", fontSize: 14 }}>{key}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd></div>)}</dl>}
        <a href="/account" style={{ display: "inline-block", marginTop: 24, color: "#6D28D9", fontSize: 14 }}>View my bookings →</a>
      </div>
    </main>
  );
}
