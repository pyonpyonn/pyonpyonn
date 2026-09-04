// SETUP: mkdir -p "app/worker" && code "app/worker/layout.tsx"
//
// The provider portal shell. Everything under /worker lives inside this.

import { createClient } from "@/lib/supabase/server";
import PortalLiveSync from "@/components/PortalLiveSync";
import PortalNav from "./PortalNav";
import JoinButton from "./JoinButton";

export default async function WorkerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Not signed in — one clean prompt, no portal chrome.
  if (!user) {
    return (
      <main style={gateWrap}>
        <div style={gateCard}>
          <div style={{ fontSize: 38 }}>🔑</div>
          <h1 style={gateTitle}>Provider portal</h1>
          <p style={gateBody}>Log in to see your jobs, hours and earnings.</p>
          <a href="/provider/login" style={btn}>
            Log in
          </a>
          <p style={{ marginTop: 16 }}>
            <a href="/provider/join" style={quiet}>
              Not registered yet? Join as a provider →
            </a>
          </p>
        </div>
      </main>
    );
  }

  const { data: prof } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  // A customer wandered in.
  if (prof?.role === "customer") {
    return (
      <main style={gateWrap}>
        <div style={gateCard}>
          <div style={{ fontSize: 38 }}>🧹</div>
          <h1 style={gateTitle}>This is the provider portal</h1>
          <p style={gateBody}>
            You&apos;re signed in as a customer. Fancy working with us instead?
          </p>
          <a href="/provider/join" style={btn}>
            Become a provider
          </a>
          <p style={{ marginTop: 16 }}>
            <a href="/account" style={quiet}>
              ← Back to my bookings
            </a>
          </p>
        </div>
      </main>
    );
  }

  const { data: prov } = await supabase
    .from("providers")
    .select(
      "id, display_name, joining_fee_paid, vetting_status, rating_avg, rating_count",
    )
    .eq("profile_id", user.id)
    .maybeSingle();

  // The live-job shortcut exists only while a provider is actually checked in.
  let hasCurrentJob = false;
  if (prov?.id) {
    const { count: live } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("status", "in_progress");
    hasCurrentJob = (live ?? 0) > 0;
  }

  const registered = !!prov;
  const paid = prov?.joining_fee_paid === true;
  const approved = prov?.vetting_status === "approved";

  return (
    <div className="portal-shell worker-shell" style={shell}>
      <PortalLiveSync userId={user.id} />
      <PortalNav
        name={prov?.display_name ?? prof?.full_name ?? user.email ?? "Provider"}
        rating={prov?.rating_avg ? Number(prov.rating_avg) : null}
        ratingCount={prov?.rating_count ?? 0}
        registered={registered}
        paid={paid}
        approved={approved}
        hasCurrentJob={hasCurrentJob}
      />

      <div className="portal-main" style={main}>
        {/* One honest banner at the top of the portal */}
        {!registered && (
          <Banner
            tone="warn"
            title="You're not registered as a provider yet"
            body="Register to start receiving jobs. It takes a couple of minutes and a one-off £150 joining fee."
            ctaHref="/provider/join"
            ctaText="Register now"
          />
        )}
        {registered && !paid && (
          <Banner
            tone="warn"
            title="Pay your joining fee to unlock the portal"
            body="A one-off £150 fee activates your account. Paid once — not a subscription. Everything unlocks the moment it clears."
            action={<JoinButton />}
          />
        )}
        {registered && paid && !approved && (
          <Banner
            tone="info"
            title={
              prov?.vetting_status === "rejected"
                ? "We couldn't approve your account"
                : "We're reviewing your application"
            }
            body={
              prov?.vetting_status === "rejected"
                ? "Please get in touch if you think this is a mistake."
                : "Your fee is paid and your details are with our team. Jobs arrive as soon as you're approved — meanwhile, set your hours and fill in your profile."
            }
          />
        )}

        {children}
      </div>
    </div>
  );
}

function Banner({
  tone,
  title,
  body,
  ctaHref,
  ctaText,
  action,
}: {
  tone: "warn" | "info";
  title: string;
  body: string;
  ctaHref?: string;
  ctaText?: string;
  action?: React.ReactNode;
}) {
  const c =
    tone === "warn"
      ? { bg: "#FFF3D6", br: "#FFDF9E", fg: "#8A5A00" }
      : { bg: "#E3F0FB", br: "#BBDCF5", fg: "#1B5E9E" };

  return (
    <div
      style={{
        background: c.bg,
        border: `2px solid ${c.br}`,
        color: c.fg,
        borderRadius: 18,
        padding: "18px 20px",
        marginBottom: 20,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <strong style={{ fontSize: 16, fontWeight: 900 }}>{title}</strong>
        <p style={{ margin: "3px 0 0", fontSize: 14.5, fontWeight: 600 }}>
          {body}
        </p>
      </div>
      {action}
      {ctaHref && (
        <a
          href={ctaHref}
          style={{
            background: "#16202A",
            color: "#fff",
            padding: "11px 20px",
            borderRadius: 999,
            textDecoration: "none",
            fontWeight: 900,
            fontSize: 14.5,
            whiteSpace: "nowrap",
          }}
        >
          {ctaText}
        </a>
      )}
    </div>
  );
}

/* ---------- styles ---------- */

const shell: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  minHeight: "100vh",
  background: "var(--ob-page)",
  color: "var(--ob-text)",
  fontFamily: "'Nunito', system-ui, sans-serif",
};

const main: React.CSSProperties = {
  flex: 1,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  background: "transparent",
  padding: "26px 22px 96px",
};

const gateWrap: React.CSSProperties = {
  minHeight: "80vh",
  background: "var(--ob-page)",
  display: "grid",
  placeItems: "center",
  padding: 24,
  fontFamily: "'Nunito', system-ui, sans-serif",
};

const gateCard: React.CSSProperties = {
  background: "var(--ob-surface-raised)",
  border: "1px solid var(--ob-border)",
  borderRadius: 24,
  padding: "34px 30px",
  maxWidth: 420,
  textAlign: "center",
  boxShadow: "0 18px 50px var(--ob-shadow-soft)",
};

const gateTitle: React.CSSProperties = {
  fontSize: 25,
  fontWeight: 900,
  letterSpacing: "-0.02em",
  margin: "10px 0 6px",
  color: "var(--ob-text)",
};

const gateBody: React.CSSProperties = {
  color: "var(--ob-muted)",
  fontSize: 15,
  fontWeight: 600,
  margin: "0 0 22px",
};

const btn: React.CSSProperties = {
  display: "inline-block",
  background: "linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7)",
  color: "#fff",
  padding: "13px 28px",
  borderRadius: 999,
  textDecoration: "none",
  fontWeight: 900,
  fontSize: 15.5,
};

const quiet: React.CSSProperties = {
  color: "var(--ob-muted)",
  fontSize: 14,
  fontWeight: 700,
  textDecoration: "none",
};
