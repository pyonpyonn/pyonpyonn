"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

export default function TopBar() {
  const path = usePathname() ?? "";
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function load() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    setEmail(user?.email ?? null);

    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      setRole(profile?.role ?? null);
    } else {
      setRole(null);
    }
    setReady(true);
  }

  useEffect(() => {
    load();
    const { data: subscription } = supabase.auth.onAuthStateChange(() => load());
    const timer = setInterval(load, 30000);
    return () => {
      subscription.subscription.unsubscribe();
      clearInterval(timer);
    };
  }, []);

  if (
    !ready ||
    !email ||
    path.startsWith("/worker") ||
    path.startsWith("/admin") ||
    path.startsWith("/account")
  )
    return null;

  const label =
    role === "admin" ? "Admin" : role === "provider" ? "Provider" : "Signed in";

  return (
    <div className="strip">
      <span>
        {label} · <strong>{email}</strong>
      </span>
      <button
        onClick={async () => {
          await supabase.auth.signOut();
          window.location.href = "/";
        }}
      >
        Sign out
      </button>
      <style jsx>{`
        .strip {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          flex-wrap: wrap;
          padding: 7px 20px;
          background: var(--ob-surface-soft);
          border-bottom: 1px solid var(--ob-border);
          color: var(--ob-muted);
          font-family: var(--font-nunito), "Nunito", system-ui, sans-serif;
          font-size: 13px;
        }
        strong {
          color: var(--ob-text);
          font-weight: 800;
        }
        button {
          padding: 0;
          border: 0;
          background: none;
          color: var(--ob-muted);
          font: inherit;
          font-weight: 800;
          cursor: pointer;
        }
        button:hover {
          color: var(--ob-purple);
        }
      `}</style>
    </div>
  );
}
