"use client";

// SETUP: mkdir -p "app/book" && code "app/book/page.tsx"
//
// Booking: Where → Session → Time → Confirm. One question per screen.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import AppointmentTimePicker from "@/components/AppointmentTimePicker";

const supabase = createClient();

type Pkg = {
  id: string;
  name: string;
  description: string | null;
  inclusions: string[] | null;
  good_to_know: string[] | null;
  price: number;
  service_type: string | null;
  duration_minutes: number | null;
};

type Area = { name: string; postcode_prefixes: string[] };

const STEPS = ["Service", "Session", "Time", "Confirm"];

function outwardCode(pc: string) {
  const s = pc.toUpperCase().replace(/\s+/g, "");
  return s.length <= 4 ? s : s.slice(0, s.length - 3);
}

const money = (n: number) => "£" + Number(n).toFixed(2);
function dayLabel(iso: string) {
  const d = new Date(iso);
  const t = new Date();
  const tm = new Date();
  tm.setDate(t.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === tm.toDateString()) return "Tomorrow";
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
const fullLabel = (iso: string) => `${dayLabel(iso)}, ${timeLabel(iso)}`;

function duration(mins: number | null) {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h} hr${h > 1 ? "s" : ""}`;
  return `${m} min`;
}

export default function BookPage() {
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [serviceType, setServiceType] = useState<string | null>(null);
  const [editPc, setEditPc] = useState(false);

  const [step, setStep] = useState(0);
  const [postcode, setPostcode] = useState("");
  const [gate, setGate] = useState<null | { ok: boolean; area?: string }>(null);
  const [selected, setSelected] = useState<Pkg | null>(null);

  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);

  const [request, setRequest] = useState("");
  const [promo, setPromo] = useState("");
  const [promoInfo, setPromoInfo] = useState<{
    ok: boolean;
    msg: string;
    discount?: number;
    total?: number;
  } | null>(null);

  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      const [{ data: pkgs }, { data: ars }] = await Promise.all([
        supabase
          .from("packages")
          .select("*")
          .eq("active", true)
          .eq("billing_type", "per_visit")
          .order("price"),
        supabase
          .from("service_areas")
          .select("name, postcode_prefixes")
          .eq("active", true),
      ]);

      const list = (pkgs ?? []) as Pkg[];
      const areaList = (ars ?? []) as Area[];
      setPackages(list);
      setAreas(areaList);

      let savedPc: string | null = null;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setSignedIn(!!user);
      if (user) {
        const { data: p } = await supabase
          .from("profiles")
          .select("role, postcode")
          .eq("id", user.id)
          .maybeSingle();
        setRole(p?.role ?? null);
        if (p?.postcode) {
          savedPc = p.postcode;
          setPostcode(p.postcode);
        }
      }

      const q = new URLSearchParams(window.location.search);
      const wantPc = q.get("pc");
      const wantType = q.get("type");
      const wantService = q.get("service");
      const wantSlot = q.get("slot");
      const reviewHandoff = q.get("review") === "1";

      if (wantType) setServiceType(wantType);
      if (wantPc) setPostcode(wantPc);

      // Already know where they live? Verify it quietly — no need to ask again.
      const pcToCheck = wantPc ?? savedPc;
      let covered = false;
      if (pcToCheck) {
        const hit = areaList.find((a) =>
          a.postcode_prefixes.includes(outwardCode(pcToCheck))
        );
        covered = !!hit;
        setGate(hit ? { ok: true, area: hit.name } : { ok: false });
      }

      const match = wantService ? list.find((p) => p.id === wantService) : undefined;

      // Assistant handoffs are checked against the current permitted booking
      // window before opening the payment summary. If anything changed, keep the known service and
      // postcode and show fresh times instead of silently returning to step one.
      if (reviewHandoff && match && wantSlot && pcToCheck) {
        try {
          const response = await fetch(
            `/api/slots?postcode=${encodeURIComponent(
              pcToCheck,
            )}&service=${encodeURIComponent(
              match.service_type ?? "",
            )}&duration=${encodeURIComponent(
              String(match.duration_minutes ?? 120),
            )}`,
            { cache: "no-store" },
          );
          const data = await response.json();
          const liveSlots = (data.slots ?? []) as string[];
          const wantedTime = new Date(wantSlot).getTime();
          const liveSlot = liveSlots.find(
            (candidate) => new Date(candidate).getTime() === wantedTime,
          );

          setSelected(match);
          setSlots(liveSlots);
          setGate(
            data.covered
              ? { ok: true, area: areaList.find((area) =>
                  area.postcode_prefixes.includes(outwardCode(pcToCheck)),
                )?.name }
              : { ok: false },
          );

          if (data.covered && liveSlot) {
            setSlot(liveSlot);
            setStep(3);
          } else {
            setStep(data.covered ? 2 : 0);
            setHandoffError(
              data.covered
                ? "That time was just taken. Choose another live time below."
                : "That postcode is not currently in our service area.",
            );
          }
        } catch {
          setSelected(match);
          setStep(2);
          setHandoffError(
            "We could not recheck that time. Please choose a live time below.",
          );
          loadSlots(
            pcToCheck,
            match.service_type ?? "",
            match.duration_minutes,
          );
        }
      } else if (reviewHandoff) {
        setHandoffError(
          "That booking link is incomplete. Please ask the assistant to prepare it again.",
        );
      } else if (match && wantSlot && covered) {
        setSelected(match);
        setSlot(wantSlot);
        setStep(3);
      } else if (match && covered) {
        setSelected(match);
        setStep(2);
        loadSlots(
          pcToCheck!,
          match.service_type ?? "",
          match.duration_minutes,
        );
      } else if (wantType && covered) {
        // Came from a category page and we know their area — straight to sessions.
        setStep(1);
      }

      setLoading(false);
    })();
  }, []);

  /* ---------- actions ---------- */
  function checkPostcode() {
    const hit = areas.find((a) =>
      a.postcode_prefixes.includes(outwardCode(postcode))
    );
    if (hit) {
      setGate({ ok: true, area: hit.name });
      setStep(1);
    } else setGate({ ok: false });
  }

  async function loadSlots(
    pc: string,
    serviceType: string,
    durationMinutes: number | null = selected?.duration_minutes ?? null,
  ) {
    setSlots(null);
    setSlot(null);
    try {
      const res = await fetch(
        `/api/slots?postcode=${encodeURIComponent(pc)}&service=${encodeURIComponent(
          serviceType
        )}&duration=${encodeURIComponent(String(durationMinutes ?? 120))}`
      );
      const data = await res.json();
      const list: string[] = data.slots ?? [];
      setSlots(list);
    } catch {
      setSlots([]);
    }
  }

  function pick(p: Pkg) {
    setSelected(p);
    setPromoInfo(null);
  }

  function goToTimes() {
    if (!selected) return;
    setStep(2);
    loadSlots(
      postcode,
      selected.service_type ?? "",
      selected.duration_minutes,
    );
  }

  async function checkPromo() {
    if (!selected) return;
    setPromoInfo(null);
    try {
      const res = await fetch("/api/promo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: promo, packageId: selected.id }),
      });
      const d = await res.json();
      setPromoInfo(
        d.valid
          ? { ok: true, msg: `${d.code} applied`, discount: d.discount, total: d.total }
          : { ok: false, msg: d.error ?? "That code isn't valid." }
      );
    } catch {
      setPromoInfo({ ok: false, msg: "Couldn't check that code." });
    }
  }

  async function accountThenPay() {
    setPaying(true);
    setPayError(null);
    try {
      if (mode === "new") {
        const res = await fetch("/api/client-signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fullName, email, password, phone, address, postcode }),
        });
        const data = await res.json();
        if (!data.ok) {
          if (data.exists) setMode("existing");
          throw new Error(data.error || "Could not create your account");
        }
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw new Error(error.message);
      setSignedIn(true);
      await startCheckout();
    } catch (e) {
      setPayError(e instanceof Error ? e.message : "Something went wrong");
      setPaying(false);
    }
  }

  function checkout() {
    if (signedIn === false) return accountThenPay();
    return startCheckout();
  }

  async function startCheckout() {
    if (!selected) return;
    setPaying(true);
    setPayError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: selected.id,
          postcode,
          request,
          slot,
          promoCode: promoInfo?.ok ? promo.trim().toUpperCase() : null,
        }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else throw new Error(data.error || "Could not start checkout");
    } catch (e) {
      setPayError(e instanceof Error ? e.message : "Checkout failed");
      setPaying(false);
    }
  }

  /* ---------- provider guard ---------- */
  if (role === "provider") {
    return (
      <main className="guard">
        <div className="gcard">
          <div style={{ fontSize: 38 }}>🧹</div>
          <h1>This is the customer booking page</h1>
          <p>Your jobs and hours are in the provider portal.</p>
          <a className="btn" href="/worker/current">
            Go to my current job
          </a>
        </div>
        <style jsx>{`
          .guard {
            min-height: 70vh;
            display: grid;
            place-items: center;
            padding: 24px;
            font-family: "Nunito", system-ui, sans-serif;
          }
          .gcard {
            background: #fff;
            border: 2px solid #edeff1;
            border-radius: 24px;
            padding: 34px 30px;
            max-width: 420px;
            text-align: center;
          }
          h1 {
            font-size: 23px;
            font-weight: 900;
            color: #16202a;
            margin: 10px 0 6px;
          }
          p {
            color: #7a828c;
            font-weight: 600;
            margin: 0 0 22px;
          }
          .btn {
            display: inline-block;
            background: linear-gradient(100deg, #f5c542, #c86fc9 55%, #7b2ff7);
            color: #fff;
            padding: 13px 26px;
            border-radius: 999px;
            text-decoration: none;
            font-weight: 900;
          }
        `}</style>
      </main>
    );
  }

  const shown = serviceType
    ? packages.filter((p) => (p.service_type ?? "").includes(serviceType))
    : packages;

  const total = selected
    ? promoInfo?.ok && promoInfo.total !== undefined
      ? promoInfo.total
      : Number(selected.price)
    : 0;

  return (
    <div className="wrap">
      <div className="grid">
        {/* ================= MAIN ================= */}
        <main>
          {handoffError && <p className="handoffError">{handoffError}</p>}
          {/* progress */}
          <p className="stepline">
            Step {step + 1} of 4 · <strong>{STEPS[step]}</strong>
          </p>
          <div className="prog">
            <span style={{ width: `${((step + 1) / 4) * 100}%` }} />
          </div>

          {/* ---- 0 SERVICE TYPE ---- */}
          {step === 0 && (
            <section>
              <h1>What do you need?</h1>
              <p className="lede">Pick one to see what&apos;s available.</p>

              <div className="types">
                {[
                  {
                    key: "clean",
                    name: "Cleaning",
                    sub: "Regular, one-off or deep cleans",
                    icon: "✦",
                  },
                  {
                    key: "massage",
                    name: "Massage",
                    sub: "60 or 90 minutes, at your home",
                    icon: "❋",
                  },
                ].map((t) => (
                  <button
                    key={t.key}
                    className={serviceType === t.key ? "type on" : "type"}
                    onClick={() => setServiceType(t.key)}
                  >
                    <span className="typeIcon">{t.icon}</span>
                    <strong>{t.name}</strong>
                    <small>{t.sub}</small>
                  </button>
                ))}
              </div>

              {/* Only ask where if we don't already know */}
              {!gate?.ok && (
                <>
                  <p className="label">Your postcode</p>
                  <div className="inline">
                    <input
                      className="field big"
                      placeholder="e.g. SW3 1AA"
                      value={postcode}
                      onChange={(e) => {
                        setPostcode(e.target.value);
                        setGate(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && checkPostcode()}
                      aria-label="Postcode"
                    />
                    <button className="go" onClick={checkPostcode}>
                      Check
                    </button>
                  </div>
                  {gate && !gate.ok && (
                    <div className="alert">
                      <strong>We&apos;re not in your area just yet.</strong>
                      <span>
                        Right now we cover {areas.map((a) => a.name).join(", ")}.
                      </span>
                    </div>
                  )}
                </>
              )}

              <button
                className="next"
                onClick={() => setStep(1)}
                disabled={!serviceType || !gate?.ok}
              >
                {!serviceType
                  ? "Choose a service"
                  : !gate?.ok
                  ? "Add your postcode"
                  : "Continue"}
              </button>

              <ul className="trust">
                <li>
                  <em>✓</em> Vetted &amp; insured professionals
                </li>
                <li>
                  <em>✓</em> Card held, not charged until the visit is done
                </li>
                <li>
                  <em>✓</em> Free cancellation up to 24 hours before
                </li>
              </ul>
            </section>
          )}

          {/* ---- 1 SESSION ---- */}
          {step === 1 && (
            <section>
              <h1>Choose your session</h1>
              <p className="lede">
                {gate?.area
                  ? `Good news — we cover ${gate.area}.`
                  : "Pick what you'd like."}
              </p>

              {loading ? (
                <p className="muted">Loading…</p>
              ) : (
                <div className="list">
                  {shown.map((p) => (
                    <button
                      key={p.id}
                      className={selected?.id === p.id ? "opt on" : "opt"}
                      onClick={() => pick(p)}
                    >
                      <span className="radio" />
                      <span className="optbody">
                        <span className="optTop">
                          <strong>{p.name}</strong>
                          <b>{money(p.price)}</b>
                        </span>
                        <span className="optMeta">
                          {duration(p.duration_minutes)}
                          {p.service_type
                            ? ` · ${
                                p.service_type.includes("massage")
                                  ? "Massage"
                                  : "Cleaning"
                              }`
                            : ""}
                        </span>
                        {p.description && (
                          <span className="optDesc">{p.description}</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <button
                className="next"
                onClick={goToTimes}
                disabled={!selected}
              >
                {selected ? `Continue with ${selected.name}` : "Choose a session"}
              </button>

              <button className="back" onClick={() => setStep(0)}>
                ← Change service
              </button>
            </section>
          )}

          {/* ---- 2 TIME ---- */}
          {step === 2 && selected && (
            <section>
              <h1>When suits you?</h1>
              <p className="lede">
                Choose the time you want. We&apos;ll find your professional after
                you book.
              </p>

              {slots === null && <p className="muted">Finding times…</p>}

              {slots !== null && slots.length === 0 && (
                <div className="alert">
                  <strong>No appointment times are available.</strong>
                  <span>Try another session or contact support.</span>
                </div>
              )}

              {slots !== null && slots.length > 0 && (
                <AppointmentTimePicker
                  slots={slots}
                  value={slot}
                  onChange={setSlot}
                  durationMinutes={selected.duration_minutes}
                />
              )}

              {slots !== null && slots.length > 0 && (
                <button
                  className="next"
                  onClick={() => setStep(3)}
                  disabled={!slot}
                >
                  {slot ? `Continue · ${fullLabel(slot)}` : "Pick a time"}
                </button>
              )}

              <button className="back" onClick={() => setStep(1)}>
                ← Change session
              </button>
            </section>
          )}

          {/* ---- 3 CONFIRM ---- */}
          {step === 3 && selected && (
            <section>
              <h1>Review and pay</h1>
              <p className="lede">
                Check your visit and payment before continuing to secure checkout.
              </p>

              <div className="reviewCard">
                <div>
                  <span>Service</span>
                  <strong>{selected.name}</strong>
                  <small>{duration(selected.duration_minutes) ?? "Visit"}</small>
                </div>
                <div>
                  <span>Date and time</span>
                  <strong>{slot ? fullLabel(slot) : "Choose a time"}</strong>
                  <small>{postcode.toUpperCase()}</small>
                </div>
                <div>
                  <span>Amount</span>
                  <strong>{money(total)}</strong>
                  <small>Held now, charged after completion</small>
                </div>
              </div>

              <p className="label">Requests (optional)</p>
              <textarea
                className="field"
                rows={3}
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="e.g. key is under the mat, please avoid the study"
              />

              <p className="label">Promo code (optional)</p>
              <div className="inline">
                <input
                  className="field"
                  placeholder="WELCOME10"
                  value={promo}
                  onChange={(e) => {
                    setPromo(e.target.value);
                    setPromoInfo(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && checkPromo()}
                />
                <button className="ghost" onClick={checkPromo}>
                  Apply
                </button>
              </div>
              {promoInfo && (
                <p className={promoInfo.ok ? "flash ok" : "flash no"}>
                  {promoInfo.msg}
                  {promoInfo.ok && promoInfo.discount !== undefined
                    ? ` — ${money(promoInfo.discount)} off`
                    : ""}
                </p>
              )}

              {signedIn === false && (
                <div className="acct">
                  <p className="label" style={{ marginTop: 0 }}>
                    Your details
                  </p>
                  <div className="toggle">
                    <button
                      className={mode === "new" ? "tg on" : "tg"}
                      onClick={() => setMode("new")}
                    >
                      I&apos;m new
                    </button>
                    <button
                      className={mode === "existing" ? "tg on" : "tg"}
                      onClick={() => setMode("existing")}
                    >
                      I have an account
                    </button>
                  </div>

                  {mode === "new" && (
                    <input
                      className="field"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Full name"
                    />
                  )}
                  <input
                    className="field"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email"
                    autoComplete="email"
                  />
                  <input
                    className="field"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "new" ? "Password (6+ characters)" : "Password"}
                    autoComplete={mode === "new" ? "new-password" : "current-password"}
                  />
                  {mode === "new" && (
                    <>
                      <input
                        className="field"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="Phone (optional)"
                      />
                      <input
                        className="field"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="Address (optional)"
                      />
                    </>
                  )}
                </div>
              )}

              <div className="held">
                <strong>Your card is held, not charged</strong>
                <span>
                  You pay once the visit is complete. If no pro accepts, the hold
                  is released and you pay nothing.
                </span>
              </div>

              {payError && <p className="flash no">{payError}</p>}

              <button className="back" onClick={() => setStep(2)}>
                ← Change time
              </button>
            </section>
          )}
        </main>

        {/* ================= BASKET ================= */}
        {step > 0 && (
          <aside className="basket">
            <p className="bhead">Your booking</p>

            <div className="brow">
              <span className="k">Where</span>
              <span className="v">
                {postcode.toUpperCase() || "—"}
                <button className="chg" onClick={() => setEditPc((v) => !v)}>
                  {editPc ? "Cancel" : "Change"}
                </button>
              </span>
            </div>

            {editPc && (
              <div className="pcEdit">
                <input
                  value={postcode}
                  onChange={(e) => {
                    setPostcode(e.target.value);
                    setGate(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      checkPostcode();
                      setEditPc(false);
                    }
                  }}
                  placeholder="New postcode"
                  aria-label="New postcode"
                />
                <button
                  onClick={() => {
                    checkPostcode();
                    setEditPc(false);
                    if (selected) {
                      loadSlots(
                        postcode,
                        selected.service_type ?? "",
                        selected.duration_minutes,
                      );
                    }
                  }}
                >
                  Update
                </button>
              </div>
            )}

            {selected ? (
              <>
                <div className="brow">
                  <span className="k">Service</span>
                  <span className="v">{selected.name}</span>
                </div>
                <div className="brow">
                  <span className="k">Length</span>
                  <span className="v">{duration(selected.duration_minutes) ?? "—"}</span>
                </div>
                <div className="brow">
                  <span className="k">When</span>
                  <span className="v">{slot ? fullLabel(slot) : "Not picked"}</span>
                </div>

                {promoInfo?.ok && promoInfo.discount !== undefined && (
                  <div className="brow">
                    <span className="k">{promo.toUpperCase()}</span>
                    <span className="v disc">−{money(promoInfo.discount)}</span>
                  </div>
                )}

                <div className="total">
                  <span>Total</span>
                  <strong>{money(total)}</strong>
                </div>
                <p className="fee">Service fee included</p>
              </>
            ) : (
              <p className="hint">Pick a session to see your total.</p>
            )}

            {step === 1 && (
              <p className="hint">
                {selected ? "Looks good — continue on the left." : "Pick a session to see your total."}
              </p>
            )}
            {step === 2 && (
              <p className="hint">
                {slot ? "Time picked — continue on the left." : "Now choose a time."}
              </p>
            )}
            {step === 3 && (
              <button className="pay" onClick={checkout} disabled={paying}>
                {paying
                  ? "Taking you to checkout…"
                  : signedIn === false
                  ? mode === "new"
                    ? "Create account & pay"
                    : "Sign in & pay"
                  : "Confirm & pay"}
              </button>
            )}

            <p className="alt">
              Booking often? <a href="/subscribe">Try a membership →</a>
            </p>
          </aside>
        )}
      </div>

      <style jsx>{`
        .wrap {
          --ink: #16202a;
          --muted: #7a828c;
          --line: #edeff1;
          --purple: #6d28d9;
          --grad: linear-gradient(100deg, #f5c542, #c86fc9 55%, #7b2ff7);
          --tint: #f8f3ff;
          min-height: 100vh;
          background: #fff;
          color: var(--ink);
          font-family: "Nunito", system-ui, sans-serif;
        }
        .grid {
          max-width: 1040px;
          margin: 0 auto;
          padding: 30px 20px 96px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 34px;
          align-items: start;
        }
        /* Without this, a wide grid child stops the column shrinking and
           pushes content off screen. */
        main {
          min-width: 0;
          overflow-wrap: anywhere;
        }
        main section {
          min-width: 0;
        }
        .next {
          width: 100%;
          margin-top: 26px;
          background: var(--grad);
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 16px;
          font: inherit;
          font-size: 16.5px;
          font-weight: 900;
          cursor: pointer;
        }
        .next:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        /* progress */
        .stepline {
          font-size: 13.5px;
          font-weight: 700;
          color: var(--muted);
          margin: 0 0 8px;
        }
        .stepline strong {
          color: var(--purple);
          font-weight: 900;
        }
        .types {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr));
          gap: 12px;
          margin-bottom: 6px;
        }
        .type {
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 18px;
          padding: 22px 20px;
          text-align: left;
          font: inherit;
          cursor: pointer;
          transition: border-color 0.15s ease, transform 0.15s ease;
        }
        .type:hover {
          border-color: #c9b6f2;
          transform: translateY(-2px);
        }
        .type.on {
          border-color: var(--purple);
          background: var(--tint);
        }
        .typeIcon {
          display: grid;
          place-items: center;
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: var(--grad);
          color: #fff;
          font-size: 18px;
          margin-bottom: 12px;
        }
        .type strong {
          display: block;
          font-size: 19px;
          font-weight: 900;
          margin-bottom: 3px;
        }
        .type small {
          color: var(--muted);
          font-size: 13.5px;
          font-weight: 600;
        }
        .chg {
          background: none;
          border: none;
          padding: 0 0 0 8px;
          font: inherit;
          font-size: 12.5px;
          font-weight: 800;
          color: var(--purple);
          cursor: pointer;
          text-decoration: underline;
        }
        .pcEdit {
          display: flex;
          gap: 6px;
          padding: 10px 0 4px;
        }
        .pcEdit input {
          flex: 1;
          min-width: 0;
          border: 2px solid var(--line);
          border-radius: 10px;
          padding: 9px 11px;
          font: inherit;
          font-size: 14px;
          font-weight: 700;
          text-transform: uppercase;
          color: var(--ink);
        }
        .pcEdit input:focus-visible {
          outline: none;
          border-color: var(--purple);
        }
        .pcEdit button {
          background: var(--grad);
          color: #fff;
          border: none;
          border-radius: 10px;
          padding: 9px 14px;
          font: inherit;
          font-size: 13.5px;
          font-weight: 900;
          cursor: pointer;
        }
        .prog {
          height: 8px;
          background: #f1f2f4;
          border-radius: 999px;
          overflow: hidden;
          margin-bottom: 26px;
        }
        .prog span {
          display: block;
          height: 100%;
          background: var(--grad);
          border-radius: 999px;
          transition: width 0.3s ease;
        }

        h1 {
          font-size: clamp(26px, 4vw, 34px);
          font-weight: 900;
          letter-spacing: -0.025em;
          margin: 0 0 6px;
        }
        .lede {
          color: var(--muted);
          font-size: 16px;
          font-weight: 600;
          margin: 0 0 24px;
        }
        .handoffError {
          margin: 0 0 16px;
          padding: 12px 14px;
          border: 1.5px solid #f0c36a;
          border-radius: 13px;
          background: #fff9e8;
          color: #7a5200;
          font-size: 14px;
          font-weight: 800;
        }
        .label {
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          margin: 22px 0 9px;
        }
        .muted {
          color: var(--muted);
          font-weight: 600;
        }

        /* fields */
        .field {
          width: 100%;
          box-sizing: border-box;
          padding: 14px 16px;
          border: 2px solid var(--line);
          border-radius: 14px;
          font: inherit;
          font-size: 16px;
          font-weight: 600;
          color: var(--ink);
          background: #fff;
          margin-bottom: 12px;
          resize: vertical;
        }
        .field:focus-visible {
          outline: none;
          border-color: var(--purple);
        }
        .field.big {
          font-size: 19px;
          font-weight: 800;
          text-transform: uppercase;
          padding: 17px 18px;
          margin-bottom: 0;
        }
        .inline {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }
        .inline .field {
          flex: 1;
          min-width: 0;
        }
        .go,
        .ghost {
          border: none;
          border-radius: 14px;
          padding: 16px 26px;
          font: inherit;
          font-size: 16px;
          font-weight: 900;
          cursor: pointer;
          white-space: nowrap;
        }
        .go {
          background: var(--grad);
          color: #fff;
        }
        .ghost {
          background: #fff;
          color: var(--purple);
          border: 2px solid var(--line);
          padding: 14px 22px;
        }

        /* trust */
        .trust {
          list-style: none;
          padding: 24px 0 0;
          margin: 26px 0 0;
          border-top: 1px solid var(--line);
          display: grid;
          gap: 12px;
        }
        .trust li {
          display: flex;
          gap: 10px;
          align-items: center;
          font-size: 15px;
          font-weight: 700;
          color: var(--ink);
        }
        .trust em {
          font-style: normal;
          color: #137b4e;
          font-weight: 900;
        }

        /* session options */
        .list {
          display: grid;
          gap: 12px;
        }
        .opt {
          display: flex;
          gap: 14px;
          align-items: flex-start;
          text-align: left;
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 18px;
          padding: 18px 20px;
          font: inherit;
          cursor: pointer;
          transition: border-color 0.15s ease, transform 0.15s ease;
        }
        .opt:hover {
          border-color: #c9b6f2;
          transform: translateY(-1px);
        }
        .opt.on {
          border-color: var(--purple);
          background: var(--tint);
        }
        .radio {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          border: 2px solid #d6dae0;
          flex-shrink: 0;
          margin-top: 2px;
        }
        .opt.on .radio {
          border-color: var(--purple);
          background: var(--grad);
          box-shadow: inset 0 0 0 3px #fff;
        }
        .optbody {
          flex: 1;
          min-width: 0;
        }
        .optTop {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: baseline;
        }
        .optTop strong {
          font-size: 17.5px;
          font-weight: 900;
        }
        .optTop b {
          font-size: 19px;
          font-weight: 900;
          color: var(--purple);
          white-space: nowrap;
        }
        .optMeta {
          display: block;
          font-size: 13.5px;
          font-weight: 700;
          color: var(--muted);
          margin-top: 2px;
        }
        .optDesc {
          display: block;
          font-size: 14.5px;
          font-weight: 600;
          color: var(--muted);
          margin-top: 8px;
        }

        /* times */
        .times {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(100%, 74px), 1fr));
          gap: 8px;
        }
        .time {
          padding: 11px 6px;
          font-size: 14.5px;
          border-width: 1.5px;
          border-radius: 10px;
        }

        /* confirm */
        .reviewCard {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 24px;
        }
        .reviewCard > div {
          min-width: 0;
          padding: 15px 16px;
          border: 1.5px solid #e8e2f2;
          border-radius: 16px;
          background: linear-gradient(145deg, #fff, #faf7ff);
        }
        .reviewCard span,
        .reviewCard strong,
        .reviewCard small {
          display: block;
        }
        .reviewCard span {
          margin-bottom: 6px;
          color: #8b92a0;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.07em;
          text-transform: uppercase;
        }
        .reviewCard strong {
          color: var(--ink);
          font-size: 15px;
          font-weight: 900;
          line-height: 1.3;
          overflow-wrap: anywhere;
        }
        .reviewCard small {
          margin-top: 4px;
          color: var(--muted);
          font-size: 12.5px;
          font-weight: 700;
          line-height: 1.35;
        }
        .acct {
          background: #fbfaff;
          border: 2px solid #ece5fb;
          border-radius: 18px;
          padding: 18px 20px 8px;
          margin: 22px 0 0;
        }
        .toggle {
          display: flex;
          gap: 8px;
          margin-bottom: 14px;
        }
        .tg {
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 999px;
          padding: 9px 16px;
          font: inherit;
          font-size: 14px;
          font-weight: 800;
          cursor: pointer;
          color: var(--ink);
        }
        .tg.on {
          background: var(--purple);
          border-color: var(--purple);
          color: #fff;
        }
        .held {
          background: #f4fbf7;
          border: 2px solid #cdead9;
          border-radius: 16px;
          padding: 15px 18px;
          margin-top: 22px;
          display: grid;
          gap: 4px;
        }
        .held strong {
          color: #137b4e;
          font-size: 15.5px;
          font-weight: 900;
        }
        .held span {
          color: #4b6b58;
          font-size: 14px;
          font-weight: 600;
          line-height: 1.5;
        }

        .alert {
          background: #fff5d9;
          border: 2px solid #ffe09e;
          border-radius: 16px;
          padding: 15px 18px;
          margin-top: 16px;
          display: grid;
          gap: 3px;
          color: #8a5a00;
        }
        .alert strong {
          font-size: 15.5px;
          font-weight: 900;
        }
        .alert span {
          font-size: 14px;
          font-weight: 600;
        }
        .flash {
          font-size: 14.5px;
          font-weight: 800;
          padding: 11px 14px;
          border-radius: 12px;
          margin: 0 0 6px;
        }
        .flash.ok {
          background: #e4f6ec;
          color: #137b4e;
        }
        .flash.no {
          background: #ffe6ea;
          color: #b0384f;
        }
        .back {
          display: inline-block;
          margin-top: 26px;
          background: none;
          border: none;
          color: var(--muted);
          font: inherit;
          font-size: 14.5px;
          font-weight: 800;
          cursor: pointer;
          padding: 6px 0;
        }
        .back:hover {
          color: var(--purple);
        }

        /* basket */
        .basket {
          background: #fff;
          border: 2px solid var(--line);
          border-radius: 22px;
          padding: 22px 22px 20px;
          position: sticky;
          top: 20px;
        }
        .bhead {
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted);
          margin: 0 0 14px;
        }
        .brow {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 11px 0;
          border-bottom: 1px solid #f4f5f7;
        }
        .k {
          font-size: 13.5px;
          font-weight: 700;
          color: var(--muted);
        }
        .v {
          font-size: 14.5px;
          font-weight: 800;
          text-align: right;
          overflow-wrap: anywhere;
        }
        .v.disc {
          color: #137b4e;
        }
        .total {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 16px 0 2px;
        }
        .total span {
          font-size: 15px;
          font-weight: 800;
          color: var(--muted);
        }
        .total strong {
          font-size: 28px;
          font-weight: 900;
        }
        .fee {
          text-align: right;
          font-size: 12.5px;
          font-weight: 700;
          color: var(--muted);
          margin: 0 0 18px;
        }
        .hint {
          font-size: 14px;
          font-weight: 700;
          color: var(--muted);
          text-align: center;
          margin: 16px 0;
        }
        .pay {
          width: 100%;
          background: var(--grad);
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 16px;
          font: inherit;
          font-size: 16.5px;
          font-weight: 900;
          cursor: pointer;
        }
        .pay:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .alt {
          margin: 18px 0 0;
          padding-top: 16px;
          border-top: 1px solid #f4f5f7;
          font-size: 13.5px;
          font-weight: 700;
          color: var(--muted);
          text-align: center;
        }
        .alt a {
          color: var(--purple);
          font-weight: 900;
          text-decoration: none;
        }

        @media (max-width: 760px) {
          .reviewCard {
            grid-template-columns: 1fr;
          }
          .picker {
            grid-template-columns: minmax(0, 1fr);
          }
          .picker .pickerCol:last-child {
            order: -1;
          }
        }
        @media (max-width: 900px) {
          .grid {
            grid-template-columns: 1fr;
            gap: 24px;
          }
          .basket {
            position: static;
            order: 2;
          }
          main {
            order: 1;
          }
        }
      `}</style>
    </div>
  );
}
