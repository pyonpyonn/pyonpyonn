-- Money-operation finalisation tests. One transaction; always rolled back.
begin;

do $test$
declare
  v_admin uuid;
  v_customer uuid;
  v_package uuid;
  v_booking uuid;
  v_claim jsonb;
  v_result jsonb;
  v_operation uuid;
  v_status text;
  v_count integer;
  v_error text;
begin
  select id into v_admin from profiles where role = 'admin' limit 1;
  select id into v_customer from profiles where role = 'customer' limit 1;
  select id into v_package from packages where active limit 1;

  if v_admin is null or v_customer is null or v_package is null then
    raise exception 'need an admin, a customer, and an active package';
  end if;

  insert into bookings (customer_id, package_id, scheduled_at, status, address)
  values (v_customer, v_package, now() + interval '3 hours', 'offered', 'SW3 1AA')
  returning id into v_booking;

  raise notice 'A — succeeded is terminal and idempotent';
  v_claim := claim_money_operation(
    'test:capture:booking:' || v_booking, 'capture', v_booking, 69.00, null
  );
  v_operation := (v_claim->>'id')::uuid;
  perform system_finalise_operation(
    v_operation, 'succeeded', 'pi_test_terminal', null
  );

  begin
    perform system_finalise_operation(v_operation, 'failed', null, 'overwrite');
    raise exception 'A FAILED: succeeded was overwritten';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'A FAILED%' then raise; end if;
  end;

  v_result := system_finalise_operation(
    v_operation, 'succeeded', 'pi_test_terminal', null
  );
  if (v_result->>'changed')::boolean then
    raise exception 'A FAILED: repeated success was not idempotent';
  end if;

  raise notice 'B — success requires Stripe proof';
  v_claim := claim_money_operation(
    'test:transfer:booking:' || v_booking, 'transfer', v_booking, 30.00, null
  );
  v_operation := (v_claim->>'id')::uuid;
  begin
    perform system_finalise_operation(v_operation, 'succeeded', null, null);
    raise exception 'B FAILED: success accepted without a Stripe object';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'B FAILED%' then raise; end if;
  end;

  raise notice 'C — normal finalisation requires processing';
  v_claim := claim_money_operation(
    'test:release:booking:' || v_booking, 'release', v_booking, 10.00, null
  );
  perform system_finalise_operation(
    (v_claim->>'id')::uuid, 'failed', null, 'first attempt failed'
  );
  begin
    perform system_finalise_operation(
      (v_claim->>'id')::uuid, 'succeeded', 'pi_skip_claim', null
    );
    raise exception 'C FAILED: failed skipped directly to succeeded';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'C FAILED%' then raise; end if;
  end;

  raise notice 'D — ambiguous requires an admin and written evidence';
  perform system_finalise_operation(
    v_operation, 'ambiguous', null, 'timeout at Stripe'
  );

  begin
    perform system_finalise_operation(v_operation, 'failed', null, 'guessing');
    raise exception 'D FAILED: system resolved ambiguity';
  exception
    when insufficient_privilege then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'D FAILED%' then raise; end if;
  end;

  v_result := claim_money_operation(
    'test:transfer:booking:' || v_booking, 'transfer', v_booking, 30.00, null
  );
  if (v_result->>'should_run')::boolean then
    raise exception 'D FAILED: ambiguous operation was reclaimed';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
  begin
    perform resolve_ambiguous_operation(v_operation, 'failed', null, 'checked');
    execute 'reset role';
    raise exception 'D FAILED: customer resolved ambiguity';
  exception
    when insufficient_privilege then execute 'reset role';
    when others then
      get stacked diagnostics v_error = message_text;
      execute 'reset role';
      if v_error like 'D FAILED%' then raise; end if;
  end;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
  begin
    perform resolve_ambiguous_operation(v_operation, 'failed', null, '   ');
    raise exception 'D FAILED: blank evidence accepted';
  exception
    when check_violation then null;
    when others then
      get stacked diagnostics v_error = message_text;
      if v_error like 'D FAILED%' then execute 'reset role'; raise; end if;
  end;

  perform resolve_ambiguous_operation(
    v_operation,
    'failed',
    null,
    'Searched Stripe transfers by operation key; no transfer exists'
  );
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  select status into v_status from money_operations where id = v_operation;
  if v_status <> 'failed' then
    raise exception 'D FAILED: resolved status is %', v_status;
  end if;

  select count(*) into v_count
  from money_operation_events
  where operation_id = v_operation
    and from_status = 'ambiguous'
    and to_status = 'failed'
    and actor_kind = 'admin'
    and actor_id = v_admin
    and reason is not null;
  if v_count <> 1 then
    raise exception 'D FAILED: expected one attributed resolution, found %', v_count;
  end if;

  v_result := claim_money_operation(
    'test:transfer:booking:' || v_booking, 'transfer', v_booking, 30.00, null
  );
  if not (v_result->>'should_run')::boolean then
    raise exception 'D FAILED: retry stayed blocked after resolution';
  end if;

  raise notice 'E — operation history covers creation, claims, and outcomes';
  select count(*) into v_count
  from money_operation_events
  where operation_id = v_operation;
  if v_count <> 5 then
    raise exception 'E FAILED: expected 5 lifecycle events, found %', v_count;
  end if;

  raise notice 'ALL MONEY OPERATION FINALISATION TESTS PASSED';
exception
  when others then
    begin execute 'reset role'; exception when others then null; end;
    begin perform set_config('request.jwt.claims', '', true); exception when others then null; end;
    raise;
end $test$;

rollback;
