import { supabaseAdmin } from "../lib/supabase";
import type {
  ClientActionsResponse,
  ClientRequiringRebookPreviewItem,
  PendingAppointmentApprovalPreviewItem
} from "../types/api";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { evaluateClientRebookStatus } from "./rebookService";

const ACTION_PREVIEW_LIMIT = 5;

const toClientName = (client: Row | null | undefined): string | null => {
  const firstName = typeof client?.first_name === "string" ? client.first_name.trim() : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name.trim() : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || null;
};

const buildClientsRequiringRebookPreview = (
  appointments: Row[],
  clientsById: Map<string, Row>,
  timeZone: string,
  now = new Date()
): ClientRequiringRebookPreviewItem[] => {
  const appointmentsByClientId = new Map<string, Row[]>();

  for (const appointment of appointments) {
    const clientId = appointment.client_id;
    if (typeof clientId !== "string") {
      continue;
    }

    const existing = appointmentsByClientId.get(clientId) ?? [];
    existing.push(appointment);
    appointmentsByClientId.set(clientId, existing);
  }

  return [...appointmentsByClientId.entries()]
    .flatMap(([clientId, clientAppointments]) => {
      const { lastQualifyingPastAppointment } = evaluateClientRebookStatus(clientAppointments, timeZone, now);
      if (!lastQualifyingPastAppointment || typeof lastQualifyingPastAppointment.appointment_date !== "string") {
        return [];
      }

      return [{
        client_id: clientId,
        client_name: toClientName(clientsById.get(clientId)),
        last_appointment_date: lastQualifyingPastAppointment.appointment_date,
        last_service_name:
          typeof lastQualifyingPastAppointment.service_name === "string"
            ? lastQualifyingPastAppointment.service_name
            : null
      }];
    })
    .sort((left, right) => left.last_appointment_date.localeCompare(right.last_appointment_date));
};

export const clientActionsService = {
  async getSummary(userId: string): Promise<ClientActionsResponse> {
    const [timeZone, pendingApprovalsCountResult, pendingApprovalsResult, clientsResult, appointmentsResult] = await Promise.all([
      businessTimeZoneService.getForUser(userId),
      supabaseAdmin
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending"),
      supabaseAdmin
        .from("appointments")
        .select("id, client_id, appointment_date, service_name, status")
        .eq("user_id", userId)
        .eq("status", "pending")
        .order("appointment_date", { ascending: true })
        .limit(ACTION_PREVIEW_LIMIT),
      supabaseAdmin
        .from("clients")
        .select("id, first_name, last_name")
        .eq("user_id", userId),
      supabaseAdmin
        .from("appointments")
        .select("client_id, appointment_date, service_name, status")
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .order("appointment_date", { ascending: true })
    ]);

    handleSupabaseError(pendingApprovalsCountResult.error, "Unable to load client action counts");
    handleSupabaseError(pendingApprovalsResult.error, "Unable to load client action previews");
    handleSupabaseError(clientsResult.error, "Unable to load client action clients");
    handleSupabaseError(appointmentsResult.error, "Unable to load client action appointments");

    const pendingApprovalRows = (pendingApprovalsResult.data ?? []) as Row[];
    const clientsById = new Map<string, Row>();

    for (const client of clientsResult.data ?? []) {
      if (typeof client.id === "string") {
        clientsById.set(client.id, client as Row);
      }
    }

    const pendingApprovalPreview: PendingAppointmentApprovalPreviewItem[] = pendingApprovalRows.map((appointment) => {
      const clientId = typeof appointment.client_id === "string" ? appointment.client_id : null;
      const client = clientId ? clientsById.get(clientId) ?? null : null;

      return {
        appointment_id: String(appointment.id ?? ""),
        client_id: clientId,
        client_name: toClientName(client),
        appointment_date: String(appointment.appointment_date ?? ""),
        service_name: typeof appointment.service_name === "string" ? appointment.service_name : null,
        status: "pending"
      };
    });

    const items: ClientActionsResponse["items"] = [];
    const pendingApprovalsCount = pendingApprovalsCountResult.count ?? 0;
    const clientsRequiringRebookPreview = buildClientsRequiringRebookPreview(
      (appointmentsResult.data ?? []) as Row[],
      clientsById,
      timeZone
    );

    if (pendingApprovalsCount > 0) {
      items.push({
        id: "pending-appointment-approvals",
        type: "pending_appointment_approvals",
        label: "Appointments requiring approval",
        priority: "high",
        count: pendingApprovalsCount,
        preview: pendingApprovalPreview
      });
    }

    if (clientsRequiringRebookPreview.length > 0) {
      items.push({
        id: "clients-requiring-rebook",
        type: "clients_requiring_rebook",
        label: "Clients requiring rebook",
        priority: "medium",
        count: clientsRequiringRebookPreview.length,
        preview: clientsRequiringRebookPreview.slice(0, ACTION_PREVIEW_LIMIT)
      });
    }

    return { items };
  }
};
