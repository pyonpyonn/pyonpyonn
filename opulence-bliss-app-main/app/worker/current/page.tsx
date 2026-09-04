// The provider's live job, using the same workspace as upcoming jobs.

import { SignedOut } from "@/app/account/page";
import { createClient } from "@/lib/supabase/server";
import WorkerJobWorkspace from "../WorkerJobWorkspace";
import { loadWorkerJob } from "../jobData";

export default async function CurrentJobPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <SignedOut area="provider" />;

  const { data: provider } = await supabase
    .from("providers")
    .select("id, joining_fee_paid, vetting_status")
    .eq("profile_id", user.id)
    .maybeSingle();

  const blocked =
    !provider ||
    !provider.joining_fee_paid ||
    provider.vetting_status !== "approved";

  const { data: rows } = !blocked
    ? await supabase
        .from("bookings")
        .select("id")
        .eq("status", "in_progress")
        .order("scheduled_at", { ascending: true })
        .limit(1)
    : { data: null };

  const bookingId = rows?.[0]?.id ?? null;
  const job = bookingId ? await loadWorkerJob(supabase, bookingId) : null;

  return (
    <main style={wrap}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {blocked ? (
          <Empty
            title="Your account isn't active for work yet"
            body="Finish provider setup and approval before starting a job."
          />
        ) : !job ? (
          <Empty
            title="No job in progress"
            body="Open an upcoming job from My jobs and check in when you arrive. Its full live workspace will then appear here."
          />
        ) : (
          <>
            <p style={{ margin: "0 0 16px" }}>
              <a href="/worker" style={backLink}>
                ← My jobs
              </a>
            </p>
            <WorkerJobWorkspace job={job} />
          </>
        )}
      </div>
    </main>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <section style={empty}>
      <h1 style={emptyTitle}>{title}</h1>
      <p style={emptyCopy}>{body}</p>
      <a href="/worker" style={button}>
        Go to my jobs
      </a>
    </section>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  color: "var(--ob-text)",
  fontFamily: "'Nunito', system-ui, sans-serif",
  padding: "4px 0 48px",
};

const empty: React.CSSProperties = {
  maxWidth: 720,
  margin: "36px auto 0",
  padding: "42px 28px",
  border: "1.5px dashed var(--ob-border)",
  borderRadius: 20,
  background: "var(--ob-surface)",
  textAlign: "center",
};

const emptyTitle: React.CSSProperties = {
  margin: "0 0 8px",
  color: "var(--ob-text)",
  fontSize: 24,
  fontWeight: 900,
};

const emptyCopy: React.CSSProperties = {
  maxWidth: 500,
  margin: "0 auto 20px",
  color: "var(--ob-muted)",
  fontSize: 14.5,
  fontWeight: 650,
  lineHeight: 1.55,
};

const button: React.CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  background: "var(--ob-text)",
  color: "var(--ob-surface)",
  padding: "11px 20px",
  fontSize: 14,
  fontWeight: 900,
  textDecoration: "none",
};

const backLink: React.CSSProperties = {
  color: "var(--ob-purple)",
  fontSize: 14,
  fontWeight: 800,
  textDecoration: "none",
};
