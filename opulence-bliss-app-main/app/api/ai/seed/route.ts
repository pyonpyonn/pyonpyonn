// Build the AI agent's knowledge base.
// Save at: app/api/ai/seed/route.ts
//
// Run once (and again whenever prices or policies change):
//   GET http://localhost:3000/api/ai/seed?key=YOUR_CRON_SECRET
//
// Add to .env.local:  GEMINI_API_KEY=your-key-from-aistudio.google.com

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMS = 768; // matches the vector(768) column

async function embed(text: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIMS,
      }),
    }
  );
  if (!res.ok) throw new Error(`Embedding failed: ${await res.text()}`);
  const json = await res.json();
  return json?.embedding?.values as number[];
}

const DOCS: { title: string; content: string }[] = [
  {
    title: "Where to find things on the site",
    content:
      "Use these pages: /book to see all services in full detail and make a booking. /providers to see our vetted professionals and their ratings. /account for your bookings, to cancel, reschedule, rate a visit or add a tip. /account/profile to save your name, phone, address and default postcode. /notifications for updates on your bookings. /provider/join to sign up as a cleaner or massage therapist. /login to sign in. Providers manage jobs at /worker, hours at /worker/availability, and pay at /worker/earnings.",
  },
  {
    title: "What Opulence Bliss is",
    content:
      "Opulence Bliss is a premium home services marketplace in London. We provide two things: professional home cleaning, and in-home massage therapy delivered by qualified therapists. Every provider is vetted and insured before they can take work. There are two ways to pay: book a single visit and pay for just that visit, or take a monthly membership where your visits are scheduled automatically.",
  },
  {
    title: "Memberships — the monthly plans",
    content:
      "A membership is a monthly plan with a three-month minimum term, billed monthly. Your visits are scheduled automatically at your preferred day and time, so you don't have to book each one. There are four plans: Essential Bliss at £189 a month (2 cleans), Signature Bliss at £329 a month (2 deep cleans plus a monthly massage), Opulence at £599 a month (4 cleans plus 2 massages), and Opulence Elite at £949 a month (4 premium cleans plus 4 massages). You can see them all and sign up at /subscribe.",
  },
  {
    title: "How membership billing works",
    content:
      "Your first payment is taken when you join, and that month's visits are scheduled straight away. You're then billed on the same date each month for a minimum of three months. Each time a payment goes through, the next set of visits is created and offered to providers. You can see your plan, how far through the term you are, your next payment date and every payment taken at /account/membership.",
  },
  {
    title: "Membership vs paying per visit",
    content:
      "Paying per visit suits people who want occasional help with no commitment — you pay only for what you book. A membership suits people who want regular care handled for them: visits scheduled automatically, the same trusted team, and no need to rebook. Memberships have a three-month minimum term; per-visit bookings have no commitment at all.",
  },
  {
    title: "Changing or pausing a membership",
    content:
      "You can modify or cancel any individual visit from /account before it starts. A replacement time must still meet the minimum booking notice and the permitted appointment window. Your card isn't charged for a cancelled visit. To pause your membership or cancel it after the three-month minimum term, contact the Opulence Bliss team and they'll arrange it.",
  },
  {
    title: "How booking works",
    content:
      "Booking takes four steps: choose your service, enter your postcode so we can check we cover you, pick a time from the slots our providers actually have free, then confirm and pay. You must be logged in to book. Bookings need at least two hours' notice. Once you book, matching providers are asked one at a time until somebody accepts, and you'll be notified as soon as one is confirmed.",
  },
  {
    title: "Where we cover",
    content:
      "We currently cover Central London, North London and West London. If your postcode isn't covered, the booking form will tell you at the postcode step and you won't be able to book. We're expanding, so it's worth checking again later.",
  },
  {
    title: "How payment works",
    content:
      "When you book, your card is authorised but NOT charged — we place a hold to secure the booking. You are only charged after the visit is complete, when your provider checks out. If no provider accepts your booking, it is cancelled automatically and the hold is released, so you pay nothing. All card details are handled by Stripe; Opulence Bliss never stores your card number.",
  },
  {
    title: "Cancelling and rescheduling",
    content:
      "You can cancel or modify a visit from My bookings in your account or ask the assistant to prepare a time change. The assistant always shows a confirmation button before changing anything. A new time must meet the minimum notice and permitted appointment window. If you cancel before the visit is complete, the card hold is released; if an eligible paid booking is cancelled, the refund process starts. Every modification keeps its audited history and the customer, provider and admin schedule are updated.",
  },
  {
    title: "Tipping",
    content:
      "Tipping is optional. After a completed visit you can add a tip of £3, £5 or £10 from your account or the rating pop-up. One hundred per cent of any tip goes to the provider who did the work — Opulence Bliss takes no cut of tips at all.",
  },
  {
    title: "Promo codes",
    content:
      "You can enter a promo code on the confirm step before paying, then press Apply to see the discount and your new total. Discounts come out of the Opulence Bliss platform margin, never out of the provider's pay. If a code is invalid, expired or fully redeemed, the form will tell you.",
  },
  {
    title: "Ratings and reviews",
    content:
      "After every completed visit both sides rate each other. Clients rate their provider out of five stars with an optional comment, and provider ratings are shown publicly on our professionals page. Providers also rate the client, and those client ratings are only visible to Opulence Bliss administrators.",
  },
  {
    title: "What happens on the day",
    content:
      "Your provider starts check-in near the service address. The platform checks their location and sends the customer a booking-specific six-digit code; the provider enters that code to begin the visit. The plaintext code is not stored. You can watch progress live in your account, including a timer once work starts. When the provider finishes they check out, which completes the job and captures the authorised payment. Both sides are then asked to rate the visit.",
  },
  {
    title: "How to prepare for a visit",
    content:
      "For cleaning, someone needs to be able to let the cleaner in, and we bring all products and equipment. For massage, you'll need a clear space of roughly two metres by two metres; the therapist brings a professional table and fresh linens. You can add requests such as access instructions, pets, or a preferred massage pressure in the requests box when you book.",
  },
  {
    title: "Becoming a provider",
    content:
      "Cleaners and massage therapists can join at the Work with us page. You sign up with your name, contact details, the services you offer and the areas you cover, then pay a one-off £150 joining fee. That fee is paid once and is not a subscription. Your account is then reviewed by our team, and once approved you start receiving job offers matched to your skills, area and availability.",
  },
  {
    title: "How providers get paid",
    content:
      "Providers see exactly what a job pays before they accept it. Payment is automatic: when the provider checks out of a completed visit, the client's card is charged and the provider's share is transferred to them by Stripe. Opulence Bliss keeps a platform margin from each visit. Tips are paid to the provider in full.",
  },
  {
    title: "Provider availability and offers",
    content:
      "Providers set the days and hours they work, and only those times appear as bookable slots to clients. A matching provider gets the offer first; if they decline or their response time ends, it moves automatically to the next provider. Each provider gets 60 minutes when a visit is at least a week away, 30 minutes when it is three to six days away, and 15 minutes when it is closer. If nobody accepts by two hours before the appointment, the booking is cancelled and the client is not charged.",
  },
  {
    title: "Getting help",
    content:
      "For a booking-specific problem, the assistant can prepare a request to the resolution desk and will submit it only after the customer confirms. A provider no-show can also be reported from the booking after the grace period. Complaints, damage, injury, safeguarding and payment disputes require a person to review the evidence; the assistant never decides fault, refunds or compensation. For immediate danger or a medical emergency call 999. Don't share card details or passwords in chat.",
  },
  {
    title: "What the assistant can do",
    content:
      "The Opulence Bliss assistant answers service, price, membership, coverage, payment, provider and visit questions from the platform knowledge base. For signed-in customers it can read their own booking and payment status, find live availability, prepare a secure booking link, prepare a cancellation, prepare a reschedule and prepare a booking-help request. Cancellation, rescheduling and help requests always require a visible confirmation button. New bookings always finish on the secure Stripe review-and-pay page; the assistant never takes card details or charges invisibly. Providers can ask about their jobs, offers, earnings and availability, but check-in, check-out, accepting, declining and withdrawing stay in the dedicated worker screens.",
  },
  {
    title: "Booking messages and live updates",
    content:
      "Once a provider accepts a booking, the customer and provider can use its private message thread for arrival details, access instructions, delays, pets and other booking-related information. Messages are immutable and the thread closes seven days after the visit. Portal pages listen for booking notifications and refresh automatically, with focus and timed refreshes as a fallback.",
  },
];

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set in .env.local" },
      { status: 500 }
    );
  }

  try {
    // Live prices, so the agent never quotes a stale figure.
    const { data: pkgs } = await admin
      .from("packages")
      .select("name, description, price, duration_minutes, service_type, billing_type, visits_per_month")
      .eq("active", true)
      .order("price");

    const perVisit = (pkgs ?? []).filter((p) => p.billing_type !== "monthly");
    const monthly = (pkgs ?? []).filter((p) => p.billing_type === "monthly");

    const priceDoc = {
      title: "Services and current prices",
      content:
        "Single visits, charged per visit: " +
        perVisit
          .map(
            (p) =>
              `${p.name} — £${Number(p.price).toFixed(0)} per visit${
                p.duration_minutes ? `, ${p.duration_minutes} minutes` : ""
              } (${p.service_type ?? "service"}). ${p.description ?? ""}`
          )
          .join(" ") +
        " Book a single visit at /book. Monthly memberships, billed monthly on a three-month minimum term: " +
        monthly
          .map(
            (p) =>
              `${p.name} — £${Number(p.price).toFixed(0)} a month${
                p.visits_per_month ? `, ${p.visits_per_month} visits a month` : ""
              }. ${p.description ?? ""}`
          )
          .join(" ") +
        " See memberships at /subscribe.",
    };

    const all = [priceDoc, ...DOCS];

    // Rebuild from scratch
    await admin
      .from("ai_docs")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");

    for (const doc of all) {
      const vector = await embed(`${doc.title}. ${doc.content}`);
      await admin.from("ai_docs").insert({
        title: doc.title,
        content: doc.content,
        embedding: vector,
      });
    }

    return NextResponse.json({ ok: true, documents: all.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Seeding failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
