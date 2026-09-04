"use client";

// Client profile — your details, saved for faster booking.
// Save at: app/account/profile/page.tsx

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

export default function ClientProfilePage() {
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [postcode, setPostcode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }
      setUid(user.id);
      setEmail(user.email ?? "");

      const { data } = await supabase
        .from("profiles")
        .select("full_name, phone, address, postcode")
        .eq("id", user.id)
        .maybeSingle();

      setName(data?.full_name ?? "");
      setPhone(data?.phone ?? "");
      setAddress(data?.address ?? "");
      setPostcode(data?.postcode ?? "");
      setLoading(false);
    })();
  }, []);

  async function save() {
    if (!uid) return;
    setSaving(true);
    setMsg(null);
    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: name.trim() || null,
        phone: phone.trim() || null,
        address: address.trim() || null,
        postcode: postcode.trim().toUpperCase() || null,
      })
      .eq("id", uid);
    setMsg(error ? error.message : "Saved — we'll use these next time you book.");
    setSaving(false);
  }

  return (
    <main className="wrap">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Hanken+Grotesk:wght@400;500;600&display=swap"
      />

      <div className="inner">
        <p className="eyebrow">Your account</p>
        <h1>Your details</h1>
        <p className="lede">
          Save your address once and your bookings get quicker. Your provider only
          sees these after they accept a job.
        </p>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : !uid ? (
          <div className="card center">
            <p>Log in to manage your details.</p>
            <a className="cta" href="/login">
              Go to log in
            </a>
          </div>
        ) : (
          <>
            <div className="card">
              <label>Email</label>
              <input value={email} disabled />

              <label>Full name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Morgan"
              />

              <label>Phone</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="07700 900000"
              />

              <label>Address</label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                rows={3}
                placeholder="Flat 4, 12 Elm Gardens, London"
              />

              <label>Postcode</label>
              <input
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                placeholder="SW3 1AA"
                style={{ textTransform: "uppercase" }}
              />
            </div>

            <button className="cta" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save details"}
            </button>
            {msg && <p className="msg">{msg}</p>}
          </>
        )}

        <p className="links">
          <a href="/account">← My bookings</a>
          <a href="/book">Book a service</a>
        </p>
      </div>

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          background: transparent;
          color: var(--ob-text);
          font-family: "Hanken Grotesk", system-ui, sans-serif;
          padding: 0 20px 80px;
        }
        .inner {
          max-width: 560px;
          margin: 0 auto;
          padding-top: 40px;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.14em;
          font-size: 12px;
          font-weight: 600;
          color: var(--ob-purple);
          margin: 0 0 6px;
        }
        h1 {
          font-family: "Fraunces", serif;
          font-weight: 500;
          font-size: 36px;
          color: var(--ob-text);
          margin: 0 0 8px;
        }
        .lede {
          color: var(--ob-muted);
          margin: 0 0 26px;
        }
        .card {
          background: var(--ob-surface-raised);
          border: 1px solid var(--ob-border);
          border-radius: 16px;
          padding: 24px 22px;
          margin-bottom: 20px;
        }
        .card.center {
          text-align: center;
        }
        label {
          display: block;
          font-size: 13.5px;
          color: var(--ob-muted);
          margin: 0 0 6px;
        }
        input,
        textarea {
          width: 100%;
          box-sizing: border-box;
          padding: 12px 14px;
          border: 1.5px solid var(--ob-border);
          border-radius: 12px;
          font: inherit;
          font-size: 15.5px;
          background: var(--ob-surface-soft);
          color: var(--ob-text);
          margin-bottom: 18px;
          resize: vertical;
        }
        input:disabled {
          background: var(--ob-surface-soft);
          color: var(--ob-muted);
        }
        input:focus-visible,
        textarea:focus-visible {
          outline: none;
          border-color: #2f4a3a;
        }
        .cta {
          background: #2f4a3a;
          color: #fbf7f0;
          border: none;
          border-radius: 999px;
          padding: 13px 26px;
          font: inherit;
          font-weight: 600;
          font-size: 15px;
          cursor: pointer;
          text-decoration: none;
          display: inline-block;
        }
        .cta:disabled {
          opacity: 0.65;
          cursor: wait;
        }
        .msg {
          background: var(--ob-mint);
          color: var(--ob-success-text);
          padding: 12px 14px;
          border-radius: 10px;
          font-size: 14.5px;
          margin: 16px 0 0;
        }
        .muted {
          color: var(--ob-muted);
        }
        .links {
          display: flex;
          gap: 18px;
          margin-top: 30px;
        }
        .links a {
          color: var(--ob-purple);
          font-size: 14px;
          text-decoration: none;
        }
      `}</style>
    </main>
  );
}
