import { Resend } from "resend";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import type { AppointmentEmailType } from "./appointmentEmailEventsService";
import type { MessageType } from "../lib/communications";
import { normalizeEmail } from "../lib/communications";
import { communicationEventsService } from "./communicationEvents";
import { communicationPreferenceTokensService } from "./communicationPreferenceTokens";
import { communicationPreferencesService } from "./communicationPreferences";
import { appointmentEmailTemplatesService, renderEmailTemplateString } from "./appointmentEmailTemplatesService";

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
  unsubscribe_url?: string | null;
  unsubscribe_label?: string | null;
  message_type?: MessageType;
  email_template?: {
    subject_template?: string | null;
    custom_message_block?: string | null;
  };
}

const defaultProcessLimit = 25;
const defaultMaxAttempts = 3;
const defaultStaleSendingAfterMinutes = 15;
const nonEssentialMessageTypes: MessageType[] = ["appointment_reminder", "rebooking_prompt", "marketing", "business_recap"];
const confirmationEmailTypes: AppointmentEmailType[] = [
  "appointment_scheduled",
  "appointment_pending",
  "appointment_confirmed"
];

const noopEmailProvider: EmailProvider = {
  async send(): Promise<EmailProviderResult> {
    return {
      status: "skipped",
      provider: "noop",
      error: "No email provider configured"
    };
  }
};

const createResendEmailProvider = (): EmailProvider | null => {
  const apiKey = getString(env.RESEND_API_KEY, "");
  const from = getString(env.EMAIL_FROM, "");
  const replyTo = getString(env.EMAIL_REPLY_TO, "");

  if (!apiKey || !from) {
    return null;
  }

  const resend = new Resend(apiKey);

  return {
    async send(message: EmailMessage): Promise<EmailProviderResult> {
      const { data, error } = await resend.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(replyTo ? { replyTo } : {})
      });

      if (error) {
        throw new Error(`Resend email send failed: ${error.message}`);
      }

      return {
        status: "sent",
        provider: "resend",
        providerMessageId: data.id
      };
    }
  };
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

const getCommunicationBaseUrl = (): string | null => env.WEB_APP_URL ?? env.CLIENT_APP_URL ?? null;

const getAppointmentMessageType = (emailType: AppointmentEmailType): MessageType => {
  switch (emailType) {
    case "appointment_cancelled":
      return "appointment_cancelled";
    case "appointment_rescheduled":
      return "appointment_rescheduled";
    case "appointment_scheduled":
    case "appointment_pending":
    case "appointment_confirmed":
      return "appointment_confirmation";
  }
};

const getEmailEventMessageType = (emailEvent: Row): MessageType => {
  const templateMessageType = normalizeTemplateData(emailEvent.template_data).message_type;
  if (typeof emailEvent.message_type === "string") {
    return emailEvent.message_type as MessageType;
  }

  if (typeof templateMessageType === "string" && nonEssentialMessageTypes.includes(templateMessageType)) {
    return templateMessageType;
  }

  return getAppointmentMessageType(emailEvent.email_type as AppointmentEmailType);
};

const isEmailConfirmationsEnabled = async (userId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("enabled")
    .eq("user_id", userId)
    .eq("key", "email_confirmations")
    .maybeSingle();

  handleSupabaseError(error, "Unable to load email confirmation automation setting");
  return data?.enabled !== false;
};

const getUnsubscribeLabel = (messageType: MessageType): string | null => {
  if (messageType === "appointment_reminder") {
    return "Unsubscribe from appointment reminders";
  }

  if (["rebooking_prompt", "marketing", "business_recap"].includes(messageType)) {
    return "Unsubscribe from non-essential emails";
  }

  return null;
};

const getUnsubscribeUrl = async (
  emailEvent: Row,
  messageType: MessageType,
  recipientEmail: string
): Promise<string | null> => {
  const label = getUnsubscribeLabel(messageType);
  const baseUrl = getCommunicationBaseUrl();
  const userId = typeof emailEvent.user_id === "string" ? emailEvent.user_id : null;

  if (!label || !baseUrl || !userId) {
    return null;
  }

  const token = await communicationPreferenceTokensService.createCommunicationPreferenceToken({
    userId,
    clientId: typeof emailEvent.client_id === "string" ? emailEvent.client_id : null,
    stylistId: typeof emailEvent.stylist_id === "string" ? emailEvent.stylist_id : userId,
    channel: "email",
    contactValue: recipientEmail,
    messageType,
    action: "unsubscribe",
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365)
  });

  return `${baseUrl.replace(/\/+$/, "")}/api/communications/unsubscribe/${encodeURIComponent(token)}`;
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

