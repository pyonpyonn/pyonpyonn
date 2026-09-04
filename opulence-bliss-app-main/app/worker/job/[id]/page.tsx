// One assigned job in full.

import { SignedOut } from "@/app/account/page";
import { createClient } from "@/lib/supabase/server";
import WorkerJobWorkspace from "../../WorkerJobWorkspace";
import { loadWorkerJob } from "../../jobData";

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <SignedOut area="provider" />;

  const job = await loadWorkerJob(supabase, id);

  if (!job) {
    return (
      <main style={wrap}>
        <div style={{ maxWidth: 620, margin: "0 auto", paddingTop: 60 }}>
          <h1 style={missingTitle}>Job not found</h1>
          <p style={{ color: "var(--ob-muted)" }}>
            This job may have been reassigned or cancelled.
          </p>
          <p style={{ marginTop: 20 }}>
            <a href="/worker" style={backLink}>
              ← Back to my jobs
            </a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <p style={{ margin: "0 0 16px" }}>
          <a href="/worker" style={backLink}>
            ← My jobs
          </a>
        </p>
        <WorkerJobWorkspace job={job} />
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  color: "var(--ob-text)",
  fontFamily: "'Nunito', system-ui, sans-serif",
  padding: "4px 0 48px",
};

const missingTitle: React.CSSProperties = {
  margin: "0 0 8px",
  color: "var(--ob-text)",
  fontSize: 32,
  fontWeight: 900,
};

const backLink: React.CSSProperties = {
  color: "var(--ob-purple)",
  fontSize: 14,
  fontWeight: 800,
  textDecoration: "none",
};
