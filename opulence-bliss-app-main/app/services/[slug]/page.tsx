"use client";

// SETUP: mkdir -p "app/services/[slug]" && code "app/services/[slug]/page.tsx"
//
// Service category page — /services/cleaning and /services/massage

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

type Pkg = {
  id: string;
  name: string;
  description: string | null;
  inclusions: string[] | null;
  good_to_know: string[] | null;
  price: number;
  duration_minutes: number | null;
  service_type: string | null;
};

type Review = { rating: number; comment: string | null; created_at: string };

const COPY: Record<
  string,
  {
    title: string;
    match: string;
    tagline: string;
    ticks: string[];
    proLink: string;
    proText: string;
    intro: string;
    alsoTitle: string;
    also: { label: string; type: string }[];
    faq: { q: string; a: string }[];
  }
> = {
  cleaning: {
    title: "Home Cleaning near you",
    match: "clean",
    tagline: "Put your feet up — we'll take care of the rest.",
    ticks: [
      "Vetted, insured cleaners in your area",
      "One-off or regular cleaning",
      "All products and equipment included",
      "7 days a week, 8am to 8pm",
    ],
    proLink: "/provider/join",
    proText: "Become an Opulence cleaner",
    intro:
      "Book a cleaner who learns your home — your products, your preferences, your rhythm. Choose a single visit, or set up regular ones and stop thinking about it.",
    alsoTitle: "Looking for something else in cleaning?",
    also: [
      { label: "Regular cleaning", type: "clean" },
      { label: "One-off cleaning", type: "clean" },
      { label: "Deep cleaning", type: "clean" },
      { label: "Cleaning & ironing", type: "clean" },
    ],
    faq: [
      {
        q: "How do I book a cleaner near me?",
        a: "Enter your postcode, choose the session that suits you, then pick a time from the slots our cleaners actually have free. You'll be matched with a vetted cleaner in your area and told as soon as one accepts.",
      },
      {
        q: "Do I need to provide anything?",
        a: "No. Your cleaner brings all products and equipment, including eco-friendly cleaning products as standard. Someone does need to be home to let them in, or you can leave access instructions when you book.",
      },
      {
        q: "How long does a clean take?",
        a: "Our Essential Clean is two hours, which suits regular upkeep of a one or two bedroom home. The Signature Deep Clean is three hours and covers the whole home including inside appliances — better for a first visit or a seasonal reset.",
      },
      {
        q: "When am I charged?",
        a: "Your card is held when you book, but only charged once the visit is complete. If no cleaner accepts your booking, the hold is released and you pay nothing.",
      },
      {
        q: "Can I have the same cleaner each time?",
        a: "Yes — after a visit you can ask for that cleaner again, and we'll prioritise them for your future bookings. A membership makes this the default.",
      },
    ],
  },
  massage: {
    title: "Mobile Massage near you",
    match: "massage",
    tagline: "Relax — we bring the treatment room to you.",
    ticks: [
      "Qualified, insured therapists in your area",
      "60 or 90 minute sessions",
      "Table, linens and oils provided",
      "7 days a week, 8am to 8pm",
    ],
    proLink: "/provider/join",
    proText: "Become an Opulence therapist",
    intro:
      "Need to decompress after a hard day? Book a wellness massage at home. Choose the technique that suits you — relaxing, deep tissue, or something gentler — and your therapist arrives with everything needed.",
    alsoTitle: "Looking for something else in massage?",
    also: [
      { label: "Female therapist", type: "massage" },
      { label: "Male therapist", type: "massage" },
      { label: "Deep tissue", type: "massage" },
      { label: "Relaxing massage", type: "massage" },
    ],
    faq: [
      {
        q: "How do I book a massage near me?",
        a: "Enter your postcode, tell us who it's for and whether you'd prefer a female or male therapist, then choose your session and a time. Your therapist arrives with a professional table, fresh linens and oils.",
      },
      {
        q: "What do I need to prepare?",
        a: "A clear space of roughly two metres by two metres, and somewhere to hang a towel. That's it — everything else comes with your therapist.",
      },
      {
        q: "How long does a massage last?",
        a: "Choose 60 or 90 minutes. The 90-minute session includes a short consultation at the start so your therapist can tailor the pressure and focus areas.",
      },
      {
        q: "Is massage suitable during pregnancy?",
        a: "Not during the first trimester. After that, please tell us when you book so we can match you with a therapist experienced in prenatal massage.",
      },
      {
        q: "Can I choose a female or male therapist?",
        a: "Yes. You'll be asked at the start of booking, and we'll only offer the job to therapists matching your preference.",
      },
    ],
  },
};

