"use client";

// One immutable thread per booking. Used by customers and providers with
// role-specific quick replies.

import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
const GRAD = "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)";
const PURPLE = "#6D28D9";

type Msg = {
  id: number;
  sender_id: string;
  sender_role: "customer" | "provider" | "admin";
  body: string;
  created_at: string;
  read_at: string | null;
};

const QUICK: Record<"customer" | "provider", string[]> = {
  customer: [
    "The key is under the mat",
    "Please ring the bell, don't knock",
    "I have a dog — she's friendly",
    "Running late, please wait 10 minutes",
  ],
  provider: [
    "On my way",
    "Running late?",
    "I'm outside",
    "All finished — thank you",
  ],
};

const DIALOG_QUICK: Record<"customer" | "provider", string[]> = {
  customer: ["See you soon!", "Thanks!", "Sounds good!"],
  provider: ["Running late?", "On my way", "I'm outside", "All finished — thank you"],
};

function when(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return today
    ? time
    : `${d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      })}, ${time}`;
}

export default function MessageThread({
  bookingId,
  viewerRole,
  closed = false,
  bare = false,
}: {
  bookingId: string;
  viewerRole: "customer" | "provider";
  closed?: boolean;
  bare?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    setMe(user?.id ?? null);

    const { data, error: loadError } = await supabase
      .from("booking_messages")
      .select("id, sender_id, sender_role, body, created_at, read_at")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: true });

    if (loadError) {
      setError(loadError.message);
      setLoaded(true);
      return;
    }

    setMessages((data ?? []) as Msg[]);
    setLoaded(true);

    if (
      user &&
      (bare || !minimized) &&
      (data ?? []).some(
        (message) => message.sender_id !== user.id && !message.read_at,
      )
    ) {
      await supabase.rpc("mark_messages_read", { p_booking_id: bookingId });
    }
  }, [bare, bookingId, minimized]);

  useEffect(() => {
    void load();
    const channel = supabase
      .channel(`booking-messages:${bookingId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "booking_messages",
          filter: `booking_id=eq.${bookingId}`,
        },
        () => void load(),
      )
      .subscribe();

    // Recovery path for a sleeping tab or a temporarily dropped socket.
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [bookingId, load]);

  useEffect(() => {
    if (messages.length) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || closed) return;

    setBusy(true);
    setError(null);

    const { error: sendError } = await supabase.rpc("send_booking_message", {
      p_booking_id: bookingId,
      p_body: trimmed,
    });

    setBusy(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }

    setBody("");
    await load();
  }

  const other = viewerRole === "customer" ? "your provider" : "your customer";
  const unread = messages.filter(
    (message) => message.sender_id !== me && !message.read_at,
  ).length;

  return (
    <section style={bare ? bareCard : card}>
      {!bare && (
        <div style={{ ...head, marginBottom: minimized ? 0 : 12 }}>
          <div style={{ minWidth: 0 }}>
            <strong style={title}>Messages</strong>
            <span style={sub}>
              {minimized
                ? `${messages.length} message${messages.length === 1 ? "" : "s"}`
                : "Stays on the platform — no phone numbers shared"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMinimized((value) => !value)}
            aria-expanded={!minimized}
            style={toggle}
          >
            {minimized
              ? `Open chat${unread > 0 ? ` (${unread})` : ""}`
              : "Minimise"}
          </button>
        </div>
      )}

      {(bare || !minimized) && (
        <>
          <div
            style={bare ? { ...log, maxHeight: "min(52vh, 520px)" } : log}
            aria-live="polite"
          >
            {!loaded ? (
              <p style={muted}>Loading…</p>
            ) : messages.length === 0 ? (
              <p style={muted}>
                Nothing yet. Anything {other} should know before the visit?
              </p>
            ) : (
              messages.map((message) => {
                const mine = message.sender_id === me;
                const fromAdmin = message.sender_role === "admin";
                return (
                  <div
                    key={message.id}
                    style={{
                      display: "flex",
                      justifyContent: mine ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        ...bubble,
                        background: fromAdmin
                          ? "#FFF3D6"
                          : bare
                            ? mine
                              ? "var(--ob-purple-soft)"
                              : "var(--ob-surface-soft)"
                            : mine
                              ? "#16202A"
                              : "#F2F3F5",
                        color: fromAdmin
                          ? "#8A5A00"
                          : bare
                            ? mine
                              ? "var(--ob-purple)"
                              : "var(--ob-text)"
                            : mine
                              ? "#fff"
                              : "#16202A",
                        borderBottomRightRadius: mine ? 5 : 16,
                        borderBottomLeftRadius: mine ? 16 : 5,
                      }}
                    >
                      {fromAdmin && <span style={badge}>Opulence Bliss</span>}
                      <span style={{ display: "block" }}>{message.body}</span>
                      <span
                        style={{
                          ...stamp,
                          color:
                            bare && mine
                              ? "var(--ob-purple)"
                              : mine
                                ? "rgba(255,255,255,0.6)"
                                : "#A9AFB7",
                          opacity: bare && mine ? 0.7 : 1,
                        }}
                      >
                        {when(message.created_at)}
                        {mine && message.read_at ? " · read" : ""}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>

          {closed ? (
            <p style={{ ...muted, marginTop: 12 }}>
              This booking is closed. Contact support if you still need help.
            </p>
          ) : (
            <>
              <div style={chips}>
                {(bare ? DIALOG_QUICK : QUICK)[viewerRole].map((reply) => (
                  <button
                    key={reply}
                    type="button"
                    style={reply === "Running late?" ? lateChip : chip}
                    disabled={busy}
                    onClick={() => {
                      if (viewerRole === "provider" && reply === "Running late?") {
                        window.dispatchEvent(
                          new CustomEvent("opulence:report-delay", {
                            detail: { bookingId },
                          }),
                        );
                        return;
                      }
                      void send(reply);
                    }}
                  >
                    {reply}
                  </button>
                ))}
              </div>

              <div style={composer}>
                <input
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void send(body);
                  }}
                  placeholder={`Message ${other}…`}
                  aria-label="Your message"
                  disabled={busy}
                  maxLength={2000}
                  style={input}
                />
                <button
                  type="button"
                  onClick={() => void send(body)}
                  disabled={busy || !body.trim()}
                  style={{
                    ...sendBtn,
                    ...(bare
                      ? { width: 46, height: 46, padding: 0, borderRadius: 999 }
                      : {}),
                    opacity: busy || !body.trim() ? 0.45 : 1,
                  }}
                  aria-label="Send message"
                >
                  {bare ? <Send size={19} /> : "Send"}
                </button>
              </div>
            </>
          )}

          {error && <p style={errStyle}>{error}</p>}
        </>
      )}
    </section>
  );
}

const card: React.CSSProperties = {
  background: "#fff",
  border: "2px solid #EDEFF1",
  borderRadius: 20,
  padding: "18px 20px",
  fontFamily: "'Nunito', system-ui, sans-serif",
};
const bareCard: React.CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  fontFamily: "'Nunito', system-ui, sans-serif",
};
const head: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
};
const title: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 900,
  color: "#16202A",
  display: "block",
};
const sub: React.CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 600,
  color: "#A9AFB7",
};
const toggle: React.CSSProperties = {
  flexShrink: 0,
  background: "#F4ECFE",
  border: "1px solid #E2D2FA",
  borderRadius: 999,
  color: PURPLE,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 900,
  padding: "7px 11px",
};
const log: React.CSSProperties = {
  display: "grid",
  gap: 8,
  maxHeight: 320,
  overflowY: "auto",
  padding: "4px 2px",
};
const bubble: React.CSSProperties = {
  maxWidth: "82%",
  padding: "10px 14px",
  borderRadius: 16,
  fontSize: 14.5,
  fontWeight: 600,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
const badge: React.CSSProperties = {
  display: "block",
  fontSize: 10.5,
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  marginBottom: 3,
  opacity: 0.75,
};
const stamp: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 700,
  marginTop: 4,
};
const muted: React.CSSProperties = {
  color: "#A9AFB7",
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
  textAlign: "center",
  padding: "14px 0",
};
const chips: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  margin: "12px 0 10px",
  paddingTop: 12,
  borderTop: "1px solid #F1F2F4",
};
const chip: React.CSSProperties = {
  background: "#F8F5FF",
  border: "1.5px solid #E8DCFA",
  borderRadius: 999,
  padding: "7px 13px",
  fontFamily: "inherit",
  fontSize: 12.5,
  fontWeight: 800,
  color: PURPLE,
  cursor: "pointer",
};
const lateChip: React.CSSProperties = {
  ...chip,
  background: "#FFF3CD",
  borderColor: "#F2B84B",
  color: "#8A5A00",
  boxShadow: "0 3px 10px rgba(242,184,75,0.16)",
};
const composer: React.CSSProperties = { display: "flex", gap: 8 };
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "2px solid #EDEFF1",
  borderRadius: 999,
  padding: "11px 16px",
  fontFamily: "inherit",
  fontSize: 15,
  fontWeight: 600,
  color: "#16202A",
};
const sendBtn: React.CSSProperties = {
  background: GRAD,
  color: "#fff",
  border: "none",
  borderRadius: 999,
  padding: "11px 20px",
  fontFamily: "inherit",
  fontSize: 14.5,
  fontWeight: 900,
  cursor: "pointer",
};
const errStyle: React.CSSProperties = {
  background: "#FFE6EA",
  color: "#B0384F",
  padding: "10px 13px",
  borderRadius: 11,
  fontSize: 13.5,
  fontWeight: 700,
  margin: "10px 0 0",
};
