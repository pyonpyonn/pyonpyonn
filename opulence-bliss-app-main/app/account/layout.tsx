import { createClient } from "@/lib/supabase/server";
import PortalLiveSync from "@/components/PortalLiveSync";
import ClientNav from "./ClientNav";

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return (
      <Gate
        emoji="🔑"
        title="Your account"
        body="Log in to see your visits, membership and details."
        href="/login"
        cta="Log in"
        altHref="/book"
        altText="Or book a service first →"
      />
    );
  const { data: prof } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();
  if (prof?.role === "provider")
    return (
      <Gate
        emoji="🧹"
        title="This is the customer area"
        body="You're signed in as a provider — your jobs and hours are in the provider portal."
        href="/worker"
        cta="Go to my jobs"
      />
    );
  if (prof?.role === "admin")
    return (
      <Gate
        emoji="🛠"
        title="This is the customer area"
        body="You're signed in as an admin — your tools are in the control panel."
        href="/admin"
        cta="Go to control panel"
      />
    );
  return (
    <div className="portal-shell account-shell" style={shell}>
      <PortalLiveSync userId={user.id} />
      <ClientNav name={prof?.full_name ?? ""} email={user.email ?? ""} />
      <div className="portal-main" style={main}>
        {children}
      </div>
    </div>
  );
}

function Gate({
  emoji,
  title,
  body,
  href,
  cta,
  altHref,
  altText,
}: {
  emoji: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  altHref?: string;
  altText?: string;
}) {
  return (
    <main style={gateWrap}>
      <div style={gateCard}>
        <div style={{ fontSize: 38 }}>{emoji}</div>
        <h1 style={gateTitle}>{title}</h1>
        <p style={gateBody}>{body}</p>
        <a href={href} style={btn}>
          {cta}
        </a>
        {altHref && (
          <p style={{ marginTop: 16 }}>
            <a href={altHref} style={quiet}>
              {altText}
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
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
