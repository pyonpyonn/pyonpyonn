"use client";

// Approve / reject a provider. Save at: app/admin/VettingButtons.tsx

import { useTransition } from "react";
import { approveProvider, rejectProvider } from "./actions";

export default function VettingButtons({ id }: { id: string }) {
  const [pending, start] = useTransition();

  const base: React.CSSProperties = {
    borderRadius: 999,
    padding: "9px 18px",
    fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: pending ? "wait" : "pointer",
    opacity: pending ? 0.6 : 1,
  };

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        disabled={pending}
        onClick={() => start(() => approveProvider(id))}
        style={{ ...base, background: "#2f4a3a", color: "#fbf7f0", border: "none" }}
      >
        {pending ? "…" : "Approve"}
      </button>
      <button
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Reject this provider?")) return;
          start(() => rejectProvider(id));
        }}
        style={{
          ...base,
          background: "transparent",
          color: "#8a4b26",
          border: "1.5px solid #e6c4b0",
        }}
      >
        Reject
      </button>
    </div>
  );
}