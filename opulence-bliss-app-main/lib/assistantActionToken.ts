import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type AssistantMutation =
  | {
      type: "cancel_booking";
      bookingId: string;
      reason: string | null;
    }
  | {
      type: "reschedule_booking";
      bookingId: string;
      newSlot: string;
      reason: string;
      note: string | null;
    }
  | {
      type: "request_booking_help";
      bookingId: string;
      message: string;
    };

type SignedAssistantMutation = AssistantMutation & {
  version: 1;
  actionId: string;
  userId: string;
  expiresAt: number;
};

const MAX_AGE_MS = 10 * 60 * 1000;

function secret() {
  const value =
    process.env.AI_ACTION_SECRET ??
    process.env.CRON_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error("Assistant action signing is not configured");
  return value;
}

function signature(encoded: string) {
  return createHmac("sha256", secret()).update(encoded).digest("base64url");
}

export function signAssistantMutation(
  mutation: AssistantMutation,
  userId: string,
) {
  const payload: SignedAssistantMutation = {
    ...mutation,
    version: 1,
    actionId: randomUUID(),
    userId,
    expiresAt: Date.now() + MAX_AGE_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

export function verifyAssistantMutation(token: string, userId: string) {
  const [encoded, supplied] = token.split(".");
  if (!encoded || !supplied) throw new Error("This confirmation is invalid");

  const expected = signature(encoded);
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("This confirmation is invalid");
  }

  let payload: SignedAssistantMutation;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SignedAssistantMutation;
  } catch {
    throw new Error("This confirmation is invalid");
  }

  if (payload.version !== 1 || payload.userId !== userId) {
    throw new Error("This confirmation belongs to another session");
  }
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) {
    throw new Error("This confirmation has expired. Ask me to prepare it again");
  }
  if (
    !["cancel_booking", "reschedule_booking", "request_booking_help"].includes(
      payload.type,
    )
  ) {
    throw new Error("This confirmation is not supported");
  }

  return payload;
}
