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
import { activityEventsService } from "./activityEventsService";
import { birthdayRemindersService } from "./birthdayRemindersService";
import { rebookNudgesService } from "./rebookNudgesService";
import { thankYouEmailsService } from "./thankYouEmailsService";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
  contentId?: string;
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
  last_service_name?: string | null;
  last_appointment_time?: string;
  last_appointment_display?: string;
  rebook_url?: string | null;
  rebook_interval_days?: number;
  birthday?: string;
  birthday_label?: string;
  birthday_display?: string;
  birthday_occurrence_date?: string;
  appointment_date?: string;
  appointment_date_display?: string;
  referral_url?: string | null;
  referral_code?: string | null;
  qr_code_url?: string | null;
  email_template?: {
    subject_template?: string | null;
    custom_message_block?: string | null;
  };
}

const defaultProcessLimit = 25;
const defaultMaxAttempts = 3;
const defaultStaleSendingAfterMinutes = 15;
const nonEssentialMessageTypes: MessageType[] = ["appointment_reminder", "rebooking_prompt", "birthday_reminder", "marketing", "business_recap"];
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
        ...(message.attachments?.length
          ? {
            attachments: message.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              contentType: attachment.contentType,
              ...(attachment.contentId ? { contentId: attachment.contentId } : {})
            }))
          }
          : {}),
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

const referralQrCodeContentId = "referral-qr-code";

const parseBase64DataUrl = (value: string): { contentType: string; content: string } | null => {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(value.trim());

  if (!match) {
    return null;
  }

  return {
    contentType: match[1],
    content: match[2].replace(/\s/g, "")
  };
};

const createReferralQrCodeAttachment = (qrCodeUrl?: string | null): EmailAttachment | null => {
  if (!qrCodeUrl) {
    return null;
  }

  const parsed = parseBase64DataUrl(qrCodeUrl);

  if (!parsed) {
    return null;
  }

  return {
    filename: "referral-qr-code.png",
    content: parsed.content,
    contentType: parsed.contentType,
    contentId: referralQrCodeContentId
  };
};

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
    case "appointment_reminder":
      return "appointment_reminder";
    case "rebooking_prompt":
      return "rebooking_prompt";
    case "birthday_reminder":
      return "birthday_reminder";
    case "thank_you_email":
      return "marketing";
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
  return data?.enabled === true;
};

