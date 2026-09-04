"use client";

// Review moderation. Save at: app/admin/ReviewList.tsx

import { useTransition } from "react";
import { deleteReview } from "./actions";

export type Review = {
  id: string;
  reviewer: string;
  rating: number;
  comment: string | null;
  created_at: string;
};

export default function ReviewList({ reviews }: { reviews: Review[] }) {
  const [pending, start] = useTransition();

  if (reviews.length === 0) {
    return (
      <p style={{ color: "#6e7a70", padding: "16px 0" }}>No reviews yet.</p>
    );
  }

  return (
    <>
      {reviews.map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 14,
            padding: "14px 0",
            borderBottom: "1px solid #f0ebe0",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 14 }}>
              <span style={{ color: "#cf854f", letterSpacing: 1 }}>
                {"★".repeat(r.rating)}
                {"☆".repeat(5 - r.rating)}
              </span>{" "}
              <span style={{ color: "#6e7a70", fontSize: 12.5 }}>
                {r.reviewer === "client"
                  ? "client → provider"
                  : "provider → client"}
              </span>
            </div>
            {r.comment && (
              <p
                style={{
                  margin: "4px 0 0",
                  color: "#26302a",
                  fontSize: 13.5,
                }}
              >
                “{r.comment}”
              </p>
            )}
            <span style={{ color: "#a89f90", fontSize: 12 }}>
              {new Date(r.created_at).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          </div>
          <button
            disabled={pending}
            onClick={() => {
              if (!window.confirm("Delete this review?")) return;
              start(() => deleteReview(r.id));
            }}
            style={{
              background: "transparent",
              color: "#8a4b26",
              border: "1.5px solid #e6c4b0",
              borderRadius: 999,
              padding: "8px 16px",
              fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
              fontSize: 13,
              fontWeight: 600,
              cursor: pending ? "wait" : "pointer",
              opacity: pending ? 0.6 : 1,
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </>
  );
}
