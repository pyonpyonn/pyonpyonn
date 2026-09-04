"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
const DEMO_PASSWORD = "Demo1234!";

type Mode = "client" | "provider";

const COPY = {
  client: {
    eyebrow: "Client account",
    title: "Welcome back",
    body: "Manage your bookings, messages, payments and membership.",
    button: "Log in to my account",
    demoEmail: "client@test.com",
    demoLabel: "Use client demo account",
    destination: "/account",
    switchText: "Are you an Opulence Bliss professional?",
    switchLabel: "Sign in as a pro",
    switchHref: "/provider/login",
    icon: "♡",
  },
  provider: {
    eyebrow: "Professional portal",
    title: "Ready for your next job?",
    body: "Sign in to manage offers, visits, messages, hours and earnings.",
    button: "Sign in to professional portal",
    demoEmail: "worker@test.com",
    demoLabel: "Use professional demo account",
    destination: "/worker",
    switchText: "Looking for your bookings?",
    switchLabel: "Client login",
    switchHref: "/login",
    icon: "OB",
  },
} as const;

export default function RoleLogin({ mode }: { mode: Mode }) {
  const content = COPY[mode];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn(em: string, pw: string) {
    setBusy(true);
    setErr(null);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: em.trim(),
      password: pw,
    });

    if (error || !data.user) {
      setErr(error?.message ?? "We couldn't sign you in.");
      setBusy(false);
      return;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .maybeSingle();

    const expectedRole = mode === "provider" ? "provider" : "customer";
    if (profile?.role !== expectedRole) {
      await supabase.auth.signOut();
      setErr(
        mode === "provider"
          ? "This is not a professional account. Please use the client login instead."
          : "This is a professional account. Please use the professional login instead.",
      );
      setBusy(false);
      return;
    }

    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href = next || content.destination;
  }

  function submit() {
    if (!email.trim() || !password) {
      setErr("Enter your email and password.");
      return;
    }
    void signIn(email, password);
  }

  return (
    <main className={`login-shell ${mode}`}>
      <section className="login-card">
        <div className="role-mark" aria-hidden="true">
          {content.icon}
        </div>
        <a className="brand" href="/">
          opulence<span>bliss</span>
        </a>

        <p className="eyebrow">{content.eyebrow}</p>
        <h1>{content.title}</h1>
        <p className="lede">{content.body}</p>

        <label htmlFor={`${mode}-email`}>Email</label>
        <input
          id={`${mode}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />

        <label htmlFor={`${mode}-password`}>Password</label>
        <input
          id={`${mode}-password`}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          placeholder="••••••••"
          autoComplete="current-password"
        />

        <button className="submit" type="button" onClick={submit} disabled={busy}>
          {busy ? "Signing in…" : content.button}
        </button>

        {err && <p className="error">{err}</p>}

        <button
          className="demo"
          type="button"
          disabled={busy}
          onClick={() => void signIn(content.demoEmail, DEMO_PASSWORD)}
        >
          {content.demoLabel}
        </button>

        <div className="switch-role">
          <span>{content.switchText}</span>
          <a href={content.switchHref}>{content.switchLabel} →</a>
        </div>

        {mode === "provider" && (
          <p className="join">
            New professional? <a href="/provider/join">Apply to join us</a>
          </p>
        )}

        <a className="home" href="/">
          ← Back to website
        </a>
      </section>

      <style jsx>{`
        .login-shell {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 42px 20px;
          color: #16202a;
          font-family: "Nunito", system-ui, sans-serif;
        }
        .login-shell.client {
          background:
            radial-gradient(circle at 12% 10%, rgba(245, 197, 66, 0.2), transparent 28%),
            linear-gradient(145deg, #fffdf8, #fbf7ff);
        }
        .login-shell.provider {
          background:
            radial-gradient(circle at 85% 12%, rgba(200, 111, 201, 0.2), transparent 32%),
            linear-gradient(145deg, #f8f4ff, #eee7fb);
        }
        .login-card {
          width: min(100%, 470px);
          box-sizing: border-box;
          padding: 34px 34px 30px;
          border: 1px solid #e7e1ef;
          border-radius: 24px;
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 22px 60px rgba(55, 37, 78, 0.13);
        }
        .provider .login-card {
          border-top: 6px solid #6d28d9;
        }
        .role-mark {
          float: right;
          width: 52px;
          height: 52px;
          display: grid;
          place-items: center;
          border-radius: 17px;
          color: #6d28d9;
          background: #f2eafd;
          font-size: 24px;
          font-weight: 900;
        }
        .provider .role-mark {
          color: #fff;
          background: linear-gradient(135deg, #c86fc9, #6d28d9);
          font-size: 17px;
        }
        .brand {
          display: inline-block;
          margin-bottom: 35px;
          color: #16202a;
          font-size: 21px;
          font-weight: 900;
          letter-spacing: -0.03em;
          text-decoration: none;
        }
        .brand span,
        .eyebrow,
        .switch-role a,
        .join a,
        .home {
          color: #6d28d9;
        }
        .eyebrow {
          margin: 0 0 7px;
          text-transform: uppercase;
          letter-spacing: 0.13em;
          font-size: 12px;
          font-weight: 900;
        }
        h1 {
          margin: 0 0 7px;
          font-size: clamp(28px, 7vw, 36px);
          line-height: 1.08;
          letter-spacing: -0.035em;
          font-weight: 900;
        }
        .lede {
          margin: 0 0 25px;
          color: #707784;
          font-size: 15.5px;
          line-height: 1.5;
          font-weight: 600;
        }
        label {
          display: block;
          margin: 0 0 6px;
          color: #555e6b;
          font-size: 13.5px;
          font-weight: 800;
        }
        input {
          width: 100%;
          box-sizing: border-box;
          margin: 0 0 17px;
          padding: 13px 14px;
          border: 1.5px solid #dfe2e7;
          border-radius: 12px;
          background: #fff;
          color: #16202a;
          font: inherit;
          font-size: 16px;
        }
        input:focus-visible {
          outline: none;
          border-color: #6d28d9;
          box-shadow: 0 0 0 3px rgba(109, 40, 217, 0.1);
        }
        .submit {
          width: 100%;
          margin-top: 4px;
          padding: 14px;
          border: none;
          border-radius: 999px;
          color: #fff;
          background: linear-gradient(100deg, #f5c542, #c86fc9 55%, #7b2ff7);
          box-shadow: 0 8px 20px rgba(109, 40, 217, 0.22);
          cursor: pointer;
          font: inherit;
          font-size: 15.5px;
          font-weight: 900;
        }
        .provider .submit {
          background: linear-gradient(100deg, #8b5cf6, #6d28d9);
        }
        .submit:disabled,
        .demo:disabled {
          opacity: 0.6;
          cursor: wait;
        }
        .error {
          margin: 15px 0 0;
          padding: 11px 13px;
          border-radius: 11px;
          background: #ffe9ed;
          color: #a92f47;
          font-size: 13.5px;
          font-weight: 700;
        }
        .demo {
          width: 100%;
          margin-top: 14px;
          padding: 11px;
          border: 1.5px solid #dfd3f5;
          border-radius: 999px;
          background: #faf7ff;
          color: #6d28d9;
          cursor: pointer;
          font: inherit;
          font-size: 13.5px;
          font-weight: 800;
        }
        .switch-role {
          display: grid;
          gap: 3px;
          margin-top: 22px;
          padding-top: 18px;
          border-top: 1px solid #ece9f0;
          color: #747b86;
          font-size: 13.5px;
        }
        .switch-role a,
        .join a {
          width: fit-content;
          font-weight: 900;
          text-decoration: none;
        }
        .join {
          margin: 13px 0 0;
          color: #747b86;
          font-size: 13.5px;
        }
        .home {
          display: inline-block;
          margin-top: 19px;
          font-size: 13.5px;
          font-weight: 800;
          text-decoration: none;
        }
        @media (max-width: 520px) {
          .login-shell {
            align-items: start;
            padding: 20px 14px;
          }
          .login-card {
            padding: 27px 22px 25px;
          }
          .brand {
            margin-bottom: 30px;
          }
        }
      `}</style>
    </main>
  );
}
