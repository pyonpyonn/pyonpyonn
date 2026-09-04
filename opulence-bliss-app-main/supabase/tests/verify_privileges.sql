-- ============================================================================
-- Verify the column revocations actually took effect
-- ============================================================================
-- Read-only. Run in the SQL Editor.
--
-- Column-level REVOKE is defeated by a table-level GRANT UPDATE — the broad
-- grant covers every column, so the narrow revoke is silently ignored. If the
-- earlier migrations revoked columns without first removing the table grant,
-- the protection was never real.
--
-- Expected result: every "MUST NOT WRITE" row reports false.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table-level UPDATE grants — the thing that defeats column revokes
-- ---------------------------------------------------------------------------
select
  'table-level UPDATE grant' as check,
  grantee,
  table_name,
  'PROBLEM — defeats every column revoke on this table' as verdict
from information_schema.role_table_grants
where table_schema = 'public'
  and privilege_type = 'UPDATE'
  and table_name in ('bookings', 'payments', 'payouts')
  and grantee in ('authenticated', 'anon', 'service_role')
order by table_name, grantee;

-- If the rows above show `authenticated` with a table-level UPDATE on
-- bookings/payments/payouts, fix it the way 0008 does:
--
--   revoke update on bookings from authenticated;
--   grant  update (address, household_notes) on bookings to authenticated;
--
-- Table grant off first, then hand back only what's safe.


-- ---------------------------------------------------------------------------
-- 2. Can each role actually write the protected columns?
-- ---------------------------------------------------------------------------
with checks(role_name, tbl, col, expectation) as (
  values
    -- 0001: booking status and assignment
    ('authenticated', 'bookings', 'status',           'MUST NOT WRITE'),
    ('authenticated', 'bookings', 'provider_id',      'MUST NOT WRITE'),
    ('anon',          'bookings', 'status',           'MUST NOT WRITE'),
    ('anon',          'bookings', 'provider_id',      'MUST NOT WRITE'),
    ('service_role',  'bookings', 'status',           'MUST NOT WRITE'),
    ('service_role',  'bookings', 'provider_id',      'MUST NOT WRITE'),

    -- 0008: timing
    ('authenticated', 'bookings', 'scheduled_at',     'MUST NOT WRITE'),
    ('authenticated', 'bookings', 'offer_expires_at', 'MUST NOT WRITE'),
    ('anon',          'bookings', 'scheduled_at',     'MUST NOT WRITE'),
    ('anon',          'bookings', 'offer_expires_at', 'MUST NOT WRITE'),
    ('service_role',  'bookings', 'scheduled_at',     'MUST NOT WRITE'),
    ('service_role',  'bookings', 'offer_expires_at', 'MUST NOT WRITE'),

    -- 0002: money
    ('authenticated', 'payments', 'status',           'MUST NOT WRITE'),
    ('anon',          'payments', 'status',           'MUST NOT WRITE'),
    ('service_role',  'payments', 'status',           'MUST NOT WRITE'),
    ('authenticated', 'payouts',  'status',           'MUST NOT WRITE'),
    ('anon',          'payouts',  'status',           'MUST NOT WRITE'),
    ('service_role',  'payouts',  'status',           'MUST NOT WRITE'),

    -- columns the app legitimately writes — these SHOULD be true
    ('authenticated', 'bookings', 'household_notes',  'should be writable'),
    ('authenticated', 'bookings', 'address',          'should be writable')
)
select
  role_name,
  tbl || '.' || col                                  as column,
  expectation,
  has_column_privilege(role_name, tbl::regclass, col, 'UPDATE') as can_write,
  case
    when expectation = 'MUST NOT WRITE'
         and has_column_privilege(role_name, tbl::regclass, col, 'UPDATE')
      then '❌ OPEN — the revoke did not take'
    when expectation = 'should be writable'
         and not has_column_privilege(role_name, tbl::regclass, col, 'UPDATE')
      then '⚠ too tight — the app cannot write this'
    else '✔'
  end as verdict
from checks
order by
  case when expectation = 'MUST NOT WRITE' then 0 else 1 end,
  tbl, col, role_name;


-- ---------------------------------------------------------------------------
-- 3. Everything `authenticated` can still write, per table
-- ---------------------------------------------------------------------------
-- Read this list and ask of each column: should a customer or provider be able
-- to set this directly, without going through a function?
select
  table_name,
  string_agg(column_name, ', ' order by column_name) as writable_columns
from information_schema.column_privileges
where table_schema = 'public'
  and grantee = 'authenticated'
  and privilege_type = 'UPDATE'
  and table_name in ('bookings', 'payments', 'payouts', 'providers',
                     'review_cases', 'money_operations', 'subscriptions')
group by table_name
order by table_name;


-- ---------------------------------------------------------------------------
-- A note on service_role and bookings.status
-- ---------------------------------------------------------------------------
-- 0001 originally revoked bookings.status from `authenticated` and `anon`, but
-- not from `service_role`. Migration 0008 removes the table-level UPDATE grant
-- from all three roles and grants back only non-state columns.
--
-- 0002 attempted to revoke payments.status and payouts.status from all three
-- roles, but the table-level UPDATE grants made those revokes ineffective.
-- Migration 0009 removes those broad grants before restoring safe columns.
--
-- Every system path goes through system_transition_booking() (SECURITY DEFINER,
-- so it keeps working after the revoke). The effective grant-back is:
--
--   revoke update on bookings from service_role;
--   grant  update (
--     address, household_notes, provider_payout, membership_fee_deducted,
--     subscription_id, customer_email
--   ) on bookings to service_role;
--
-- Check the grant list against what your service-role code genuinely writes
-- before running it — and deploy it as its own enforcement migration, not
-- alongside application changes.
