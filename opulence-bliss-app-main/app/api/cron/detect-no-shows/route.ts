// SETUP: mkdir -p "app/api/cron/detect-no-shows" && code "app/api/cron/detect-no-shows/route.ts"
//
// Nobody turned up. Somebody has to notice.
//
// Until now, a provider failing to arrive was only caught if the CUSTOMER
// reported it. A customer who is out, or who assumes we already know, gets
// nothing — the booking just sits at `scheduled` forever.
//
// This sweep runs every 5–10 minutes and does three things:
//
//   LATE      start + 15 min, no check-in   → nudge both sides, no state change
//   NO-SHOW   start + 45 min, no check-in   → needs_review + blocking case
//   ABANDONED in progress, well past the end → needs_review + case
//
// It makes NO decision about money. It opens a case and stops.
//
//   GET /api/cron/detect-no-shows?key=CRON_SECRET
//   GET /api/cron/detect-no-shows?key=CRON_SECRET&dry=1

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** Grace before we say anything at all. */
const LATE_AFTER_MIN = 15;
/** Grace before we call it a no-show. */
const NO_SHOW_AFTER_MIN = 45;
/** How long past the expected finish before an unclosed visit is suspicious. */
const ABANDONED_AFTER_MIN = 120;

type Row = {
  id: string;
  customer_id: string | null;
  provider_id: string | null;
  scheduled_at: string;
  status: string;
  customer_email: string | null;
  packages: { name: string; duration_minutes: number | null } | { name: string; duration_minutes: number | null }[] | null;
  check_ins: { arrived_at: string | null } | { arrived_at: string | null }[] | null;
};

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

async function notify(
  userId: string | null,
  title: string,
  body: string,
  href: string
) {
  if (!userId) return;
  await admin.from("notifications").insert({
    user_id: userId,
    title,
    body,
    href,
  });
}

