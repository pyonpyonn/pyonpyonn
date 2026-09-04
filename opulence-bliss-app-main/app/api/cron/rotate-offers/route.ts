import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { rotateBookingOffer } from "@/lib/offerRotation";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;
  if (!secret || (key !== secret && bearer !== secret)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const { data: waiting, error } = await admin
    .from("bookings")
    .select("id")
    .eq("status", "offered")
    .is("provider_id", null)
    .gt("offer_expires_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summary = {
    checked: waiting?.length ?? 0,
    activated: 0,
    waiting: 0,
    exhausted: 0,
    skipped: 0,
    errors: [] as { booking_id: string; message: string }[],
  };

  for (const booking of waiting ?? []) {
    try {
      const result = await rotateBookingOffer(admin, booking.id);
      if (result.action === "activated") summary.activated++;
      else if (result.action === "waiting") summary.waiting++;
      else if (result.action === "exhausted") summary.exhausted++;
      else summary.skipped++;
    } catch (cause) {
      summary.errors.push({
        booking_id: booking.id,
        message: cause instanceof Error ? cause.message : "Rotation failed",
      });
    }
  }

  return NextResponse.json({ ok: summary.errors.length === 0, ...summary });
}
