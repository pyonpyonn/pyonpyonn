"use client";

// Admin buttons with a confirm step. Save at: app/admin/AdminButtons.tsx

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bringBookingToNow,
  wipeAvailability,
  wipeReviews,
  resetJoiningFees,
  resetPrototypeData,
} from "./actions";

type Job = {
  label: string;
  hint: string;
  confirm: string;
  run: () => Promise<void | { message?: string }>;
  danger?: boolean;
};

export default function AdminButtons() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const jobs: Job[] = [
    {
      label: "Move next booking to now",
      hint: "For testing: pulls the soonest upcoming visit forward a couple of minutes so you can check in and out straight away. Real rules still apply.",
      confirm: "Move the next upcoming booking to right now?",
      run: async () => {
        await bringBookingToNow();
      },
    },
    {
      label: "Clear all availability",
      hint: "Wipes every provider's working hours. They'll need to set them again.",
      confirm: "Delete all provider availability?",
      run: wipeAvailability,
    },
    {
      label: "Clear all reviews",
      hint: "Deletes every rating from both sides and resets the cached averages.",
      confirm: "Delete all reviews and reset ratings?",
      run: wipeReviews,
    },
    {
      label: "Reset joining fees",
      hint: "Marks every provider as unpaid, so you can re-test the £150 paywall.",
      confirm: "Reset all providers to unpaid?",
      run: resetJoiningFees,
    },
    {
      label: "Reset all prototype activity",
      hint: "Clears test bookings, payments, payouts, subscriptions, reviews, messages, notifications and their workflow history. Accounts, providers, services, availability and configuration stay in place.",
      confirm:
        "Delete ALL prototype activity? Accounts, providers, services and availability will be kept. This cannot be undone.",
      run: resetPrototypeData,
      danger: true,
    },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {jobs.map((j) => (
        <div
          key={j.label}
          style={{
            background: "#fff",
            border: `1.5px solid ${j.danger ? "#e6b0b0" : "#ece5d8"}`,
            borderRadius: 14,
            padding: "18px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong
              style={{
                display: "block",
                color: j.danger ? "#8a2f2f" : "#2f4a3a",
                fontSize: 15.5,
                marginBottom: 3,
              }}
            >
              {j.label}
            </strong>
            <span style={{ color: "#6e7a70", fontSize: 13.5 }}>{j.hint}</span>
          </div>
          <button
            disabled={pending}
            onClick={() => {
              if (!window.confirm(j.confirm)) return;
              setDone(null);
              setError(null);
              start(async () => {
                try {
                  const result = await j.run();
                  setDone(
                    result?.message ?? `Done — ${j.label.toLowerCase()}.`,
                  );
                  router.refresh();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The reset could not be completed.",
                  );
                }
              });
            }}
            style={{
              background: j.danger ? "#8a2f2f" : "transparent",
              color: j.danger ? "#fff" : "#8a4b26",
              border: j.danger ? "none" : "1.5px solid #e6c4b0",
              borderRadius: 999,
              padding: "10px 20px",
              fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
              fontSize: 14,
              fontWeight: 600,
              cursor: pending ? "wait" : "pointer",
              opacity: pending ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {pending ? "Working…" : "Run"}
          </button>
        </div>
      ))}

      {done && (
        <p
          style={{
            background: "#e7eee7",
            color: "#2f4a3a",
            padding: "12px 14px",
            borderRadius: 10,
            fontSize: 14.5,
            margin: 0,
          }}
        >
          {done}
        </p>
      )}

      {error && (
        <p
          style={{
            background: "#ffe6ea",
            color: "#8a2f2f",
            padding: "12px 14px",
            borderRadius: 10,
            fontSize: 14.5,
            margin: 0,
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
