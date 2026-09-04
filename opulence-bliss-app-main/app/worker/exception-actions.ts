"use server";

// SETUP: mkdir -p "app/worker" && code "app/worker/exception-actions.ts"
//
// The two things that go wrong on the provider's side.
//
// Neither decides who pays what — that's a judgement, and it belongs to an
// operator looking at a review case. These actions record what happened, put
// the booking somewhere safe, and tell the customer the truth.

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient as ssr } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { seedAndStartOfferRotation } from "@/lib/offerRotation";

const admin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Dropping out inside this window is a late cancellation. */
const LATE_HOURS = 24;

/** How far from the address we'll accept a "nobody's home" report. */
const GEOFENCE_METRES = 500;
const NO_ACCESS_GRACE_MINUTES = 15;
const MAX_REASON_LENGTH = 1000;

type Result = { ok: boolean; message: string };

async function requireProvider(bookingId: string) {
  const s = await ssr();
  const {
    data: { user },
  } = await s.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: prov } = await s
    .from("providers")
    .select("id, display_name")
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!prov) throw new Error("Not a provider");

  const { data: booking } = await s
    .from("bookings")
    .select(
      "id, status, scheduled_at, address, customer_id, customer_email, provider_id, package_id, packages(name, service_type)",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) throw new Error("Job not found");
  if (booking.provider_id !== prov.id) {
    throw new Error("This job is not assigned to you");
  }

  return { s, user, prov, booking };
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return !v ? null : Array.isArray(v) ? (v[0] ?? null) : v;
}

function cleanReason(reason: string) {
  return reason.trim().slice(0, MAX_REASON_LENGTH);
}

function extractPostcode(value: string | null) {
  if (!value) return null;
  const upper = value.toUpperCase().replace(/\s+/g, " ").trim();
  const full = upper.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/);
  if (full) return full[0];
  const outcode = upper.match(/^[A-Z]{1,2}\d[A-Z\d]?$/);
  return outcode ? outcode[0] : null;
}

async function geocodeAddress(value: string | null) {
  const postcode = extractPostcode(value);
  if (!postcode) return null;

  try {
    const response = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`,
      { cache: "no-store" },
    );
    if (response.ok) {
      const body = await response.json();
      if (
        typeof body?.result?.latitude === "number" &&
        typeof body?.result?.longitude === "number"
      ) {
        return { lat: body.result.latitude, lng: body.result.longitude };
      }
    }
  } catch {
    // Fall through to the less precise outcode lookup.
  }

  const outcode = postcode.split(" ")[0];
  try {
    const response = await fetch(
      `https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.result?.latitude === "number" &&
      typeof body?.result?.longitude === "number"
      ? { lat: body.result.latitude, lng: body.result.longitude }
      : null;
  } catch {
    return null;
  }
}

/* ==========================================================================
 * 1. "I can't attend"
 * ========================================================================== */
