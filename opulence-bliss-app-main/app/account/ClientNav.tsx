"use client";

// SETUP: mkdir -p "app/account" && code "app/account/ClientNav.tsx"

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, LogOut, Plus, Store } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

const PURPLE = "var(--ob-purple)";
const GRAD = "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)";
const INK = "var(--ob-text)";
const MUTED = "var(--ob-muted)";

type Item = {
  href: string;
  label: string;
  short: string;
  icon: string;
  exact?: boolean;
};

const ITEMS: Item[] = [
  {
    href: "/account",
    label: "My bookings",
    short: "Visits",
    icon: "◫",
    exact: true,
  },
  {
    href: "/account/membership",
    label: "Membership",
    short: "Plan",
    icon: "★",
  },
  { href: "/account/profile", label: "My details", short: "You", icon: "☺" },
  { href: "/account/updates", label: "Updates", short: "News", icon: "✦" },
];

export default function ClientNav({
  name,
  email,
}: {
  name: string;
  email: string;
}) {
  const path = usePathname() ?? "";
  const [hover, setHover] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    setCollapsed(localStorage.getItem("opulence-account-nav") !== "expanded");
  }, []);

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

  const isOn = (i: Item) =>
    i.exact ? path === i.href : path.startsWith(i.href);

  const first = (name || email || "Y").trim().charAt(0).toUpperCase();

  function toggleSidebar() {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem(
        "opulence-account-nav",
        next ? "collapsed" : "expanded",
      );
      return next;
    });
  }

  return (
    <>
      {/* ---------------- desktop sidebar ---------------- */}
      <aside className={collapsed ? "side collapsed" : "side"}>
        <div className="nav-head">
          <Link href="/" style={brand} aria-label="Opulence Bliss home">
            <span className="full-brand">
              opulence<span style={{ color: PURPLE }}>bliss</span>
            </span>
            <span className="mini-brand">ob</span>
          </Link>
          <button
            type="button"
            className="collapse-toggle"
            onClick={toggleSidebar}
            aria-label={
              collapsed ? "Expand account menu" : "Minimise account menu"
            }
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <div style={profile}>
          <div style={avatar}>{first}</div>
          <div className="nav-copy" style={{ minWidth: 0 }}>
            <div style={pName}>{name || "Your account"}</div>
            <div style={pMeta}>{email}</div>
          </div>
        </div>

        <div className="nav-copy" style={sectionLabel}>
          My account
        </div>

        <nav style={{ display: "grid", gap: 4 }}>
          {ITEMS.map((i) => {
            const on = isOn(i);
            const hot = hover === i.href;
            return (
              <Link
                key={i.href}
                href={i.href}
                prefetch
                title={collapsed ? i.label : undefined}
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
                <span className="nav-copy" style={{ flex: 1 }}>
                  {i.label}
                </span>
                {i.href === "/account/updates" && unread > 0 && (
                  <span className="nav-count" style={pill}>
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <Link
          href="/book"
          style={bookBtn}
          className="book-service"
          aria-label="Book a service"
          title={collapsed ? "Book a service" : undefined}
        >
          {collapsed ? <Plus size={19} /> : "Book a service"}
        </Link>

        <div style={foot}>
          <button
            style={footBtn}
            className="foot-action"
            title={collapsed ? "Sign out" : undefined}
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/";
            }}
          >
            <LogOut size={16} />
            <span className="nav-copy">Sign out</span>
          </button>
          <Link
            href="/"
            style={footBtn}
            className="foot-action"
            title={collapsed ? "Browse the site" : undefined}
          >
            <Store size={16} />
            <span className="nav-copy">Browse the site</span>
          </Link>
        </div>
      </aside>

      {/* ---------------- mobile top ---------------- */}
      <div className="mtop">
        <Link href="/" style={{ ...brand, fontSize: 20 }}>
          opulence<span style={{ color: PURPLE }}>bliss</span>
        </Link>
        <Link href="/book" style={mBook}>
          Book
        </Link>
      </div>

      {/* ---------------- mobile bottom tabs ---------------- */}
      <nav className="tabs">
        {ITEMS.map((i) => {
          const on = isOn(i);
          return (
            <Link
              key={i.href}
              href={i.href}
              prefetch
              style={{ ...tab, color: on ? PURPLE : MUTED }}
            >
              <span style={{ ...tabIcon, position: "relative" }}>
                {i.icon}
                {i.href === "/account/updates" && unread > 0 && (
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
        .mini-brand {
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
            transition:
              width 0.22s ease,
              flex-basis 0.22s ease,
              padding 0.22s ease;
          }
          .side.collapsed {
            width: 82px;
            flex-basis: 82px;
            padding-left: 12px;
            padding-right: 12px;
            align-items: center;
          }
          .nav-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            width: 100%;
          }
          .collapse-toggle {
            display: grid;
            place-items: center;
            width: 30px;
            height: 30px;
            flex: 0 0 30px;
            border: 1px solid var(--ob-border);
            border-radius: 10px;
            background: var(--ob-surface-soft);
            color: var(--ob-text);
            cursor: pointer;
          }
          .collapse-toggle:hover {
            border-color: ${PURPLE};
            color: ${PURPLE};
          }
          .collapsed .full-brand,
          .collapsed .nav-copy {
            display: none;
          }
          .collapsed .mini-brand {
            display: inline;
            color: ${PURPLE};
            font-size: 19px;
            text-transform: lowercase;
          }
          .collapsed .nav-head {
            display: grid;
            justify-items: center;
          }
          .collapsed nav {
            width: 100%;
          }
          .collapsed nav a {
            justify-content: center;
            padding-left: 0 !important;
            padding-right: 0 !important;
            border-left-color: transparent !important;
          }
          .collapsed .nav-count {
            position: absolute;
            top: 3px;
            right: 2px;
            min-width: 17px !important;
            height: 17px !important;
            padding: 0 4px !important;
            font-size: 9px !important;
          }
          .collapsed .book-service {
            width: 44px;
            height: 44px;
            box-sizing: border-box;
            display: grid;
            place-items: center;
            padding: 0 !important;
          }
          .foot-action {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .collapsed .foot-action {
            width: 42px;
            height: 38px;
            box-sizing: border-box;
            justify-content: center;
            padding: 0 !important;
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
  background: GRAD,
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
  overflow: "hidden",
  textOverflow: "ellipsis",
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
  position: "relative",
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

const bookBtn: React.CSSProperties = {
  background: GRAD,
  color: "#fff",
  textAlign: "center",
  textDecoration: "none",
  fontWeight: 900,
  fontSize: 14.5,
  padding: "12px",
  borderRadius: 999,
  marginTop: 4,
};

const mBook: React.CSSProperties = {
  background: GRAD,
  color: "#fff",
  textDecoration: "none",
  fontWeight: 900,
  fontSize: 14,
  padding: "9px 18px",
  borderRadius: 999,
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
