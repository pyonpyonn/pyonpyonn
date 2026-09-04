// AI concierge — knowledge base, live account tools and confirmation-gated
// customer actions. The model may PREPARE a mutation, but it never executes
// one: signed actions run only after the customer presses Confirm in the UI.

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import {
  signAssistantMutation,
  verifyAssistantMutation,
} from "@/lib/assistantActionToken";
import {
  cancelCustomerBooking,
  rescheduleCustomerBooking,
} from "@/lib/customerBookingOperations";
import { getRescheduleWindow } from "@/lib/bookingState";
import { getVisitStatus } from "@/lib/visitStatus";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * A Supabase client acting AS the signed-in user, built from the token the
 * browser sends. Row-level security still applies, so this can only ever see
 * that person's own data.
 */
function asUser(token: string | null) {
  if (!token) return null;
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMS = 768;
const CHAT_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

type AssistantAction =
  | {
      kind: "navigate";
      label: string;
      summary: string;
      href: string;
      tone: "primary" | "danger";
    }
  | {
      kind: "confirm";
      label: string;
      summary: string;
      confirmText: string;
      token: string;
      tone: "primary" | "danger";
    };

type ToolResult = Record<string, unknown> & {
  client_action?: AssistantAction;
};

type AgentContext = {
  origin: string;
  client: SupabaseClient | null;
  user: User | null;
  role: string;
};

/* ------------------------------------------------------------------ */
/* Tools the model may call                                            */
/* ------------------------------------------------------------------ */

const SHARED_TOOLS = [
  {
    name: "check_coverage",
    description:
      "Check whether Opulence Bliss covers a UK postcode. Use whenever someone mentions a postcode or asks if you come to their area.",
    parameters: {
      type: "OBJECT",
      properties: {
        postcode: {
          type: "STRING",
          description: "UK postcode or district, e.g. 'SW3 1AA' or 'IG11'",
        },
      },
      required: ["postcode"],
    },
  },
  {
    name: "list_services",
    description:
      "List current services and memberships with prices. Use for any question about what's offered or what things cost.",
    parameters: { type: "OBJECT", properties: {} },
  },
];

const CLIENT_TOOLS = [
  {
    name: "find_slots",
    description:
      "Find permitted customer-selectable appointment times for a covered postcode. Worker matching happens after booking, so these times are not claims about a specific worker's availability.",
    parameters: {
      type: "OBJECT",
      properties: {
        postcode: { type: "STRING", description: "UK postcode" },
        service_type: {
          type: "STRING",
          description: "Either 'cleaning' or 'massage'",
        },
        date: {
          type: "STRING",
          description:
            "Optional ISO date (YYYY-MM-DD) to narrow to one day. Work it out from today's date if the person says something like 'in 3 days' or 'Friday'.",
        },
        duration_minutes: {
          type: "NUMBER",
          description: "The chosen service duration in minutes, when known.",
        },
      },
      required: ["postcode"],
    },
  },
  {
    name: "prepare_booking",
    description:
      "Prepare a clear Review and pay button once the customer has chosen a service, postcode and exact permitted time. Card payment always requires the customer to finish on the secure checkout page.",
    parameters: {
      type: "OBJECT",
      properties: {
        service_name: {
          type: "STRING",
          description:
            "Exact service name, e.g. 'Bliss Massage · 60 min' or 'Essential Clean'",
        },
        postcode: { type: "STRING", description: "UK postcode" },
        slot: {
          type: "STRING",
          description:
            "The chosen slot as a full ISO timestamp, exactly as returned by find_slots",
        },
      },
      required: ["service_name", "postcode", "slot"],
    },
  },
  {
    name: "my_membership",
    description:
      "Check whether the signed-in customer has a monthly membership, and if so which plan, its status, how far through the term they are and when the next payment is due. Use for 'do I have a subscription', 'when am I next billed', 'what plan am I on'.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "my_bookings",
    description:
      "Get the signed-in customer's recent bookings with booking IDs, provider, customer-facing status, money status and links. Call this before acting when the user has not supplied a booking ID.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "booking_status",
    description:
      "Get the current, customer-safe status of one signed-in customer's booking, including who acts next, card/refund state, review case summary and available actions.",
    parameters: {
      type: "OBJECT",
      properties: {
        booking_id: {
          type: "STRING",
          description: "Exact booking UUID returned by my_bookings",
        },
      },
      required: ["booking_id"],
    },
  },
  {
    name: "reschedule_options",
    description:
      "Check the real reschedule window and list permitted replacement times for one booking. Use before preparing a reschedule.",
    parameters: {
      type: "OBJECT",
      properties: {
        booking_id: {
          type: "STRING",
          description: "Exact booking UUID returned by my_bookings",
        },
        date: {
          type: "STRING",
          description: "Optional YYYY-MM-DD date requested by the customer",
        },
      },
      required: ["booking_id"],
    },
  },
  {
    name: "prepare_cancel_booking",
    description:
      "Prepare a cancellation confirmation for the signed-in customer's booking. This does not cancel by itself. Use only after the customer clearly asks to cancel.",
    parameters: {
      type: "OBJECT",
      properties: {
        booking_id: {
          type: "STRING",
          description: "Exact booking UUID returned by my_bookings",
        },
        reason: {
          type: "STRING",
          description: "Optional brief reason in the customer's own words",
        },
      },
      required: ["booking_id"],
    },
  },
  {
    name: "prepare_reschedule_booking",
    description:
      "Prepare a reschedule confirmation using an exact ISO slot returned by reschedule_options. This does not change the booking by itself.",
    parameters: {
      type: "OBJECT",
      properties: {
        booking_id: {
          type: "STRING",
          description: "Exact booking UUID returned by my_bookings",
        },
        new_slot: {
          type: "STRING",
          description: "Exact ISO timestamp returned by reschedule_options",
        },
        reason: {
          type: "STRING",
          description: "Short customer reason, such as Change of plans",
        },
        note: {
          type: "STRING",
          description: "Optional message for the provider",
        },
      },
      required: ["booking_id", "new_slot", "reason"],
    },
  },
  {
    name: "prepare_booking_help_request",
    description:
      "Prepare a request for the human resolution desk about a specific booking, especially when rescheduling is blocked or the customer explicitly asks for a person. This does not submit until confirmed.",
    parameters: {
      type: "OBJECT",
      properties: {
        booking_id: {
          type: "STRING",
          description: "Exact booking UUID returned by my_bookings",
        },
        message: {
          type: "STRING",
          description: "What the customer needs help with, in plain language",
        },
      },
      required: ["booking_id", "message"],
    },
  },
  {
    name: "my_spend",
    description:
      "Get how much the signed-in customer has spent in total and how many visits they've had.",
    parameters: { type: "OBJECT", properties: {} },
  },
];

const PROVIDER_TOOLS = [
  {
    name: "my_jobs",
    description:
      "Get the signed-in provider's own jobs — open offers, what's confirmed, anything in progress. Use for 'what work have I got', 'what's my next job', 'do I have any offers'.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "my_earnings",
    description:
      "Get the signed-in provider's earnings — paid so far, pending, tips and their rating. Use for 'how much have I earned', 'when do I get paid', 'what's my rating'.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "my_availability",
    description:
      "Get the signed-in provider's working days and hours, and whether their account is active for work.",
    parameters: { type: "OBJECT", properties: {} },
  },
];

function toolsFor(role: string) {
  return [
    {
      functionDeclarations: [
        ...SHARED_TOOLS,
        ...(role === "provider" ? PROVIDER_TOOLS : CLIENT_TOOLS),
      ],
    },
  ];
}

function district(pc: string) {
  const s = (pc || "").toUpperCase().replace(/\s+/g, "");
  if (!s) return "";
  const full = s.match(/^([A-Z]{1,2}\d[A-Z\d]?)\d[A-Z]{2}$/);
  if (full) return full[1];
  return s.length > 4 ? s.slice(0, s.length - 3) : s;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return !value ? null : Array.isArray(value) ? (value[0] ?? null) : value;
}

function postcodeFromAddress(value: string | null | undefined) {
  const match = value
    ?.toUpperCase()
    .match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  return match?.[1]?.replace(/\s+/g, " ") ?? district(value ?? "");
}

function friendlyDate(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

async function ownClientBooking(context: AgentContext, bookingId: string) {
  if (!context.client || !context.user || context.role !== "client") {
    return {
      error: "Sign in as a customer before managing a booking.",
      booking: null,
    };
  }

  const { data, error } = await context.client
    .from("bookings")
    .select(
      "id, customer_id, status, scheduled_at, address, package_id, packages(name, service_type, duration_minutes)",
    )
    .eq("id", bookingId)
    .eq("customer_id", context.user.id)
    .maybeSingle();

  if (error || !data) {
    return { error: "That booking was not found in your account.", booking: null };
  }
  return { error: null, booking: data };
}

async function replacementSlots(
  context: AgentContext,
  booking: {
    address: string | null;
    packages:
      | { name: string; service_type: string | null; duration_minutes?: number | null }
      | { name: string; service_type: string | null; duration_minutes?: number | null }
      | { name: string; service_type: string | null; duration_minutes?: number | null }[]
      | null;
  },
  date?: string | null,
) {
  const pkg = one(booking.packages);
  const postcode = postcodeFromAddress(booking.address);
  const service = String(pkg?.service_type ?? "").includes("massage")
    ? "massage"
    : "cleaning";
  const response = await fetch(
    `${context.origin}/api/slots?postcode=${encodeURIComponent(
      postcode,
    )}&service=${encodeURIComponent(service)}&duration=${encodeURIComponent(
      String(pkg?.duration_minutes ?? 120),
    )}`,
    { cache: "no-store" },
  );
  const data = await response.json();
  let slots = (data.slots ?? []) as string[];
  if (date) slots = slots.filter((slot) => slot.slice(0, 10) === date);
  return {
    covered: data.covered === true,
    postcode,
    service: pkg?.name ?? "Service",
    slots,
  };
}

async function executeConfirmedAction(context: AgentContext, token: string) {
  if (!context.client || !context.user || context.role !== "client") {
    return {
      ok: false as const,
      message: "Please sign in as a customer and ask me to prepare that again.",
    };
  }

  const action = verifyAssistantMutation(token, context.user.id);
  const owned = await ownClientBooking(context, action.bookingId);
  if (!owned.booking) {
    return { ok: false as const, message: owned.error };
  }

  if (action.type === "cancel_booking") {
    return cancelCustomerBooking(
      context.client,
      action.bookingId,
      action.reason ?? undefined,
      "assistant",
    );
  }

  if (action.type === "reschedule_booking") {
    const window = await getRescheduleWindow(context.client, action.bookingId);
    if (!window.can_reschedule) {
      return {
        ok: false as const,
        message: window.reason ?? "This booking can no longer be rescheduled.",
      };
    }

    const available = await replacementSlots(context, owned.booking);
    const selectedTime = new Date(action.newSlot).getTime();
    const stillAvailable = available.slots.some(
      (slot) => new Date(slot).getTime() === selectedTime,
    );
    if (!stillAvailable) {
      return {
        ok: false as const,
        message:
          "That time is outside the current permitted options. Ask me to list the times again.",
      };
    }

    return rescheduleCustomerBooking(
      context.client,
      action.bookingId,
      action.newSlot,
      action.reason,
      action.note ?? undefined,
      "assistant",
    );
  }

  const message = action.message.trim().slice(0, 1000);
  const currentStatus = await getVisitStatus(
    context.client,
    action.bookingId,
  );
  if (currentStatus?.reviewCase && !currentStatus.reviewCase.resolved) {
    return {
      ok: false as const,
      message:
        "This booking already has an open support case. You can follow it from My bookings or add booking details in Messages.",
    };
  }
  const { error } = await context.client.rpc("open_review_case", {
    p_booking_id: action.bookingId,
    p_category: "other",
    p_priority: "normal",
    p_blocks_payment: false,
    p_blocks_payout: false,
    p_notes: `Customer requested help through the assistant: ${message}`,
    p_created_by: null,
  });
  if (error) return { ok: false as const, message: error.message };

  revalidatePath("/account");
  revalidatePath(`/account/visit/${action.bookingId}`);
  revalidatePath("/admin/review");
  return {
    ok: true as const,
    message:
      "Your request has been sent to the resolution desk. You can follow the visit from My bookings.",
  };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  context: AgentContext,
): Promise<ToolResult> {
  try {
    if (name === "check_coverage") {
      const d = district(String(args.postcode ?? ""));
      const { data } = await admin
        .from("service_areas")
        .select("name, postcode_prefixes")
        .eq("active", true);
      const hit = (data ?? []).find((a) =>
        (a.postcode_prefixes ?? []).includes(d)
      );
      return hit
        ? { covered: true, area: hit.name, district: d }
        : {
            covered: false,
            district: d,
            areas_we_cover: (data ?? []).map((a) => a.name),
          };
    }

    if (name === "list_services") {
      const { data } = await admin
        .from("packages")
        .select("name, price, duration_minutes, service_type, description")
        .eq("active", true)
        .order("price");
      return { services: data ?? [] };
    }

    if (name === "find_slots") {
      const pc = String(args.postcode ?? "");
      const svc = String(args.service_type ?? "");
      const res = await fetch(
        `${context.origin}/api/slots?postcode=${encodeURIComponent(
          pc
        )}&service=${encodeURIComponent(svc)}&duration=${encodeURIComponent(
          String(Number(args.duration_minutes) || 120),
        )}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      let slots: string[] = data.slots ?? [];
      if (args.date) {
        const want = String(args.date);
        slots = slots.filter((s) => s.slice(0, 10) === want);
      }
      return {
        covered: data.covered ?? false,
        count: slots.length,
        slots: slots.slice(0, 10),
        note: slots.length
          ? "Times are shown in UK time. The customer may choose any returned time; worker matching happens after booking."
          : "No permitted appointment times for that day. Suggest another day.",
      };
    }

    if (name === "prepare_booking") {
      const wanted = String(args.service_name ?? "").toLowerCase().trim();
      const { data: pkgs } = await admin
        .from("packages")
        .select("id, name, price, duration_minutes")
        .eq("active", true);

      const match =
        (pkgs ?? []).find((p) => p.name.toLowerCase() === wanted) ??
        (pkgs ?? []).find((p) =>
          p.name.toLowerCase().includes(wanted.slice(0, 12))
        );

      if (!match) {
        return {
          ok: false,
          error: "No service by that name. Call list_services first.",
        };
      }

      const pc = String(args.postcode ?? "");
      const slot = String(args.slot ?? "");
      const url = `/book?review=1&source=assistant&service=${match.id}&pc=${encodeURIComponent(
        pc
      )}&slot=${encodeURIComponent(slot)}`;

      return {
        ok: true,
        url,
        service: match.name,
        price_gbp: Number(match.price),
        duration_minutes: match.duration_minutes,
        when: slot,
        note: "Nothing is booked or charged until the customer reviews and pays on the secure booking page.",
        client_action: {
          kind: "navigate",
          label: "Review and pay",
          summary: `${match.name} · £${Number(match.price).toFixed(2)} · ${friendlyDate(slot)}`,
          href: url,
          tone: "primary",
        },
      };
    }

    if (name === "booking_status") {
      const bookingId = String(args.booking_id ?? "");
      const owned = await ownClientBooking(context, bookingId);
      if (!owned.booking || !context.client) {
        return { ok: false, error: owned.error };
      }
      const status = await getVisitStatus(context.client, bookingId);
      if (!status) return { ok: false, error: "Booking not found." };
      const pkg = one(owned.booking.packages);
      return {
        ok: true,
        booking_id: bookingId,
        service: pkg?.name ?? "Service",
        scheduled_for: owned.booking.scheduled_at,
        booking_status: owned.booking.status,
        headline: status.headline,
        detail: status.detail,
        waiting_on: status.nextActorLabel,
        next_step: status.nextActorDetail,
        money: status.money,
        deadline: status.deadline,
        review_case: status.reviewCase,
        available_actions: status.actions.map((action) => ({
          kind: action.kind,
          label: action.label,
        })),
        details_at: `/account/visit/${bookingId}`,
      };
    }

    if (name === "reschedule_options") {
      const bookingId = String(args.booking_id ?? "");
      const owned = await ownClientBooking(context, bookingId);
      if (!owned.booking || !context.client) {
        return { ok: false, error: owned.error };
      }
      const window = await getRescheduleWindow(context.client, bookingId);
      if (!window.can_reschedule) {
        return {
          ok: false,
          can_reschedule: false,
          reason: window.reason,
          cutoff_at: window.cutoff_at,
          help_available: true,
          details_at: `/account/visit/${bookingId}?reschedule=1`,
        };
      }
      const available = await replacementSlots(
        context,
        owned.booking,
        args.date ? String(args.date) : null,
      );
      return {
        ok: true,
        can_reschedule: true,
        booking_id: bookingId,
        current_time: owned.booking.scheduled_at,
        cutoff_at: window.cutoff_at,
        lockout_hours: window.lockout_hours,
        count: available.slots.length,
        options: available.slots.slice(0, 12).map((slot) => ({
          iso: slot,
          label: friendlyDate(slot),
        })),
        note:
          available.slots.length > 0
            ? "Ask the customer to choose one exact option before preparing the change."
            : "No replacement times are currently permitted.",
      };
    }

    if (name === "prepare_cancel_booking") {
      const bookingId = String(args.booking_id ?? "");
      const owned = await ownClientBooking(context, bookingId);
      if (!owned.booking || !context.user || !context.client) {
        return { ok: false, error: owned.error };
      }
      if (!["offered", "declined", "scheduled"].includes(owned.booking.status)) {
        return {
          ok: false,
          error: `A ${owned.booking.status} booking cannot be cancelled here.`,
        };
      }
      const status = await getVisitStatus(context.client, bookingId);
      const pkg = one(owned.booking.packages);
      const reason = String(args.reason ?? "").trim().slice(0, 240) || null;
      const token = signAssistantMutation(
        { type: "cancel_booking", bookingId, reason },
        context.user.id,
      );
      const summary = `${pkg?.name ?? "Visit"} · ${friendlyDate(
        owned.booking.scheduled_at,
      )}. ${status?.money.explanation ?? "Any eligible card hold will be released."}`;
      return {
        ok: true,
        requires_customer_confirmation: true,
        client_action: {
          kind: "confirm",
          label: "Cancel this booking",
          summary,
          confirmText:
            "Cancel this booking now? This cannot be undone from the chat.",
          token,
          tone: "danger",
        },
      };
    }

    if (name === "prepare_reschedule_booking") {
      const bookingId = String(args.booking_id ?? "");
      const newSlot = String(args.new_slot ?? "");
      const owned = await ownClientBooking(context, bookingId);
      if (!owned.booking || !context.user || !context.client) {
        return { ok: false, error: owned.error };
      }
      const window = await getRescheduleWindow(context.client, bookingId);
      if (!window.can_reschedule) {
        return { ok: false, can_reschedule: false, error: window.reason };
      }
      const available = await replacementSlots(context, owned.booking);
      const selectedTime = new Date(newSlot).getTime();
      if (
        !Number.isFinite(selectedTime) ||
        !available.slots.some(
          (slot) => new Date(slot).getTime() === selectedTime,
        )
      ) {
        return {
          ok: false,
          error:
            "That time is not in the current permitted booking window. Call reschedule_options again.",
        };
      }
      const reason =
        String(args.reason ?? "").trim().slice(0, 120) || "Schedule changed";
      const note = String(args.note ?? "").trim().slice(0, 250) || null;
      const pkg = one(owned.booking.packages);
      const token = signAssistantMutation(
        {
          type: "reschedule_booking",
          bookingId,
          newSlot,
          reason,
          note,
        },
        context.user.id,
      );
      return {
        ok: true,
        requires_customer_confirmation: true,
        client_action: {
          kind: "confirm",
          label: "Confirm new time",
          summary: `${pkg?.name ?? "Visit"}: ${friendlyDate(
            owned.booking.scheduled_at,
          )} → ${friendlyDate(newSlot)}`,
          confirmText: `Move this booking to ${friendlyDate(newSlot)}?`,
          token,
          tone: "primary",
        },
      };
    }

    if (name === "prepare_booking_help_request") {
      const bookingId = String(args.booking_id ?? "");
      const message = String(args.message ?? "").trim().slice(0, 1000);
      const owned = await ownClientBooking(context, bookingId);
      if (!owned.booking || !context.user || !message) {
        return {
          ok: false,
          error: owned.error ?? "Tell me what help you need.",
        };
      }
      const token = signAssistantMutation(
        { type: "request_booking_help", bookingId, message },
        context.user.id,
      );
      return {
        ok: true,
        requires_customer_confirmation: true,
        client_action: {
          kind: "confirm",
          label: "Send help request",
          summary: message,
          confirmText:
            "Send this booking issue to the Opulence Bliss resolution desk?",
          token,
          tone: "primary",
        },
      };
    }

    // ---- user-scoped: RLS makes sure they only see their own ----
    if (
      name === "my_bookings" ||
      name === "my_spend" ||
      name === "my_membership" ||
      name === "my_jobs" ||
      name === "my_earnings" ||
      name === "my_availability"
    ) {
      if (!context.client) {
        return { signed_in: false, message: "Ask them to log in at /login." };
      }
      const {
        data: { user },
      } = await context.client.auth.getUser();
      if (!user) {
        return { signed_in: false, message: "Ask them to log in at /login." };
      }

      if (name === "my_membership") {
        const { data: sub } = await context.client
          .from("subscriptions")
          .select(
            "status, start_date, contract_length_months, cycles_billed, current_period_end, preferred_weekday, preferred_hour, paused_until, packages(name, price, visits_per_month)"
          )
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!sub) {
          return {
            signed_in: true,
            has_membership: false,
            message:
              "No membership. They pay per visit. Memberships are at /subscribe.",
          };
        }

        const p = sub.packages as
          | { name: string; price: number; visits_per_month: number | null }
          | { name: string; price: number; visits_per_month: number | null }[]
          | null;
        const pk = Array.isArray(p) ? p[0] : p;
        const days = [
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ];

        return {
          signed_in: true,
          has_membership: true,
          plan: pk?.name ?? "Membership",
          monthly_price_gbp: Number(pk?.price ?? 0),
          visits_per_month: pk?.visits_per_month ?? null,
          status: sub.paused_until ? "paused" : sub.status,
          months_billed: sub.cycles_billed,
          contract_months: sub.contract_length_months,
          next_payment: sub.current_period_end,
          schedule:
            sub.preferred_weekday !== null
              ? `${days[sub.preferred_weekday]}s at ${String(
                  sub.preferred_hour ?? 10
                ).padStart(2, "0")}:00`
              : null,
          started: sub.start_date,
          manage_at: "/account/membership",
        };
      }

      if (name === "my_bookings") {
        const { data: upcoming } = await context.client
          .from("bookings")
          .select("id, scheduled_at, status, address, packages(name), providers(display_name)")
          .in("status", ["offered", "declined", "scheduled", "in_progress", "needs_review"])
          .order("scheduled_at", { ascending: true })
          .limit(6);
        const remaining = Math.max(0, 6 - (upcoming?.length ?? 0));
        const { data: history } = remaining
          ? await context.client
              .from("bookings")
              .select("id, scheduled_at, status, address, packages(name), providers(display_name)")
              .in("status", ["completed", "cancelled"])
              .order("scheduled_at", { ascending: false })
              .limit(remaining)
          : { data: [] };
        const rows = [...(upcoming ?? []), ...(history ?? [])];
        const statuses = await Promise.all(
          rows.map((booking) => getVisitStatus(context.client!, booking.id)),
        );
        return {
          signed_in: true,
          bookings: rows.map((b, index) => {
            const p = b.packages as
              | { name: string }
              | { name: string }[]
              | null;
            const provider = one(b.providers as never) as {
              display_name: string | null;
            } | null;
            const projected = statuses[index];
            return {
              booking_id: b.id,
              service: (Array.isArray(p) ? p[0]?.name : p?.name) ?? "Service",
              when: b.scheduled_at,
              status: b.status,
              headline: projected?.headline ?? "Status unavailable",
              waiting_on: projected?.nextActorLabel ?? null,
              money: projected?.money.label ?? null,
              provider: provider?.display_name ?? null,
              postcode: postcodeFromAddress(b.address),
              details_at: `/account/visit/${b.id}`,
            };
          }),
        };
      }

      if (name === "my_jobs") {
        const { data } = await context.client
          .from("bookings")
          .select("scheduled_at, status, address, packages(name)")
          .order("scheduled_at", { ascending: true })
          .limit(10);

        const { data: offers } = await context.client
          .from("booking_offers")
          .select("status")
          .eq("status", "open");

        return {
          signed_in: true,
          open_offers: (offers ?? []).length,
          jobs: (data ?? []).map((b) => {
            const p = b.packages as
              | { name: string }
              | { name: string }[]
              | null;
            return {
              service: (Array.isArray(p) ? p[0]?.name : p?.name) ?? "Service",
              when: b.scheduled_at,
              status: b.status,
              postcode: postcodeFromAddress(b.address),
            };
          }),
          see_offers_at: "/worker",
        };
      }

      if (name === "my_earnings") {
        const { data: prov } = await context.client
          .from("providers")
          .select("rating_avg, rating_count, joining_fee_paid, vetting_status")
          .eq("profile_id", user.id)
          .maybeSingle();

        const { data } = await context.client
          .from("payments")
          .select("split_breakdown, status, kind");

        const share = (p: { split_breakdown: unknown }) =>
          Number(
            (p.split_breakdown as { provider?: number } | null)?.provider ?? 0
          );
        const rows = data ?? [];
        const paid = rows.filter(
          (p) => p.status === "succeeded" && p.kind !== "tip"
        );
        const pending = rows.filter((p) => p.status === "pending");
        const tips = rows.filter(
          (p) => p.kind === "tip" && p.status === "succeeded"
        );

        return {
          signed_in: true,
          account_active: prov?.joining_fee_paid === true,
          approved: prov?.vetting_status === "approved",
          paid_gbp: Number(paid.reduce((s, p) => s + share(p), 0).toFixed(2)),
          pending_gbp: Number(
            pending.reduce((s, p) => s + share(p), 0).toFixed(2)
          ),
          tips_gbp: Number(tips.reduce((s, p) => s + share(p), 0).toFixed(2)),
          visits_completed: paid.length,
          rating: prov?.rating_avg ? Number(prov.rating_avg) : null,
          rating_count: prov?.rating_count ?? 0,
          detail_at: "/worker/earnings",
          note: "Paid automatically after checking out of each visit.",
        };
      }

      if (name === "my_availability") {
        const { data: prov } = await context.client
          .from("providers")
          .select("id, joining_fee_paid, vetting_status, services")
          .eq("profile_id", user.id)
          .maybeSingle();

        if (!prov) return { signed_in: true, is_provider: false };

        const { data: avail } = await context.client
          .from("provider_availability")
          .select("weekday, start_time, end_time")
          .eq("provider_id", prov.id);

        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return {
          signed_in: true,
          is_provider: true,
          account_active: prov.joining_fee_paid,
          approved: prov.vetting_status === "approved",
          skills: prov.services ?? [],
          hours: (avail ?? []).map(
            (a) =>
              `${days[a.weekday]} ${String(a.start_time).slice(0, 5)}–${String(
                a.end_time
              ).slice(0, 5)}`
          ),
          change_at: "/worker/availability",
        };
      }

      // my_spend
      const { data } = await context.client
        .from("payments")
        .select("gross_amount, status, kind")
        .eq("status", "succeeded");
      const visits = (data ?? []).filter((p) => p.kind !== "tip");
      const total = (data ?? []).reduce(
        (s, p) => s + Number(p.gross_amount ?? 0),
        0
      );
      return {
        signed_in: true,
        visits_paid: visits.length,
        total_spent_gbp: Number(total.toFixed(2)),
      };
    }

    return { error: "Unknown tool" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Tool failed" };
  }
}

/* ------------------------------------------------------------------ */

async function embed(text: string) {
  const res = await fetch(
    `${API}/${EMBED_MODEL}:embedContent?key=${process.env.GEMINI_API_KEY}`,
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

async function generateWithFallback(body: unknown) {
  const models = [
    CHAT_MODEL,
    ...(CHAT_MODEL === "gemini-3.5-flash-lite"
      ? []
      : ["gemini-3.5-flash-lite"]),
  ];
  let lastError = "Gemini request failed";

  for (const model of models) {
    const response = await fetch(
      `${API}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) {
      return { ok: true as const, json: await response.json(), model };
    }

    lastError = await response.text();
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
  }

  return { ok: false as const, error: lastError };
}

function systemPrompt(context: string, role: string) {
  const now = new Date();
  const who =
    role === "provider"
      ? `You are talking to a PROVIDER — a cleaner or massage therapist who works through the platform. Answer from their side: their jobs, earnings, availability, how and when they get paid, the £150 joining fee, approval. Never try to sell them a customer booking or a membership. Their pages are /worker (jobs), /worker/current (live job), /worker/earnings, /worker/availability, /worker/profile.`
      : role === "admin"
      ? `You are talking to an ADMIN of the platform. Be brief and factual. Their tools are at /admin.`
      : role === "client"
      ? `You are talking to a signed-in CUSTOMER. You can inspect their own bookings, status, money state, membership and spend. You can prepare booking, cancellation, reschedule and booking-help actions for their explicit confirmation.`
      : `You are talking to a VISITOR who isn't signed in. You can answer general questions, but for anything about their own account tell them to log in at /login. If they want to work for us, point them to /provider/join.`;

  return `You are the support assistant for Opulence Bliss, a premium home cleaning and in-home massage marketplace in London.

${who}

Today is ${now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })}. The current time is ${now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })} UK time. Work out relative dates like "in 3 days" or "Friday" from this.

Use tools rather than guessing. If someone asks about their account, status, price, coverage, availability or a booking action, call the relevant tool. Never infer a booking ID: call my_bookings and disambiguate if more than one booking could match.

There are two ways customers pay: a single visit at /book, or a monthly membership at /subscribe with a three-month minimum term. Both exist — never say one of them isn't offered.

You are an action-capable concierge with a strict confirmation boundary:
- For a new booking, gather service, postcode and time, list permitted appointment times, then call prepare_booking. Do not claim a worker is already free: matching starts after booking. The customer must review and pay on the secure page; never say the booking is complete before that.
- For cancellation, call prepare_cancel_booking only after the customer clearly asks. The returned button is the confirmation. Never say cancelled until the tool result after the button is pressed says it succeeded.
- For rescheduling, call reschedule_options, let the customer choose an exact returned time, then call prepare_reschedule_booking. The appointment window and minimum notice are enforced again at confirmation.
- If rescheduling is blocked or the customer explicitly wants a person, call prepare_booking_help_request. Never claim a human request was sent until its confirmation succeeds.
- Providers may ask about jobs, offers, earnings and availability. Do not perform check-in, check-out, accept, decline or withdrawal in chat; direct them to the relevant worker page because those flows require dedicated safety/location controls.

Rules:
- Write links as plain paths only, e.g. /book?service=abc&pc=SW3%201AA&slot=... — never use markdown link syntax with square brackets, and never write http:// or a domain.
- Rely on the CONTEXT below and your tool results. Never invent prices, policies or availability.
- Treat unresolved commercial rules as unknown; do not turn current technical behaviour into a legal promise.
- If you don't know, say so. For a booking-specific issue, offer the confirmed resolution-desk request; for a general issue, explain that the public support channel is still being finalised.
- Warm, brief, practical. Two or three sentences is usually plenty. Plain text, no markdown, no asterisks.
- Give times as friendly UK times, e.g. "Monday 3 August at 3:00pm".
- End with a useful next step and the relevant page path. Never invent a page.
- British English, pounds sterling.
- Never ask for card details, passwords or full street addresses.
- For immediate danger or a medical emergency, tell them to call 999. For injury, damage, safeguarding, complaints or disputes, do not decide fault or money; direct them to a person and the resolution process.

CONTEXT:
${context}`;
}

export async function POST(req: NextRequest) {
  try {
    // Who are we talking to? Prefer the token the browser sent; fall back to
    // cookies if it's missing.
    const bearer =
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;

    let client: SupabaseClient | null = asUser(bearer);
    if (!client) {
      try {
        client = (await createServerClient()) as unknown as SupabaseClient;
      } catch {
        client = null;
      }
    }

    let role = "guest";
    let user: User | null = null;
    if (client) {
      try {
        const auth = await client.auth.getUser();
        user = auth.data.user;
        if (user) {
          const { data: me } = await client
            .from("profiles")
            .select("role")
            .eq("id", user.id)
            .maybeSingle();
          role = me?.role === "customer" ? "client" : (me?.role ?? "client");
        }
      } catch {
        /* stay a guest */
      }
    }

    const agentContext: AgentContext = {
      origin: req.nextUrl.origin,
      client,
      user,
      role,
    };

    const payload = await req.json();
    const actionToken = String(payload.actionToken ?? "").trim();
    if (actionToken) {
      try {
        const result = await executeConfirmedAction(agentContext, actionToken);
        return NextResponse.json(
          { reply: result.message, actionCompleted: result.ok },
          { status: result.ok ? 200 : 409 },
        );
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "That action could not be confirmed.",
          },
          { status: 400 },
        );
      }
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "The assistant isn't configured yet." },
        { status: 500 },
      );
    }

    const { message, history } = payload;
    const question = String(message ?? "").trim().slice(0, 500);
    if (!question) {
      return NextResponse.json({ error: "Ask me something!" }, { status: 400 });
    }

    // Retrieve relevant knowledge. Tool results remain the source of truth for
    // live prices, availability and personal account data.
    let knowledge = "No additional knowledge article matched this question.";
    try {
      const vector = await embed(question);
      const { data: matches } = await admin.rpc("match_ai_docs", {
        query_embedding: vector,
        match_count: 7,
      });
      if (matches?.length) {
        knowledge = matches
          .map(
            (match: { title: string; content: string }) =>
              `[${match.title}] ${match.content}`,
          )
          .join("\n\n");
      }
    } catch (error) {
      console.error("Retrieval failed:", error);
    }

    const past = Array.isArray(history) ? history.slice(-6) : [];
    const contents: unknown[] = [
      ...past.map((m: { role: string; text: string }) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.text).slice(0, 500) }],
      })),
      { role: "user", parts: [{ text: question }] },
    ];

    const body = () => ({
      systemInstruction: { parts: [{ text: systemPrompt(knowledge, role) }] },
      contents,
      tools: toolsFor(role),
      generationConfig: {
        maxOutputTokens: 1400,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });

    let pendingAction: AssistantAction | undefined;

    // Tool loop — enough for lookup → options → confirmation preparation.
    for (let round = 0; round < 5; round++) {
      const generated = await generateWithFallback(body());
      if (!generated.ok) {
        console.error("Gemini error:", generated.error);
        return NextResponse.json(
          { error: "The assistant is unavailable right now." },
          { status: 502 }
        );
      }

      const json = generated.json;
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter(
        (p: { functionCall?: unknown }) => p.functionCall
      );

      if (calls.length === 0) {
        const reply = parts
          .map((p: { text?: string }) => p.text ?? "")
          .join("")
          .trim();
        return NextResponse.json({
          reply:
            reply ||
            "Sorry, I couldn't work that one out. Please contact the Opulence Bliss team.",
          ...(pendingAction ? { action: pendingAction } : {}),
        });
      }

      // Run whatever it asked for, then let it answer.
      contents.push({ role: "model", parts });

      const responses: unknown[] = [];
      for (const c of calls) {
        const fc = c.functionCall as {
          name: string;
          args?: Record<string, unknown>;
          id?: string;
        };
        const result = await runTool(fc.name, fc.args ?? {}, agentContext);
        if (result.client_action) pendingAction = result.client_action;
        const safeResult = { ...result };
        delete safeResult.client_action;
        responses.push({
          functionResponse: {
            ...(fc.id ? { id: fc.id } : {}),
            name: fc.name,
            response: { result: safeResult },
          },
        });
      }
      contents.push({ role: "user", parts: responses });
    }

    return NextResponse.json({
      reply:
        "I couldn't quite pin that down. Try /book to choose an appointment time, or ask me something more specific.",
      ...(pendingAction ? { action: pendingAction } : {}),
    });
  } catch (e) {
    console.error("Chat error:", e);
    return NextResponse.json(
      { error: "Sorry, something went wrong. Try again in a moment." },
      { status: 500 }
    );
  }
}
