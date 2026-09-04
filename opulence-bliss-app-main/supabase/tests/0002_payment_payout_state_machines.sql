-- ============================================================================
-- 0002 — tests
-- ============================================================================
-- Run AFTER 0001 and 0002, in the Supabase SQL Editor.
--
-- The whole file runs inside ONE transaction and ROLLS BACK at the end, so it
-- leaves no bookings, payments, payouts, events or cases behind.
--
-- Any failure raises and aborts the transaction — which also rolls back. So:
--   clean run  → "ALL 0002 TESTS PASSED"
--   failure    → an exception naming the test, and nothing written either way.
--
-- Sections D2–D4 switch to the `authenticated` role with a simulated JWT so the
-- derived-actor logic is exercised for real rather than bypassed.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Carrier for ids between DO blocks (rolled back with everything else)
-- ---------------------------------------------------------------------------
create temp table t_ids (k text primary key, v uuid) on commit drop;

-- ===========================================================================
-- A. Setup + B. Payment machine + C. Readiness + E. Payout + F. Reconciliation
-- ===========================================================================
do $$
declare
  v_customer  uuid;
  v_outsider  uuid;
  v_provider  uuid;   -- profiles.id
  v_prov_row  uuid;   -- providers.id
  v_pkg       uuid;
  v_sub       uuid;

  v_bk_oneoff uuid;   -- completed, will be funded
  v_bk_unfund uuid;   -- completed, never funded
  v_bk_early  uuid;   -- funded, not completed
  v_bk_member uuid;   -- membership visit, no invoice period
  v_bk_hold   uuid;   -- completed + funded, but a blocking case
  v_bk_late   uuid;   -- completed + funded, case opened AFTER release
  v_bk_soft   uuid;   -- completed + funded, non-blocking case

  v_pay       uuid;
  v_pay2      uuid;
  v_out       uuid;
  v_res       jsonb;
  v_err       text;
  v_count     int;
  v_status    text;
