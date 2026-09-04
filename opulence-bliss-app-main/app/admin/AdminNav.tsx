"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const LINKS = [
  ["/admin", "Overview"],
  ["/admin/bookings", "Bookings & schedule"],
  ["/admin/customers", "Customers"],
  ["/admin/cleaners", "Cleaners"],
  ["/admin/review", "Reports"],
] as const;

export default function AdminNav({ email }: { email: string }) {
  const pathname = usePathname();

  return (
    <nav className="admin-nav" aria-label="Admin navigation">
      <div className="admin-brand">
        <Link href="/admin">OB Admin</Link>
        <span>{email}</span>
      </div>
      <div className="admin-links">
        {LINKS.map(([href, label]) => {
          const active =
            href === "/admin" ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={active ? "active" : ""}>
              {label}
            </Link>
          );
        })}
      </div>
      <button
        type="button"
        onClick={async () => {
          await createClient().auth.signOut();
          window.location.href = "/admin/login";
        }}
      >
        Sign out
      </button>

      <style jsx>{`
        .admin-nav {
          display: flex;
          align-items: center;
          gap: 18px;
          width: min(1180px, calc(100% - 32px));
          box-sizing: border-box;
          margin: 18px auto 28px;
          padding: 12px 14px;
          border: 1px solid #e5e7eb;
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 8px 24px rgba(22, 32, 42, 0.06);
          font-family: "Nunito", system-ui, sans-serif;
        }
        .admin-brand {
          min-width: 145px;
        }
        .admin-brand :global(a) {
          display: block;
          color: #16202a;
          font-size: 16px;
          font-weight: 900;
          text-decoration: none;
        }
        .admin-brand span {
          display: block;
          max-width: 180px;
          overflow: hidden;
          color: #7a828c;
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .admin-links {
          display: flex;
          flex: 1;
          gap: 5px;
          overflow-x: auto;
        }
        .admin-links :global(a) {
          border-radius: 9px;
          padding: 8px 11px;
          color: #58616d;
          font-size: 12.5px;
          font-weight: 800;
          text-decoration: none;
          white-space: nowrap;
        }
        .admin-links :global(a.active) {
          background: #f4ecfe;
          color: #6d28d9;
        }
        button {
          border: 1px solid #e5e7eb;
          border-radius: 999px;
          padding: 8px 12px;
          background: #fff;
          color: #58616d;
          font: inherit;
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
          white-space: nowrap;
        }
        @media (max-width: 760px) {
          .admin-nav {
            align-items: stretch;
            flex-wrap: wrap;
          }
          .admin-brand {
            flex: 1;
          }
          .admin-links {
            order: 3;
            width: 100%;
          }
        }
      `}</style>
    </nav>
  );
}
