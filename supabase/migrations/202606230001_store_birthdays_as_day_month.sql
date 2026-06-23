do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'clients'
      and column_name = 'birthday'
      and data_type = 'date'
  ) then
    alter table public.clients
      alter column birthday type text
      using case
        when birthday is null then null
        else to_char(birthday, 'DD/MM')
      end;
  end if;
end $$;

alter table public.clients
  drop constraint if exists clients_birthday_dd_mm_check;

alter table public.clients
  add constraint clients_birthday_dd_mm_check
  check (
    birthday is null
    or (
      birthday ~ '^\d{2}/\d{2}$'
      and substring(birthday from 1 for 2)::int between 1 and 31
      and substring(birthday from 4 for 2)::int between 1 and 12
      and substring(birthday from 1 for 2)::int <= extract(
        day from (
          date_trunc(
            'month',
            make_date(2024, substring(birthday from 4 for 2)::int, 1)
          )
          + interval '1 month - 1 day'
        )
      )
    )
  );

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'birthday_reminders'
      and column_name = 'birthday'
      and data_type = 'date'
  ) then
    alter table public.birthday_reminders
      alter column birthday type text
      using to_char(birthday, 'DD/MM');
  end if;
end $$;

alter table public.birthday_reminders
  drop constraint if exists birthday_reminders_birthday_dd_mm_check;

alter table public.birthday_reminders
  add constraint birthday_reminders_birthday_dd_mm_check
  check (
    birthday ~ '^\d{2}/\d{2}$'
    and substring(birthday from 1 for 2)::int between 1 and 31
    and substring(birthday from 4 for 2)::int between 1 and 12
    and substring(birthday from 1 for 2)::int <= extract(
      day from (
        date_trunc(
          'month',
          make_date(2024, substring(birthday from 4 for 2)::int, 1)
        )
        + interval '1 month - 1 day'
      )
    )
  );
