"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "access") {
      setError("That account does not have administrator access.");
    }
  }, []);

  async function submit() {
    if (!email.trim() || !password) {
      setError("Enter your admin email and password.");
      return;
    }

    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error: signInError } =
      await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

    if (signInError || !data.user) {
      setError("The admin email or password is incorrect.");
      setBusy(false);
      return;
    }

    const { data: profile, error: roleError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .maybeSingle();

    if (roleError || profile?.role !== "admin") {
      await supabase.auth.signOut();
      setError("That account does not have administrator access.");
      setBusy(false);
      return;
    }

    window.location.href = "/admin";
  }

  return (
    <main className="wrap">
      <section className="card">
        <a className="brand" href="/">
          Opulence Bliss
        </a>
        <span className="icon">
          <ShieldCheck size={27} />
        </span>
        <p className="eyebrow">Restricted access</p>
        <h1>Admin login</h1>
        <p className="lede">
          Sign in with an authorised administrator account to manage operations.
        </p>

        <label htmlFor="admin-email">Admin email</label>
        <input
          id="admin-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          placeholder="admin@example.com"
        />
        <label htmlFor="admin-password">Password</label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void submit()}
          autoComplete="current-password"
          placeholder="••••••••"
        />
        <button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? "Checking access…" : "Sign in securely"}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="security">
          Access is checked against the administrator role stored in the
          database. Client and cleaner accounts are refused even with a valid
          password.
        </p>
      </section>

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          display: grid;
          place-items: center;
          box-sizing: border-box;
          padding: 24px;
          background: #f7f8fa;
          color: #16202a;
          font-family: "Nunito", system-ui, sans-serif;
        }
        .card {
          width: min(430px, 100%);
          box-sizing: border-box;
          border: 1px solid #e5e7eb;
          border-radius: 22px;
          padding: 32px;
          background: #fff;
          box-shadow: 0 18px 52px rgba(22, 32, 42, 0.12);
        }
        .brand {
          display: inline-block;
          margin-bottom: 24px;
          color: #16202a;
          font-size: 17px;
          font-weight: 900;
          text-decoration: none;
        }
        .icon {
          display: grid;
          place-items: center;
          width: 50px;
          height: 50px;
          margin-bottom: 15px;
          border-radius: 15px;
          background: #f4ecfe;
          color: #6d28d9;
        }
        .eyebrow {
          margin: 0 0 5px;
          color: #6d28d9;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.13em;
          text-transform: uppercase;
        }
        h1 {
          margin: 0 0 7px;
          font-size: 30px;
          font-weight: 900;
          letter-spacing: -0.025em;
        }
        .lede {
          margin: 0 0 24px;
          color: #6b7280;
          font-size: 14px;
          line-height: 1.5;
        }
        label {
          display: block;
          margin: 0 0 6px;
          color: #4b5563;
          font-size: 13px;
          font-weight: 800;
        }
        input {
          width: 100%;
          box-sizing: border-box;
          margin-bottom: 16px;
          border: 1.5px solid #dfe3e8;
          border-radius: 11px;
          padding: 12px 13px;
          background: #fff;
          color: #16202a;
          font: inherit;
          font-size: 15px;
        }
        input:focus-visible {
          outline: 3px solid #eee4ff;
          border-color: #6d28d9;
        }
        button {
          width: 100%;
          border: 0;
          border-radius: 11px;
          padding: 13px;
          background: #16202a;
          color: #fff;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
        }
        button:disabled {
          opacity: 0.6;
          cursor: wait;
        }
        .error {
          margin: 13px 0 0;
          border-radius: 10px;
          padding: 10px 12px;
          background: #ffe6ea;
          color: #a52e47;
          font-size: 13px;
          font-weight: 750;
        }
        .security {
          margin: 18px 0 0;
          color: #7a828c;
          font-size: 11.5px;
          line-height: 1.5;
        }
      `}</style>
    </main>
  );
}