const getTemplateVariables = (
  templateData: AppointmentEmailTemplateData,
  {
    recipientName,
    serviceName,
    businessName,
    appointmentTime,
    managementUrl
  }: {
    recipientName: string;
    serviceName: string;
    businessName: string;
    appointmentTime: string;
    managementUrl: string | null;
  }
) => ({
  client_name: recipientName,
  service_name: serviceName,
  appointment_time: appointmentTime,
  business_name: businessName,
  business_phone: getString(templateData.business_phone, ""),
  business_email: getString(templateData.business_email, ""),
  manage_appointment_url: managementUrl ?? ""
});

const renderConfiguredText = (
  value: string | null | undefined,
  variables: ReturnType<typeof getTemplateVariables>
): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  try {
    appointmentEmailTemplatesService.validateTemplatePayload({ customMessageBlock: trimmed });
    return renderEmailTemplateString(trimmed, variables);
  } catch {
    return null;
  }
};

const renderConfiguredSubject = (
  emailType: AppointmentEmailType,
  defaultSubject: string,
  value: string | null | undefined,
  variables: ReturnType<typeof getTemplateVariables>
): string => {
  if (!appointmentEmailTemplatesService.isCustomizableAppointmentEmailType(emailType)) {
    return defaultSubject;
  }

  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return defaultSubject;
  }

  try {
    appointmentEmailTemplatesService.validateTemplatePayload({ subjectTemplate: trimmed });
    return renderEmailTemplateString(trimmed, variables) || defaultSubject;
  } catch {
    return defaultSubject;
  }
};

const renderTextBlockLines = (value: string | null): string[] =>
  value ? value.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean) : [];

