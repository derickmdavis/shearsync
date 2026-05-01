import type { PostgrestError } from "@supabase/supabase-js";
import {
  getCurrentLocalDate,
  getEndOfLocalDayUtc,
  getStartOfCurrentLocalMonthUtc,
  getStartOfLocalDayUtc
} from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError, isMissingColumnError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";

const DASHBOARD_APPOINTMENT_SELECT = `
  id,
  client_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  notes,
  status,
  client:clients!appointments_client_id_fkey (
    id,
    first_name,
    last_name
  )
`;

const toDashboardAppointment = (appointment: Row): Row => {
  const client = (appointment.client ?? null) as Row | null;
  const firstName = typeof client?.first_name === "string" ? client.first_name : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name : "";
  const clientName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    ...appointment,
    client_name: clientName || undefined
  };
};

const mapDashboardAppointments = (appointments: Row[] | null | undefined): Row[] =>
  (appointments ?? []).map((row) => toDashboardAppointment(row as Row));

const dedupeAppointments = (appointments: Row[]): Row[] => {
  const seenIds = new Set<string>();

  return appointments.filter((appointment) => {
    const id = typeof appointment.id === "string" ? appointment.id : null;

    if (!id) {
      return true;
    }

    if (seenIds.has(id)) {
      return false;
    }

    seenIds.add(id);
    return true;
  });
};

const loadTopClients = async (
  userId: string
): Promise<{ data: Row[] | null; error: PostgrestError | null }> => {
  const initialResult = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("user_id", userId)
    .order("total_spend", { ascending: false })
    .limit(5);

  if (!isMissingColumnError(initialResult.error, "total_spend")) {
    return initialResult;
  }

  return supabaseAdmin
    .from("clients")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(5);
};

export const dashboardService = {
  async getSummary(userId: string): Promise<Row> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const nowIso = new Date().toISOString();
    const todayDate = getCurrentLocalDate(timeZone);
    const startOfTodayIso = getStartOfLocalDayUtc(todayDate, timeZone).toISOString();
    const endOfTodayIso = getEndOfLocalDayUtc(todayDate, timeZone).toISOString();
    const startOfCurrentMonthIso = getStartOfCurrentLocalMonthUtc(timeZone).toISOString();
    const [clientsResult, remindersResult, todayAppointmentsResult, upcomingAppointmentsResult, nextAppointmentResult, recentAppointmentsResult, revenueResult, topClientsResult] =
      await Promise.all([
        supabaseAdmin
          .from("clients")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        supabaseAdmin
          .from("reminders")
          .select("*")
          .eq("user_id", userId)
          .eq("status", "open")
          .gte("due_date", new Date().toISOString())
          .order("due_date", { ascending: true })
          .limit(10),
        supabaseAdmin
          .from("appointments")
          .select(DASHBOARD_APPOINTMENT_SELECT)
          .eq("user_id", userId)
          .neq("status", "cancelled")
          .gte("appointment_date", startOfTodayIso)
          .lt("appointment_date", endOfTodayIso)
          .order("appointment_date", { ascending: true }),
        supabaseAdmin
          .from("appointments")
          .select(DASHBOARD_APPOINTMENT_SELECT)
          .eq("user_id", userId)
          .neq("status", "cancelled")
          .gte("appointment_date", nowIso)
          .order("appointment_date", { ascending: true })
          .limit(100),
        supabaseAdmin
          .from("appointments")
          .select(DASHBOARD_APPOINTMENT_SELECT)
          .eq("user_id", userId)
          .neq("status", "cancelled")
          .gte("appointment_date", nowIso)
          .order("appointment_date", { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from("appointments")
          .select(DASHBOARD_APPOINTMENT_SELECT)
          .eq("user_id", userId)
          .neq("status", "cancelled")
          .lt("appointment_date", nowIso)
          .order("appointment_date", { ascending: false })
          .limit(100),
        supabaseAdmin
          .from("appointments")
          .select("price")
          .eq("user_id", userId)
          .eq("status", "completed")
          .gte("appointment_date", startOfCurrentMonthIso),
        loadTopClients(userId)
      ]);

    handleSupabaseError(clientsResult.error, "Unable to load dashboard client count");
    handleSupabaseError(remindersResult.error, "Unable to load dashboard reminders");
    handleSupabaseError(todayAppointmentsResult.error, "Unable to load dashboard today appointments");
    handleSupabaseError(upcomingAppointmentsResult.error, "Unable to load dashboard upcoming appointments");
    handleSupabaseError(nextAppointmentResult.error, "Unable to load dashboard next appointment");
    handleSupabaseError(recentAppointmentsResult.error, "Unable to load dashboard recent appointments");
    handleSupabaseError(revenueResult.error, "Unable to load dashboard revenue");
    handleSupabaseError(topClientsResult.error, "Unable to load dashboard top clients");

    const monthlyRevenue = (revenueResult.data ?? []).reduce((sum, row) => {
      const price = typeof row.price === "number" ? row.price : Number(row.price ?? 0);
      return sum + price;
    }, 0);

    const todayAppointments = mapDashboardAppointments(todayAppointmentsResult.data as Row[] | null | undefined);
    const upcomingAppointments = mapDashboardAppointments(upcomingAppointmentsResult.data as Row[] | null | undefined);
    const recentAppointments = mapDashboardAppointments(recentAppointmentsResult.data as Row[] | null | undefined);
    const dashboardAppointments = dedupeAppointments([...todayAppointments, ...upcomingAppointments]);
    const nextAppointment = nextAppointmentResult.data
      ? toDashboardAppointment(nextAppointmentResult.data as Row)
      : null;

    return {
      total_clients: clientsResult.count ?? 0,
      upcoming_reminders: remindersResult.data ?? [],
      appointments: dashboardAppointments,
      today_appointments: todayAppointments,
      upcoming_appointments: upcomingAppointments,
      next_appointment: nextAppointment,
      recent_appointments: recentAppointments,
      top_clients_by_spend: topClientsResult.data ?? [],
      monthly_revenue_summary: {
        month_start: startOfCurrentMonthIso,
        completed_revenue: monthlyRevenue
      }
    };
  }
};
