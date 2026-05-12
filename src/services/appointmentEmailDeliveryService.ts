import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import type { AppointmentEmailType } from "./appointmentEmailEventsService";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProviderResult {
  status: "sent" | "skipped";
  provider: string;
  providerMessageId?: string;
  error?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailProviderResult>;
}

export interface ProcessAppointmentEmailOptions {
  limit?: number;
  provider?: EmailProvider;
  allowNoopProvider?: boolean;
  now?: Date;
  appointmentManagementBaseUrl?: string;
  maxAttempts?: number;
  staleSendingAfterMinutes?: number;
}

export interface AppointmentEmailProcessingResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface AppointmentEmailTemplateData {
  recipient_name?: string;
  service_name?: string;
  appointment_start_time?: string;
  appointment_end_time?: string;
  appointment_start_display?: string;
  appointment_end_display?: string;
  appointment_time_display?: string;
  duration_minutes?: number;
  business_timezone?: string;
  stylist_display_name?: string | null;
  business_name?: string | null;
  business_display_name?: string;
  business_phone?: string | null;
  business_email?: string | null;
  management_token?: string;
  management_url?: string | null;
  cancelled_by?: "client" | "stylist";
  status?: string;
}

const defaultProcessLimit = 25;
const defaultMaxAttempts = 3;
const defaultStaleSendingAfterMinutes = 15;