begin
  raise notice '=== A. setup ===';

  select id into v_customer from profiles where role = 'customer' order by created_at limit 1;
  select id into v_outsider from profiles
   where role = 'customer' and id <> v_customer order by created_at limit 1;
  select p.id, pr.id into v_provider, v_prov_row
    from profiles p join providers pr on pr.profile_id = p.id
   where p.role = 'provider' order by p.created_at limit 1;
  select id into v_pkg from packages where active order by price limit 1;

  if v_customer is null or v_provider is null or v_pkg is null then
    raise exception 'need one customer, one provider and one active package';
  end if;

  insert into t_ids values
    ('customer', v_customer), ('provider', v_provider),
    ('prov_row', v_prov_row), ('pkg', v_pkg);
  if v_outsider is not null then
    insert into t_ids values ('outsider', v_outsider);
  end if;

  -- ======================= B. PAYMENT MACHINE ============================
  raise notice '=== B. payment machine ===';

  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_pkg, now() + interval '1 hour', 'offered', 'SW3 1AA')
  returning id into v_bk_oneoff;

  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_oneoff, v_prov_row, 'open');

  perform _apply_booking_transition(v_bk_oneoff, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_oneoff, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_oneoff, 'completed',   v_provider, 'provider', null, '{}'::jsonb);

  insert into payments (booking_id, gross_amount, status, kind, stripe_payment_ref)
  values (v_bk_oneoff, 69.00, 'authorised', 'booking', 'pi_test_0002')
  returning id into v_pay;
  insert into t_ids values ('payment', v_pay), ('bk_oneoff', v_bk_oneoff);

  -- B1: the full retry path
  raise notice 'B1 — authorised → capturing → capture_failed → capturing → succeeded';
  perform system_transition_payment(v_pay, 'capturing', null, '{}'::jsonb);
  perform system_transition_payment(v_pay, 'capture_failed', 'card declined', '{}'::jsonb);
  perform system_transition_payment(v_pay, 'capturing', null, '{}'::jsonb);
  perform system_transition_payment(v_pay, 'succeeded', null, '{}'::jsonb);

  select status into v_status from payments where id = v_pay;
  if v_status <> 'succeeded' then
    raise exception 'B1 FAILED: ended at % not succeeded', v_status;
  end if;

  select count(*) into v_count from payment_events where payment_id = v_pay;
  if v_count <> 4 then
    raise exception 'B1 FAILED: expected 4 events, found %', v_count;
  end if;
  raise notice '   ok — 4 events, retry path works';

  -- B2: capture failure demands a reason
  raise notice 'B2 — capture_failed requires a reason';
  insert into payments (booking_id, gross_amount, status, kind)
  values (v_bk_oneoff, 69.00, 'authorised', 'booking')
  returning id into v_pay2;

  perform system_transition_payment(v_pay2, 'capturing', null, '{}'::jsonb);
  begin
    perform system_transition_payment(v_pay2, 'capture_failed', null, '{}'::jsonb);
    raise exception 'B2 FAILED: capture failed with no reason';
  exception
    when check_violation then raise notice '   ok — reason demanded';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'B2 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- B3: an invalid jump
  raise notice 'B3 — authorised → refunded is not a transition';
  begin
    perform system_transition_payment(v_pay2, 'refunded', 'nonsense', '{}'::jsonb);
    raise exception 'B3 FAILED: illegal payment jump allowed';
  exception
    when check_violation then raise notice '   ok — refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'B3 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- B4: events are immutable
  raise notice 'B4 — payment events cannot be rewritten or deleted';
  begin
    update payment_events set reason = 'tampered' where payment_id = v_pay;
    raise exception 'B4 FAILED: payment event updated';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'B4 FAILED%' then raise; end if;
      raise notice '   ok — update blocked';
  end;
  begin
    delete from payment_events where payment_id = v_pay;
    raise exception 'B4 FAILED: payment event deleted';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'B4 FAILED%' then raise; end if;
      raise notice '   ok — delete blocked';
  end;

  -- ==================== C. PAYOUT READINESS ==============================
  raise notice '=== C. funding → payout readiness ===';

  -- C1: completed, never funded
  raise notice 'C1 — completed without funding stays not_ready';
  insert into bookings (customer_id, package_id, scheduled_at, status, address,
                        provider_payout)
  values (v_customer, v_pkg, now() + interval '1 hour', 'offered', 'SW3 1AA', 30.00)
  returning id into v_bk_unfund;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_unfund, v_prov_row, 'open');
  perform _apply_booking_transition(v_bk_unfund, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_unfund, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_unfund, 'completed',   v_provider, 'provider', null, '{}'::jsonb);

  insert into payments (booking_id, gross_amount, status, kind)
  values (v_bk_unfund, 69.00, 'authorised', 'booking');          -- never captured

  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_unfund, 30.00, 'not_ready')
  returning id into v_out;

  v_res := maybe_release_payout(v_bk_unfund);
  select status into v_status from payouts where id = v_out;
  if (v_res->>'released')::boolean or v_status <> 'not_ready' then
    raise exception 'C1 FAILED: released without funding (% / %)', v_res, v_status;
  end if;
  raise notice '   ok — held back';

  -- C2: funded, not completed
  raise notice 'C2 — funding without completion stays not_ready';
  insert into bookings (customer_id, package_id, scheduled_at, status, address,
                        provider_payout)
  values (v_customer, v_pkg, now() + interval '1 hour', 'offered', 'SW3 1AA', 30.00)
  returning id into v_bk_early;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_early, v_prov_row, 'open');
  perform _apply_booking_transition(v_bk_early, 'scheduled', v_provider, 'provider', null, '{}'::jsonb);

  insert into payments (booking_id, gross_amount, status, kind)
  values (v_bk_early, 69.00, 'succeeded', 'booking');             -- money in
  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_early, 30.00, 'not_ready')
  returning id into v_out;

  v_res := maybe_release_payout(v_bk_early);
  select status into v_status from payouts where id = v_out;
  if (v_res->>'released')::boolean or v_status <> 'not_ready' then
    raise exception 'C2 FAILED: released before the work was done (%)', v_res;
  end if;
  raise notice '   ok — work-not-complete respected';

  -- C3: both conditions met
  raise notice 'C3 — completed AND funded releases not_ready → pending';
  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_oneoff, 30.00, 'not_ready')
  returning id into v_out;
  insert into t_ids values ('payout_oneoff', v_out);

  v_res := maybe_release_payout(v_bk_oneoff);   -- its payment succeeded in B1
  select status into v_status from payouts where id = v_out;
  if not (v_res->>'released')::boolean or v_status <> 'pending' then
    raise exception 'C3 FAILED: not released (% / %)', v_res, v_status;
  end if;
  raise notice '   ok — pending';

  -- C4: membership with no invoice period must fail closed
  raise notice 'C4 — membership payment without period boundaries fails closed';
  insert into subscriptions (customer_id, package_id, status, start_date,
                             contract_length_months)
  values (v_customer, v_pkg, 'active', current_date, 3)
  returning id into v_sub;

  insert into bookings (customer_id, package_id, subscription_id, scheduled_at,
                        status, address, provider_payout)
  values (v_customer, v_pkg, v_sub, now() + interval '1 hour', 'offered',
          'SW3 1AA', 30.00)
  returning id into v_bk_member;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_member, v_prov_row, 'open');
  perform _apply_booking_transition(v_bk_member, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_member, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_member, 'completed',   v_provider, 'provider', null, '{}'::jsonb);

  -- paid invoice, but we don't know which period it covers
  insert into payments (subscription_id, gross_amount, status, kind,
                        period_start, period_end)
  values (v_sub, 189.00, 'succeeded', 'subscription', null, null);

  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_member, 30.00, 'not_ready')
  returning id into v_out;

  v_res := maybe_release_payout(v_bk_member);
  select status into v_status from payouts where id = v_out;
  if (v_res->>'released')::boolean or v_status <> 'not_ready' then
    raise exception
      'C4 FAILED: released on an invoice with unknown period (% / %)', v_res, v_status;
  end if;
  raise notice '   ok — failed closed';

  -- C5: same membership, now with a covering period → releases
  raise notice 'C5 — membership with a covering period does release';
  update payments
     set period_start = now() - interval '1 day',
         period_end   = now() + interval '30 days'
   where subscription_id = v_sub and kind = 'subscription';

  v_res := maybe_release_payout(v_bk_member);
  select status into v_status from payouts where id = v_out;
  if not (v_res->>'released')::boolean or v_status <> 'pending' then
    raise exception 'C5 FAILED: covering invoice did not release (% / %)', v_res, v_status;
  end if;
  raise notice '   ok — pending';

  -- ==================== D(a). BLOCKING REVIEWS ===========================
  raise notice '=== D. review cases (privileged parts) ===';

  -- D1: a blocking case forces held instead of pending
  raise notice 'D1 — blocking review produces held';
  insert into bookings (customer_id, package_id, scheduled_at, status, address,
                        provider_payout)
  values (v_customer, v_pkg, now() + interval '1 hour', 'offered', 'SW3 1AA', 30.00)
  returning id into v_bk_hold;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_hold, v_prov_row, 'open');
  perform _apply_booking_transition(v_bk_hold, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_hold, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_hold, 'completed',   v_provider, 'provider', null, '{}'::jsonb);
  insert into payments (booking_id, gross_amount, status, kind)
  values (v_bk_hold, 69.00, 'succeeded', 'booking');
  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_hold, 30.00, 'not_ready')
  returning id into v_out;

  insert into review_cases (booking_id, category, priority, blocks_payout,
                            response_due_at, resolution_due_at)
  values (v_bk_hold, 'damage_or_injury', 'urgent', true,
          now() + interval '1 hour', now() + interval '1 day');

  v_res := maybe_release_payout(v_bk_hold);
  select status into v_status from payouts where id = v_out;
  if (v_res->>'released')::boolean or v_status <> 'held' then
    raise exception 'D1 FAILED: expected held, got % (%)', v_status, v_res;
  end if;
  raise notice '   ok — held';

  -- D5: a non-blocking case must NOT hold anything
  raise notice 'D5 — non-blocking review leaves the payout alone';
  insert into bookings (customer_id, package_id, scheduled_at, status, address,
                        provider_payout)
  values (v_customer, v_pkg, now() + interval '1 hour', 'offered', 'SW3 1AA', 30.00)
  returning id into v_bk_soft;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_soft, v_prov_row, 'open');
  perform _apply_booking_transition(v_bk_soft, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_soft, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_soft, 'completed',   v_provider, 'provider', null, '{}'::jsonb);
  insert into payments (booking_id, gross_amount, status, kind)
  values (v_bk_soft, 69.00, 'succeeded', 'booking');
  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_soft, 30.00, 'not_ready')
  returning id into v_out;

  insert into review_cases (booking_id, category, priority, blocks_payout,
                            response_due_at, resolution_due_at)
  values (v_bk_soft, 'quality_complaint', 'low', false,
          now() + interval '3 days', now() + interval '14 days');

  v_res := maybe_release_payout(v_bk_soft);
  select status into v_status from payouts where id = v_out;
  if not (v_res->>'released')::boolean or v_status <> 'pending' then
    raise exception 'D5 FAILED: non-blocking case interfered (% / %)', v_res, v_status;
  end if;
  raise notice '   ok — released normally';

  -- Keep this still-pending payout for D2. E1 uses a separate payout and
  -- advances it to paid, so D2 never rewinds financial history for setup.
  insert into t_ids values
    ('bk_soft', v_bk_soft), ('payout_soft', v_out);

  -- carry a released payout forward for the payout-machine tests
  insert into bookings (customer_id, package_id, scheduled_at, status, address,
                        provider_payout)
  values (v_customer, v_pkg, now() + interval '1 hour', 'offered', 'SW3 1AA', 30.00)
  returning id into v_bk_late;
  insert into booking_offers (booking_id, provider_id, status)
  values (v_bk_late, v_prov_row, 'open');
  perform _apply_booking_transition(v_bk_late, 'scheduled',   v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_late, 'in_progress', v_provider, 'provider', null, '{}'::jsonb);
  perform _apply_booking_transition(v_bk_late, 'completed',   v_provider, 'provider', null, '{}'::jsonb);
  insert into payments (booking_id, gross_amount, status, kind)
  values (v_bk_late, 69.00, 'succeeded', 'booking');
  insert into payouts (provider_id, booking_id, amount, status)
  values (v_prov_row, v_bk_late, 30.00, 'not_ready')
  returning id into v_out;
  perform maybe_release_payout(v_bk_late);      -- now 'pending'

  insert into t_ids values
    ('bk_late', v_bk_late), ('payout_late', v_out),
    ('bk_hold', v_bk_hold), ('sub', v_sub);

  select status into v_status from payouts where id = v_out;
  if v_status <> 'pending' then
    raise exception 'setup FAILED: expected pending before D2, got %', v_status;
  end if;

  -- ==================== E. PAYOUT MACHINE ================================
  raise notice '=== E. payout machine ===';

  -- E1: failed → processing retry, never a second logical operation
  raise notice 'E1 — retry follows failed → processing on the same operation';
  perform system_transition_payout(v_out, 'processing', null, '{}'::jsonb);
  perform system_transition_payout(v_out, 'failed', 'insufficient platform balance', '{}'::jsonb);

  v_res := claim_money_operation(
    'transfer:booking:' || v_bk_late || ':provider:' || v_prov_row,
    'transfer', v_bk_late, 30.00, null);
  if (v_res->>'should_run')::boolean is not true then
    raise exception 'E1 FAILED: first transfer claim refused (%)', v_res;
  end if;

  -- mark that attempt failed, then retry the SAME key
  update money_operations
     set status = 'failed', last_error = 'insufficient balance', completed_at = now()
   where operation_key = 'transfer:booking:' || v_bk_late || ':provider:' || v_prov_row;

  v_res := claim_money_operation(
    'transfer:booking:' || v_bk_late || ':provider:' || v_prov_row,
    'transfer', v_bk_late, 30.00, null);
  if (v_res->>'should_run')::boolean is not true then
    raise exception 'E1 FAILED: retry was not allowed (%)', v_res;
  end if;

  select count(*) into v_count from money_operations
   where operation_key = 'transfer:booking:' || v_bk_late || ':provider:' || v_prov_row;
  if v_count <> 1 then
    raise exception 'E1 FAILED: % operation rows for one logical transfer', v_count;
  end if;

  perform system_transition_payout(v_out, 'processing', null, '{}'::jsonb);
  perform system_transition_payout(v_out, 'paid', null, '{}'::jsonb);
  select status into v_status from payouts where id = v_out;
  if v_status <> 'paid' then
    raise exception 'E1 FAILED: ended at %', v_status;
  end if;
  raise notice '   ok — one operation row, retry succeeded';

  -- E2: payout events immutable
  raise notice 'E2 — payout events cannot be rewritten or deleted';
  begin
    update payout_events set reason = 'tampered' where payout_id = v_out;
    raise exception 'E2 FAILED: payout event updated';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'E2 FAILED%' then raise; end if;
      raise notice '   ok — update blocked';
  end;
  begin
    delete from payout_events where payout_id = v_out;
    raise exception 'E2 FAILED: payout event deleted';
  exception
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'E2 FAILED%' then raise; end if;
      raise notice '   ok — delete blocked';
  end;

  -- E3: an invalid payout jump
  raise notice 'E3 — not_ready → paid is not a transition';
  begin
    perform system_transition_payout(
      (select id from payouts where booking_id = v_bk_unfund limit 1),
      'paid', 'nonsense', '{}'::jsonb);
    raise exception 'E3 FAILED: illegal payout jump allowed';
  exception
    when check_violation then raise notice '   ok — refused';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'E3 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  -- ==================== F. RECONCILIATION UNIQUENESS =====================
  raise notice '=== F. reconciliation findings ===';
  raise notice 'F1 — two payout-only findings of the same type must both land';

  insert into reconciliation_findings (finding_type, severity, payout_id)
  values ('local_paid_without_stripe_transfer', 'critical', v_out);

  insert into reconciliation_findings (finding_type, severity, payout_id)
  values ('local_paid_without_stripe_transfer', 'critical',
          (select id from payouts where booking_id = v_bk_hold limit 1));

  select count(*) into v_count from reconciliation_findings
   where finding_type = 'local_paid_without_stripe_transfer' and status = 'open';
  if v_count < 2 then
    raise exception
      'F1 FAILED: payout-only findings collided — only % row(s)', v_count;
  end if;
  raise notice '   ok — % findings recorded', v_count;

  raise notice 'F2 — the SAME subject does not raise twice';
  begin
    insert into reconciliation_findings (finding_type, severity, payout_id)
    values ('local_paid_without_stripe_transfer', 'critical', v_out);
    raise exception 'F2 FAILED: duplicate open finding was accepted';
  exception
    when unique_violation then raise notice '   ok — deduplicated';
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'F2 FAILED%' then raise; end if;
      raise notice '   ok — rejected (%)', v_err;
  end;

  raise notice ' ';
  raise notice 'Sections A–F passed.';
