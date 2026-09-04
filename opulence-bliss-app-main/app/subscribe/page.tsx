"use client";

// SETUP: mkdir -p "app/subscribe" && code "app/subscribe/page.tsx"
//
// Monthly memberships — the 3-month recurring contract.

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import AppointmentTimePicker from "@/components/AppointmentTimePicker";
import { londonDate, londonParts } from "@/lib/appointmentWindow";

const supabase = createClient();

type Plan = {
  id: string;
  name: string;
  description: string | null;
  inclusions: string[] | null;
  good_to_know: string[] | null;
  price: number;
  visits_per_month: number | null;
  duration_minutes: number | null;
};

type Area = { name: string; postcode_prefixes: string[] };

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function outward(pc: string) {
  const s = pc.toUpperCase().replace(/\s+/g, "");
  return s.length <= 4 ? s : s.slice(0, s.length - 3);
}

const money = (n: number) => "£" + Number(n).toFixed(0);

function firstMembershipVisit(weekday: number, hour: number) {
  const today = londonParts(Date.now());
  let day = new Date(Date.UTC(today.year, today.month - 1, today.day + 2));
  while (day.getUTCDay() !== weekday) {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  return londonDate(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    hour,
  );
}

function displayHour(hour: number) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Europe/London",
  }).format(londonDate(2026, 1, 15, hour));
}

