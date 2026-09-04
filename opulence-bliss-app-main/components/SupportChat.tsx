"use client";

// SETUP: mkdir -p "components" && code "components/SupportChat.tsx"
//
// Floating chat, bottom right.

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

const GRAD = "linear-gradient(135deg,#F5C542,#C86FC9 55%,#7B2FF7)";
const PURPLE = "#6D28D9";

type Msg = { role: "user" | "assistant"; text: string };

type AssistantAction =
  | {
      kind: "navigate";
      label: string;
      summary: string;
      href: string;
      tone: "primary" | "danger";
    }
  | {
      kind: "confirm";
      label: string;
      summary: string;
      confirmText: string;
      token: string;
      tone: "primary" | "danger";
    };

type ChatMsg = Msg & { action?: AssistantAction };

const SUGGESTIONS = [
  "What's my next booking status?",
  "Help me reschedule",
  "Book a service for me",
  "Cancel my next booking",
];

/* ---------- link handling ---------- */

const PATHS = [
  "provider/join",
  "account/updates",
  "account/membership",
  "account/profile",
  "worker/availability",
  "worker/earnings",
  "worker/profile",
  "worker/current",
  "providers",
  "subscribe",
  "account",
  "worker",
  "login",
  "book",
];

const LINK_RE = new RegExp(
  `\\[([^\\]]+)\\]\\(([^)]+)\\)|(https?://[^\\s)]+)|(/(?:${PATHS.join(
    "|",
  )})(?:\\?[^\\s)]*)?)`,
  "g",
);

function toPath(href: string) {
  try {
    if (/^https?:\/\//.test(href)) {
      const u = new URL(href);
      return u.pathname + u.search;
    }
  } catch {
    /* ignore */
  }
  return href;
}