end $$;


-- ===========================================================================
-- D2. A blocking case opened AFTER release must hold a pending payout
-- ===========================================================================
do $$
declare
  v_bk       uuid;
  v_out      uuid;
  v_customer uuid;
  v_status   text;
  v_case     uuid;
begin
  raise notice '=== D2 — late blocking case holds a pending payout ===';

  select v into v_bk  from t_ids where k = 'bk_soft';
  select v into v_out from t_ids where k = 'payout_soft';
  select v into v_customer from t_ids where k = 'customer';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_case := open_review_case(
    v_bk, 'damage_or_injury', 'urgent', true, true,
    'Client reported damage after the visit', null);
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);

  select status into v_status from payouts where id = v_out;

  if v_status <> 'held' then
    raise notice '   NOTE: payout is % — open_review_case did not hold it.', v_status;
    raise exception
      'D2 FAILED: a blocking case must hold an already-pending payout (got %)',
      v_status;
  end if;
  raise notice '   ok — held by case %', v_case;
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $$;


-- ===========================================================================
-- D3. Participation is enforced, and created_by cannot be spoofed
-- ===========================================================================
-- Runs as `authenticated` with a simulated JWT, so auth.uid() is real.
do $$
declare
  v_bk       uuid;
  v_outsider uuid;
  v_customer uuid;
  v_spoof    uuid;
  v_case     uuid;
  v_owner    uuid;
  v_err      text;