export default function SubscribePage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [chosen, setChosen] = useState<Plan | null>(null);
  const [postcode, setPostcode] = useState("");
  const [gate, setGate] = useState<null | { ok: boolean; area?: string }>(null);
  const [weekday, setWeekday] = useState(2);
  const [hour, setHour] = useState(10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [{ data: p }, { data: a }] = await Promise.all([
        supabase
          .from("packages")
          .select(
            "id, name, description, inclusions, good_to_know, price, visits_per_month, duration_minutes"
          )
          .eq("active", true)
          .eq("billing_type", "monthly")
          .order("price"),
        supabase
          .from("service_areas")
          .select("name, postcode_prefixes")
          .eq("active", true),
      ]);
      setPlans(p ?? []);
      setAreas(a ?? []);
    })();
  }, []);

  function check() {
    const out = outward(postcode);
    const hit = areas.find((x) => x.postcode_prefixes.includes(out));
    setGate(hit ? { ok: true, area: hit.name } : { ok: false });
  }

  async function subscribe() {
    if (!chosen || !gate?.ok) return;
    setBusy(true);
    setErr(null);

    // First visit: next occurrence of the chosen weekday at the chosen London
    // time, at least two calendar days from now.
    const first = firstMembershipVisit(weekday, hour);

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: chosen.id,
          postcode: postcode.toUpperCase(),
          slot: first.toISOString(),
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error(data.error || "Couldn't start subscription");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  const durationMinutes = chosen?.duration_minutes ?? 120;
  const membershipSlots = useMemo(() => {
    const latestStart = Math.floor((19 * 60 - durationMinutes) / 60);
    return Array.from(
      { length: Math.max(0, latestStart - 7 + 1) },
      (_, index) => firstMembershipVisit(weekday, 7 + index).toISOString(),
    );
  }, [durationMinutes, weekday]);
  const selectedMembershipSlot =
    membershipSlots.find((slot) => londonParts(slot).hour === hour) ?? null;

  return (
    <main className="wrap">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap"
      />

      <div className="inner">
        <p className="eyebrow">Memberships</p>
        <h1>Regular care, handled</h1>
        <p className="lede">
          A three-month membership with your visits scheduled automatically.
          Billed monthly, same trusted team each time.
        </p>

        {/* Plans */}
        <div className="grid">
          {plans.length === 0 ? (
            <p className="muted">Loading memberships…</p>
          ) : (
            plans.map((p, i) => (
              <article
                key={p.id}
                className={
                  chosen?.id === p.id
                    ? "plan on"
                    : i === 1
                    ? "plan featured"
                    : "plan"
                }
                onClick={() => setChosen(p)}
              >
                {i === 1 && chosen?.id !== p.id && (
                  <span className="pill">Most chosen</span>
                )}
                <h2>{p.name}</h2>
                <p className="price">
                  {money(p.price)} <span>/ month</span>
                </p>
                <p className="visits">
                  {p.visits_per_month ?? 2} visits a month
                </p>
                {p.description && <p className="desc">{p.description}</p>}
                {p.inclusions && (
                  <ul>
                    {p.inclusions.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
                {p.good_to_know && (
                  <>
                    <p className="sub-head">Good to know</p>
                    <ul className="know">
                      {p.good_to_know.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </>
                )}
                <span className="choose">
                  {chosen?.id === p.id ? "Selected ✓" : "Select"}
                </span>
              </article>
            ))
          )}
        </div>

        {/* Set up */}
        {chosen && (
          <section className="setup">
            <h2>Set up your {chosen.name} membership</h2>

            <label>Your postcode</label>
            <div className="row">
              <input
                value={postcode}
                onChange={(e) => {
                  setPostcode(e.target.value);
                  setGate(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && check()}
                placeholder="SW3 1AA"
              />
              <button className="ghost" onClick={check}>
                Check
              </button>
            </div>
            {gate?.ok && <p className="ok">We cover {gate.area}.</p>}
            {gate && !gate.ok && (
              <p className="no">
                We&apos;re not in your area yet — try another postcode.
              </p>
            )}

            <label>Preferred day</label>
            <div className="chips">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  className={weekday === i ? "chip on" : "chip"}
                  onClick={() => setWeekday(i)}
                >
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>

            <label>Preferred time</label>
            <AppointmentTimePicker
              slots={membershipSlots}
              value={selectedMembershipSlot}
              onChange={(slot) => setHour(londonParts(slot).hour)}
              durationMinutes={durationMinutes}
              showDate={false}
            />

            <div className="summary">
              <div>
                <dt>Plan</dt>
                <dd>{chosen.name}</dd>
              </div>
              <div>
                <dt>Monthly</dt>
                <dd>{money(chosen.price)}</dd>
              </div>
              <div>
                <dt>Term</dt>
                <dd>3 months minimum</dd>
              </div>
              <div>
                <dt>Visits</dt>
                <dd>
                  {chosen.visits_per_month ?? 2} a month, {DAYS[weekday]}s at{" "}
                  {displayHour(hour)}
                </dd>
              </div>
            </div>

            <button
              className="go"
              onClick={subscribe}
              disabled={busy || !gate?.ok}
            >
              {busy
                ? "Taking you to secure checkout…"
                : `Start membership — ${money(chosen.price)}/month`}
            </button>
            <p className="small">
              Billed monthly for a minimum of three months. Your first payment is
              taken today, and your visits are scheduled straight away.
            </p>
            {err && <p className="no">{err}</p>}
          </section>
        )}

        <p className="alt">
          Just want a one-off visit? <a href="/book">Book a single service →</a>
        </p>
      </div>

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          background: #fff;
          color: #16202A;
          font-family: "Nunito", system-ui, sans-serif;
          padding: 0 20px 80px;
        }
        .inner {
          max-width: 1040px;
          margin: 0 auto;
          padding-top: 40px;
        }
        .brand {
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 19px;
          font-weight: 600;
          color: #16202A;
          text-decoration: none;
          display: inline-block;
          margin-bottom: 26px;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.14em;
          font-size: 12px;
          font-weight: 600;
          color: #6D28D9;
          margin: 0 0 8px;
        }
        h1 {
          font-family: "Nunito", system-ui, sans-serif;
          font-weight: 900;
          font-size: clamp(32px, 5vw, 46px);
          color: #16202A;
          margin: 0 0 12px;
        }
        .lede {
          color: #7A828C;
          font-size: 17px;
          max-width: 52ch;
          margin: 0 0 34px;
          line-height: 1.6;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 18px;
        }
        .plan {
          position: relative;
          background: #fff;
          border: 1.5px solid #EDEFF1;
          border-radius: 18px;
          padding: 26px 24px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          transition: border-color 0.16s ease, transform 0.16s ease;
        }
        .plan:hover {
          border-color: #6D28D9;
          transform: translateY(-2px);
        }
        .plan.featured {
          border-color: #F5C542;
        }
        .plan.on {
          border-color: #16202A;
          box-shadow: 0 12px 32px rgba(22,32,42, 0.12);
        }
        .pill {
          position: absolute;
          top: -11px;
          left: 22px;
          background: linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7);
          color: #fff;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 4px 12px;
          border-radius: 999px;
        }
        h2 {
          font-family: "Nunito", system-ui, sans-serif;
          font-weight: 900;
          font-size: 22px;
          color: #16202A;
          margin: 0 0 6px;
        }
        .price {
          font-family: "Nunito", system-ui, sans-serif;
          font-size: 28px;
          margin: 0 0 2px;
        }
        .price span {
          font-family: "Nunito", sans-serif;
          font-size: 13.5px;
          color: #7A828C;
        }
        .visits {
          font-size: 13.5px;
          color: #6D28D9;
          margin: 0 0 12px;
        }
        .desc {
          font-size: 14.5px;
          color: #7A828C;
          margin: 0 0 14px;
        }
        .sub-head {
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #6D28D9;
          margin: 14px 0 8px;
        }
        ul {
          list-style: none;
          padding: 0;
          margin: 0 0 8px;
          display: grid;
          gap: 7px;
        }
        li {
          font-size: 14px;
          padding-left: 18px;
          position: relative;
        }
        li::before {
          content: "·";
          position: absolute;
          left: 5px;
          color: #6D28D9;
          font-weight: 700;
        }
        ul.know li {
          color: #7A828C;
          font-size: 13px;
        }
        .choose {
          margin-top: auto;
          padding-top: 16px;
          font-size: 14px;
          font-weight: 600;
          color: #16202A;
        }
        .setup {
          background: #fff;
          border: 1px solid #EDEFF1;
          border-radius: 20px;
          padding: 30px 28px;
          margin-top: 30px;
          max-width: 620px;
        }
        .setup h2 {
          font-size: 24px;
          margin-bottom: 20px;
        }
        label {
          display: block;
          font-size: 13.5px;
          color: #7A828C;
          margin: 18px 0 8px;
        }
        .row {
          display: flex;
          gap: 10px;
        }
        input {
          flex: 1;
          min-width: 0;
          padding: 12px 14px;
          border: 1.5px solid #E5E7EA;
          border-radius: 12px;
          font: inherit;
          font-size: 15.5px;
          text-transform: uppercase;
          color: #16202A;
        }
        input:focus-visible {
          outline: none;
          border-color: #16202A;
        }
        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
        }
        .chip {
          background: #FFFFFF;
          border: 1.5px solid #EDEFF1;
          border-radius: 999px;
          padding: 8px 14px;
          font: inherit;
          font-size: 13.5px;
          color: #16202A;
          cursor: pointer;
        }
        .chip.on {
          background: #16202A;
          border-color: #16202A;
          color: #FFFFFF;
          font-weight: 600;
        }
        .ghost {
          background: none;
          border: 1.5px solid #16202A;
          color: #16202A;
          border-radius: 12px;
          padding: 12px 18px;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .ok,
        .no {
          font-size: 14px;
          padding: 10px 12px;
          border-radius: 10px;
          margin: 10px 0 0;
        }
        .ok {
          background: #F4ECFE;
          color: #16202A;
          font-weight: 600;
        }
        .no {
          background: #FFE6EA;
          color: #B0384F;
        }
        .summary {
          background: #FFFFFF;
          border-radius: 14px;
          padding: 6px 18px;
          margin: 24px 0 20px;
        }
        .summary > div {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 0;
          border-bottom: 1px solid #EDEFF1;
        }
        .summary > div:last-child {
          border-bottom: none;
        }
        .summary dt {
          color: #7A828C;
          font-size: 13.5px;
        }
        .summary dd {
          margin: 0;
          font-weight: 600;
          font-size: 14.5px;
          text-align: right;
        }
        .go {
          width: 100%;
          background: linear-gradient(100deg,#F5C542,#C86FC9 55%,#7B2FF7);
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 15px;
          font: inherit;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
        }
        .go:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .small {
          font-size: 12.5px;
          color: #7A828C;
          text-align: center;
          margin: 12px 0 0;
        }
        .alt {
          margin-top: 34px;
          color: #7A828C;
          font-size: 15px;
        }
        .alt a {
          color: #16202A;
          font-weight: 600;
        }
        .muted {
          color: #7A828C;
        }
      `}</style>
    </main>
  );
}
