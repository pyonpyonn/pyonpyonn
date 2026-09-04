"use client";

// SETUP: code "app/page.tsx"
//
// Landing page — two-level nav, hero, coloured service bands.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

type Pkg = { price: number; service_type: string | null; billing_type: string };

export default function Home() {
  const [from, setFrom] = useState<{ clean: number; massage: number }>({
    clean: 0,
    massage: 0,
  });
  const [postcode, setPostcode] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("packages")
        .select("price, service_type, billing_type")
        .eq("active", true)
        .eq("billing_type", "per_visit");

      const list = (data ?? []) as Pkg[];
      const min = (t: string) => {
        const p = list
          .filter((x) => (x.service_type ?? "").includes(t))
          .map((x) => Number(x.price));
        return p.length ? Math.min(...p) : 0;
      };
      setFrom({ clean: min("clean"), massage: min("massage") });
    })();
  }, []);

  const bookLink = postcode
    ? `/book?pc=${encodeURIComponent(postcode)}`
    : "/book";

  return (
    <div className="site">
      {/* ---------- HERO ---------- */}
      <header className="hero">
        <div className="hero-inner">
          <h1>
            You do the living,
            <br />
            we&apos;ll handle the rest
          </h1>
          <p className="lede">
            Vetted cleaners and massage therapists across London. Book a single
            visit or a monthly membership — your call.
          </p>

          <div className="composer">
            <input
              placeholder="Enter your postcode"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              aria-label="Postcode"
            />
            <a className="btn" href={bookLink}>
              Book my cleaning
            </a>
          </div>
          <p className="micro">
            Central, North &amp; West London · pay per visit or subscribe
          </p>
        </div>
      </header>

      {/* ---------- SERVICE BANDS ---------- */}
      <section className="bands" id="services">
        <a className="band clean" href="/services/cleaning">
          <div>
            <h2>Cleaning</h2>
            <p>and ironing, at home</p>
            {from.clean > 0 && <span className="from">from £{from.clean}</span>}
          </div>
          <span className="arrow">→</span>
        </a>

        <a className="band massage" href="/services/massage">
          <div>
            <h2>Massage</h2>
            <p>at home</p>
            {from.massage > 0 && (
              <span className="from">from £{from.massage}</span>
            )}
          </div>
          <span className="arrow">→</span>
        </a>

        <a className="band member" href="/subscribe">
          <div>
            <h2>Memberships</h2>
            <p>regular visits, handled for you</p>
            <span className="from">from £189 / month</span>
          </div>
          <span className="arrow">→</span>
        </a>
      </section>

      {/* ---------- TRUST ---------- */}
      <section className="strip">
        {[
          ["Vetted & insured", "Every provider background-checked"],
          ["Clear pricing", "No hourly haggling, no hidden fees"],
          ["Your regular pro", "Ask for them again next time"],
          ["Book in 2 hours", "Same-day slots when pros are free"],
        ].map(([t, s]) => (
          <div key={t}>
            <strong>{t}</strong>
            <span>{s}</span>
          </div>
        ))}
      </section>

      {/* ---------- HOW IT WORKS ---------- */}
      <section id="how" className="band-alt">
        <div className="inner">
          <p className="eyebrow center">How it works</p>
          <h2 className="center big">Four steps, then it just happens</h2>
          <ol className="steps">
            {[
              ["Enter your postcode", "We check we cover you."],
              ["Choose your service", "See the price before you commit."],
              ["Pick a time", "Only times a pro is genuinely free."],
              ["Sit back", "They arrive, check in, and take care of it."],
            ].map(([t, s], i) => (
              <li key={t}>
                <span className="num">{i + 1}</span>
                <div>
                  <strong>{t}</strong>
                  <p>{s}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- TESTIMONIALS ---------- */}
      <section className="quotes-wrap">
        <div className="inner">
          <p className="eyebrow center">From our members</p>
          <h2 className="center big">Quietly, reliably better</h2>
          <div className="quotes">
            {[
              [
                "The same cleaner every fortnight has changed how our home feels. I no longer think about it.",
                "Eleanor R. · Kensington",
              ],
              [
                "Having a therapist come to the house after a long week is the best thing I've added to my routine.",
                "James T. · Hampstead",
              ],
              [
                "Booking took two minutes and the standard has never slipped. That's all I wanted.",
                "Priya M. · Chiswick",
              ],
            ].map(([q, who]) => (
              <blockquote key={who}>
                <p>{q}</p>
                <footer>{who}</footer>
              </blockquote>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- CTA ---------- */}
      <section className="cta-band">
        <h2>Ready to hand it over?</h2>
        <p>Enter your postcode and see what&apos;s free this week.</p>
        <a className="btn light" href="/book">
          Book a service
        </a>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="foot">
        <div>
          <strong>Opulence Bliss</strong>
          <p>Premium home &amp; wellness care, London.</p>
        </div>
        <div className="foot-links">
          <a href="/services/cleaning">Cleaning</a>
          <a href="/services/massage">Massage</a>
          <a href="/subscribe">Memberships</a>
          <a href="/provider/join">Work with us</a>
          <a href="/provider/login">Provider login</a>
        </div>
      </footer>

      <style jsx>{`
        .site {
          --cream: var(--ob-surface);
          --green: var(--ob-text);
          --green-mid: var(--ob-purple);
          --green-pale: var(--ob-purple-soft);
          --apricot: #f5c542;
          --apricot-deep: var(--ob-purple);
          --ink: var(--ob-text);
          --muted: var(--ob-muted);
          --line: var(--ob-border);
          background: transparent;
          color: var(--ink);
          font-family: var(--font-nunito), "Nunito", system-ui, sans-serif;
          overflow-x: hidden;
        }
        h1,
        h2,
        h3 {
          font-family: inherit;
          font-weight: 900;
          color: var(--green);
        }
        .center {
          text-align: center;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.14em;
          font-size: 12px;
          font-weight: 600;
          color: var(--apricot-deep);
          margin: 0 0 8px;
        }
        .inner {
          max-width: 1080px;
          margin: 0 auto;
        }

        /* TOP BAR */
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
          font-size: 24px;
          font-weight: 600;
          color: var(--green);
          text-decoration: none;
          letter-spacing: -0.01em;
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

        /* SERVICE NAV */
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
        .servicenav a:hover {
          color: var(--apricot-deep);
          border-bottom-color: var(--apricot);
        }

        /* HERO */
        .hero {
          position: relative;
          isolation: isolate;
          overflow: hidden;
          background: linear-gradient(112deg, #d8a72d, #bd66ba 53%, #6d28d9);
          padding: 88px 28px 96px;
        }
        .hero::before,
        .hero::after {
          content: "";
          position: absolute;
          z-index: -1;
          border-radius: 999px;
          pointer-events: none;
        }
        .hero::before {
          width: 420px;
          height: 420px;
          top: -270px;
          right: 8%;
          background: rgba(255, 255, 255, 0.2);
          filter: blur(3px);
        }
        .hero::after {
          width: 300px;
          height: 300px;
          left: -120px;
          bottom: -220px;
          background: rgba(71, 22, 143, 0.24);
        }
        .hero-inner {
          max-width: 1080px;
          margin: 0 auto;
        }
        h1 {
          color: #fff;
          font-size: clamp(38px, 6.5vw, 74px);
          line-height: 1.02;
          letter-spacing: -0.015em;
          margin: 0 0 18px;
        }
        .lede {
          color: rgba(255, 255, 255, 0.9);
          font-size: 18px;
          line-height: 1.6;
          max-width: 44ch;
          margin: 0 0 30px;
        }
        .composer {
          display: flex;
          gap: 10px;
          background: rgba(255, 255, 255, 0.94);
          border: 1px solid rgba(255, 255, 255, 0.56);
          border-radius: 999px;
          padding: 7px 7px 7px 22px;
          max-width: 500px;
          box-shadow: 0 18px 48px rgba(45, 19, 73, 0.22);
          backdrop-filter: blur(12px);
        }
        .composer input {
          flex: 1;
          border: none;
          outline: none;
          font: inherit;
          font-size: 16px;
          background: transparent;
          color: var(--ink);
          text-transform: uppercase;
          min-width: 0;
        }
        .btn {
          background: linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7);
          color: #fff;
          text-decoration: none;
          border-radius: 999px;
          padding: 13px 26px;
          font-weight: 900;
          font-size: 15.5px;
          white-space: nowrap;
          display: inline-block;
          box-shadow: 0 7px 18px rgba(72, 28, 142, 0.2);
          transition: transform 0.18s ease, filter 0.18s ease;
        }
        .btn:hover {
          filter: brightness(1.06);
          transform: translateY(-1px);
        }
        .btn.light {
          background: var(--cream);
          color: var(--green);
        }
        .micro {
          color: rgba(255, 255, 255, 0.8);
          font-size: 13.5px;
          margin: 14px 0 0;
        }

        /* SERVICE BANDS */
        .bands {
          max-width: 1080px;
          margin: 0 auto;
          padding: 44px 28px 10px;
          display: grid;
          gap: 16px;
        }
        .band {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 168px;
          padding: 30px 34px;
          border: 1px solid var(--line);
          border-radius: 22px;
          text-decoration: none;
          transition: transform 0.18s ease, box-shadow 0.18s ease;
          box-shadow: 0 9px 26px var(--ob-shadow-soft);
        }
        .band:hover {
          transform: translateY(-3px);
          box-shadow: 0 18px 46px var(--ob-shadow);
        }
        .band h2 {
          font-size: clamp(30px, 4.4vw, 46px);
          margin: 0 0 4px;
          color: var(--green);
        }
        .band p {
          margin: 0 0 10px;
          font-size: 16px;
          color: rgba(38, 48, 42, 0.72);
        }
        .from {
          display: inline-block;
          background: rgba(255, 255, 255, 0.82);
          border: 1px solid rgba(255, 255, 255, 0.48);
          color: var(--green);
          font-size: 13.5px;
          font-weight: 700;
          padding: 6px 14px;
          border-radius: 999px;
        }
        .arrow {
          font-size: 30px;
          color: var(--green);
          opacity: 0.6;
        }
        .band.clean {
          background: linear-gradient(100deg,#F6F1FF,#EDE4FB);
        }
        .band.massage {
          background: linear-gradient(100deg,#FFF8E6,#FDEEC4);
        }
        .band.member {
          background: linear-gradient(100deg,#F7F8F9,#ECEEF1);
        }

        /* TRUST STRIP */
        .strip {
          border-top: 1px solid var(--line);
          border-bottom: 1px solid var(--line);
          background: var(--ob-surface);
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          max-width: 1080px;
          margin: 44px auto 0;
          border: 1px solid var(--line);
          border-radius: 20px;
          overflow: hidden;
          box-shadow: 0 10px 30px var(--ob-shadow-soft);
        }
        .strip > div {
          padding: 26px 24px;
          border-right: 1px solid var(--line);
        }
        .strip > div:last-child {
          border-right: none;
        }
        .strip strong {
          display: block;
          color: var(--green);
          font-size: 15px;
          margin-bottom: 4px;
        }
        .strip span {
          font-size: 13.5px;
          color: var(--muted);
        }

        /* BANDS / SECTIONS */
        .band-alt {
          background: color-mix(in srgb, var(--ob-surface-soft) 74%, transparent);
          padding: 78px 28px;
          margin-top: 0;
        }
        .quotes-wrap {
          padding: 78px 28px;
        }
        .big {
          font-size: clamp(30px, 4.4vw, 44px);
          margin: 0 0 12px;
          line-height: 1.1;
        }
        .steps {
          list-style: none;
          padding: 0;
          margin: 44px 0 0;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 22px;
        }
        .steps li {
          display: grid;
          gap: 12px;
        }
        .num {
          display: grid;
          place-items: center;
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: linear-gradient(135deg, #c86fc9, #6d28d9);
          color: #fff;
          font-family: inherit;
          font-size: 17px;
        }
        .steps strong {
          color: var(--green);
          font-size: 16.5px;
        }
        .steps p {
          color: var(--muted);
          font-size: 14.5px;
          margin: 6px 0 0;
          line-height: 1.55;
        }
        .quotes {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 22px;
          margin-top: 42px;
        }
        blockquote {
          background: var(--ob-surface-raised);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 28px 26px;
          margin: 0;
          box-shadow: 0 10px 30px var(--ob-shadow-soft);
        }
        blockquote p {
          font-family: inherit;
          font-size: 17.5px;
          line-height: 1.5;
          color: var(--ink);
          margin: 0 0 16px;
        }
        blockquote footer {
          font-size: 13.5px;
          color: var(--muted);
        }

        /* CTA */
        .cta-band {
          background: linear-gradient(135deg, #18202d, #302040);
          color: #fff;
          text-align: center;
          padding: 76px 28px;
        }
        .cta-band h2 {
          color: #fff;
          font-size: clamp(30px, 4.4vw, 44px);
          margin: 0 0 10px;
        }
        .cta-band p {
          color: #cfdcd2;
          margin: 0 0 26px;
        }

        /* FOOTER */
        .foot {
          max-width: 1080px;
          margin: 0 auto;
          padding: 44px 28px 76px;
          display: flex;
          justify-content: space-between;
          gap: 24px;
          flex-wrap: wrap;
        }
        .foot strong {
          font-family: inherit;
          font-size: 18px;
          color: var(--green);
        }
        .foot p {
          color: var(--muted);
          font-size: 14px;
          margin: 6px 0 0;
        }
        .foot-links {
          display: flex;
          gap: 22px;
          flex-wrap: wrap;
        }
        .foot-links a {
          color: var(--green-mid);
          text-decoration: none;
          font-size: 14.5px;
        }
        .foot-links a:hover {
          color: var(--green);
        }

        /* RESPONSIVE */
        @media (max-width: 900px) {
          .strip,
          .steps,
          .quotes {
            grid-template-columns: 1fr 1fr;
          }
          .strip > div:nth-child(2) {
            border-right: none;
          }
          .strip {
            margin-left: 20px;
            margin-right: 20px;
          }
        }
        @media (max-width: 620px) {
          .topbar,
          .servicenav {
            padding-left: 16px;
            padding-right: 16px;
          }
          .servicenav {
            gap: 20px;
          }
          .hero {
            padding: 54px 16px 62px;
          }
          .bands {
            padding: 30px 16px 4px;
          }
          .band {
            min-height: 130px;
            padding: 22px 22px;
          }
          .strip,
          .steps,
          .quotes {
            grid-template-columns: 1fr;
          }
          .strip > div {
            border-right: none;
            border-bottom: 1px solid var(--line);
          }
          .composer {
            flex-direction: column;
            border-radius: 18px;
            padding: 14px;
          }
          .composer .btn {
            width: 100%;
            box-sizing: border-box;
            text-align: center;
          }
          .strip {
            margin-left: 16px;
            margin-right: 16px;
          }
        }
      `}</style>
    </div>
  );
}
