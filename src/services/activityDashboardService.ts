import { ApiError, requireFound } from "../lib/errors";
import { addDays, getCurrentLocalDate, getEndOfLocalDayUtc, getLocalDateForInstant, getStartOfLocalDayUtc } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { ActivityEventItem } from "../types/api";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { activityEventsService } from "./activityEventsService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { birthdayReminderSettingsService } from "./birthdayReminderSettingsService";
import { birthdayRemindersService } from "./birthdayRemindersService";
import { rebookNudgesService } from "./rebookNudgesService";
import { thankYouEmailsService } from "./thankYouEmailsService";
import { entitlementsService } from "./entitlementsService";
import type { PlanFeatureKey, UserEntitlements } from "../lib/plans";
import { communicationPreferencesService } from "./communicationPreferences";
import type { MessageType } from "../lib/communications";
import { recordProductTelemetry } from "./productTelemetry";

const AUTOMATION_KEYS = [
  "rebook_nudges",
  "appointment_reminders",
  "email_confirmations",
  "no_show_follow_up",
  "waitlist_match",
  "birthday_reminders",
  "thank_you_emails"
] as const;

export type AutomationControlKey = (typeof AUTOMATION_KEYS)[number];

const AUTOMATION_LABELS: Record<AutomationControlKey, string> = {
  rebook_nudges: "Rebook Nudges",
  appointment_reminders: "Appointment Reminders",
  email_confirmations: "Email Confirmations",
  no_show_follow_up: "No Show Follow-up",
  waitlist_match: "Waitlist Match",
  birthday_reminders: "Birthday Reminders",
  thank_you_emails: "Thank You Emails"
};

const AUTOMATION_FEATURES: Partial<Record<AutomationControlKey, PlanFeatureKey>> = {
  rebook_nudges: "rebookNudges",
  birthday_reminders: "birthdayReminders",
  thank_you_emails: "thankYouEmails",
  waitlist_match: "waitlistMatch",
  no_show_follow_up: "noShowFollowUp"
};

const APPOINTMENT_SELECT = `
  id,
  user_id,
  client_id,
  service_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  status,
  booking_source,
  created_at,
  updated_at
`;

const REMINDER_SELECT = `
  id,
  user_id,
  client_id,
  appointment_id,
  title,
  due_date,
  status,
  channel,
  reminder_type,
  sent_at,
  created_at,
  updated_at
`;

const APPOINTMENT_REMINDER_EMAIL_SELECT = `
  id,
  user_id,
  client_id,
  appointment_id,
  email_type,
  recipient_email,
  status,
  created_at,
  updated_at,
  template_data
`;

type ReminderQueueItem = {
  reminder_id: unknown;
  rebook_nudge_id?: unknown;
  birthday_reminder_id?: unknown;
  thank_you_email_id?: unknown;
  email_event_id?: unknown;
  appointment_id?: unknown;
  client_id?: unknown;
  client_name: string;
  send_at: unknown;
  appointment_start_time?: unknown;
  channel: unknown;
  reminder_type: unknown;
  status: string;
};

type AutomationQueueSource = "appointment_reminders" | "rebook_nudges" | "birthday_reminders" | "thank_you_emails";

type AutomationQueueItem = ReminderQueueItem & {
  automation_key: AutomationQueueSource;
  send_at: string;
  channel: "email" | "sms";
  reminder_type: string;
};

type AutomationQueueCandidate = AutomationQueueItem & {
  eligibility_contact: string | null;
  eligibility_message_type: MessageType;
};

const customersReachedWindowMs = 30 * 24 * 60 * 60 * 1000;

const CUSTOMER_REACHED_COMMUNICATION_MESSAGE_TYPES: MessageType[] = [
  "appointment_reminder",
  "appointment_cancelled",
  "appointment_rescheduled",
  "waitlist_update",
  "rebooking_prompt",
  "birthday_reminder",
  "marketing"
];

const CUSTOMER_REACHED_EMAIL_TYPES = [
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_reminder",
  "rebooking_prompt",
  "birthday_reminder",
  "thank_you_email"
];

const CUSTOMER_REACHED_REMINDER_TYPES = ["appointment_reminder", "follow_up", "general"];

const REBOOK_NUDGE_SELECT = `
  id,
  user_id,
  client_id,
  last_appointment_id,
  recipient_email,
  status,
  approval_required,
  send_after,
  template_data,
  created_at,
  updated_at
`;

const THANK_YOU_EMAIL_SELECT = `
  id,
  user_id,
  client_id,
  appointment_id,
  recipient_email,
  status,
  approval_required,
  send_after,
  template_data,
  created_at,
  updated_at
`;

const BIRTHDAY_REMINDER_SELECT = `
  id,
  user_id,
  client_id,
  recipient_email,
  birthday,
  scheduled_send_at,
  status,
  template_data,
  created_at,
  updated_at
`;

const WAITLIST_SELECT = `
  id,
  user_id,
  client_id,
  service_id,
  requested_date,
  requested_time_preference,
  client_name,
  client_email,
  client_phone,
  note,
  status,
  source,
  created_at,
  updated_at,
  services(name)
`;

const isAutomationControlKey = (value: string): value is AutomationControlKey =>
  (AUTOMATION_KEYS as readonly string[]).includes(value);

const getString = (row: Row, key: string): string | null =>
  typeof row[key] === "string" ? row[key] as string : null;

const getNumber = (row: Row, key: string): number =>
  typeof row[key] === "number" ? row[key] as number : Number(row[key] ?? 0);

const toClientName = (client: Row | undefined): string => {
  const firstName = typeof client?.first_name === "string" ? client.first_name : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name : "";
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Client";
};

const centsFromPrice = (value: unknown): number => Math.round(Number(value ?? 0) * 100);

