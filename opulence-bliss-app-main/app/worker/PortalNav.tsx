"use client";

// SETUP: mkdir -p "app/worker" && code "app/worker/PortalNav.tsx"
//
// Inline styles on purpose. Media queries only for showing/hiding.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

const PURPLE = "var(--ob-purple)";
const GRAD = "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)";
const INK = "var(--ob-text)";
const MUTED = "var(--ob-muted)";

type Item = { href: string; label: string; short: string; icon: string };

const ITEMS: Item[] = [
  { href: "/worker/current", label: "Current job", short: "Now", icon: "▶" },
  { href: "/worker", label: "Jobs", short: "Jobs", icon: "≡" },
  { href: "/worker/earnings", label: "My status", short: "Status", icon: "£" },
  {
    href: "/worker/availability",
    label: "Availability",
    short: "Hours",
    icon: "◷",
  },
  { href: "/worker/profile", label: "My profile", short: "You", icon: "☺" },
  { href: "/worker/updates", label: "Updates", short: "News", icon: "✦" },
];

export default function PortalNav({
  name,
  rating,
  ratingCount,
  registered,
  paid,
  approved,
  hasCurrentJob,
}: {
  name: string;
  rating: number | null;
  ratingCount: number;
  registered: boolean;
  paid: boolean;
  approved: boolean;
  hasCurrentJob: boolean;
}) {
  const path = usePathname() ?? "";
  const [hover, setHover] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let alive = true;
    async function count() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || !alive) return;
      const { count: n } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("read", false);
      if (alive) setUnread(n ?? 0);
    }
    count();
    const t = setInterval(count, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const locked = !registered || !paid;

  // Only show the live-job shortcut after the provider has checked in.
  const items = hasCurrentJob
    ? ITEMS
    : ITEMS.filter((i) => i.href !== "/worker/current");

  const status = !registered
    ? { text: "Not registered", bg: "var(--ob-blush)", fg: "var(--ob-danger-text)" }
    : !paid
      ? { text: "Fee unpaid", bg: "var(--ob-butter)", fg: "var(--ob-warning-text)" }
      : !approved
        ? { text: "Awaiting approval", bg: "var(--ob-butter)", fg: "var(--ob-warning-text)" }
        : { text: "Active", bg: "var(--ob-mint)", fg: "var(--ob-success-text)" };

  const isOn = (href: string) =>
    href === "/worker" ? path === "/worker" : path.startsWith(href);

  const first = (name || "P").trim().charAt(0).toUpperCase();

  return (
    <>
      {/* ================= DESKTOP SIDEBAR ================= */}
      <aside className="side">
        <Link href="/worker" style={brand}>
          opulence<span style={{ color: PURPLE }}>pro</span>
        </Link>

        <div style={profile}>
          <div style={avatar}>{first}</div>
          <div style={{ minWidth: 0 }}>
            <div style={pName}>{name || "Provider"}</div>
            <div style={pMeta}>
              {rating
                ? `${Number(rating).toFixed(1)} ★  ·  ${ratingCount} review${
                    ratingCount === 1 ? "" : "s"
                  }`
                : "No reviews yet"}
            </div>
          </div>
        </div>

        <span style={{ ...chip, background: status.bg, color: status.fg }}>
          {status.text}
        </span>

        <div style={sectionLabel}>Portal</div>

        <nav style={{ display: "grid", gap: 4 }}>
          {items.map((i) => {
            const on = isOn(i.href);
            const lock = locked && i.href !== "/worker";
            const hot = hover === i.href;

            if (lock) {
              return (
                <div
                  key={i.href}
                  style={{ ...row, color: MUTED, cursor: "not-allowed", opacity: 0.62 }}
                  title="Pay the £150 joining fee to unlock"
                >
                  <span
                    style={{
                      ...badge,
                      background: "var(--ob-surface-soft)",
                      color: MUTED,
                    }}
                  >
                    {i.icon}
                  </span>
                  <span style={{ flex: 1 }}>{i.label}</span>
                  <span style={{ fontSize: 12 }}>🔒</span>
                </div>
              );
            }

            return (
              <Link
                key={i.href}
                href={i.href}
                prefetch
                onMouseEnter={() => setHover(i.href)}
                onMouseLeave={() => setHover(null)}
                style={{
                  ...row,
                  background: on
                    ? "var(--ob-purple-soft)"
                    : hot
                      ? "var(--ob-surface-soft)"
                      : "transparent",
                  color: on ? PURPLE : INK,
                  borderLeft: on
                    ? `3px solid ${PURPLE}`
                    : "3px solid transparent",
                  paddingLeft: 10,
                }}
              >
                <span
                  style={{
                    ...badge,
                    background: on
                      ? "var(--ob-purple-soft)"
                      : "var(--ob-surface-soft)",
                    color: on ? PURPLE : MUTED,
                  }}
                >
                  {i.icon}
                </span>
                <span style={{ flex: 1 }}>{i.label}</span>
                {i.href === "/worker/updates" && unread > 0 && (
                  <span style={pill}>{unread}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {!registered && (
          <Link href="/provider/join" style={joinBtn}>
            Register as a provider
          </Link>
        )}

        <div style={foot}>
          <button
            style={footBtn}
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/";
            }}
          >
            Sign out
          </button>
          <Link href="/" style={footBtn}>
            Customer site →
          </Link>
        </div>
      </aside>

      {/* ================= MOBILE TOP ================= */}
      <div className="mtop">
        <Link href="/worker" style={{ ...brand, fontSize: 20 }}>
          opulence<span style={{ color: PURPLE }}>pro</span>
        </Link>
        <span style={{ ...chip, background: status.bg, color: status.fg }}>
          {status.text}
        </span>
      </div>

      {/* ================= MOBILE TABS ================= */}
      <nav className="tabs">
        {items.map((i) => {
          const on = isOn(i.href);
          const lock = locked && i.href !== "/worker";
          return lock ? (
            <div key={i.href} style={{ ...tab, color: MUTED, opacity: 0.58 }}>
              <span style={tabIcon}>🔒</span>
              {i.short}
            </div>
          ) : (
            <Link
              key={i.href}
              href={i.href}
              prefetch
              style={{ ...tab, color: on ? PURPLE : MUTED }}
            >
              <span style={{ ...tabIcon, position: "relative" }}>
                {i.icon}
                {i.href === "/worker/updates" && unread > 0 && (
                  <span style={tabDot} />
                )}
              </span>
              {i.short}
            </Link>
          );
        })}
      </nav>

      <style jsx>{`
        .side {
          display: none;
        }
        .mtop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 16px;
          background: var(--ob-surface-glass);
          border-bottom: 1px solid var(--ob-border);
          backdrop-filter: blur(18px) saturate(140%);
          position: sticky;
          top: 0;
          z-index: 30;
        }
        .tabs {
          display: flex;
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 60;
          background: var(--ob-surface-glass);
          border-top: 1px solid var(--ob-border);
          padding: 6px 4px 8px;
          box-shadow: 0 -8px 26px var(--ob-shadow-soft);
          backdrop-filter: blur(18px) saturate(140%);
        }
        @media (min-width: 900px) {
          .side {
            display: flex;
            flex-direction: column;
            gap: 14px;
            width: 250px;
            flex: 0 0 250px;
            height: 100vh;
            box-sizing: border-box;
            overflow-y: auto;
            padding: 24px 16px;
            background: var(--ob-surface-glass);
            border-right: 1px solid var(--ob-border);
            position: sticky;
            top: 0;
            align-self: flex-start;
            box-shadow: 10px 0 32px var(--ob-shadow-soft);
            backdrop-filter: blur(20px) saturate(145%);
          }
          .mtop,
          .tabs {
            display: none;
          }
        }
      `}</style>
    </>
  );
}

/* ---------- inline styles ---------- */

const brand: React.CSSProperties = {
  fontFamily: "'Nunito', system-ui, sans-serif",
  fontSize: 24,
  fontWeight: 900,
  letterSpacing: "-0.035em",
  lineHeight: 1,
  color: INK,
  textDecoration: "none",
  padding: "0 8px 4px",
};

const profile: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "12px 10px",
  background: "var(--ob-surface-soft)",
  border: "1px solid var(--ob-border)",
  borderRadius: 16,
};

const avatar: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: "50%",
  background: `linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)`,
  color: "#fff",
  display: "grid",
  placeItems: "center",
  fontWeight: 900,
  fontSize: 18,
  flexShrink: 0,
};

const pName: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: INK,
  lineHeight: 1.25,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const pMeta: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: MUTED,
};

const chip: React.CSSProperties = {
  alignSelf: "flex-start",
  fontSize: 12,
  fontWeight: 800,
  padding: "5px 12px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--ob-muted)",
  padding: "6px 10px 0",
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "10px 12px",
  borderRadius: 12,
  fontSize: 15,
  fontWeight: 800,
  textDecoration: "none",
  fontFamily: "'Nunito', system-ui, sans-serif",
};

const badge: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 9,
  display: "grid",
  placeItems: "center",
  fontSize: 13,
  fontWeight: 900,
  flexShrink: 0,
};