function Linkified({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(LINK_RE.source, "g");

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const href = toPath(m[2] ?? m[3] ?? m[4] ?? "");
    const label = m[1] ?? href;
    const booking = href.startsWith("/book?");
    out.push(
      booking ? (
        <a key={m.index} href={href} className="confirm">
          Confirm &amp; pay →
        </a>
      ) : (
        <a key={m.index} href={href}>
          {label}
        </a>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/* ---------- widget ---------- */

export default function SupportChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      role: "assistant",
      text: "Hi! I can answer questions, find live times, check your booking and payment status, prepare a booking, or help you cancel and reschedule safely. What would you like to do?",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open]);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("opulence:open-support", show);
    return () => window.removeEventListener("opulence:open-support", show);
  }, []);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const history = msgs.slice(1);
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setBusy(true);

    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;

      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: question, history }),
      });
      const data = await res.json();
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          text:
            data.reply ??
            data.error ??
            "Sorry, I couldn't answer that. Please contact the team.",
          action: data.action,
        },
      ]);
    } catch {
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          text: "I couldn't reach the server. Try again shortly.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction(index: number, action: AssistantAction) {
    if (busy) return;
    if (action.kind === "navigate") {
      window.location.href = action.href;
      return;
    }
    if (!window.confirm(action.confirmText)) return;

    setBusy(true);
    setMsgs((current) =>
      current.map((message, messageIndex) =>
        messageIndex === index ? { ...message, action: undefined } : message,
      ),
    );

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ actionToken: action.token }),
      });
      const data = await response.json();
      setMsgs((current) => [
        ...current,
        {
          role: "assistant",
          text:
            data.reply ??
            data.error ??
            "That action could not be completed. Please try again.",
        },
      ]);
      if (response.ok && data.actionCompleted) {
        window.dispatchEvent(new Event("opulence:refresh"));
        window.dispatchEvent(new Event("opulence:notification"));
      }
    } catch {
      setMsgs((current) => [
        ...current,
        {
          role: "assistant",
          text: "I couldn't reach the server, so nothing was changed. Please try again.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- closed: the floating button ---------- */
  if (!open) {
    return (
      <div className="fabWrap">
        <span className="tip">Need a hand?</span>
        <button
          className="fab"
          onClick={() => setOpen(true)}
          aria-label="Open support chat"
        >
          <span className="ring" aria-hidden="true" />
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 3C6.9 3 3 6.4 3 10.6c0 2.3 1.2 4.3 3.1 5.7-.1 1-.5 2.3-1.4 3.4-.2.3.1.7.4.6 1.9-.5 3.4-1.4 4.3-2.1.8.2 1.7.3 2.6.3 5.1 0 9-3.4 9-7.9S17.1 3 12 3Z"
            />
            <circle cx="8.2" cy="10.6" r="1.15" fill="#fff" />
            <circle cx="12" cy="10.6" r="1.15" fill="#fff" />
            <circle cx="15.8" cy="10.6" r="1.15" fill="#fff" />
          </svg>
        </button>

        <style jsx>{`
          .fabWrap {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 9998;
            display: flex;
            align-items: center;
            gap: 10px;
            font-family: "Nunito", system-ui, sans-serif;
          }
          .tip {
            background: #16202a;
            color: #fff;
            font-size: 13px;
            font-weight: 800;
            padding: 8px 14px;
            border-radius: 999px;
            white-space: nowrap;
            opacity: 0;
            transform: translateX(8px);
            transition:
              opacity 0.2s ease,
              transform 0.2s ease;
            pointer-events: none;
          }
          .fabWrap:hover .tip {
            opacity: 1;
            transform: translateX(0);
          }
          .fab {
            position: relative;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            border: none;
            background: ${GRAD};
            color: #fff;
            display: grid;
            place-items: center;
            cursor: pointer;
            box-shadow: 0 10px 26px rgba(123, 47, 247, 0.34);
            animation: float 3.4s ease-in-out infinite;
          }
          .fab:hover {
            transform: scale(1.06);
          }
          .fab svg {
            position: relative;
            z-index: 1;
          }
          .ring {
            position: absolute;
            inset: -6px;
            border-radius: 50%;
            border: 2px solid rgba(123, 47, 247, 0.45);
            animation: pulse 2.6s ease-out infinite;
          }
          @keyframes float {
            0%,
            100% {
              transform: translateY(0);
            }
            50% {
              transform: translateY(-7px);
            }
          }
          @keyframes pulse {
            0% {
              transform: scale(0.9);
              opacity: 0.7;
            }
            70% {
              transform: scale(1.25);
              opacity: 0;
            }
            100% {
              opacity: 0;
            }
          }
          @media (prefers-reduced-motion: reduce) {
            .fab {
              animation: none;
            }
            .ring {
              animation: none;
              opacity: 0.4;
            }
          }
          @media (max-width: 620px) {
            .fabWrap {
              right: 14px;
              bottom: 76px;
            }
            .tip {
              display: none;
            }
            .fab {
              width: 54px;
              height: 54px;
            }
          }
        `}</style>
      </div>
    );
  }

  /* ---------- open: the panel ---------- */
  return (
    <div className="panel">
      <header>
        <div className="hwho">
          <span className="dot" />
          <div>
            <strong>Opulence Bliss</strong>
            <small>Support assistant</small>
          </div>
        </div>
        <button onClick={() => setOpen(false)} aria-label="Close chat">
          ×
        </button>
      </header>

      <div className="log">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "row me" : "row them"}>
            <div className="message-stack">
              <p>
                {m.role === "assistant" ? <Linkified text={m.text} /> : m.text}
              </p>
              {m.role === "assistant" && m.action && (
                <div
                  className={`action-card ${
                    m.action.tone === "danger" ? "danger" : ""
                  }`}
                >
                  <span>{m.action.summary}</span>
                  <div className="action-row">
                    {m.action.kind === "navigate" ? (
                      <a href={m.action.href}>{m.action.label}</a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void confirmAction(i, m.action!)}
                        disabled={busy}
                      >
                        {m.action.label}
                      </button>
                    )}
                    <button
                      type="button"
                      className="dismiss"
                      disabled={busy}
                      onClick={() =>
                        setMsgs((current) =>
                          current.map((message, messageIndex) =>
                            messageIndex === i
                              ? { ...message, action: undefined }
                              : message,
                          ),
                        )
                      }
                    >
                      Not now
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="row them">
            <p className="dots">
              <span />
              <span />
              <span />
            </p>
          </div>
        )}

        {msgs.length === 1 && (
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
          placeholder="Ask a question…"
          aria-label="Your message"
          disabled={busy}
        />
        <button
          onClick={() => send(input)}
          disabled={busy || !input.trim()}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M3 20.5 22 12 3 3.5l3 8.5-3 8.5Z" />
          </svg>
        </button>
      </div>

      <p className="note">
        Actions only run after you confirm. Never share card details or passwords.
      </p>

      <style jsx>{`
        .panel {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 9998;
          width: min(380px, calc(100vw - 40px));
          height: min(540px, calc(100vh - 110px));
          background: #fff;
          border: 2px solid #edeff1;
          border-radius: 22px;
          box-shadow: 0 24px 60px rgba(22, 32, 42, 0.24);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: "Nunito", system-ui, sans-serif;
          animation: rise 0.24s ease;
        }
        @keyframes rise {
          from {
            opacity: 0;
            transform: translateY(14px);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          background: ${GRAD};
          color: #fff;
        }
        .hwho {
          display: flex;
          align-items: center;
          gap: 9px;
        }
        .hwho strong {
          display: block;
          font-size: 15.5px;
          font-weight: 900;
          letter-spacing: -0.01em;
        }
        .hwho small {
          font-size: 12px;
          font-weight: 700;
          opacity: 0.85;
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #b6ffb0;
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25);
        }
        header button {
          background: rgba(255, 255, 255, 0.18);
          border: none;
          color: #fff;
          width: 30px;
          height: 30px;
          border-radius: 50%;
          font-size: 19px;
          line-height: 1;
          cursor: pointer;
        }
        header button:hover {
          background: rgba(255, 255, 255, 0.3);
        }
        .log {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: #fbfaff;
        }
        .row {
          display: flex;
        }
        .row.me {
          justify-content: flex-end;
        }
        .message-stack {
          display: grid;
          gap: 7px;
          max-width: 88%;
        }
        .row.me .message-stack {
          justify-items: end;
        }
        .row p {
          margin: 0;
          padding: 11px 14px;
          border-radius: 16px;
          font-size: 14.5px;
          font-weight: 600;
          line-height: 1.5;
          max-width: 100%;
          box-sizing: border-box;
          white-space: pre-wrap;
        }
        .row.them p {
          background: #fff;
          border: 1.5px solid #edeff1;
          color: #16202a;
          border-bottom-left-radius: 5px;
        }
        .row.me p {
          background: #16202a;
          color: #fff;
          border-bottom-right-radius: 5px;
        }
        .row.them p :global(a) {
          color: ${PURPLE};
          font-weight: 900;
          text-decoration: underline;
        }
        .row.them p :global(a.confirm) {
          display: inline-block;
          margin-top: 9px;
          background: ${GRAD};
          color: #fff;
          padding: 10px 18px;
          border-radius: 999px;
          text-decoration: none;
          font-size: 14px;
        }
        .action-card {
          padding: 11px;
          border: 1.5px solid #d9c6fa;
          border-radius: 14px;
          background: linear-gradient(135deg, #fff, #f7f2ff);
          box-shadow: 0 8px 22px rgba(109, 40, 217, 0.09);
        }
        .action-card.danger {
          border-color: #f3cbd4;
          background: linear-gradient(135deg, #fff, #fff5f7);
        }
        .action-card > span {
          display: block;
          color: #4b5563;
          font-size: 12.5px;
          font-weight: 700;
          line-height: 1.45;
        }
        .action-row {
          display: flex;
          gap: 7px;
          margin-top: 9px;
        }
        .action-row a,
        .action-row button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 36px;
          padding: 8px 12px;
          border: 0;
          border-radius: 10px;
          background: ${GRAD};
          color: #fff;
          text-decoration: none;
          font: inherit;
          font-size: 12.5px;
          font-weight: 900;
          cursor: pointer;
        }
        .danger .action-row a,
        .danger .action-row button:not(.dismiss) {
          background: #b0384f;
        }
        .action-row .dismiss {
          border: 1.5px solid #e3e5e8;
          background: #fff;
          color: #6b7280;
        }
        .action-row button:disabled {
          cursor: wait;
          opacity: 0.55;
        }
        .dots {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        .dots span {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #b9bec5;
          animation: blink 1.2s infinite;
        }
        .dots span:nth-child(2) {
          animation-delay: 0.2s;
        }
        .dots span:nth-child(3) {
          animation-delay: 0.4s;
        }
        @keyframes blink {
          0%,
          100% {
            opacity: 0.3;
          }
          50% {
            opacity: 1;
          }
        }
        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin-top: 4px;
        }
        .chips button {
          background: #fff;
          border: 1.5px solid #e8dcfa;
          border-radius: 999px;
          padding: 8px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 800;
          color: ${PURPLE};
          cursor: pointer;
        }
        .chips button:hover {
          background: #f8f3ff;
        }
        .composer {
          display: flex;
          gap: 8px;
          padding: 12px 14px 6px;
          border-top: 1.5px solid #edeff1;
          background: #fff;
        }
        .composer input {
          flex: 1;
          min-width: 0;
          border: 2px solid #edeff1;
          border-radius: 999px;
          padding: 11px 16px;
          font: inherit;
          font-size: 15px;
          font-weight: 600;
          color: #16202a;
        }
        .composer input:focus-visible {
          outline: none;
          border-color: ${PURPLE};
        }
        .composer button {
          background: ${GRAD};
          color: #fff;
          border: none;
          border-radius: 50%;
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          cursor: pointer;
          flex-shrink: 0;
        }
        .composer button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .note {
          margin: 0;
          padding: 4px 14px 12px;
          font-size: 11.5px;
          font-weight: 600;
          color: #a9afb7;
          text-align: center;
          background: #fff;
        }
        @media (max-width: 620px) {
          .panel {
            right: 12px;
            left: 12px;
            bottom: 76px;
            width: auto;
            height: min(70vh, 520px);
          }
        }
      `}</style>
    </div>
  );
}
