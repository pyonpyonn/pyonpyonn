// SETUP: mkdir -p "app/api/client-signup" && code "app/api/client-signup/route.ts"
//
// Create a customer account AND their profile in one go, from inside the
// booking flow. No confirmation email — they're mid-purchase.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { fullName, email, password, phone, address, postcode } =
      await req.json();

    if (!fullName || !email || !password) {
      return NextResponse.json(
        { error: "Please fill in your name, email and a password." },
        { status: 400 }
      );
    }
    if (String(password).length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    const { data: created, error } = await admin.auth.admin.createUser({
      email: String(email).trim(),
      password: String(password),
      email_confirm: true,
    });

    if (error || !created.user) {
      const msg = error?.message ?? "Could not create your account.";
      const exists = /already|exists|registered/i.test(msg);
      return NextResponse.json(
        {
          error: exists
            ? "There's already an account with that email — sign in instead."
            : msg,
          exists,
        },
        { status: 400 }
      );
    }

    // Profile, filled in properly from the start.
    await admin.from("profiles").upsert(
      {
        id: created.user.id,
        email: String(email).trim(),
        role: "customer",
        full_name: String(fullName).trim(),
        phone: phone ? String(phone).trim() : null,
        address: address ? String(address).trim() : null,
        postcode: postcode ? String(postcode).trim().toUpperCase() : null,
      },
      { onConflict: "id" }
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sign-up failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}