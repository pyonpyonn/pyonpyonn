"use client";

// Tab navigation for the client / provider areas.
// Save at: components/AreaNav.tsx

import { usePathname } from "next/navigation";

const CLIENT = [
  { href: "/account", label: "My bookings" },
  { href: "/account/membership", label: "Membership" },
  { href: "/book", label: "Book a service" },
  { href: "/account/profile", label: "My details" },
  { href: "/notifications", label: "Updates" },
];

const PROVIDER = [
  { href: "/worker/current", label: "Current job" },
  { href: "/worker", label: "My jobs" },
  { href: "/worker/earnings", label: "Earnings" },
  { href: "/worker/availability", label: "Availability" },
  { href: "/worker/profile", label: "My profile" },
];

export default function AreaNav({ area }: { area: "client" | "provider" }) {
  const path = usePathname();
  const items = area === "client" ? CLIENT : PROVIDER;

  return (
    <nav className="tabs" aria-label={`${area} navigation`}>
      {items.map((i) => {
        const active =
          path === i.href ||
          (i.href !== "/account" && i.href !== "/worker" && path?.startsWith(i.href));
        return (
          <a key={i.href} href={i.href} className={active ? "tab on" : "tab"}>
            {i.label}
          </a>
        );
      })}

      <style jsx>{`
        .tabs {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin: 0 0 30px;
          font-family: "Hanken Grotesk", system-ui, sans-serif;
        }
        .tab {
          background: #fff;
          border: 1.5px solid #ece5d8;
          border-radius: 999px;
          padding: 10px 18px;
          font-size: 14px;
          font-weight: 500;
          color: #4a544c;
          text-decoration: none;
          transition: border-color 0.16s ease, background 0.16s ease,
            color 0.16s ease;
        }
        .tab:hover {
          border-color: #cf854f;
          color: #2f4a3a;
        }
        .tab.on {
          background: #2f4a3a;
          border-color: #2f4a3a;
          color: #fbf7f0;
          font-weight: 600;
        }
      `}</style>
    </nav>
  );
}