export async function cannotAttend(
  bookingId: string,
  reason: string,
): Promise<Result> {
  if (!reason?.trim())
    return {
      ok: false,
      message: "Please tell us why so we can help the client.",
    };

  const explanation = cleanReason(reason);
  const { s, user, prov, booking } = await requireProvider(bookingId);
  const pkg = one(booking.packages as never) as {
    name: string;
    service_type: string | null;
  } | null;

  const scheduledAt = new Date(booking.scheduled_at).getTime();
  const hoursOut = (scheduledAt - Date.now()) / 3_600_000;
  const late = hoursOut < LATE_HOURS;

  // Once the start time has passed this is a no-show, not a useful
  // re-broadcast of an already-started slot.
  if (hoursOut <= 0) {
    const { error: caseError } = await admin.rpc(
      "system_report_unfilled_rebroadcast",
      {
        p_booking_id: bookingId,
        p_reason: `Provider cannot attend after the scheduled start: ${explanation}`,
        p_notes: `${
          prov.display_name ?? "Provider"
        } withdrew after the visit was due. Reason given: ${explanation}`,
        p_created_by: user.id,
      },
    );
    if (caseError) return { ok: false, message: caseError.message };

    await Promise.allSettled([
      booking.customer_id
        ? admin.from("notifications").insert({
            user_id: booking.customer_id,
            title: "Problem with your visit",
            body: "Your provider cannot attend. Payment is paused while our team arranges the next step.",
            href: `/account/visit/${bookingId}`,
          })
        : Promise.resolve(),
      sendEmail({
        to: booking.customer_email,
        subject: "A problem with your visit",
        title: "We need to sort your visit",
        body: `<p>Your provider can no longer attend your <strong>${
          pkg?.name ?? "visit"
        }</strong>.</p><p>Payment is paused while our team reviews what happened and contacts you.</p>`,
        cta: { text: "See your visit", url: `/account/visit/${bookingId}` },
      }),
    ]);

    revalidatePath("/worker");
    revalidatePath("/worker/current");
    revalidatePath("/account");
    revalidatePath(`/account/visit/${bookingId}`);
    return {
      ok: true,
      message:
        "Removed from your schedule. The visit was already due, so our team has been alerted.",
    };
  }

  const replacementExpiry = new Date(
    Math.min(
      scheduledAt,
      Math.max(Date.now() + 15 * 60_000, scheduledAt - 2 * 3_600_000),
    ),
  ).toISOString();

  // Back on the market — the customer keeps their slot and their hold.
  const { error } = await s.rpc("transition_booking", {
    p_booking_id: bookingId,
    p_to_status: "offered",
    p_reason: `Provider cannot attend: ${explanation}`,
    p_meta: {
      hours_before: Math.round(hoursOut),
      late,
      provider_id: prov.id,
      offer_expires_at: replacementExpiry,
    },
  });

  if (error) return { ok: false, message: error.message };

  // ---- queue everyone else who fits, then ask them one at a time ----
  const district = (booking.address ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\d[A-Z]{2}$/, "");

  const { data: areas } = await admin
    .from("service_areas")
    .select("id, postcode_prefixes")
    .eq("active", true);

  const areaIds = (areas ?? [])
    .filter((a) => (a.postcode_prefixes ?? []).includes(district))
    .map((a) => a.id);

  let offered = 0;
  if (areaIds.length) {
    const { data: links } = await admin
      .from("provider_service_areas")
      .select("provider_id")
      .in("service_area_id", areaIds);

    const ids = [...new Set((links ?? []).map((l) => l.provider_id))].filter(
      (id) => id !== prov.id, // not the person who just dropped it
    );

    if (ids.length) {
      const { data: previousOffers } = await admin
        .from("booking_offers")
        .select("provider_id, status")
        .eq("booking_id", bookingId);
      const declined = new Set(
        (previousOffers ?? [])
          .filter((offer) => offer.status === "declined")
          .map((offer) => offer.provider_id),
      );
      const eligibleIds = ids.filter((id) => !declined.has(id));

      const svc = (pkg?.service_type ?? "cleaning").includes("massage")
        ? "massage"
        : "cleaning";

      const { data: provs } = eligibleIds.length
        ? await admin
            .from("providers")
            .select("id, profile_id")
            .in("id", eligibleIds)
            .eq("vetting_status", "approved")
            .eq("joining_fee_paid", true)
            .contains("services", [svc])
        : { data: [] };

      if (provs?.length) {
        await seedAndStartOfferRotation(
          admin,
          bookingId,
          provs.map((provider) => provider.id),
        );
        offered = provs.length;
      }
    }
  }

  // Nobody left to ask? That's a case, not a silent failure.
  if (offered === 0) {
    const { error: caseError } = await admin.rpc(
      "system_report_unfilled_rebroadcast",
      {
        p_booking_id: bookingId,
        p_reason: "No eligible replacement provider after re-broadcast",
        p_notes: `Provider dropped out ${Math.round(
          hoursOut,
        )}h before and no replacement is available. Reason: ${explanation}`,
        p_created_by: user.id,
      },
    );
    if (caseError) {
      return {
        ok: false,
        message: `Removed from your schedule, but escalation needs attention: ${caseError.message}`,
      };
    }
  }

  // A late drop-out is a reliability matter, whether or not we refill it.
  if (late) {
    await admin.rpc("open_review_case", {
      p_booking_id: bookingId,
      p_category: "late_cancellation",
      p_priority: offered > 0 ? "normal" : "high",
      p_blocks_payment: false,
      p_blocks_payout: false,
      p_notes: `${prov.display_name ?? "Provider"} withdrew ${Math.round(
        hoursOut,
      )}h before the visit. Reason given: ${explanation}`,
      p_created_by: user.id,
    });
  }

  // ---- tell the customer straight away ----
  await Promise.allSettled([
    booking.customer_id
      ? admin.from("notifications").insert({
          user_id: booking.customer_id,
          title:
            offered > 0
              ? "Finding you another provider"
              : "Problem with your visit",
          body:
            offered > 0
              ? `Your provider can no longer make it, so we've offered your ${
                  pkg?.name ?? "visit"
                } to ${offered} other provider${offered === 1 ? "" : "s"}. Your booking and card hold remain in place.`
              : "Your provider can no longer make it and we don't have a replacement yet. Payment is paused while our team handles it.",
          href: `/account/visit/${bookingId}`,
        })
      : Promise.resolve(),
    sendEmail({
      to: booking.customer_email,
      subject:
        offered > 0
          ? "We're finding you another provider"
          : "A problem with your visit",
      title:
        offered > 0
          ? "Your provider had to withdraw"
          : "We need to sort your visit",
      body:
        offered > 0
          ? `<p>Your provider can no longer attend, so we've put your <strong>${
              pkg?.name ?? "visit"
            }</strong> back out to other vetted providers in your area.</p>
             <p>Your time slot and existing card hold are unchanged. We'll confirm as soon as someone accepts.</p>`
          : `<p>Your provider can no longer attend your <strong>${
              pkg?.name ?? "visit"
            }</strong>, and we don't yet have a replacement.</p>
             <p>Payment is paused while our team reviews the options and contacts you.</p>`,
      cta: { text: "See your visit", url: `/account/visit/${bookingId}` },
    }),
  ]);

  revalidatePath("/worker");
  revalidatePath("/worker/current");
  revalidatePath("/account");
  revalidatePath(`/account/visit/${bookingId}`);

  return {
    ok: true,
    message:
      offered > 0
        ? `Removed from your schedule. Offered to ${offered} other provider${
            offered === 1 ? "" : "s"
          }.`
        : "Removed from your schedule. No replacement available yet — our team has been alerted.",
  };
}

