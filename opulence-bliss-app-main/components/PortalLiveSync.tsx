"use client";

// Keeps the server-rendered customer and provider portals in step with the
// other participant. Cross-portal booking actions always create a notification
// for the affected user, so that row is the lightweight refresh signal.

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
const FALLBACK_MS = 60_000;
const FOCUS_STALE_MS = 5_000;
const DEBOUNCE_MS = 350;

export default function PortalLiveSync({ userId }: { userId: string }) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshRef = useRef(Date.now());

  const refresh = useCallback(
    (notify = false) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        lastRefreshRef.current = Date.now();
        router.refresh();
        if (notify) window.dispatchEvent(new Event("opulence:notification"));
      }, DEBOUNCE_MS);
    },
    [router],
  );

  useEffect(() => {
    const channel = supabase
      .channel(`portal-live:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => refresh(true),
      )
      .subscribe();

    const refreshIfVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastRefreshRef.current >= FOCUS_STALE_MS
      ) {
        refresh();
      }
    };
    const refreshNow = () => refresh();

    const fallback = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, FALLBACK_MS);

    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener("online", refreshIfVisible);
    window.addEventListener("opulence:refresh", refreshNow);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      window.clearInterval(fallback);
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener("online", refreshIfVisible);
      window.removeEventListener("opulence:refresh", refreshNow);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      void supabase.removeChannel(channel);
    };
  }, [refresh, userId]);

  return null;
}
