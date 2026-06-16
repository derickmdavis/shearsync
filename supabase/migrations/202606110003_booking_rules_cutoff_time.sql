do $$
declare
  cutoff_data_type text;
begin
  select data_type
  into cutoff_data_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'booking_rules'
    and column_name = 'same_day_booking_cutoff';

  if cutoff_data_type is null then
    return;
  end if;

  if cutoff_data_type <> 'time without time zone' then
    alter table public.booking_rules
      alter column same_day_booking_cutoff drop default;

    alter table public.booking_rules
      alter column same_day_booking_cutoff type time
      using (
        case
          when same_day_booking_cutoff is null then '17:00:00'::time
          when trim(same_day_booking_cutoff::text) ~* '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?([[:space:]]?(am|pm))?$'
            then same_day_booking_cutoff::time
          else '17:00:00'::time
        end
      );
  end if;

  alter table public.booking_rules
    alter column same_day_booking_cutoff set default '17:00:00',
    alter column same_day_booking_cutoff set not null;
end
$$;
