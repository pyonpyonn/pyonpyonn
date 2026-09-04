// Provider joining fee — payment confirmation.
// Save at: app/worker/join/success/page.tsx

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function JoinSuccess({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;

  let ok = false;
  let amount = 0;

  if (session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const providerId = session.metadata?.provider_id;
      amount = session.amount_total ?? 0;

      if (session.payment_status === "paid" && providerId) {
        await admin
          .from("providers")
          .update({
            joining_fee_paid: true,
            joining_fee_ref: String(session.payment_intent ?? session.id),
            joining_fee_at: new Date().toISOString(),
          })
          .eq("id", providerId);
        ok = true;
      }
    } catch {
      ok = false;
    }
  }

  return (
    <main
      style={{
        minHeight: "80vh",
        background: "#fbf7f0",
        color: "#26302a",
        fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Hanken+Grotesk:wght@400;600&display=swap"
      />
      <div
        style={{
          background: "#fff",
          border: "1px solid #ece5d8",
          borderRadius: 18,
          padding: "38px 34px",
          maxWidth: 440,
          textAlign: "center",
        }}
      >
        <p
          style={{
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            fontSize: 12,
            fontWeight: 600,
            color: "#cf854f",
            margin: "0 0 8px",
          }}
        >
          Provider registration
        </p>
        <h1
          style={{
            fontFamily: "'Fraunces', serif",
            fontWeight: 500,
            fontSize: 28,
            color: "#2f4a3a",
            margin: "0 0 8px",
          }}
        >
          {ok ? "You're active" : "Couldn't confirm payment"}
        </h1>
        <p style={{ color: "#6e7a70", margin: "0 0 24px" }}>
          {ok
            ? `Joining fee of £${(amount / 100).toFixed(
                2
              )} received. You can now accept jobs.`
            : "Check the Stripe test dashboard, or try again from your dashboard."}
        </p>
        <a
          href="/worker"
          style={{
            display: "inline-block",
            background: "#2f4a3a",
            color: "#fbf7f0",
            padding: "12px 26px",
            borderRadius: 999,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Go to my jobs
        </a>
      </div>
    </main>
  );
}