const joinBtn: React.CSSProperties = {
  background: `linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)`,
  color: "#fff",
  textAlign: "center",
  textDecoration: "none",
  fontWeight: 900,
  fontSize: 14.5,
  padding: "12px",
  borderRadius: 999,
  marginTop: 4,
};

const foot: React.CSSProperties = {
  marginTop: "auto",
  display: "grid",
  gap: 10,
  paddingTop: 16,
  borderTop: "1px solid var(--ob-border)",
};

const footBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "0 10px",
  textAlign: "left",
  fontFamily: "'Nunito', system-ui, sans-serif",
  fontSize: 13.5,
  fontWeight: 700,
  color: MUTED,
  textDecoration: "none",
  cursor: "pointer",
};

const tab: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
  fontWeight: 800,
  textDecoration: "none",
  padding: "4px 0",
  fontFamily: "'Nunito', system-ui, sans-serif",
};

const tabIcon: React.CSSProperties = { fontSize: 16, lineHeight: 1 };

const pill: React.CSSProperties = {
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 999,
  background: GRAD,
  color: "#fff",
  fontSize: 11,
  fontWeight: 900,
  display: "grid",
  placeItems: "center",
};

const tabDot: React.CSSProperties = {
  position: "absolute",
  top: -2,
  right: -6,
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#7B2FF7",
  boxShadow: "0 0 0 2px var(--ob-surface)",
};