async function providerProfile(providerId: string | null) {
  if (!providerId) return null;
  const { data } = await admin
    .from("providers")
    .select("profile_id, display_name")
    .eq("id", providerId)
    .maybeSingle();
  return data ?? null;
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;
  if (!secret || (key !== secret && bearer !== secret)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const now = Date.now();

  const late: string[] = [];
  const noShows: string[] = [];
  const abandoned: string[] = [];
  const notes: string[] = [];

  try {
    /* ==================================================================
     * 1. Confirmed visits that should have started
     * ================================================================== */
    const { data: due } = await admin
      .from("bookings")
      .select(
        "id, customer_id, provider_id, scheduled_at, status, customer_email, packages(name, duration_minutes), check_ins(arrived_at)"
      )
      .eq("status", "scheduled")
      .lt("scheduled_at", new Date(now - LATE_AFTER_MIN * 60000).toISOString())
      .gt("scheduled_at", new Date(now - 24 * 60 * 60000).toISOString())
      .limit(200);

    for (const b of (due ?? []) as unknown as Row[]) {
      const ci = one(b.check_ins);
      if (ci?.arrived_at) continue; // they turned up

      const pkg = one(b.packages);
      const service = pkg?.name ?? "your visit";
      const minsLate = Math.floor(
        (now - new Date(b.scheduled_at).getTime()) / 60000
      );

      const prov = await providerProfile(b.provider_id);

      /* ---------- past the no-show line ---------- */
      if (minsLate >= NO_SHOW_AFTER_MIN) {
        noShows.push(b.id);
        if (dry) continue;

        // Straight through the state machine. No payment decision here.
        const { error: tErr } = await admin.rpc("system_transition_booking", {
          p_booking_id: b.id,
          p_to_status: "needs_review",
          p_reason: `Provider had not checked in ${minsLate} minutes after the start time`,
        });

        if (tErr) {
          notes.push(`${b.id}: ${tErr.message}`);
          continue;
        }

        // Blocks the payout — nobody is paid for a visit that didn't happen
        // until someone has looked at it.
        const { error: caseError } = await admin.rpc("open_review_case", {
          p_booking_id: b.id,
          p_category: "worker_no_show",
          p_priority: "urgent",
          p_blocks_payment: true,
          p_blocks_payout: true,
          p_notes: `Detected automatically: no check-in ${minsLate} minutes after the scheduled start.`,
        });
        if (caseError) notes.push(`${b.id}: case: ${caseError.message}`);

        await notify(
          b.customer_id,
          "We're sorry — your provider hasn't arrived",
          `${service} was due at ${new Date(b.scheduled_at).toLocaleTimeString(
            "en-GB",
            { hour: "2-digit", minute: "2-digit", hour12: true }
          )}. We've flagged it and our team is on it. You won't be charged for a visit that didn't happen.`,
          `/account/visit/${b.id}`
        );

        await notify(
          prov?.profile_id ?? null,
          "Missed job flagged",
          `You hadn't checked in for ${service}. It's been passed to our team.`,
          "/worker"
        );

        await sendEmail({
          to: b.customer_email,
          subject: "Your provider hasn't arrived",
          title: "We're sorry — nobody has arrived",
          body: `<p>Your <strong>${service}</strong> was due to start and your provider hasn't checked in.</p>
                 <p>We've flagged this and our team is looking at it now. <strong>You won't be charged</strong> for a visit that didn't happen.</p>
                 <p>We'll be in touch shortly.</p>`,
          cta: { text: "See your visit", url: `/account/visit/${b.id}` },
        });

        continue;
      }

      /* ---------- merely late ---------- */
      late.push(b.id);
      if (dry) continue;

      // A nudge, once. No state change — they may still be parking.
      const { count: already } = await admin
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", b.customer_id ?? "")
        .eq("title", "Your provider is running late")
        .eq("href", `/account/visit/${b.id}`);

      if ((already ?? 0) === 0) {
        await notify(
          b.customer_id,
          "Your provider is running late",
          `${service} was due at ${new Date(b.scheduled_at).toLocaleTimeString(
            "en-GB",
            { hour: "2-digit", minute: "2-digit", hour12: true }
          )}. If nobody arrives shortly we'll step in — you don't need to do anything.`,
          `/account/visit/${b.id}`
        );

        await notify(
          prov?.profile_id ?? null,
          "You're late for a job",
          `${service} started ${minsLate} minutes ago. Check in as soon as you arrive.`,
          "/worker/current"
        );
      }
    }

    /* ==================================================================
     * 2. Visits left running long after they should have finished
     * ================================================================== */
    const { data: running } = await admin
      .from("bookings")
      .select(
        "id, customer_id, provider_id, scheduled_at, status, customer_email, packages(name, duration_minutes), check_ins(arrived_at)"
      )
      .eq("status", "in_progress")
      .limit(200);

    for (const b of (running ?? []) as unknown as Row[]) {
      const ci = one(b.check_ins);
      const pkg = one(b.packages);
      if (!ci?.arrived_at) continue;

      const expectedEnd =
        new Date(ci.arrived_at).getTime() +
        (pkg?.duration_minutes ?? 120) * 60000;

      if (now < expectedEnd + ABANDONED_AFTER_MIN * 60000) continue;

      abandoned.push(b.id);
      if (dry) continue;

      const { error } = await admin.rpc("system_transition_booking", {
        p_booking_id: b.id,
        p_to_status: "needs_review",
        p_reason: `Still in progress ${Math.floor(
          (now - expectedEnd) / 60000
        )} minutes after the expected finish — no check-out`,
      });

      if (error) {
        notes.push(`${b.id}: ${error.message}`);
        continue;
      }

      const { error: caseError } = await admin.rpc("open_review_case", {
        p_booking_id: b.id,
        p_category: "work_stopped",
        p_priority: "high",
        p_blocks_payment: true,
        p_blocks_payout: true,
        p_notes:
          "Detected automatically: checked in but never checked out. The customer has not been charged.",
      });
      if (caseError) notes.push(`${b.id}: case: ${caseError.message}`);

      await notify(
        b.customer_id,
        "We're checking on your visit",
        `${pkg?.name ?? "Your visit"} hasn't been closed off properly. Our team is looking into it — you haven't been charged.`,
        `/account/visit/${b.id}`
      );
    }

    return NextResponse.json({
      ok: true,
      mode: dry ? "dry-run (nothing written)" : "applied",
      thresholds: {
        late_after_minutes: LATE_AFTER_MIN,
        no_show_after_minutes: NO_SHOW_AFTER_MIN,
        abandoned_after_minutes: ABANDONED_AFTER_MIN,
      },
      late: late.length,
      no_shows: noShows.length,
      abandoned: abandoned.length,
      ids: dry ? { late, noShows, abandoned } : undefined,
      notes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sweep failed";
    console.error("No-show sweep:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
