alter table public.appointment_payments
  add column if not exists total_recorded numeric(10, 2)
    generated always as (amount + tip_amount) stored;