const getUnsubscribeLabel = (messageType: MessageType): string | null => {
  if (messageType === "appointment_reminder") {
    return "Unsubscribe from appointment reminders";
  }

  if (["rebooking_prompt", "birthday_reminder", "marketing", "business_recap"].includes(messageType)) {
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
    case "appointment_reminder":
      return `Reminder: your ${serviceName} appointment with ${businessName}`;
    case "rebooking_prompt":
      return `Time to book your next visit with ${businessName}`;
    case "birthday_reminder":
      return `Happy birthday from ${businessName}`;
    case "thank_you_email":
      return `Thank you for visiting ${businessName}`;
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
): Record<string, string> => ({
  client_name: recipientName,
  service_name: serviceName,
  appointment_time: appointmentTime,
  business_name: businessName,
  business_phone: getString(templateData.business_phone, ""),
  business_email: getString(templateData.business_email, ""),
  manage_appointment_url: managementUrl ?? "",
  last_service_name: getString(templateData.last_service_name, serviceName),
  last_appointment_date: getString(templateData.last_appointment_display, getString(templateData.last_appointment_time, "")),
  rebook_url: getString(templateData.rebook_url, ""),
  birthday: getString(templateData.birthday_display, getString(templateData.birthday_label, getString(templateData.birthday, ""))),
  appointment_date: getString(templateData.appointment_date_display, getString(templateData.appointment_date, appointmentTime)),
  referral_url: getString(templateData.referral_url, ""),
  referral_code: getString(templateData.referral_code, "")
});

const renderConfiguredText = (
  emailType: AppointmentEmailType,
  value: string | null | undefined,
  variables: ReturnType<typeof getTemplateVariables>
): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  try {
    appointmentEmailTemplatesService.validateTemplatePayload({ customMessageBlock: trimmed });
    return renderEmailTemplateString(trimmed, variables as Parameters<typeof renderEmailTemplateString>[1]);
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
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return defaultSubject;
  }

  try {
    appointmentEmailTemplatesService.validateTemplatePayload({ subjectTemplate: trimmed });
    return renderEmailTemplateString(trimmed, variables as Parameters<typeof renderEmailTemplateString>[1]) || defaultSubject;
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
    case "appointment_reminder":
      return `This is a reminder that your appointment with ${businessName} is coming up.`;
    case "rebooking_prompt":
      return `It has been a little while since your last visit with ${businessName}.`;
    case "birthday_reminder":
      return `Wishing you a very happy birthday from ${businessName}.`;
    case "thank_you_email":
      return `Thank you for visiting ${businessName}. Share your referral link with a friend when you are ready.`;
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
  const customMessageBlock = renderConfiguredText(
    emailType,
    templateData.email_template?.custom_message_block,
    templateVariables
  );
  const unsubscribeUrl = templateData.unsubscribe_url ?? null;
  const unsubscribeLabel = getString(templateData.unsubscribe_label, "Manage communication preferences");
  const details = emailType === "rebooking_prompt"
    ? [
      `Last service: ${getString(templateData.last_service_name, serviceName)}`,
      templateData.last_appointment_display ? `Last visit: ${templateData.last_appointment_display}` : null,
      templateData.rebook_url ? `Book your next visit: ${templateData.rebook_url}` : null
    ].filter(Boolean) as string[]
    : emailType === "birthday_reminder"
      ? [
        `Birthday: ${getString(templateData.birthday_display, getString(templateData.birthday_label, getString(templateData.birthday, "today")))}`
      ]
    .filter(Boolean) as string[]
    : emailType === "thank_you_email"
      ? [
        `Service: ${serviceName}`,
        `Visit: ${getString(templateData.appointment_date_display, getString(templateData.appointment_date, appointmentTime))}`,
        templateData.referral_url ? `Referral link: ${templateData.referral_url}` : null,
        templateData.referral_code ? `Referral code: ${templateData.referral_code}` : null
      ].filter(Boolean) as string[]
    : [
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
  const qrCodeAttachment = emailType === "thank_you_email"
    ? createReferralQrCodeAttachment(templateData.qr_code_url)
    : null;
  const qrCodeImageSrc = qrCodeAttachment
    ? `cid:${referralQrCodeContentId}`
    : templateData.qr_code_url;
  const qrCodeImage = emailType === "thank_you_email" && templateData.qr_code_url
    ? `<p><img src="${escapeHtml(qrCodeImageSrc ?? "")}" alt="Referral QR code" width="160" height="160"></p>`
    : "";

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
      qrCodeImage,
      ...(contactLine ? [`<p>${escapeHtml(contactLine)}</p>`] : []),
      ...(unsubscribeUrl ? [`<p><a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(unsubscribeLabel)}</a></p>`] : []),
      `<p>Thank you,<br>${escapeHtml(businessName)}</p>`
    ].join(""),
    ...(qrCodeAttachment ? { attachments: [qrCodeAttachment] } : {})
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

const getQueuedAppointmentStartTime = (emailEvent: Row): string | null => {
  const templateData = normalizeTemplateData(emailEvent.template_data);
  if (typeof templateData.appointment_start_time === "string" && templateData.appointment_start_time.length > 0) {
    return templateData.appointment_start_time;
  }

  const emailType = typeof emailEvent.email_type === "string" ? emailEvent.email_type : "";
  const appointmentId = typeof emailEvent.appointment_id === "string" ? emailEvent.appointment_id : "";
  const idempotencyKey = typeof emailEvent.idempotency_key === "string" ? emailEvent.idempotency_key : "";
  const prefix = `${emailType}:${appointmentId}:`;
  return idempotencyKey.startsWith(prefix) ? idempotencyKey.slice(prefix.length) : null;
};

const getAppointmentReminderSkipReason = async (emailEvent: Row): Promise<string | null> => {
  if (emailEvent.email_type !== "appointment_reminder") {
    return null;
  }

  const userId = typeof emailEvent.user_id === "string" ? emailEvent.user_id : "";
  const appointmentId = typeof emailEvent.appointment_id === "string" ? emailEvent.appointment_id : "";
  const queuedStartTime = getQueuedAppointmentStartTime(emailEvent);

  if (!userId || !appointmentId || !queuedStartTime) {
    return "appointment_reminder_missing_appointment_context";
  }

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id, appointment_date, status")
    .eq("id", appointmentId)
    .eq("user_id", userId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to validate appointment reminder freshness");

  const appointment = data as Row | null;
  if (!appointment) {
    return "appointment_reminder_appointment_missing";
  }

  if (appointment.status !== "pending" && appointment.status !== "scheduled") {
    return "appointment_reminder_appointment_not_active";
  }

  if (appointment.appointment_date !== queuedStartTime) {
    return "appointment_reminder_appointment_changed";
  }

  return null;
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
    const globalEmailUnsubscribeCache = new Map<string, boolean>();
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
          await rebookNudgesService.markForEmailEvent(claimedEvent, "skipped", "Email confirmations automation disabled");
          await birthdayRemindersService.markForEmailEvent(claimedEvent, "skipped", "Email confirmations automation disabled");
          await thankYouEmailsService.markForEmailEvent(claimedEvent, "skipped", "Email confirmations automation disabled");
          result.skipped += 1;
          continue;
        }

        const canSend = userId
          ? await communicationPreferencesService.canSendCommunication({
            userId,
            clientId,
            channel: "email",
            to: recipientEmail,
            messageType,
            globalEmailUnsubscribeCache
          })
          : { canSend: false, reason: "missing_contact" as const, toNormalized: normalizeEmail(recipientEmail) ?? undefined };

        if (!canSend.canSend) {
          const status = canSend.reason === "missing_sms_consent" ? "skipped_missing_consent" : "skipped_opted_out";
          await communicationEventsService.logCommunicationEvent({
            userId: userId || "unknown",
            clientId,
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
          await rebookNudgesService.markForEmailEvent(
            claimedEvent,
            "skipped",
            canSend.reason ?? "Communication preference blocked send"
          );
          await birthdayRemindersService.markForEmailEvent(
            claimedEvent,
            "skipped",
            canSend.reason ?? "Communication preference blocked send"
          );
          await thankYouEmailsService.markForEmailEvent(
            claimedEvent,
            "skipped",
            canSend.reason ?? "Communication preference blocked send"
          );
          result.skipped += 1;
          continue;
        }

        const appointmentReminderSkipReason = await getAppointmentReminderSkipReason(claimedEvent);
        if (appointmentReminderSkipReason) {
          await communicationEventsService.logCommunicationEvent({
            userId: userId || "unknown",
            clientId,
            channel: "email",
            messageType,
            toAddress: recipientEmail,
            toNormalized: normalizeEmail(recipientEmail),
            provider: null,
            status: "skipped_opted_out",
            errorCode: appointmentReminderSkipReason,
            metadata: { appointment_email_event_id: claimedEvent.id ?? null }
          });
          await markEmailEvent(String(claimedEvent.id ?? ""), {
            status: "skipped",
            error: appointmentReminderSkipReason
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
          await rebookNudgesService.markForEmailEvent(claimedEvent, "sent", null);
          await birthdayRemindersService.markForEmailEvent(claimedEvent, "sent", null);
          await thankYouEmailsService.markForEmailEvent(claimedEvent, "sent", null);
          try {
            await activityEventsService.recordAppointmentReminderEmailSent(userId, {
              ...claimedEvent,
              sent_at: now.toISOString()
            });
          } catch (activityError) {
            console.warn("[APPOINTMENT_EMAIL_DELIVERY] reminder activity logging failed", {
              emailEventId: claimedEvent.id ?? null,
              userId,
              error: activityError instanceof Error ? activityError.message : String(activityError)
            });
          }
          result.sent += 1;
          try {
            await communicationEventsService.logCommunicationEvent({
              userId,
              clientId,
              channel: "email",
              messageType,
              toAddress: recipientEmail,
              toNormalized,
              provider: providerResult.provider,
              providerMessageId: providerResult.providerMessageId ?? null,
              status: "sent",
              metadata: { appointment_email_event_id: claimedEvent.id ?? null }
            });
          } catch (telemetryError) {
            console.warn("[APPOINTMENT_EMAIL_DELIVERY] sent email telemetry failed", {
              emailEventId: claimedEvent.id ?? null,
              userId,
              error: telemetryError instanceof Error ? telemetryError.message : String(telemetryError)
            });
          }
          continue;
        }

        await markEmailEvent(String(claimedEvent.id ?? ""), {
          status: "skipped",
          provider: providerResult.provider,
          provider_message_id: providerResult.providerMessageId ?? null,
          error: providerResult.error ?? (isNoopProvider(provider) ? "No email provider configured" : null)
        });
        await rebookNudgesService.markForEmailEvent(
          claimedEvent,
          "skipped",
          providerResult.error ?? (isNoopProvider(provider) ? "No email provider configured" : null)
        );
        await birthdayRemindersService.markForEmailEvent(
          claimedEvent,
          "skipped",
          providerResult.error ?? (isNoopProvider(provider) ? "No email provider configured" : null)
        );
        await thankYouEmailsService.markForEmailEvent(
          claimedEvent,
          "skipped",
          providerResult.error ?? (isNoopProvider(provider) ? "No email provider configured" : null)
        );
        result.skipped += 1;
        await communicationEventsService.logCommunicationEvent({
          userId,
          clientId,
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
        await rebookNudgesService.markForEmailEvent(claimedEvent, "failed", message);
        await birthdayRemindersService.markForEmailEvent(claimedEvent, "failed", message);
        await thankYouEmailsService.markForEmailEvent(claimedEvent, "failed", message);
        await communicationEventsService.logCommunicationEvent({
          userId: typeof claimedEvent.user_id === "string" ? claimedEvent.user_id : "unknown",
          clientId: typeof claimedEvent.client_id === "string" ? claimedEvent.client_id : null,
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
