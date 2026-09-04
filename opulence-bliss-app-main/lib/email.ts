// Email via Resend. Save at: lib/email.ts
//
// Add to .env.local:
//   RESEND_API_KEY=re_xxxxxxxx
//   EMAIL_FROM=Opulence Bliss <onboarding@resend.dev>
//
// If RESEND_API_KEY isn't set, these calls quietly do nothing — the app
// keeps working, you just don't get email.

const FROM =
  process.env.EMAIL_FROM ?? "Opulence Bliss <onboarding@resend.dev>";

/** Where this app lives. Set NEXT_PUBLIC_SITE_URL in production. */
export const SITE = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

/** Turn "/account" into a full link; leave absolute URLs alone. */
function absolute(url: string) {
  return url.startsWith("/") ? `${SITE}${url}` : url;
}

function wrap(title: string, body: string, cta?: { text: string; url: string }) {
  return `
<div style="background:#fbf7f0;padding:32px 16px;font-family:-apple-system,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #ece5d8;border-radius:16px;padding:32px 30px;">
    <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#cf854f;font-weight:600;margin:0 0 6px;">
      Opulence Bliss
    </p>
    <h1 style="font-family:Georgia,serif;font-weight:500;font-size:24px;color:#2f4a3a;margin:0 0 14px;">
      ${title}
    </h1>
    <div style="color:#4a544c;font-size:15px;line-height:1.6;">${body}</div>
    ${
      cta
        ? `<p style="margin:26px 0 0;">
             <a href="${absolute(cta.url)}" style="display:inline-block;background:#2f4a3a;color:#fbf7f0;
                text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;font-size:14px;">
               ${cta.text}
             </a>
           </p>`
        : ""
    }
    <p style="color:#a89f90;font-size:12px;margin:28px 0 0;border-top:1px solid #f0ebe0;padding-top:16px;">
      Premium home &amp; wellness care, London.
    </p>
  </div>
</div>`.trim();
}

export async function sendEmail(opts: {
  to: string | null | undefined;
  subject: string;
  title: string;
  body: string;
  cta?: { text: string; url: string };
}) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !opts.to) return { skipped: true };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [opts.to],
        subject: opts.subject,
        html: wrap(opts.title, opts.body, opts.cta),
      }),
    });
    if (!res.ok) {
      console.error("Resend error:", await res.text());
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error("Email failed:", e);
    return { ok: false };
  }
}