// Available slots for a postcode.
// Save at: app/api/slots/route.ts
// Try: localhost:3000/api/slots?postcode=SW3%201AA

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  APPOINTMENT_END_HOUR,
  APPOINTMENT_START_HOUR,
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
  londonDate,
  londonParts,
} from "@/lib/appointmentWindow";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DAYS_AHEAD = 14;
const SLOT_INTERVAL_MINUTES = 60;

function outwardCode(pc: string) {
  const s = (pc || "").toUpperCase().replace(/\s+/g, "");
  if (s.length <= 4) return s;
  return s.slice(0, s.length - 3);
}

export async function GET(req: NextRequest) {
  try {
    const postcode = req.nextUrl.searchParams.get("postcode") ?? "";
    const requestedDuration = Number(
      req.nextUrl.searchParams.get("duration") ??
        DEFAULT_APPOINTMENT_DURATION_MINUTES,
    );
    const durationMinutes =
      Number.isFinite(requestedDuration) && requestedDuration > 0
        ? Math.min(Math.round(requestedDuration), 12 * 60)
        : DEFAULT_APPOINTMENT_DURATION_MINUTES;
    const out = outwardCode(postcode);
    if (!out) {
      return NextResponse.json({ error: "Missing postcode" }, { status: 400 });
    }

    // 1. Which areas cover this postcode?
    const { data: areas } = await admin
      .from("service_areas")
      .select("id, name, postcode_prefixes")
      .eq("active", true);

    const areaIds = (areas ?? [])
      .filter((a) => (a.postcode_prefixes ?? []).includes(out))
      .map((a) => a.id);

    if (areaIds.length === 0) {
      return NextResponse.json({ covered: false, slots: [], suggested: [] });
    }

    // Customers choose the appointment first. Provider availability does not
    // remove a permitted time: matching and offer rotation happen after the
    // booking is paid. This keeps the customer flow open even with a thin
    // worker roster.
    const now = Date.now();
    const slots: string[] = [];
    const today = londonParts(now);

    for (let d = 0; d <= DAYS_AHEAD; d++) {
      // Use a timezone-neutral calendar cursor, then convert each London wall
      // clock time to its real UTC instant. This stays correct across BST/GMT.
      const day = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
      const year = day.getUTCFullYear();
      const month = day.getUTCMonth() + 1;
      const date = day.getUTCDate();

      for (
        let minute = APPOINTMENT_START_HOUR * 60;
        minute + durationMinutes <= APPOINTMENT_END_HOUR * 60;
        minute += SLOT_INTERVAL_MINUTES
      ) {
        const slot = londonDate(
          year,
          month,
          date,
          Math.floor(minute / 60),
          minute % 60,
        );
        if (slot.getTime() < now + 2 * 60 * 60 * 1000) continue;
        slots.push(slot.toISOString());
      }
    }

    // Suggested times are convenience choices, never availability claims.
    const suggested: { iso: string; reason: string }[] = [];
    const push = (iso: string, reason: string) => {
      if (iso && !suggested.some((s) => s.iso === iso) && suggested.length < 3) {
        suggested.push({ iso, reason });
      }
    };

    if (slots.length) {
      push(slots[0], "Soonest permitted time");
      const morning = slots.find((slot) => {
        const d = londonParts(slot);
        return d.weekday >= 1 && d.weekday <= 5 && d.hour >= 9 && d.hour <= 11;
      });
      if (morning) push(morning, "Weekday morning");
    }

    return NextResponse.json({
      covered: true,
      slots,
      suggested,
      appointmentWindow: {
        start: "07:00",
        end: "19:00",
        durationMinutes,
      },
      workerAvailabilityRequired: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not load slots";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