const money = (n: number) => "£" + Number(n).toFixed(0);

function ago(iso: string) {
  const days = Math.floor(
    (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
  });
}

export default function ServicePage() {
  const params = useParams<{ slug: string }>();
  const slug = (params?.slug ?? "cleaning").toString();
  const copy = COPY[slug] ?? COPY.cleaning;

  const [items, setItems] = useState<Pkg[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [postcode, setPostcode] = useState("");
  const [open, setOpen] = useState<number | null>(0);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("packages")
        .select(
          "id, name, description, inclusions, good_to_know, price, duration_minutes, service_type"
        )
        .eq("active", true)
        .eq("billing_type", "per_visit")
        .order("price");

      setItems(
        ((data ?? []) as Pkg[]).filter((p) =>
          (p.service_type ?? "").includes(copy.match)
        )
      );

      const { data: revs } = await supabase
        .from("reviews")
        .select("rating, comment, created_at")
        .eq("reviewer", "client")
        .order("created_at", { ascending: false })
        .limit(6);
      setReviews((revs ?? []) as Review[]);
    })();
  }, [copy.match]);

  const cheapest = items.length
    ? Math.min(...items.map((i) => Number(i.price)))
    : 0;
  const avg =
    reviews.length > 0
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : null;

  const bookLink = `/book?type=${copy.match}${
    postcode ? `&pc=${encodeURIComponent(postcode)}` : ""
  }`;

  return (
    <div className="page">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap"
      />

      {/* ---------- HERO ---------- */}
      <header className="hero">
        <div className="inner hero-grid">
          <div>
            <h1>{copy.title}</h1>

            {avg !== null ? (
              <p className="stars">
                <span>{"★".repeat(Math.round(avg))}</span> {avg.toFixed(1)}/5 ·{" "}
                <a href="#reviews">
                  {reviews.length} review{reviews.length === 1 ? "" : "s"}
                </a>
              </p>
            ) : (
              <p className="stars muted">New — be one of our first reviews</p>
            )}

            <p className="tagline">{copy.tagline}</p>

            <ul className="ticks">
              {copy.ticks.map((t) => (
                <li key={t}>{t}</li>
              ))}
              {cheapest > 0 && (
                <li>
                  <strong>
                    {slug === "massage" ? "Sessions" : "Cleans"} from{" "}
                    {money(cheapest)}
                  </strong>
                </li>
              )}
            </ul>

            <div className="composer">
              <input
                placeholder="Enter your postcode"
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                aria-label="Postcode"
              />
              <a className="btn" href={bookLink}>
                Book my {slug === "massage" ? "massage" : "cleaning"}
              </a>
            </div>

            <a className="prolink" href={copy.proLink}>
              {copy.proText} →
            </a>
          </div>

          <div className="hero-art" aria-hidden="true">
            <span>{slug === "massage" ? "❋" : "✿"}</span>
          </div>
        </div>
      </header>

      {/* ---------- REASSURANCE ---------- */}
      <section className="love">
        <div className="inner">
          <h2 className="center">You&apos;re going to love us</h2>
          <div className="cards3">
            {[
              [
                "We're thorough",
                "Every provider is vetted, insured and rated by the people they've worked for.",
              ],
              [
                "We're flexible",
                "Something come up? Reschedule or cancel free of charge before your visit.",
              ],
              [
                "We're fair",
                "You're only charged once the visit is done — and your provider keeps their full rate.",
              ],
            ].map(([t, s]) => (
              <div key={t} className="lovecard">
                <strong>{t}</strong>
                <p>{s}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- REVIEWS ---------- */}
      <section className="reviews" id="reviews">
        <div className="inner">
          <h2>{slug === "massage" ? "Massage" : "Cleaning"} reviews</h2>

          {reviews.length === 0 ? (
            <div className="empty">
              No reviews yet. Every customer rates their visit, and they&apos;ll
              appear here as they come in.
            </div>
          ) : (
            <>
              {avg !== null && (
                <p className="big-score">
                  <strong>{avg.toFixed(1)}</strong> /5 · from{" "}
                  {reviews.length} verified customer
                  {reviews.length === 1 ? "" : "s"}
                </p>
              )}
              <div className="revgrid">
                {reviews.map((r, i) => (
                  <blockquote key={i}>
                    <p className="rstars">
                      {"★".repeat(r.rating)}
                      {"☆".repeat(5 - r.rating)}{" "}
                      <small>{ago(r.created_at)}</small>
                    </p>
                    {r.comment ? (
                      <p className="rtext">{r.comment}</p>
                    ) : (
                      <p className="rtext muted">Rated {r.rating} out of 5.</p>
                    )}
                    <footer>Verified customer</footer>
                  </blockquote>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {/* ---------- SERVICES ---------- */}
      <section className="services">
        <div className="inner">
          <h2>Our {slug === "massage" ? "massage" : "cleaning"} services</h2>
          <p className="intro">{copy.intro}</p>

          {items.length === 0 ? (
            <p className="muted">Loading…</p>
          ) : (
            <div className="grid">
              {items.map((p, i) => (
                <article key={p.id} className={i === 0 ? "card pop" : "card"}>
                  {i === 0 && <span className="pill">Popular</span>}
                  <h3>{p.name}</h3>
                  <p className="price">
                    {money(p.price)}
                    <span>
                      {" "}
                      per visit
                      {p.duration_minutes ? ` · ${p.duration_minutes} min` : ""}
                    </span>
                  </p>
                  {p.description && <p className="desc">{p.description}</p>}
                  {p.inclusions && (
                    <ul>
                      {p.inclusions.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  )}
                  <a className="btn ghost" href={bookLink}>
                    Book this
                  </a>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ---------- SOMETHING ELSE ---------- */}
      <section className="also">
        <div className="inner">
          <h2>{copy.alsoTitle}</h2>
          <div className="chips">
            {copy.also.map((a) => (
              <a key={a.label} href={`/book?type=${a.type}`} className="chip">
                {a.label}
              </a>
            ))}
            <a href="/subscribe" className="chip alt">
              Regular visits — memberships
            </a>
          </div>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="faq">
        <div className="inner">
          <h2>
            All about our {slug === "massage" ? "massage" : "cleaning"} service
          </h2>
          <div className="qs">
            {copy.faq.map((f, i) => (
              <div key={f.q} className={open === i ? "q open" : "q"}>
                <button onClick={() => setOpen(open === i ? null : i)}>
                  <span>{f.q}</span>
                  <em>{open === i ? "−" : "+"}</em>
                </button>
                {open === i && <p>{f.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <style jsx>{`
        .page {
          --cream: #ffffff;
          --green: #16202A;
          --green-pale: #F4ECFE;
          --apricot: #F5C542;
          --apricot-deep: #6D28D9;
          --ink: #16202A;
          --muted: #7A828C;
          --line: #EDEFF1;
          background: var(--cream);
          color: var(--ink);
          font-family: "Nunito", system-ui, sans-serif;
          padding-bottom: 40px;
        }
        .inner {
          max-width: 1040px;
          margin: 0 auto;
          padding: 0 28px;
        }
        h1,
        h2,
        h3 {
          font-family: "Nunito", system-ui, sans-serif;
          font-weight: 900;
          color: var(--green);
        }
        .center {
          text-align: center;
        }
        .muted {
          color: var(--muted);
        }

        /* bars */
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 18px 28px;
          background: #fff;
          border-bottom: 1px solid var(--line);
        }
        .logo {
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 23px;
          font-weight: 600;
          color: var(--green);
          text-decoration: none;
        }
        .top-right {
          display: flex;
          align-items: center;
          gap: 22px;
        }
        .jobs {
          color: var(--ink);
          font-size: 15px;
          font-weight: 600;
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .icon {
          color: var(--green);
          font-size: 20px;
          text-decoration: none;
        }
        .servicenav {
          display: flex;
          gap: 30px;
          padding: 0 28px;
          background: #fff;
          border-bottom: 1px solid var(--line);
          overflow-x: auto;
        }
        .servicenav a {
          color: var(--ink);
          text-decoration: none;
          font-size: 16px;
          font-weight: 600;
          padding: 15px 0;
          border-bottom: 3px solid transparent;
          white-space: nowrap;
        }
        .servicenav a.on {
          color: var(--apricot-deep);
          border-bottom-color: var(--apricot-deep);
        }

        /* hero */
        .hero {
          background: linear-gradient(120deg,#FFF8E6,#F6F1FF 55%,#EDE4FB);
          padding: 52px 0 58px;
        }
        .hero-grid {
          display: grid;
          grid-template-columns: 1.25fr 0.75fr;
          gap: 40px;
          align-items: center;
        }
        h1 {
          font-size: clamp(30px, 5vw, 50px);
          line-height: 1.05;
          margin: 0 0 8px;
        }
        .stars {
          margin: 0 0 16px;
          font-size: 15px;
        }
        .stars span {
          color: var(--apricot-deep);
          letter-spacing: 2px;
        }
        .stars a {
          color: var(--green);
          text-decoration: underline;
        }
        .tagline {
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 19px;
          color: var(--green);
          margin: 0 0 20px;
        }
        .ticks {
          list-style: none;
          padding: 0;
          margin: 0 0 26px;
          display: grid;
          gap: 9px;
        }
        .ticks li {
          font-size: 16px;
          padding-left: 28px;
          position: relative;
        }
        .ticks li::before {
          content: "✓";
          position: absolute;
          left: 0;
          color: var(--green);
          font-weight: 700;
        }
        .composer {
          display: flex;
          gap: 10px;
          background: #fff;
          border-radius: 999px;
          padding: 7px 7px 7px 22px;
          max-width: 480px;
          box-shadow: 0 10px 30px rgba(22,32,42, 0.12);
        }
        .composer input {
          flex: 1;
          border: none;
          outline: none;
          font: inherit;
          font-size: 16px;
          background: transparent;
          text-transform: uppercase;
          min-width: 0;
          color: var(--ink);
        }
        .btn {
          background: linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7);
          color: #fff;
          text-decoration: none;
          border-radius: 999px;
          padding: 13px 24px;
          font-weight: 700;
          font-size: 15px;
          white-space: nowrap;
          display: inline-block;
        }
        .btn:hover {
          filter: brightness(1.06);
        }
        .btn.ghost {
          background: transparent;
          color: var(--green);
          border: 1.5px solid var(--green);
          margin-top: auto;
          text-align: center;
        }
        .btn.wide {
          display: block;
          text-align: center;
          background: var(--apricot-deep);
          max-width: 480px;
          margin: 0 auto;
        }
        .prolink {
          display: inline-block;
          margin-top: 18px;
          color: var(--green);
          font-size: 14.5px;
          font-weight: 600;
        }
        .hero-art {
          display: grid;
          place-items: center;
          aspect-ratio: 4 / 3;
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.9);
        }
        .hero-art span {
          font-size: 74px;
          color: var(--apricot-deep);
          opacity: 0.55;
        }

        /* love */
        .love {
          padding: 62px 0 10px;
        }
        h2 {
          font-size: clamp(26px, 3.6vw, 36px);
          margin: 0 0 24px;
        }
        .cards3 {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 18px;
        }
        .lovecard {
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 24px 22px;
        }
        .lovecard strong {
          display: block;
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 19px;
          color: var(--green);
          margin-bottom: 6px;
        }
        .lovecard p {
          margin: 0;
          color: var(--muted);
          font-size: 14.5px;
          line-height: 1.55;
        }

        /* reviews */
        .reviews {
          padding: 62px 0 10px;
        }
        .big-score {
          margin: 0 0 22px;
          font-size: 16px;
          color: var(--muted);
        }
        .big-score strong {
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 34px;
          color: var(--apricot-deep);
        }
        .revgrid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 16px;
        }
        blockquote {
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 20px 22px;
          margin: 0;
        }
        .rstars {
          margin: 0 0 8px;
          color: var(--apricot-deep);
          letter-spacing: 2px;
          font-size: 15px;
        }
        .rstars small {
          color: var(--muted);
          letter-spacing: 0;
          font-size: 12.5px;
        }
        .rtext {
          margin: 0 0 12px;
          font-size: 14.5px;
          line-height: 1.55;
          color: var(--ink);
        }
        blockquote footer {
          font-size: 12.5px;
          color: var(--muted);
        }
        .empty {
          background: #fff;
          border: 1.5px dashed #E5E7EA;
          border-radius: 14px;
          padding: 28px 24px;
          color: var(--muted);
          text-align: center;
        }

        /* services */
        .services {
          padding: 62px 0 10px;
        }
        .intro {
          color: #3A424B;
          font-size: 16.5px;
          line-height: 1.6;
          max-width: 62ch;
          margin: -8px 0 26px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(255px, 1fr));
          gap: 18px;
        }
        .card {
          position: relative;
          background: #fff;
          border: 1.5px solid var(--line);
          border-radius: 18px;
          padding: 26px 24px;
          display: flex;
          flex-direction: column;
        }
        .card.pop {
          border-color: var(--apricot);
        }
        .pill {
          position: absolute;
          top: -11px;
          right: 20px;
          background: var(--apricot-deep);
          color: #fff;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 4px 12px;
          border-radius: 999px;
        }
        h3 {
          font-size: 21px;
          margin: 0 0 6px;
        }
        .price {
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 27px;
          color: var(--ink);
          margin: 0 0 12px;
        }
        .price span {
          font-family: "Nunito", sans-serif;
          font-size: 13px;
          color: var(--muted);
        }
        .desc {
          color: var(--muted);
          font-size: 14.5px;
          margin: 0 0 14px;
        }
        .card ul {
          list-style: none;
          padding: 0;
          margin: 0 0 22px;
          display: grid;
          gap: 8px;
        }
        .card li {
          font-size: 14px;
          padding-left: 18px;
          position: relative;
        }
        .card li::before {
          content: "·";
          position: absolute;
          left: 5px;
          color: var(--apricot-deep);
          font-weight: 700;
        }

        /* also */
        .also {
          padding: 62px 0 10px;
        }
        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .chip {
          background: #fff;
          border: 1.5px solid var(--line);
          border-radius: 999px;
          padding: 11px 20px;
          font-size: 15px;
          font-weight: 600;
          color: var(--green);
          text-decoration: none;
        }
        .chip:hover {
          border-color: var(--apricot-deep);
        }
        .chip.alt {
          background: var(--green-pale);
          border-color: var(--green-pale);
        }

        /* faq */
        .faq {
          padding: 62px 0 20px;
        }
        .qs {
          display: grid;
          gap: 10px;
          max-width: 760px;
        }
        .q {
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 14px;
          overflow: hidden;
        }
        .q.open {
          border-color: var(--apricot);
        }
        .q button {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          background: none;
          border: none;
          padding: 18px 20px;
          font: inherit;
          font-size: 16px;
          font-weight: 600;
          color: var(--green);
          text-align: left;
          cursor: pointer;
        }
        .q em {
          font-style: normal;
          font-size: 21px;
          color: var(--apricot-deep);
        }
        .q p {
          margin: 0;
          padding: 0 20px 20px;
          color: #3A424B;
          font-size: 15.5px;
          line-height: 1.6;
        }


        @media (max-width: 900px) {
          .hero-grid {
            grid-template-columns: 1fr;
          }
          .hero-art {
            display: none;
          }
          .cards3 {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 620px) {
          .inner,
          .topbar,
          .servicenav {
            padding-left: 16px;
            padding-right: 16px;
          }
          .servicenav {
            gap: 20px;
          }
          .composer {
            flex-direction: column;
            border-radius: 18px;
            padding: 14px;
          }
        }
      `}</style>
    </div>
  );
}