const loadClientsById = async (userId: string, clientIds: Array<string | null>): Promise<Map<string, Row>> => {
  const ids = [...new Set(clientIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, first_name, last_name, preferred_name, email, phone")
    .eq("user_id", userId)
    .in("id", ids);

  handleSupabaseError(error, "Unable to load activity dashboard clients");
  return new Map(((data ?? []) as Row[]).map((client) => [client.id as string, client]));
};

const loadAutomationSettings = async (userId: string): Promise<Map<AutomationControlKey, boolean>> => {
  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("key, enabled")
    .eq("user_id", userId);

  handleSupabaseError(error, "Unable to load automation settings");

  return new Map(
    ((data ?? []) as Row[])
      .filter((row) => typeof row.key === "string" && isAutomationControlKey(row.key))
      .map((row) => [row.key as AutomationControlKey, row.enabled === true])
  );
};

const getEnabled = (settings: Map<AutomationControlKey, boolean>, key: AutomationControlKey): boolean =>
  settings.get(key) ?? false;

const isAutomationAvailable = (entitlements: UserEntitlements, key: AutomationControlKey): boolean => {
  const featureKey = AUTOMATION_FEATURES[key];
  return !featureKey || (entitlements.status !== "cancelled" && entitlements.features[featureKey]);
};

const getEffectiveEnabled = (
  settings: Map<AutomationControlKey, boolean>,
  entitlements: UserEntitlements,
  key: AutomationControlKey
): boolean => isAutomationAvailable(entitlements, key) && getEnabled(settings, key);

const isEmailChannelSendable = (client: Row | undefined, recipientEmail?: unknown): boolean =>
  (typeof recipientEmail === "string" && recipientEmail.trim().length > 0)
  || (typeof client?.email === "string" && client.email.trim().length > 0);

const isSmsChannelSendable = (entitlements: UserEntitlements, client: Row | undefined): boolean =>
  entitlements.status !== "cancelled"
  && entitlements.features.smsReminders
  && entitlements.smsRemainingThisMonth > 0
  && typeof client?.phone === "string"
  && client.phone.trim().length > 0;

const isChannelSendable = (
  entitlements: UserEntitlements,
  client: Row | undefined,
  channel: unknown,
  recipientEmail?: unknown
): channel is "email" | "sms" => {
  if (channel === "email") {
    return isEmailChannelSendable(client, recipientEmail);
  }

  if (channel === "sms") {
    return isSmsChannelSendable(entitlements, client);
  }

  return false;
};

const sortAutomationQueue = (items: AutomationQueueItem[]): AutomationQueueItem[] =>
  [...items].sort((left, right) => left.send_at.localeCompare(right.send_at));

const stripAutomationQueueEligibilityFields = (item: AutomationQueueCandidate): AutomationQueueItem => {
  const {
    eligibility_contact: _eligibilityContact,
    eligibility_message_type: _eligibilityMessageType,
    ...queueItem
  } = item;
  return queueItem;
};

const filterEligibleAutomationQueue = async (
  userId: string,
  candidates: AutomationQueueCandidate[]
): Promise<AutomationQueueItem[]> => {
  if (candidates.length === 0) {
    return [];
  }

  const eligibilityById = await communicationPreferencesService.canSendCommunicationsReadOnly(
    userId,
    candidates.map((candidate) => ({
      id: String(candidate.reminder_id ?? ""),
      clientId: typeof candidate.client_id === "string" ? candidate.client_id : null,
      channel: candidate.channel,
      to: candidate.eligibility_contact,
      messageType: candidate.eligibility_message_type
    }))
  );

  return candidates
    .filter((candidate) => eligibilityById.get(String(candidate.reminder_id ?? ""))?.canSend === true)
    .map(stripAutomationQueueEligibilityFields);
};

const loadRecentActivity = async (userId: string): Promise<ActivityEventItem[]> => {
  const feed = await activityEventsService.getFeed(userId, { limit: 10 });
  return feed.groups.flatMap((group) => group.events).slice(0, 10);
};

const loadCancellationReviewItems = async (userId: string, timeZone: string) => {
  const { data, error } = await supabaseAdmin
    .from("activity_events")
    .select("id, client_id, appointment_id, occurred_at, metadata")
    .eq("user_id", userId)
    .eq("activity_type", "appointment_cancelled")
    .order("occurred_at", { ascending: false })
    .limit(50);

  handleSupabaseError(error, "Unable to load cancellation review items");
  const cancellationEvents = (data ?? []) as Row[];
  const appointmentIds = cancellationEvents.map((row) => getString(row, "appointment_id"));
  if (cancellationEvents.length === 0) {
    return [];
  }

  const concreteAppointmentIds = appointmentIds.filter((id): id is string => Boolean(id));
  const appointmentData: Row[] = [];
  if (concreteAppointmentIds.length > 0) {
    const { data: appointments, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .eq("user_id", userId)
      .in("id", concreteAppointmentIds);

    handleSupabaseError(appointmentError, "Unable to load cancellation review appointments");
    appointmentData.push(...((appointments ?? []) as Row[]));
  }

  const appointmentsById = new Map(appointmentData.map((appointment) => [appointment.id as string, appointment]));
  const clientsById = await loadClientsById(userId, cancellationEvents.map((row) => getString(row, "client_id")));

  const clientIds = [...new Set(cancellationEvents.map((row) => getString(row, "client_id")).filter((id): id is string => Boolean(id)))];
  const futureAppointmentData: Row[] = [];
  if (clientIds.length > 0) {
    const { data: futureAppointments, error: futureAppointmentError } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, appointment_date, status")
      .eq("user_id", userId)
      .in("client_id", clientIds)
      .neq("status", "cancelled")
      .gte("appointment_date", getStartOfLocalDayUtc(getCurrentLocalDate(timeZone), timeZone).toISOString());

    handleSupabaseError(futureAppointmentError, "Unable to load cancellation resolution appointments");
    futureAppointmentData.push(...((futureAppointments ?? []) as Row[]));
  }

  return cancellationEvents
    .map((event) => {
      const appointmentId = getString(event, "appointment_id");
      if (!appointmentId) {
        return null;
      }

      const appointment = appointmentId ? appointmentsById.get(appointmentId) : undefined;
      if (appointment && appointment.status !== "cancelled") {
        return null;
      }

      const clientId = getString(event, "client_id");
      const metadata = (event.metadata ?? {}) as Row;
      const appointmentStartTime = getString(metadata, "appointment_start_time") ?? getString(appointment ?? {}, "appointment_date");
      const hasReplacement = clientId
        ? futureAppointmentData.some((futureAppointment) => {
          const futureDate = getString(futureAppointment, "appointment_date");
          return futureAppointment.client_id === clientId && (!appointmentStartTime || (futureDate ?? "") >= appointmentStartTime);
        })
        : false;

      if (hasReplacement) {
        return null;
      }

      return {
        appointment_id: appointmentId,
        client_id: clientId,
        client_name: getString(metadata, "client_name") ?? toClientName(clientId ? clientsById.get(clientId) : undefined),
        service_name: getString(metadata, "service_name") ?? getString(appointment ?? {}, "service_name"),
        appointment_start_time: appointmentStartTime,
        canceled_at: getString(event, "occurred_at"),
        canceled_by: getString(metadata, "cancelled_by") ?? "stylist",
        review_status: "pending" as const
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
};

const loadReminderQueue = async (
  userId: string,
  enabled: boolean
): Promise<Row[]> => {
  if (!enabled) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("reminders")
    .select(REMINDER_SELECT)
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("reminder_type", "appointment_reminder")
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load reminder queue");
  return (data ?? []) as Row[];
};

const toReminderQueueCandidates = (
  reminders: Row[],
  clientsById: Map<string, Row>,
  entitlements: UserEntitlements
): AutomationQueueCandidate[] => {
  return reminders.flatMap((reminder) => {
    const clientId = getString(reminder, "client_id");
    const client = clientId ? clientsById.get(clientId) : undefined;
    const channel = reminder.channel ?? "sms";
    const sendAt = getString(reminder, "due_date");
    const eligibilityContact = channel === "email" ? getString(client ?? {}, "email") : getString(client ?? {}, "phone");
    if (!sendAt || !isChannelSendable(entitlements, client, channel)) {
      return [];
    }

    return {
      automation_key: "appointment_reminders",
      reminder_id: reminder.id,
      appointment_id: reminder.appointment_id ?? null,
      client_id: clientId,
      client_name: toClientName(client),
      send_at: sendAt,
      channel,
      reminder_type: "appointment_reminder",
      eligibility_contact: eligibilityContact,
      eligibility_message_type: "appointment_reminder",
      status: "scheduled"
    };
  });
};

const loadAppointmentEmailReminderQueue = async (
  userId: string,
  enabled: boolean
): Promise<{ emailEvents: Row[]; appointmentsById: Map<string, Row> }> => {
  if (!enabled) {
    return { emailEvents: [], appointmentsById: new Map() };
  }

  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .select(APPOINTMENT_REMINDER_EMAIL_SELECT)
    .eq("user_id", userId)
    .eq("email_type", "appointment_reminder")
    .in("status", ["queued", "sending"])
    .order("created_at", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load appointment reminder email queue");
  const emailEvents = (data ?? []) as Row[];
  const appointmentIds = [...new Set(emailEvents.map((row) => getString(row, "appointment_id")).filter((id): id is string => Boolean(id)))];
  const appointmentData: Row[] = [];

  if (appointmentIds.length > 0) {
    const { data: appointments, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select("id, appointment_date")
      .eq("user_id", userId)
      .in("id", appointmentIds);

    handleSupabaseError(appointmentError, "Unable to load appointment reminder email appointments");
    appointmentData.push(...((appointments ?? []) as Row[]));
  }

  const appointmentsById = new Map(appointmentData.map((appointment) => [appointment.id as string, appointment]));
  return { emailEvents, appointmentsById };
};

const toAppointmentEmailReminderQueueCandidates = (
  emailEvents: Row[],
  appointmentsById: Map<string, Row>,
  clientsById: Map<string, Row>,
  entitlements: UserEntitlements
): AutomationQueueCandidate[] => {
  return emailEvents.flatMap((emailEvent) => {
    const clientId = getString(emailEvent, "client_id");
    const client = clientId ? clientsById.get(clientId) : undefined;
    const appointmentId = getString(emailEvent, "appointment_id");
    const appointment = appointmentId ? appointmentsById.get(appointmentId) : undefined;
    const templateData = (emailEvent.template_data ?? {}) as Row;
    const appointmentStartTime = getString(appointment ?? {}, "appointment_date") ?? getString(templateData, "appointment_start_time");
    const sendAt = getString(emailEvent, "created_at");
    if (!sendAt || !isChannelSendable(entitlements, client, "email", emailEvent.recipient_email)) {
      return [];
    }

    return {
      automation_key: "appointment_reminders",
      reminder_id: emailEvent.id,
      email_event_id: emailEvent.id,
      // reminder_queue items must always include appointment_id in the response contract,
      // even when the source email event has no appointment attached.
      appointment_id: appointmentId ?? null,
      client_id: clientId,
      client_name: toClientName(client),
      send_at: sendAt,
      appointment_start_time: appointmentStartTime,
      channel: "email",
      reminder_type: "appointment_reminder",
      eligibility_contact: getString(emailEvent, "recipient_email") ?? getString(client ?? {}, "email"),
      eligibility_message_type: "appointment_reminder",
      status: emailEvent.status === "sending" ? "sending" : "queued"
    };
  });
};

const getReminderQueueDedupeKey = (item: ReminderQueueItem): string => {
  const appointmentId = String(item.appointment_id ?? "");
  const reminderType = String(item.reminder_type ?? "");
  const channel = String(item.channel ?? "");

  if (appointmentId && reminderType && channel) {
    return `${appointmentId}:${reminderType}:${channel}`;
  }

  return `reminder:${String(item.reminder_id ?? "")}`;
};

const mergeReminderQueues = (
  legacyReminderQueue: AutomationQueueCandidate[],
  appointmentEmailReminderQueue: AutomationQueueCandidate[]
): AutomationQueueCandidate[] => {
  const appointmentEmailReminderKeys = new Set(
    appointmentEmailReminderQueue.map((reminder) => getReminderQueueDedupeKey(reminder))
  );

  return [
    ...legacyReminderQueue.filter((reminder) => !appointmentEmailReminderKeys.has(getReminderQueueDedupeKey(reminder))),
    ...appointmentEmailReminderQueue
  ];
};

const loadRebookNudgeQueue = async (
  userId: string,
  enabled: boolean
): Promise<Row[]> => {
  if (!enabled) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("rebook_nudges")
    .select(REBOOK_NUDGE_SELECT)
    .eq("user_id", userId)
    .eq("status", "queued")
    .eq("approval_required", false)
    .gte("send_after", new Date().toISOString())
    .order("send_after", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load rebook nudge automation queue");
  return (data ?? []) as Row[];
};

const toRebookNudgeQueueCandidates = (
  rows: Row[],
  clientsById: Map<string, Row>,
  entitlements: UserEntitlements
): AutomationQueueCandidate[] => {
  return rows.flatMap((row) => {
    const clientId = getString(row, "client_id");
    const client = clientId ? clientsById.get(clientId) : undefined;
    const sendAt = getString(row, "send_after");
    if (!sendAt || !isChannelSendable(entitlements, client, "email", row.recipient_email)) {
      return [];
    }

    return {
      automation_key: "rebook_nudges",
      reminder_id: row.id,
      rebook_nudge_id: row.id,
      appointment_id: row.last_appointment_id ?? null,
      client_id: clientId,
      client_name: toClientName(client),
      send_at: sendAt,
      channel: "email",
      reminder_type: "rebook_nudge",
      eligibility_contact: getString(row, "recipient_email") ?? getString(client ?? {}, "email"),
      eligibility_message_type: "rebooking_prompt",
      status: "queued"
    };
  });
};

const loadBirthdayReminderAutomationQueue = async (
  userId: string,
  enabled: boolean
): Promise<Row[]> => {
  if (!enabled) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("birthday_reminders")
    .select(BIRTHDAY_REMINDER_SELECT)
    .eq("user_id", userId)
    .eq("status", "queued")
    .gte("scheduled_send_at", new Date().toISOString())
    .order("scheduled_send_at", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load birthday reminder automation queue");
  return (data ?? []) as Row[];
};

const toBirthdayReminderQueueCandidates = (
  rows: Row[],
  clientsById: Map<string, Row>,
  entitlements: UserEntitlements
): AutomationQueueCandidate[] => {
  return rows.flatMap((row) => {
    const clientId = getString(row, "client_id");
    const client = clientId ? clientsById.get(clientId) : undefined;
    const templateData = (row.template_data ?? {}) as Row;
    const sendAt = getString(row, "scheduled_send_at");
    if (!sendAt || !isChannelSendable(entitlements, client, "email", row.recipient_email)) {
      return [];
    }

    return {
      automation_key: "birthday_reminders",
      reminder_id: row.id,
      birthday_reminder_id: row.id,
      // reminder_queue items must always include appointment_id in the response contract,
      // even when birthday reminders are not tied to a specific appointment.
      appointment_id: null,
      client_id: clientId,
      client_name: getString(templateData, "client_name") ?? toClientName(client),
      send_at: sendAt,
      channel: "email",
      reminder_type: "birthday_reminder",
      eligibility_contact: getString(row, "recipient_email") ?? getString(client ?? {}, "email"),
      eligibility_message_type: "birthday_reminder",
      status: "queued"
    };
  });
};

const loadThankYouEmailQueue = async (
  userId: string,
  enabled: boolean
): Promise<Row[]> => {
  if (!enabled) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("thank_you_emails")
    .select(THANK_YOU_EMAIL_SELECT)
    .eq("user_id", userId)
    .eq("status", "queued")
    .eq("approval_required", false)
    .gte("send_after", new Date().toISOString())
    .order("send_after", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load thank you email automation queue");
  return (data ?? []) as Row[];
};

const toThankYouEmailQueueCandidates = (
  rows: Row[],
  clientsById: Map<string, Row>,
  entitlements: UserEntitlements
): AutomationQueueCandidate[] => {
  return rows.flatMap((row) => {
    const clientId = getString(row, "client_id");
    const client = clientId ? clientsById.get(clientId) : undefined;
    const sendAt = getString(row, "send_after");
    if (!sendAt || !isChannelSendable(entitlements, client, "email", row.recipient_email)) {
      return [];
    }

    return {
      automation_key: "thank_you_emails",
      reminder_id: row.id,
      thank_you_email_id: row.id,
      appointment_id: row.appointment_id ?? null,
      client_id: clientId,
      client_name: toClientName(client),
      send_at: sendAt,
      channel: "email",
      reminder_type: "thank_you_email",
      eligibility_contact: getString(row, "recipient_email") ?? getString(client ?? {}, "email"),
      eligibility_message_type: "marketing",
      status: "queued"
    };
  });
};

const loadReviewRequestQueue = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("reminders")
    .select(REMINDER_SELECT)
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("reminder_type", "follow_up")
    .order("due_date", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load review request queue");
  const reminders = (data ?? []) as Row[];
  const clientsById = await loadClientsById(userId, reminders.map((row) => getString(row, "client_id")));

  return reminders.map((reminder) => {
    const clientId = getString(reminder, "client_id");
    return {
      review_request_id: reminder.id,
      appointment_id: reminder.appointment_id ?? null,
      client_id: clientId,
      client_name: toClientName(clientId ? clientsById.get(clientId) : undefined),
      completed_at: null,
      send_at: reminder.due_date,
      channel: reminder.channel ?? "sms",
      status: "queued"
    };
  });
};

const loadWaitlistMatches = async (userId: string, timeZone: string) => {
  const today = getCurrentLocalDate(timeZone);
  const { data: waitlistData, error: waitlistError } = await supabaseAdmin
    .from("waitlist_entries")
    .select(WAITLIST_SELECT)
    .eq("user_id", userId)
    .eq("status", "active")
    .gte("requested_date", today)
    .order("requested_date", { ascending: true })
    .limit(50);

  handleSupabaseError(waitlistError, "Unable to load waitlist entries for matches");

  const { data: openingData, error: openingError } = await supabaseAdmin
    .from("appointments")
    .select(APPOINTMENT_SELECT)
    .eq("user_id", userId)
    .eq("status", "cancelled")
    .gte("appointment_date", getStartOfLocalDayUtc(today, timeZone).toISOString())
    .order("appointment_date", { ascending: true })
    .limit(50);

  handleSupabaseError(openingError, "Unable to load open appointment slots for waitlist matches");

  const openings = (openingData ?? []) as Row[];
  return ((waitlistData ?? []) as Row[])
    .flatMap((entry) => {
      const service = (entry.services ?? null) as Row | null;
      const entryServiceId = getString(entry, "service_id");
      const entryServiceName = getString(service ?? {}, "name");
      const requestedDate = getString(entry, "requested_date");
      const opening = openings.find((candidate) => {
        const candidateDate = getString(candidate, "appointment_date");
        const sameDate = candidateDate ? getLocalDateForInstant(candidateDate, timeZone) === requestedDate : false;
        const sameService = entryServiceId
          ? candidate.service_id === entryServiceId
          : !entryServiceName || candidate.service_name === entryServiceName;
        return sameDate && sameService;
      });

      if (!opening) {
        return [];
      }

      const openingStart = getString(opening, "appointment_date");
      const durationMinutes = getNumber(opening, "duration_minutes");
      const openingEnd = openingStart
        ? new Date(new Date(openingStart).getTime() + durationMinutes * 60_000).toISOString()
        : null;

      return [{
        waitlist_entry_id: entry.id,
        client_id: entry.client_id ?? null,
        client_name: entry.client_name,
        service_id: entry.service_id ?? null,
        service_name: entryServiceName ?? opening.service_name ?? null,
        requested_date: requestedDate,
        requested_time_preference: entry.requested_time_preference ?? null,
        matched_opening_start_time: openingStart,
        matched_opening_end_time: openingEnd,
        confidence_score: entryServiceId ? 0.9 : 0.75,
        reason: entryServiceId ? "Same service and requested date" : "Requested date has a matching opening"
      }];
    })
    .slice(0, 20);
};

const loadAutomationHealth = async (userId: string, settings: Map<AutomationControlKey, boolean>) => {
  const now = new Date();
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60_000).toISOString();

  const [failedEmailsResult, delayedEmailsResult, overdueRemindersResult] = await Promise.all([
    supabaseAdmin
      .from("appointment_email_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "failed"),
    supabaseAdmin
      .from("appointment_email_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "queued")
      .lt("created_at", fifteenMinutesAgo),
    supabaseAdmin
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "open")
      .lt("due_date", now.toISOString())
  ]);

  handleSupabaseError(failedEmailsResult.error, "Unable to load failed automation count");
  handleSupabaseError(delayedEmailsResult.error, "Unable to load delayed automation count");
  handleSupabaseError(overdueRemindersResult.error, "Unable to load overdue reminder count");

  const disabledCount = AUTOMATION_KEYS.filter((key) => !getEnabled(settings, key)).length;
  const failedCount = failedEmailsResult.count ?? 0;
  const delayedCount = (delayedEmailsResult.count ?? 0) + (overdueRemindersResult.count ?? 0);
  const reasons: string[] = [];

  if (failedCount > 0) reasons.push(`${failedCount} automation delivery ${failedCount === 1 ? "failure" : "failures"}`);
  if (delayedCount > 0) reasons.push(`${delayedCount} delayed automation ${delayedCount === 1 ? "item" : "items"}`);
  if (disabledCount > 0) reasons.push(`${disabledCount} automation ${disabledCount === 1 ? "control is" : "controls are"} disabled`);

  const score = Math.max(0, 100 - failedCount * 20 - delayedCount * 5 - disabledCount * 10);
  const status = failedCount > 0 || score < 80 ? "issue" : delayedCount > 0 || disabledCount > 0 ? "warning" : "all_good";

  return {
    score,
    status,
    failed_count: failedCount,
    delayed_count: delayedCount,
    reasons
  };
};

const loadImpactThisWeek = async (userId: string, timeZone: string) => {
  const today = getCurrentLocalDate(timeZone);
  const startDate = addDays(today, -6);
  const startIso = getStartOfLocalDayUtc(startDate, timeZone).toISOString();
  const endIso = getEndOfLocalDayUtc(today, timeZone).toISOString();

  const [bookingActivityResult, reminderActivityResult, filledWaitlistResult] = await Promise.all([
    supabaseAdmin
      .from("activity_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("activity_type", "booking_created")
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso),
    supabaseAdmin
      .from("activity_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("activity_type", "reminder_sent")
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso),
    supabaseAdmin
      .from("waitlist_entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "booked")
      .gte("updated_at", startIso)
      .lt("updated_at", endIso)
  ]);

  handleSupabaseError(bookingActivityResult.error, "Unable to load automation booking impact");
  handleSupabaseError(reminderActivityResult.error, "Unable to load automation reminder impact");
  handleSupabaseError(filledWaitlistResult.error, "Unable to load automation opening impact");

  const openingsFilledCount = filledWaitlistResult.count ?? 0;
  const recoveredRevenueCents = 0;

  return {
    booked_count: 0,
    total_booking_activity_count: bookingActivityResult.count ?? 0,
    recovered_revenue_cents: recoveredRevenueCents,
    reminders_sent_count: reminderActivityResult.count ?? 0,
    openings_filled_count: openingsFilledCount
  };
};

const addClientIds = (clientIds: Set<string>, rows: Row[] | null | undefined): void => {
  (rows ?? []).forEach((row) => {
    const clientId = getString(row, "client_id");
    if (clientId) {
      clientIds.add(clientId);
    }
  });
};

const loadCustomersReachedLast30Days = async (userId: string): Promise<number> => {
  const sinceIso = new Date(Date.now() - customersReachedWindowMs).toISOString();
  const [
    communicationEventsResult,
    appointmentEmailEventsResult,
    reminderEventsResult,
    reminderActivityResult,
    rebookNudgesResult,
    birthdayRemindersResult,
    thankYouEmailsResult
  ] = await Promise.all([
    supabaseAdmin
      .from("communication_events")
      .select("client_id")
      .eq("user_id", userId)
      .in("status", ["sent", "delivered"])
      .in("message_type", CUSTOMER_REACHED_COMMUNICATION_MESSAGE_TYPES)
      .not("client_id", "is", null)
      .gte("created_at", sinceIso),
    supabaseAdmin
      .from("appointment_email_events")
      .select("client_id")
      .eq("user_id", userId)
      .eq("status", "sent")
      .in("email_type", CUSTOMER_REACHED_EMAIL_TYPES)
      .not("client_id", "is", null)
      .gte("sent_at", sinceIso),
    supabaseAdmin
      .from("reminders")
      .select("client_id")
      .eq("user_id", userId)
      .eq("status", "sent")
      .in("reminder_type", CUSTOMER_REACHED_REMINDER_TYPES)
      .not("client_id", "is", null)
      .gte("sent_at", sinceIso),
    supabaseAdmin
      .from("activity_events")
      .select("client_id")
      .eq("user_id", userId)
      .eq("activity_type", "reminder_sent")
      .not("client_id", "is", null)
      .gte("occurred_at", sinceIso),
    supabaseAdmin
      .from("rebook_nudges")
      .select("client_id")
      .eq("user_id", userId)
      .eq("status", "sent")
      .not("client_id", "is", null)
      .gte("sent_at", sinceIso),
    supabaseAdmin
      .from("birthday_reminders")
      .select("client_id")
      .eq("user_id", userId)
      .eq("status", "sent")
      .not("client_id", "is", null)
      .gte("sent_at", sinceIso),
    supabaseAdmin
      .from("thank_you_emails")
      .select("client_id")
      .eq("user_id", userId)
      .eq("status", "sent")
      .not("client_id", "is", null)
      .gte("sent_at", sinceIso)
  ]);

  handleSupabaseError(communicationEventsResult.error, "Unable to load customers reached communication events");
  handleSupabaseError(appointmentEmailEventsResult.error, "Unable to load customers reached email events");
  handleSupabaseError(reminderEventsResult.error, "Unable to load customers reached reminders");
  handleSupabaseError(reminderActivityResult.error, "Unable to load customers reached reminder activity");
  handleSupabaseError(rebookNudgesResult.error, "Unable to load customers reached rebook nudges");
  handleSupabaseError(birthdayRemindersResult.error, "Unable to load customers reached birthday reminders");
  handleSupabaseError(thankYouEmailsResult.error, "Unable to load customers reached thank you emails");

  const clientIds = new Set<string>();
  addClientIds(clientIds, communicationEventsResult.data as Row[] | null | undefined);
  addClientIds(clientIds, appointmentEmailEventsResult.data as Row[] | null | undefined);
  addClientIds(clientIds, reminderEventsResult.data as Row[] | null | undefined);
  addClientIds(clientIds, reminderActivityResult.data as Row[] | null | undefined);
  addClientIds(clientIds, rebookNudgesResult.data as Row[] | null | undefined);
  addClientIds(clientIds, birthdayRemindersResult.data as Row[] | null | undefined);
  addClientIds(clientIds, thankYouEmailsResult.data as Row[] | null | undefined);

  return clientIds.size;
};

export const activityDashboardService = {
  isAutomationControlKey,

  async getDashboard(userId: string): Promise<Row> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const [entitlements, settings, birthdayReminderSettings] = await Promise.all([
      entitlementsService.getEntitlementsForUser(userId),
      loadAutomationSettings(userId),
      birthdayReminderSettingsService.getRawForUser(userId)
    ]);
    const appointmentRemindersEnabled = getEffectiveEnabled(settings, entitlements, "appointment_reminders");
    const rebookNudgesEnabled = getEffectiveEnabled(settings, entitlements, "rebook_nudges");
    const birthdayRemindersEnabled = getEffectiveEnabled(settings, entitlements, "birthday_reminders");
    const birthdayReminderApprovalRequired = birthdayReminderSettings?.approval_required !== false;
    const birthdayReminderAutoSendEnabled = birthdayRemindersEnabled && !birthdayReminderApprovalRequired;
    const thankYouEmailsEnabled = getEffectiveEnabled(settings, entitlements, "thank_you_emails");
    const [
      recentActivity,
      cancellationReviewItems,
      reminderRows,
      appointmentEmailReminderSource,
      rebookNudgeRows,
      birthdayReminderRows,
      thankYouEmailRows,
      reviewRequestQueue,
      waitlistMatches,
      feedCounts,
      rebookNudgeCounts,
      outstandingRebookNudges,
      birthdayReminderCounts,
      birthdayReminderQueue,
      thankYouEmailCounts,
      customersReachedLast30Days
    ] = await Promise.all([
      loadRecentActivity(userId),
      loadCancellationReviewItems(userId, timeZone),
      loadReminderQueue(userId, appointmentRemindersEnabled),
      loadAppointmentEmailReminderQueue(userId, appointmentRemindersEnabled),
      loadRebookNudgeQueue(userId, rebookNudgesEnabled),
      loadBirthdayReminderAutomationQueue(userId, birthdayReminderAutoSendEnabled),
      loadThankYouEmailQueue(userId, thankYouEmailsEnabled),
      loadReviewRequestQueue(userId),
      Promise.resolve(
        isAutomationAvailable(entitlements, "waitlist_match")
          ? loadWaitlistMatches(userId, timeZone)
          : []
      ),
      activityEventsService.getCategoryCounts(userId, {}, timeZone),
      rebookNudgesService.getCountsForUser(userId),
      rebookNudgesEnabled ? rebookNudgesService.getOutstandingForUser(userId, 50) : [],
      birthdayRemindersEnabled ? birthdayRemindersService.getCountsForUser(userId) : Promise.resolve({ pending_approval: 0, queued: 0 }),
      birthdayReminderAutoSendEnabled ? birthdayRemindersService.getQueuedForUser(userId, 50) : [],
      thankYouEmailsService.getCountsForUser(userId),
      loadCustomersReachedLast30Days(userId)
    ]);

    const [automationHealth, automationImpactThisWeek] = await Promise.all([
      loadAutomationHealth(userId, settings),
      loadImpactThisWeek(userId, timeZone)
    ]);

    const automationQueueClientsById = await loadClientsById(userId, [
      ...reminderRows.map((row) => getString(row, "client_id")),
      ...appointmentEmailReminderSource.emailEvents.map((row) => getString(row, "client_id")),
      ...rebookNudgeRows.map((row) => getString(row, "client_id")),
      ...birthdayReminderRows.map((row) => getString(row, "client_id")),
      ...thankYouEmailRows.map((row) => getString(row, "client_id"))
    ]);
    const legacyReminderCandidates = toReminderQueueCandidates(reminderRows, automationQueueClientsById, entitlements);
    const appointmentEmailReminderCandidates = toAppointmentEmailReminderQueueCandidates(
      appointmentEmailReminderSource.emailEvents,
      appointmentEmailReminderSource.appointmentsById,
      automationQueueClientsById,
      entitlements
    );
    const rebookNudgeCandidates = toRebookNudgeQueueCandidates(rebookNudgeRows, automationQueueClientsById, entitlements);
    const birthdayReminderCandidates = toBirthdayReminderQueueCandidates(birthdayReminderRows, automationQueueClientsById, entitlements);
    const thankYouEmailCandidates = toThankYouEmailQueueCandidates(thankYouEmailRows, automationQueueClientsById, entitlements);
    const appointmentReminderQueueCandidates = mergeReminderQueues(legacyReminderCandidates, appointmentEmailReminderCandidates);
    const automationQueue = sortAutomationQueue(await filterEligibleAutomationQueue(userId, [
      ...appointmentReminderQueueCandidates,
      ...rebookNudgeCandidates,
      ...birthdayReminderCandidates,
      ...thankYouEmailCandidates
    ]));
    const appointmentReminderQueue = automationQueue.filter((item) => item.automation_key === "appointment_reminders");
    const eligibleRebookNudgeQueue = automationQueue.filter((item) => item.automation_key === "rebook_nudges");
    const eligibleBirthdayReminderQueue = automationQueue.filter((item) => item.automation_key === "birthday_reminders");
    const eligibleThankYouEmailQueue = automationQueue.filter((item) => item.automation_key === "thank_you_emails");
    const eligibleBirthdayReminderIds = new Set(
      eligibleBirthdayReminderQueue.map((item) => String(item.birthday_reminder_id ?? item.reminder_id ?? ""))
    );
    const eligibleBirthdayReminderApiQueue = birthdayReminderQueue.filter((item) =>
      eligibleBirthdayReminderIds.has(String(item.reminder_id ?? ""))
    );
    const rebookNudgeApprovalNeededCount = rebookNudgeCounts.pending_approval;
    const birthdayReminderApprovalNeededCount = birthdayReminderApprovalRequired
      ? birthdayReminderCounts.pending_approval
      : 0;
    const thankYouEmailApprovalNeededCount = thankYouEmailCounts.pending_approval;
    const rebookNudgeAutoSendQueuedCount = eligibleRebookNudgeQueue.length;
    const birthdayReminderAutoSendQueuedCount = birthdayReminderApprovalRequired
      ? 0
      : eligibleBirthdayReminderQueue.length;
    const thankYouEmailAutoSendQueuedCount = eligibleThankYouEmailQueue.length;
    const birthdayReminderMode = birthdayReminderApprovalRequired ? "approval_required" : "automatic";
    const noShowTodayCount = 0;
    const automationControls = [
      {
        key: "rebook_nudges",
        label: AUTOMATION_LABELS.rebook_nudges,
        enabled: rebookNudgesEnabled,
        feature_available: isAutomationAvailable(entitlements, "rebook_nudges"),
        status_label: !isAutomationAvailable(entitlements, "rebook_nudges")
          ? "Upgrade required"
          : rebookNudgeApprovalNeededCount > 0
          ? `${rebookNudgeApprovalNeededCount} need approval`
          : `${rebookNudgeAutoSendQueuedCount} queued`,
        due_count: feedCounts.rebook,
        pending_approval_count: rebookNudgeApprovalNeededCount,
        queued_count: rebookNudgeAutoSendQueuedCount
      },
      {
        key: "appointment_reminders",
        label: AUTOMATION_LABELS.appointment_reminders,
        enabled: appointmentRemindersEnabled,
        feature_available: isAutomationAvailable(entitlements, "appointment_reminders"),
        status_label: `${appointmentReminderQueue.length} scheduled`,
        scheduled_count: appointmentReminderQueue.length
      },
      {
        key: "email_confirmations",
        label: AUTOMATION_LABELS.email_confirmations,
        enabled: getEffectiveEnabled(settings, entitlements, "email_confirmations"),
        feature_available: isAutomationAvailable(entitlements, "email_confirmations"),
        status_label: getEffectiveEnabled(settings, entitlements, "email_confirmations") ? "On for bookings" : "Paused"
      },
      {
        key: "no_show_follow_up",
        label: AUTOMATION_LABELS.no_show_follow_up,
        enabled: getEffectiveEnabled(settings, entitlements, "no_show_follow_up"),
        feature_available: isAutomationAvailable(entitlements, "no_show_follow_up"),
        status_label: isAutomationAvailable(entitlements, "no_show_follow_up")
          ? `${noShowTodayCount} needed today`
          : "Upgrade required",
        due_count: noShowTodayCount
      },
      {
        key: "waitlist_match",
        label: AUTOMATION_LABELS.waitlist_match,
        enabled: getEffectiveEnabled(settings, entitlements, "waitlist_match"),
        feature_available: isAutomationAvailable(entitlements, "waitlist_match"),
        status_label: isAutomationAvailable(entitlements, "waitlist_match")
          ? `${waitlistMatches.length} ${waitlistMatches.length === 1 ? "match" : "matches"} found`
          : "Upgrade required",
        match_count: waitlistMatches.length
      },
      {
        key: "birthday_reminders",
        label: AUTOMATION_LABELS.birthday_reminders,
        enabled: birthdayRemindersEnabled,
        feature_available: isAutomationAvailable(entitlements, "birthday_reminders"),
        status_label: !isAutomationAvailable(entitlements, "birthday_reminders")
          ? "Upgrade required"
          : birthdayReminderApprovalNeededCount > 0
          ? `${birthdayReminderApprovalNeededCount} need approval`
          : `${birthdayReminderAutoSendQueuedCount} queued`,
        pending_approval_count: birthdayReminderApprovalNeededCount,
        queued_count: birthdayReminderAutoSendQueuedCount
      },
      {
        key: "thank_you_emails",
        label: AUTOMATION_LABELS.thank_you_emails,
        enabled: thankYouEmailsEnabled,
        feature_available: isAutomationAvailable(entitlements, "thank_you_emails"),
        status_label: !isAutomationAvailable(entitlements, "thank_you_emails")
          ? "Upgrade required"
          : thankYouEmailApprovalNeededCount > 0
          ? `${thankYouEmailApprovalNeededCount} need approval`
          : `${thankYouEmailAutoSendQueuedCount} queued`,
        pending_approval_count: thankYouEmailApprovalNeededCount,
        queued_count: thankYouEmailAutoSendQueuedCount
      }
    ];

    return {
      needs_attention: {
        cancellations_need_review_count: cancellationReviewItems.length,
        waitlist_match_count: waitlistMatches.length,
        pending_approval_count: feedCounts.approvals,
        pending_reminder_count: automationQueue.length,
        queued_review_request_count: reviewRequestQueue.length,
        pending_rebook_nudge_count: rebookNudgeApprovalNeededCount,
        birthday_reminder_count: birthdayReminderApprovalNeededCount,
        pending_thank_you_email_count: thankYouEmailApprovalNeededCount
      },
      pending_approval_count: feedCounts.approvals,
      pending_rebook_nudge_count: rebookNudgeApprovalNeededCount,
      queued_rebook_nudge_count: rebookNudgeAutoSendQueuedCount,
      outstanding_rebook_nudges: outstandingRebookNudges,
      birthday_reminder_count: birthdayReminderApprovalRequired
        ? birthdayReminderApprovalNeededCount
        : birthdayReminderAutoSendQueuedCount,
      queued_birthday_reminder_count: birthdayReminderAutoSendQueuedCount,
      birthdayReminderMode,
      birthday_reminder_queue: eligibleBirthdayReminderApiQueue,
      pending_thank_you_email_count: thankYouEmailApprovalNeededCount,
      queued_thank_you_email_count: thankYouEmailAutoSendQueuedCount,
      cancellation_review_count: cancellationReviewItems.length,
      cancellation_review_items: cancellationReviewItems,
      waitlist_match_count: waitlistMatches.length,
      waitlist_matches: waitlistMatches,
      pending_reminder_count: automationQueue.length,
      scheduled_reminder_count: automationQueue.length,
      reminder_queue: automationQueue,
      queued_review_request_count: reviewRequestQueue.length,
      review_request_queue: reviewRequestQueue,
      automation_health: automationHealth,
      automation_health_score: automationHealth.score,
      automation_health_status: automationHealth.status,
      failed_automation_count: automationHealth.failed_count,
      delayed_automation_count: automationHealth.delayed_count,
      health_reasons: automationHealth.reasons,
      automation_impact_this_week: automationImpactThisWeek,
      customers_reached_last_30_days: customersReachedLast30Days,
      recent_activity: recentActivity,
      automation_controls: automationControls
    };
  },

  async updateAutomationSetting(userId: string, key: string, enabled: boolean): Promise<Row> {
    if (!isAutomationControlKey(key)) {
      throw new ApiError(400, "Unsupported automation setting key");
    }

    const featureKey = AUTOMATION_FEATURES[key];
    if (enabled && featureKey) {
      await entitlementsService.assertFeatureAllowed(userId, featureKey);
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("automation_settings")
      .select("*")
      .eq("user_id", userId)
      .eq("key", key)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to load automation setting");

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("automation_settings")
        .update({ enabled })
        .eq("user_id", userId)
        .eq("key", key)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update automation setting");
      const setting = requireFound(data, "Automation setting not found");
      await recordProductTelemetry({
        accountUserId: userId,
        actorUserId: userId,
        eventType: enabled ? "automation_enabled" : "automation_disabled",
        eventSource: "backend",
        metadata: {
          automation_key: key
        }
      });
      return setting;
    }

    const { data, error } = await supabaseAdmin
      .from("automation_settings")
      .insert({ user_id: userId, key, enabled })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create automation setting");
    const setting = requireFound(data, "Automation setting was not created");
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      eventType: enabled ? "automation_enabled" : "automation_disabled",
      eventSource: "backend",
      metadata: {
        automation_key: key
      }
    });
    return setting;
  }
};
