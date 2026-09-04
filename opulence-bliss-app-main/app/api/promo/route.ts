// Validate a promo code and preview the discount.
// Save at: app/api/promo/route.ts

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Keep in step with the checkout route.
export const PLATFORM_MARGIN_RATE = 0.2;

export function discountFor(
  grossPence: number,
  promo: { percent_off: number | null; amount_off: number | null }
) {
  const raw = promo.percent_off
    ? Math.round((grossPence * promo.percent_off) / 100)
    : Math.round(Number(promo.amount_off ?? 0) * 100);
  // Never eat into the provider's share — cap at the platform margin.
  const marginCap = Math.round(grossPence * PLATFORM_MARGIN_RATE);
  return Math.max(0, Math.min(raw, marginCap));
}

export async function POST(req: NextRequest) {
  try {
    const { code, packageId } = await req.json();
    const clean = String(code ?? "").trim().toUpperCase();
    if (!clean) {
      return NextResponse.json({ valid: false, error: "Enter a code." });
    }

    const { data: promo } = await admin
      .from("promo_codes")
      .select("code, description, percent_off, amount_off, active, expires_at, max_uses, uses")
      .eq("code", clean)
      .maybeSingle();

    if (!promo || !promo.active) {
      return NextResponse.json({ valid: false, error: "That code isn't valid." });
    }
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return NextResponse.json({ valid: false, error: "That code has expired." });
    }
    if (promo.max_uses !== null && promo.uses >= promo.max_uses) {
      return NextResponse.json({
        valid: false,
        error: "That code has been fully redeemed.",
      });
    }

    const { data: pkg } = await admin
      .from("packages")
      .select("price")
      .eq("id", packageId ?? "")
      .maybeSingle();

    if (!pkg) {
      return NextResponse.json({ valid: false, error: "Pick a service first." });
    }

    const gross = Math.round(Number(pkg.price) * 100);
    const discount = discountFor(gross, promo);

    if (discount <= 0) {
      return NextResponse.json({
        valid: false,
        error: "That code doesn't apply to this service.",
      });
    }

    return NextResponse.json({
      valid: true,
      code: promo.code,
      description: promo.description,
      discount: discount / 100,
      total: (gross - discount) / 100,
    });
  } catch {
    return NextResponse.json(
      { valid: false, error: "Couldn't check that code." },
      { status: 500 }
    );
  }
}