begin
  raise notice '=== D3 — participation + actor derivation ===';

  select v into v_bk       from t_ids where k = 'bk_hold';
  select v into v_customer from t_ids where k = 'customer';
  select v into v_outsider from t_ids where k = 'outsider';
  select coalesce(v_outsider, v) into v_spoof
    from t_ids where k = 'provider';

  if v_outsider is null then
    raise notice '   outsider sub-check SKIPPED — needs a second customer account';
  else
    -- ---- as somebody with no connection to the booking ----
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    begin
      v_case := open_review_case(v_bk, 'quality_complaint', 'normal',
                                 false, false, 'not my booking', null);
      execute 'reset role';
      raise exception 'D3 FAILED: a non-participant opened a case';
    exception
      when insufficient_privilege then
        execute 'reset role';
        raise notice '   ok — outsider refused';
      when others then
        get stacked diagnostics v_err = message_text;
        execute 'reset role';
        if v_err like 'D3 FAILED%' then raise; end if;
        raise notice '   ok — outsider refused (%)', v_err;
    end;
  end if;

  -- ---- as the actual customer, trying to blame someone else ----
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_case := open_review_case(v_bk, 'quality_complaint', 'normal',
                             false, false, 'the floor was missed',
                             v_spoof);             -- attempted spoof
  execute 'reset role';

  select created_by into v_owner from review_cases where id = v_case;

  if v_owner is distinct from v_customer then
    raise exception
      'D3 FAILED: created_by was % — expected the authenticated caller %',
      v_owner, v_customer;
  end if;
  raise notice '   ok — created_by derived, spoof ignored';

  -- Do not leak the simulated request context into later test blocks.
  perform set_config('request.jwt.claims', '{}'::text, true);
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $$;