const noopEmailProvider: EmailProvider = {
  async send(): Promise<EmailProviderResult> {
    return {
      status: "skipped",
      provider: "noop",
      error: "No email provider configured"
    };
  }
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const normalizeTemplateData = (value: unknown): AppointmentEmailTemplateData =>
  value && typeof value === "object" ? value as AppointmentEmailTemplateData : {};

const getString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const getAppointmentManagementUrl = (
  templateData: AppointmentEmailTemplateData,
  appointmentManagementBaseUrl?: string
): string | null => {
  if (templateData.management_url) {
    return templateData.management_url;
  }

  const managementToken = templateData.management_token;
  const baseUrl = appointmentManagementBaseUrl
    ?? env.WEB_APP_URL
    ?? env.CLIENT_APP_URL;

  if (!managementToken || !baseUrl) {
    return null;
  }

  return `${baseUrl.replace(/\/+$/, "")}/appointments/manage/${encodeURIComponent(managementToken)}`;
};

const getSubject = (emailType: AppointmentEmailType, serviceName: string, businessName: string): string => {
  switch (emailType) {
    case "appointment_scheduled":
      return `Your ${serviceName} appointment with ${businessName} is confirmed`;
    case "appointment_pending":
      return `${businessName} received your ${serviceName} request`;
    case "appointment_confirmed":
      return `${businessName} approved your ${serviceName} appointment`;
    case "appointment_cancelled":
      return `Your ${serviceName} appointment with ${businessName} was cancelled`;
    case "appointment_rescheduled":
      return `Your ${serviceName} appointment with ${businessName} was rescheduled`;
  }
};

const getIntro = (emailType: AppointmentEmailType, templateData: AppointmentEmailTemplateData, businessName: string): string => {
  switch (emailType) {
    case "appointment_scheduled":
      return `Your appointment with ${businessName} is confirmed.`;
    case "appointment_pending":
      return `${businessName} received your appointment request and will confirm it after review.`;
    case "appointment_confirmed":
      return `${businessName} approved your appointment request.`;
    case "appointment_cancelled":
      return templateData.cancelled_by === "client"
        ? "Your appointment was cancelled."
        : `${businessName} cancelled this appointment.`;
    case "appointment_rescheduled":
      return templateData.status === "pending"
        ? `Your appointment with ${businessName} was rescheduled and is waiting for approval.`
        : `Your appointment with ${businessName} was rescheduled.`;
  }
};

const getContactLine = (templateData: AppointmentEmailTemplateData, businessName: string): string | null => {
  if (templateData.business_phone && templateData.business_email) {
    return `Questions? Contact ${businessName} at ${templateData.business_phone} or ${templateData.business_email}.`;
  }

  if (templateData.business_phone) {
    return `Questions? Contact ${businessName} at ${templateData.business_phone}.`;
  }

  if (templateData.business_email) {
    return `Questions? Contact ${businessName} at ${templateData.business_email}.`;
  }

  return null;
};

export const renderAppointmentEmail = (
  emailEvent: Row,
  options: { appointmentManagementBaseUrl?: string } = {}
): EmailMessage => {
  const emailType = emailEvent.email_type as AppointmentEmailType;
  const recipientEmail = getString(emailEvent.recipient_email, "");

  if (!recipientEmail) {
    throw new ApiError(400, "Appointment email event is missing a recipient");
  }

  const templateData = normalizeTemplateData(emailEvent.template_data);
  const recipientName = getString(templateData.recipient_name, "there");
  const serviceName = getString(templateData.service_name, "Appointment");
  const businessName = getString(templateData.business_display_name, "your stylist");
  const appointmentTime = getString(
    templateData.appointment_time_display,
    getString(templateData.appointment_start_display, getString(templateData.appointment_start_time, "your scheduled time"))
  );
  const durationMinutes = Number(templateData.duration_minutes ?? 0);
  const managementUrl = getAppointmentManagementUrl(templateData, options.appointmentManagementBaseUrl);
  const intro = getIntro(emailType, templateData, businessName);
  const contactLine = getContactLine(templateData, businessName);
  const details = [
    `Service: ${serviceName}`,
    `Time: ${appointmentTime}`,
    templateData.business_timezone ? `Timezone: ${templateData.business_timezone}` : null,
    durationMinutes > 0 ? `Duration: ${durationMinutes} minutes` : null,
    managementUrl ? `Manage appointment: ${managementUrl}` : null
  ].filter(Boolean) as string[];
  const text = [
    `Hi ${recipientName},`,
    "",
    intro,
    "",
    ...details,
    ...(contactLine ? ["", contactLine] : []),
    "",
    `Thank you,`,
    businessName
  ].join("\n");
  const detailItems = details
    .map((detail) => `<li>${escapeHtml(detail)}</li>`)
    .join("");

  return {
    to: recipientEmail,
    subject: getSubject(emailType, serviceName, businessName),
    text,
    html: [
      `<h1>${escapeHtml(getSubject(emailType, serviceName, businessName))}</h1>`,
      `<p>Hi ${escapeHtml(recipientName)},</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      `<ul>${detailItems}</ul>`,
      ...(contactLine ? [`<p>${escapeHtml(contactLine)}</p>`] : []),
      `<p>Thank you,<br>${escapeHtml(businessName)}</p>`
    ].join("")
  };
};

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isNoopProvider = (provider: EmailProvider): boolean => provider === noopEmailProvider;

const getProvider = (options: ProcessAppointmentEmailOptions): EmailProvider => {
  if (options.provider) {
    return options.provider;
  }

  if (options.allowNoopProvider) {
    return noopEmailProvider;
  }

  throw new ApiError(503, "Email provider is not configured");
};

const canAttemptEmailEvent = (
  emailEvent: Row,
  {
    now,
    maxAttempts,
    staleSendingAfterMinutes
  }: {
    now: Date;
    maxAttempts: number;
    staleSendingAfterMinutes: number;
  }
): boolean => {
  if (toNumber(emailEvent.attempt_count, 0) >= maxAttempts) {
    return false;
  }

  if (emailEvent.status !== "sending") {
    return emailEvent.status === "queued" || emailEvent.status === "failed";
  }

  const lastAttemptAt = typeof emailEvent.last_attempt_at === "string"
    ? new Date(emailEvent.last_attempt_at)
    : null;

  if (!lastAttemptAt || !Number.isFinite(lastAttemptAt.getTime())) {
    return true;
  }

  const staleSendingCutoff = new Date(now.getTime() - staleSendingAfterMinutes * 60_000);
  return lastAttemptAt <= staleSendingCutoff;
};

const getRetryableEmailEvents = async ({
  limit,
  now,
  maxAttempts,
  staleSendingAfterMinutes
}: {
  limit: number;
  now: Date;
  maxAttempts: number;
  staleSendingAfterMinutes: number;
}): Promise<RowList> => {
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .select("*")
    .in("status", ["queued", "failed", "sending"])
    .order("created_at", { ascending: true })
    .limit(limit * 5);

  handleSupabaseError(error, "Unable to load queued appointment emails");

  return ((data ?? []) as RowList)
    .filter((emailEvent) =>
      canAttemptEmailEvent(emailEvent, {
        now,
        maxAttempts,
        staleSendingAfterMinutes
      })
    )
    .slice(0, limit);
};

const markEmailEvent = async (
  emailEventId: string,
  updates: Row
): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .update(updates)
    .eq("id", emailEventId)
    .select("*")
    .maybeSingle();

  handleSupabaseError(error, "Unable to update appointment email event");
  return data as Row | null;
};

const claimEmailEvent = async (emailEvent: Row, now: Date): Promise<Row | null> => {
  const emailEventId = String(emailEvent.id ?? "");
  const currentStatus = String(emailEvent.status ?? "");
  const attemptCount = toNumber(emailEvent.attempt_count, 0);
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .update({
      status: "sending",
      attempt_count: attemptCount + 1,
      last_attempt_at: now.toISOString(),
      error: null
    })
    .eq("id", emailEventId)
    .eq("status", currentStatus)
    .select("*")
    .maybeSingle();

  handleSupabaseError(error, "Unable to claim appointment email event");
  return data as Row | null;
};

export const appointmentEmailDeliveryService = {
  noopEmailProvider,
  renderAppointmentEmail,

  async processQueuedAppointmentEmails(
    options: ProcessAppointmentEmailOptions = {}
  ): Promise<AppointmentEmailProcessingResult> {
    const limit = Math.max(1, options.limit ?? defaultProcessLimit);
    const provider = getProvider(options);
    const now = options.now ?? new Date();
    const maxAttempts = Math.max(1, options.maxAttempts ?? defaultMaxAttempts);
    const staleSendingAfterMinutes = Math.max(1, options.staleSendingAfterMinutes ?? defaultStaleSendingAfterMinutes);
    const emailEvents = await getRetryableEmailEvents({
      limit,
      now,
      maxAttempts,
      staleSendingAfterMinutes
    });

    const result: AppointmentEmailProcessingResult = {
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0
    };

    for (const emailEvent of emailEvents) {
      const claimedEvent = await claimEmailEvent(emailEvent, now);

      if (!claimedEvent) {
        continue;
      }

      result.processed += 1;

      try {
        const message = renderAppointmentEmail(claimedEvent, {
          appointmentManagementBaseUrl: options.appointmentManagementBaseUrl
        });
        const providerResult = await provider.send(message);

        if (providerResult.status === "sent") {
          await markEmailEvent(String(claimedEvent.id ?? ""), {
            status: "sent",
            provider: providerResult.provider,
            provider_message_id: providerResult.providerMessageId ?? null,
            sent_at: now.toISOString(),
            error: null
          });
          result.sent += 1;
          continue;
        }

        await markEmailEvent(String(claimedEvent.id ?? ""), {
          status: "skipped",
          provider: providerResult.provider,
          provider_message_id: providerResult.providerMessageId ?? null,
          error: providerResult.error ?? (isNoopProvider(provider) ? "No email provider configured" : null)
        });
        result.skipped += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to send appointment email";
        await markEmailEvent(String(claimedEvent.id ?? ""), {
          status: "failed",
          error: message
        });
        result.failed += 1;
      }
    }

    return result;
  }
};