const renderHtmlBlock = (value: string | null): string[] =>
  renderTextBlockLines(value).map((paragraph) =>
    `<p>${paragraph.split(/\n/).map((line) => escapeHtml(line)).join("<br>")}</p>`
  );

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
  const templateVariables = getTemplateVariables(templateData, {
    recipientName,
    serviceName,
    businessName,
    appointmentTime,
    managementUrl
  });
  const defaultSubject = getSubject(emailType, serviceName, businessName);
  const subject = renderConfiguredSubject(
    emailType,
    defaultSubject,
    templateData.email_template?.subject_template,
    templateVariables
  );
  const customMessageBlock = appointmentEmailTemplatesService.isCustomizableAppointmentEmailType(emailType)
    ? renderConfiguredText(templateData.email_template?.custom_message_block, templateVariables)
    : null;
  const unsubscribeUrl = templateData.unsubscribe_url ?? null;
  const unsubscribeLabel = getString(templateData.unsubscribe_label, "Manage communication preferences");
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
    ...(customMessageBlock ? ["", customMessageBlock] : []),
    "",
    ...details,
    ...(contactLine ? ["", contactLine] : []),
    ...(unsubscribeUrl ? ["", `${unsubscribeLabel}: ${unsubscribeUrl}`] : []),
    "",
    `Thank you,`,
    businessName
  ].join("\n");
  const detailItems = details
    .map((detail) => `<li>${escapeHtml(detail)}</li>`)
    .join("");

  return {
    to: recipientEmail,
    subject,
    text,
    html: [
      `<h1>${escapeHtml(subject)}</h1>`,
      `<p>Hi ${escapeHtml(recipientName)},</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      ...renderHtmlBlock(customMessageBlock),
      `<ul>${detailItems}</ul>`,
      ...(contactLine ? [`<p>${escapeHtml(contactLine)}</p>`] : []),
      ...(unsubscribeUrl ? [`<p><a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(unsubscribeLabel)}</a></p>`] : []),
      `<p>Thank you,<br>${escapeHtml(businessName)}</p>`
    ].join("")
  };
};

const prepareEmailMessage = async (
  emailEvent: Row,
  options: { appointmentManagementBaseUrl?: string } = {}
): Promise<{ message: EmailMessage; messageType: MessageType; toNormalized: string | null }> => {
  const messageType = getEmailEventMessageType(emailEvent);
  const recipientEmail = getString(emailEvent.recipient_email, "");
  const unsubscribeUrl = await getUnsubscribeUrl(emailEvent, messageType, recipientEmail);
  const unsubscribeLabel = getUnsubscribeLabel(messageType);
  const templateData = normalizeTemplateData(emailEvent.template_data);

  return {
    message: renderAppointmentEmail({
      ...emailEvent,
      template_data: {
        ...templateData,
        ...(unsubscribeUrl ? { unsubscribe_url: unsubscribeUrl } : {}),
        ...(unsubscribeLabel ? { unsubscribe_label: unsubscribeLabel } : {})
      }
    }, options),
    messageType,
    toNormalized: normalizeEmail(recipientEmail)
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

  const resendProvider = createResendEmailProvider();

  if (resendProvider) {
    return resendProvider;
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
  createResendEmailProvider,
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
        const userId = typeof claimedEvent.user_id === "string" ? claimedEvent.user_id : "";
        const clientId = typeof claimedEvent.client_id === "string" ? claimedEvent.client_id : null;
        const stylistId = typeof claimedEvent.stylist_id === "string" ? claimedEvent.stylist_id : userId || null;
        const messageType = getEmailEventMessageType(claimedEvent);
        const recipientEmail = getString(claimedEvent.recipient_email, "");
        if (
          userId
          && confirmationEmailTypes.includes(claimedEvent.email_type as AppointmentEmailType)
          && !(await isEmailConfirmationsEnabled(userId))
        ) {
          await communicationEventsService.logCommunicationEvent({
            userId,
            clientId,
            stylistId,
            channel: "email",
            messageType,
            toAddress: recipientEmail,
            toNormalized: normalizeEmail(recipientEmail),
            provider: null,
            status: "skipped_opted_out",
            errorCode: "disabled",
            errorMessage: "Email confirmations automation disabled",
            metadata: { appointment_email_event_id: claimedEvent.id ?? null }
          });
          await markEmailEvent(String(claimedEvent.id ?? ""), {
            status: "skipped",
            error: "Email confirmations automation disabled"
          });
          result.skipped += 1;
          continue;
        }

        const canSend = userId
          ? await communicationPreferencesService.canSendCommunication({
            userId,
            clientId,
            stylistId,
            channel: "email",
            to: recipientEmail,
            messageType
          })
          : { canSend: false, reason: "missing_contact" as const, toNormalized: normalizeEmail(recipientEmail) ?? undefined };

        if (!canSend.canSend) {
          const status = canSend.reason === "missing_sms_consent" ? "skipped_missing_consent" : "skipped_opted_out";
          await communicationEventsService.logCommunicationEvent({
            userId: userId || "unknown",
            clientId,
            stylistId,
            channel: "email",
            messageType,
            toAddress: recipientEmail,
            toNormalized: canSend.toNormalized ?? normalizeEmail(recipientEmail),
            provider: null,
            status,
            errorCode: canSend.reason ?? null,
            metadata: { appointment_email_event_id: claimedEvent.id ?? null }
          });
          await markEmailEvent(String(claimedEvent.id ?? ""), {
            status: "skipped",
            error: canSend.reason ?? "Communication preference blocked send"
          });
          result.skipped += 1;
          continue;
        }

        const { message, toNormalized } = await prepareEmailMessage(claimedEvent, {
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
          await communicationEventsService.logCommunicationEvent({
            userId,
            clientId,
            stylistId,
            channel: "email",
            messageType,
            toAddress: recipientEmail,
            toNormalized,
            provider: providerResult.provider,
            providerMessageId: providerResult.providerMessageId ?? null,
            status: "sent",
            metadata: { appointment_email_event_id: claimedEvent.id ?? null }
          });
          continue;
        }

        await markEmailEvent(String(claimedEvent.id ?? ""), {
          status: "skipped",
          provider: providerResult.provider,
          provider_message_id: providerResult.providerMessageId ?? null,
          error: providerResult.error ?? (isNoopProvider(provider) ? "No email provider configured" : null)
        });
        result.skipped += 1;
        await communicationEventsService.logCommunicationEvent({
          userId,
          clientId,
          stylistId,
          channel: "email",
          messageType,
          toAddress: recipientEmail,
          toNormalized,
          provider: providerResult.provider,
          providerMessageId: providerResult.providerMessageId ?? null,
          status: "failed",
          errorMessage: providerResult.error ?? null,
          metadata: { appointment_email_event_id: claimedEvent.id ?? null }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to send appointment email";
        await markEmailEvent(String(claimedEvent.id ?? ""), {
          status: "failed",
          error: message
        });
        await communicationEventsService.logCommunicationEvent({
          userId: typeof claimedEvent.user_id === "string" ? claimedEvent.user_id : "unknown",
          clientId: typeof claimedEvent.client_id === "string" ? claimedEvent.client_id : null,
          stylistId: typeof claimedEvent.stylist_id === "string"
            ? claimedEvent.stylist_id
            : typeof claimedEvent.user_id === "string" ? claimedEvent.user_id : null,
          channel: "email",
          messageType: getEmailEventMessageType(claimedEvent),
          toAddress: getString(claimedEvent.recipient_email, ""),
          toNormalized: normalizeEmail(getString(claimedEvent.recipient_email, "")),
          status: "failed",
          errorMessage: message,
          metadata: { appointment_email_event_id: claimedEvent.id ?? null }
        });
        result.failed += 1;
      }
    }

    return result;
  }
};
