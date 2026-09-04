"use client";

// Pay the one-off joining fee.
// Save at: app/worker/JoinButton.tsx

import { useState } from "react";

export default function JoinButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/provider-join", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      if (data.alreadyPaid) {
        window.location.reload();
        return;
      }
      throw new Error(data.error || "Could not start payment");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Payment failed");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={pay}
        disabled={busy}
        style={{
          background: "#cf854f",
          color: "#fff",
          border: "none",
          borderRadius: 999,
          padding: "13px 26px",
          fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
          fontSize: 15,
          fontWeight: 600,
          cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? "Taking you to secure checkout…" : "Pay £150 joining fee"}
      </button>
      {err && (
        <p
          style={{
            background: "#f6e7dd",
            color: "#8a4b26",
            padding: "10px 12px",
            borderRadius: 10,
            fontSize: 14,
            marginTop: 12,
          }}
        >
          {err}
        </p>
      )}
    </div>
  );
}