# Questions for Opulence Bliss

_A running list of decisions only the client can make. Add to it whenever we
build something on an assumption, or where their preference may differ from
ours. Nothing here is a technical question._

**How to use this file**

- Anything **Open** is a guess we've made. If they disagree later, it changes code.
- **Blocking** means we cannot go live with real money until it's answered.
- When something is answered, move it to the log at the bottom **with the date
  and their exact words**. Paraphrasing decisions is how disputes start.
- One thing per row. If a question needs a paragraph to answer, it's two questions.

---

## 1. Launch blockers

Real money cannot move until every one of these is answered in writing.

| #   | Question                                                                                                              | What we've assumed                                                                                              | Why it matters                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1.1 | **The exact payment split.** Cleaner's hourly rate, therapist's flat fee, platform margin, membership fee.            | 20% platform / 80% provider · £15/hr cleaner · £45 flat therapist · £30/month membership fee. All placeholders. | Every payout and invoice figure comes from these. Wrong numbers mean underpaying real people.  |
| 1.2 | **Payment model.** Monthly memberships as specified, pay-per-visit, or both?                                          | Both are built and working.                                                                                     | Their brief specified 3-month recurring; we built per-visit first. Unresolved since the start. |
| 1.3 | **Mobile apps.** Formally defer the two native apps and launch on responsive web, or build them now?                  | Treated as still in scope, nothing built.                                                                       | Largest unbuilt item in the signed brief. Affects timeline, price and milestones.              |
| 1.4 | **The four packages.** Final names, prices and what each includes.                                                    | Four per-visit services and four monthly plans, invented.                                                       | Shown on every page and charged to real cards.                                                 |
| 1.5 | **Launch postcodes.** Which areas are covered on day one?                                                             | Central, North and West London.                                                                                 | Postcode gating turns customers away based on this.                                            |
| 1.6 | **Terms & conditions and privacy policy.** Who writes them, and by when?                                              | Not written.                                                                                                    | Legally required before taking cards and holding home addresses.                               |
| 1.7 | **Stripe business verification and Connect onboarding.** Whose company details, whose bank account?                   | Test mode only; all payouts go to one test account.                                                             | Real providers cannot be paid until they're onboarded properly.                                |
| 1.8 | **Account ownership.** Supabase, Stripe, Vercel, Gemini, domain — registered to Opulence Bliss with developer access. | Currently all under the developer's accounts.                                                                   | Promised in writing in the quote. Must be transferred before launch.                           |

---

## 2. Money rules

These are the exceptions that get argued about with a customer watching. Each
needs a rule, not a judgement call.

| #    | Question                                                                                                  | What we've assumed                            |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 2.1  | **Late cancellation by the customer.** Free until when? Any charge after that?                            | Free at any time. No charge, ever.            |
| 2.2  | **No-show by the customer** (provider arrives, nobody home). Charged in full, part, or not at all?        | Goes to review. No automatic charge.          |
| 2.3  | **No-show by the provider.** Customer refunded in full, plus anything as an apology?                      | Full release of the hold. Nothing extra.      |
| 2.4  | **Provider cancels after accepting.** Any compensation to the customer? Any consequence for the provider? | Re-broadcast, hold kept, no penalty recorded. |
| 2.5  | **Work stopped part-way.** Partial charge, partial refund, or full refund?                                | Goes to review. Admin decides case by case.   |
| 2.6  | **Unsafe property.** Is the provider paid for turning up?                                                 | Goes to review. Nothing automatic.            |
| 2.7  | **Damage or injury.** Who is liable, what's the insurance position, what does the platform pay?           | Goes to review. No policy.                    |
| 2.8  | **Tips.** 100% to the provider confirmed? Any platform fee?                                               | 100% to the provider, no fee.                 |
| 2.9  | **Refunds.** Who may approve one, and up to what amount without escalation?                               | Any admin, any amount.                        |
| 2.10 | **Failed or reversed payment after a completed visit.** Is the provider still paid? Who absorbs it?       | Payout held, goes to review.                  |
| 2.11 | **Payout timing.** Immediately on check-out, or after a holding period?                                   | Immediately on check-out.                     |
| 2.12 | **Chargebacks.** Who bears the cost, and is the provider's payout clawed back?                            | No policy. Nothing built.                     |
| 2.13 | **Membership visit not used** in a given month. Rolls over, or lost?                                      | Lost. No rollover built.                      |
| 2.14 | **Membership cancelled mid-term.** Any charge for the remainder of the 3 months?                          | Cancel at any time, no charge.                |