/* ==========================================================================
 * 2. "Nobody's home"
 * ========================================================================== */
export async function reportClientUnavailable(
  bookingId: string,
  reason: string,
  gps?: { lat: number; lng: number } | null,
): Promise<Result> {
  if (!reason?.trim())
    return { ok: false, message: "Tell us what happened when you arrived." };

  const explanation = cleanReason(reason);
  const { s, prov, booking } = await requireProvider(bookingId);
  const reportFrom =
    new Date(booking.scheduled_at).getTime() + NO_ACCESS_GRACE_MINUTES * 60_000;
  if (Date.now() < reportFrom) {
    return {
      ok: false,
      message: `Wait at the address and try contacting the client. You can report no access from ${new Date(
        reportFrom,
      ).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })}.`,
    };
  }

  // Being at the door is the whole claim. Check it the same way we check in.
  let atProperty: boolean | null = null;
  let distance: number | null = null;

  const validGps =
    gps &&
    Number.isFinite(gps.lat) &&
    Number.isFinite(gps.lng) &&
    Math.abs(gps.lat) <= 90 &&
    Math.abs(gps.lng) <= 180
      ? gps
      : null;

  if (validGps && booking.address) {
    try {
      const target = await geocodeAddress(booking.address);
      if (target) {
        distance = metres(validGps.lat, validGps.lng, target.lat, target.lng);
        atProperty = distance <= GEOFENCE_METRES;
      }
    } catch {
      /* leave unverified */
    }
  }

  const { error } = await s.rpc("report_booking_exception", {
    p_booking_id: bookingId,
    p_reason: `Client unavailable: ${explanation}`,
    p_category: "client_unavailable",
    p_notes:
      `${prov.display_name ?? "Provider"} reported no access. ` +
      `Location ${
        atProperty === true
          ? `verified (${Math.round(distance ?? 0)}m from the address)`
          : atProperty === false
            ? `NOT verified (${Math.round(distance ?? 0)}m away)`
            : "not verified"
      }. Reason given: ${explanation}`,
    p_meta: {
      provider_id: prov.id,
      location_verified: atProperty,
      distance_metres: distance,
      reported_at: new Date().toISOString(),
      gps_lat: validGps?.lat ?? null,
      gps_lng: validGps?.lng ?? null,
    },
  });

  if (error) return { ok: false, message: error.message };

  const pkg = one(booking.packages as never) as { name: string } | null;

  await Promise.allSettled([
    booking.customer_id
      ? admin.from("notifications").insert({
          user_id: booking.customer_id,
          title: "We couldn't get in",
          body: `Your provider reported that they couldn't get access for your ${
            pkg?.name ?? "visit"
          }. Payment is paused while our team reviews what happened.`,
          href: `/account/visit/${bookingId}`,
        })
      : Promise.resolve(),
    sendEmail({
      to: booking.customer_email,
      subject: "We couldn't get in for your visit",
      title: "Your provider reported no access",
      body: `<p>Your provider reported that they couldn't get access for your <strong>${
        pkg?.name ?? "visit"
      }</strong>.</p><p>Payment is paused while our team reviews what happened and contacts you.</p>`,
      cta: { text: "See your visit", url: `/account/visit/${bookingId}` },
    }),
  ]);

  revalidatePath("/worker");
  revalidatePath("/worker/current");
  revalidatePath("/account");
  revalidatePath(`/account/visit/${bookingId}`);

  return {
    ok: true,
    message:
      atProperty === false
        ? "Reported — but your location didn't match the address, so our team will check before deciding."
        : "Reported. Our team will review what happened and what happens with payment.",
  };
}

/* ---------- distance, in metres ---------- */
function metres(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