-- ===========================================================================
-- D4. Duplicate open cases converge on one row
-- ===========================================================================
do $$
declare
  v_bk       uuid;
  v_customer uuid;
  v_a        uuid;
  v_b        uuid;
  v_count    int;
begin
  raise notice '=== D4 — duplicate open cases converge ===';
  select v into v_bk from t_ids where k = 'bk_hold';
  select v into v_customer from t_ids where k = 'customer';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  v_a := open_review_case(v_bk, 'work_stopped', 'high', true, true, 'first', null);
  v_b := open_review_case(v_bk, 'work_stopped', 'high', true, true, 'again', null);
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}'::text, true);

  if v_a is distinct from v_b then
    raise exception 'D4 FAILED: two cases created (% and %)', v_a, v_b;
  end if;

  select count(*) into v_count from review_cases
   where booking_id = v_bk and category = 'work_stopped' and status <> 'resolved';
  if v_count <> 1 then
    raise exception 'D4 FAILED: % open cases of one category', v_count;
  end if;
  raise notice '   ok — one case, returned twice';

  raise notice ' ';
  raise notice 'ALL 0002 TESTS PASSED';
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    perform set_config('request.jwt.claims', '{}'::text, true);
    raise;
end $$;

-- ===========================================================================
-- Nothing is kept.
-- ===========================================================================
rollback;