---

## 3. Scope questions

Things in the brief that aren't built, or built differently.

| #    | Question                                                                                                       | Position                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 3.1  | **48-hour reschedule lockout.** Confirm 48 hours is right, and whether admins may override it.                 | Being built now as a configurable rule, admin override allowed with a recorded reason.                                   |
| 3.2  | **Pause a membership visit.** How many per month, and how much notice?                                         | Not built. Cancel and reschedule work.                                                                                   |
| 3.3  | **Bonus media library.** Videos and PDFs — where do the files come from, and web-only or in-app?               | Not built. Recommended web-only to avoid app-store commission on digital content.                                        |
| 3.4  | **Calendar view** of upcoming visits in the customer's account.                                                | Not built — the account shows a list. The booking flow has a calendar.                                                   |
| 3.5  | **Provider vetting.** What do we actually check? DBS, ID, insurance, references?                               | Admin approves manually. No documents collected.                                                                         |
| 3.6  | **Provider joining fee.** £150 one-off confirmed? Refundable if they're not approved?                          | £150 one-off, non-refundable, charged before approval. **Worth deciding — charging before approval invites complaints.** |
| 3.7  | **Geofence radius.** 500m from the postcode — right for London?                                                | 500m, with an override that's recorded.                                                                                  |
| 3.8  | **Offer expiry.** Currently 2 hours before the visit. Right?                                                   | 2 hours, matching the minimum booking notice.                                                                            |
| 3.9  | **Two-way ratings.** Providers rating clients — confirm they want this, and that client ratings stay internal. | Built. Client ratings visible to admins only.                                                                            |
| 3.10 | **Support channel.** Where does "contact support" go? Email, phone, in-app?                                    | Currently points at the customer's Updates page. Placeholder.                                                            |

---

## 4. Operational

Not blocking launch, but someone has to own them.

| #   | Question                                                                                   | Position                                                                                                            |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 4.1 | **Who monitors the resolution desk**, and what response time do we promise?                | SLAs are set by case priority: 1h urgent, 4h high, 1 day normal. Invented — needs confirming against real staffing. |
| 4.2 | **Who reads the reconciliation findings** each morning?                                    | Nobody assigned.                                                                                                    |
| 4.3 | **Transactional email sender domain.** Which address do customers see?                     | `onboarding@resend.dev`. Needs a real domain.                                                                       |
| 4.4 | **AI assistant.** Happy for it to answer customers directly? Any topics it must refuse?    | Live with account lookups. It may prepare booking, cancellation, reschedule and support-request actions, but every mutation needs an explicit customer confirmation and checkout still requires Stripe. |
| 4.5 | **Data retention.** How long do we keep addresses, GPS check-in coordinates and chat logs? | Kept indefinitely. **Needs a policy — GPS and addresses are personal data.**                                        |
| 4.6 | **Provider suspension.** Who can suspend a provider, and on what grounds?                  | Admin can reject at vetting. No suspension flow.                                                                    |

---

## 5. Answered

_Move items here with the date and their own words._

| Date | Question | Their answer |
| ---- | -------- | ------------ |
| —    | —        | —            |

---

## 6. Raised by us, still unsent

Questions we've identified but haven't put to the client yet. Clear this section
before every client call.

- **1.1, 1.2, 1.3** — the three that block everything. Draft email prepared.
- **2.1–2.14** — send as a single list; they'll answer faster in one pass than piecemeal.
- **3.6** — charging a £150 joining fee before approval is a refund argument waiting to happen.
- **4.5** — GPS coordinates are being stored with no retention policy.
