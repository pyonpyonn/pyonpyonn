"use client";

// Notifications — everything that's happened on your bookings or jobs.
// Save at: app/notifications/page.tsx

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

type Note = {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  created_at: string;
};

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export default function NotificationsPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(true);

  async function load() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSignedIn(false);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("notifications")
      .select("id, title, body, href, read, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    setNotes(data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function markAll() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", user.id)
      .eq("read", false);
    load();
  }

  const unread = notes.filter((n) => !n.read).length;

  return (
    <main className="wrap">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Hanken+Grotesk:wght@400;500;600&display=swap"
      />

      <div className="inner">
        <p className="eyebrow">Updates</p>
        <h1>Notifications</h1>
        <p className="lede">
          {unread > 0 ? `${unread} unread` : "You're all caught up."}
        </p>

        {!signedIn ? (
          <div className="empty">
            <p>Log in to see your notifications.</p>
            <a className="cta" href="/login">
              Go to log in
            </a>
          </div>
        ) : loading ? (
          <p className="muted">Loading…</p>
        ) : notes.length === 0 ? (
          <div className="empty">Nothing yet. Activity will show up here.</div>
        ) : (
          <>
            {unread > 0 && (
              <button className="mark" onClick={markAll}>
                Mark all as read
              </button>
            )}
            <div className="list">
              {notes.map((n) => (
                <a
                  key={n.id}
                  href={n.href ?? "#"}
                  className={n.read ? "note" : "note new"}
                >
                  <div>
                    <strong>{n.title}</strong>
                    {n.body && <p>{n.body}</p>}
                  </div>
                  <span className="when">{ago(n.created_at)}</span>
                </a>
              ))}
            </div>
          </>
        )}

        <p className="links">
          <a href="/">← Back to site</a>
        </p>
      </div>

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          background: #fbf7f0;
          color: #26302a;
          font-family: "Hanken Grotesk", system-ui, sans-serif;
          padding: 0 20px 70px;
        }
        .inner {
          max-width: 620px;
          margin: 0 auto;
          padding-top: 40px;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.14em;
          font-size: 12px;
          font-weight: 600;
          color: #cf854f;
          margin: 0 0 6px;
        }
        h1 {
          font-family: "Fraunces", serif;
          font-weight: 500;
          font-size: 36px;
          color: #2f4a3a;
          margin: 0 0 6px;
        }
        .lede {
          color: #6e7a70;
          margin: 0 0 22px;
        }
        .mark {
          background: none;
          border: 1.5px solid #ece5d8;
          border-radius: 999px;
          padding: 8px 18px;
          font: inherit;
          font-size: 13.5px;
          color: #5b7a65;
          cursor: pointer;
          margin-bottom: 16px;
        }
        .mark:hover {
          border-color: #2f4a3a;
          color: #2f4a3a;
        }
        .list {
          display: grid;
          gap: 10px;
        }
        .note {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          background: #fff;
          border: 1px solid #ece5d8;
          border-left: 4px solid #ece5d8;
          border-radius: 12px;
          padding: 16px 18px;
          text-decoration: none;
          color: inherit;
        }
        .note:hover {
          border-color: #cf854f;
        }
        .note.new {
          border-left-color: #cf854f;
          background: #fffdfa;
        }
        .note strong {
          display: block;
          color: #2f4a3a;
          font-size: 15.5px;
          margin-bottom: 3px;
        }
        .note p {
          margin: 0;
          color: #6e7a70;
          font-size: 14px;
        }
        .when {
          color: #a89f90;
          font-size: 12.5px;
          white-space: nowrap;
        }
        .empty {
          background: #fff;
          border: 1.5px dashed #d8cfbe;
          border-radius: 14px;
          padding: 30px 24px;
          text-align: center;
          color: #6e7a70;
        }
        .cta {
          display: inline-block;
          margin-top: 14px;
          background: #2f4a3a;
          color: #fbf7f0;
          padding: 11px 24px;
          border-radius: 999px;
          text-decoration: none;
          font-weight: 600;
        }
        .muted {
          color: #6e7a70;
        }
        .links {
          margin-top: 28px;
        }
        .links a {
          color: #5b7a65;
          font-size: 14px;
          text-decoration: none;
        }
      `}</style>
    </main>
  );
}