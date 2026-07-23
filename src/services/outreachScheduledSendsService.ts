import { ApiError } from "../lib/errors";
import {
  SCHEDULED_OUTREACH_KINDS,
  type ScheduledOutreachItemContract,
  type ScheduledOutreachKind,
  type ScheduledOutreachListContract,
  type ScheduledOutreachStatus
} from "../lib/outreachContracts";
import { supabaseAdmin } from "../lib/supabase";
import type { MessageType } from "../lib/communications";
import type { UserEntitlements } from "../lib/plans";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { appointmentReminderSuppressionsService } from "./appointmentReminderSuppressionsService";
import { birthdayRemindersService } from "./birthdayRemindersService";
import { communicationPreferencesService } from "./communicationPreferences";
import { entitlementsService } from "./entitlementsService";
import { rebookNudgesService } from "./rebookNudgesService";
import { thankYouEmailsService } from "./thankYouEmailsService";
import { campaignSubmissionService } from "./campaignSubmissionService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { addDays, getCurrentLocalDate, getStartOfLocalDayUtc } from "../lib/timezone";

const APPOINTMENT_REMINDER_LEAD_MS = 24 * 60 * 60 * 1_000;
const DATABASE_PAGE_SIZE = 500;
const LOOKUP_BATCH_SIZE = 200;

type ScheduledSendResource = {
  version: 1;
  kind: ScheduledOutreachKind;
  source_id: string;
  occurrence_at?: string;
};

type ScheduledSendCandidate = ScheduledOutreachItemContract & {
  eligibility_client_id: string | null;
  eligibility_to: string | null;
  eligibility_message_type: MessageType;
};

type ListScheduledSendsOptions = {
  status?: ScheduledOutreachStatus;
  kinds?: ScheduledOutreachKind[];
  window?: "today_tomorrow";
  limit: number;
  cursor?: string;
  now?: Date;
};

type CursorPayload = {
  send_at: string;
  kind: ScheduledOutreachKind;
  id: string;
};

type WindowedCursorPayload = {
  version: 2;
  send_at: string;
  id: string;
  filter: string;
};

type ScheduledSendsWindow = {
  kind: "today_tomorrow";
  timezone: string;
  startsAt: string;
  endsAt: string;
};

const getString = (row: Row | null | undefined, key: string): string | null =>
  typeof row?.[key] === "string" && String(row[key]).trim().length > 0 ? String(row[key]).trim() : null;

const getClientDisplayName = (client: Row | undefined): string => {
  const preferredName = getString(client, "preferred_name");
  const firstName = getString(client, "first_name");
  const lastName = getString(client, "last_name");
  return preferredName ?? ([firstName, lastName].filter(Boolean).join(" ").trim() || "Client");
};

const encodeResourceId = (resource: ScheduledSendResource): string =>
  Buffer.from(JSON.stringify(resource), "utf8").toString("base64url");

export const decodeScheduledSendResourceId = (id: string): ScheduledSendResource => {
  try {
    const parsed = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as Partial<ScheduledSendResource>;
    if (
      parsed.version !== 1
      || typeof parsed.kind !== "string"
      || !(SCHEDULED_OUTREACH_KINDS as readonly string[]).includes(parsed.kind)
      || typeof parsed.source_id !== "string"
      || !parsed.source_id
      || (parsed.occurrence_at !== undefined && typeof parsed.occurrence_at !== "string")
    ) {
      throw new Error("Invalid resource identifier");
    }

    return parsed as ScheduledSendResource;
  } catch {
    throw new ApiError(400, "Invalid scheduled send identifier");
  }
};

const encodeCursor = (item: ScheduledOutreachItemContract): string =>
  Buffer.from(JSON.stringify({
    send_at: item.send_at,
    kind: item.kind,
    id: item.id
  } satisfies CursorPayload), "utf8").toString("base64url");

const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      typeof parsed.send_at !== "string"
      || typeof parsed.kind !== "string"
      || !(SCHEDULED_OUTREACH_KINDS as readonly string[]).includes(parsed.kind)
      || typeof parsed.id !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }

    return parsed as CursorPayload;
  } catch {
    throw new ApiError(400, "Invalid scheduled sends cursor");
  }
};

const encodeWindowedCursor = (item: ScheduledOutreachItemContract, filter: string): string =>
  Buffer.from(JSON.stringify({
    version: 2,
    send_at: item.send_at,
    id: item.id,
    filter
  } satisfies WindowedCursorPayload), "utf8").toString("base64url");

const decodeWindowedCursor = (cursor: string, expectedFilter: string): WindowedCursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<WindowedCursorPayload>;
    if (
      parsed.version !== 2
      || typeof parsed.send_at !== "string"
      || typeof parsed.id !== "string"
      || typeof parsed.filter !== "string"
      || parsed.filter !== expectedFilter
    ) {
      throw new Error("Invalid cursor shape");
    }

    return parsed as WindowedCursorPayload;
  } catch {
    throw new ApiError(400, "Invalid scheduled sends cursor");
  }
};

const compareItems = (left: ScheduledOutreachItemContract, right: ScheduledOutreachItemContract): number =>
  left.send_at.localeCompare(right.send_at)
  || left.kind.localeCompare(right.kind)
  || left.id.localeCompare(right.id);

const compareWindowedItems = (left: ScheduledOutreachItemContract, right: ScheduledOutreachItemContract): number =>
  left.send_at.localeCompare(right.send_at) || left.id.localeCompare(right.id);

const loadAllRows = async (
  fetchPage: (start: number, end: number) => PromiseLike<{ data: unknown; error: unknown }>,
  errorMessage: string
): Promise<Row[]> => {
  const rows: Row[] = [];
  for (let start = 0; ; start += DATABASE_PAGE_SIZE) {
    const result = await fetchPage(start, start + DATABASE_PAGE_SIZE - 1);
    handleSupabaseError(result.error as Parameters<typeof handleSupabaseError>[0], errorMessage);
    const page = (result.data ?? []) as Row[];
    rows.push(...page);
    if (page.length < DATABASE_PAGE_SIZE) {
      return rows;
    }
  }
};

const isAfterCursor = (item: ScheduledOutreachItemContract, cursor: CursorPayload): boolean =>
  item.send_at > cursor.send_at
  || (item.send_at === cursor.send_at && item.kind > cursor.kind)
  || (item.send_at === cursor.send_at && item.kind === cursor.kind && item.id > cursor.id);

const isAfterWindowedCursor = (item: ScheduledOutreachItemContract, cursor: WindowedCursorPayload): boolean =>
  item.send_at > cursor.send_at || (item.send_at === cursor.send_at && item.id > cursor.id);

const createWindow = (timeZone: string, now: Date): ScheduledSendsWindow => {
  const today = getCurrentLocalDate(timeZone, now);
  return {
    kind: "today_tomorrow",
    timezone: timeZone,
    startsAt: getStartOfLocalDayUtc(today, timeZone).toISOString(),
    endsAt: getStartOfLocalDayUtc(addDays(today, 2), timeZone).toISOString()
  };
};

const isWithinWindow = (item: ScheduledOutreachItemContract, window: ScheduledSendsWindow): boolean =>
  item.send_at >= window.startsAt && item.send_at < window.endsAt;

const getWindowCursorFilter = (
  userId: string,
  options: ListScheduledSendsOptions,
  window: ScheduledSendsWindow
): string => JSON.stringify({
  user_id: userId,
  status: options.status ?? "queued",
  kinds: [...(options.kinds ?? [])].sort(),
  window: window.kind,
  timezone: window.timezone,
  starts_at: window.startsAt,
  ends_at: window.endsAt
});

const loadAutomationSettings = async (userId: string): Promise<Map<string, boolean>> => {
  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("key, enabled")
    .eq("user_id", userId);

  handleSupabaseError(error, "Unable to load scheduled outreach automation settings");
  return new Map(((data ?? []) as Row[]).map((row) => [String(row.key ?? ""), row.enabled === true]));
};

const loadClients = async (userId: string, clientIds: string[]): Promise<Map<string, Row>> => {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (ids.length === 0) {
    return new Map();
  }

  const rows: Row[] = [];
  for (let index = 0; index < ids.length; index += LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(index, index + LOOKUP_BATCH_SIZE);
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, preferred_name, email, deleted_at")
      .eq("user_id", userId)
      .in("id", batch)
      .is("deleted_at", null);

    handleSupabaseError(error, "Unable to load scheduled outreach clients");
    rows.push(...((data ?? []) as Row[]));
  }

  return new Map(rows.map((row) => [String(row.id ?? ""), row]));
};

const loadAppointmentCandidates = async (
  userId: string,
  enabled: boolean,
  now: Date,
  window?: ScheduledSendsWindow
): Promise<{ appointments: Row[]; emailEvents: Row[]; suppressions: Set<string> }> => {
  if (!enabled) {
    return { appointments: [], emailEvents: [], suppressions: new Set() };
  }

  const [appointments, emailEvents] = await Promise.all([
    loadAllRows(
      (start, end) => {
        let query = supabaseAdmin
          .from("appointments")
          .select("id, user_id, client_id, appointment_date, service_name, status")
          .eq("user_id", userId)
          .in("status", ["pending", "scheduled"])
          .gt("appointment_date", now.toISOString());
        if (window) {
          query = query
            .gte("appointment_date", new Date(new Date(window.startsAt).getTime() + APPOINTMENT_REMINDER_LEAD_MS).toISOString())
            .lt("appointment_date", new Date(new Date(window.endsAt).getTime() + APPOINTMENT_REMINDER_LEAD_MS).toISOString());
        }
        return query
          .order("appointment_date", { ascending: true })
          .order("id", { ascending: true })
          .range(start, end);
      },
      "Unable to load future appointment reminders"
    ),
    loadAllRows(
      (start, end) => supabaseAdmin
        .from("appointment_email_events")
        .select("id, user_id, client_id, appointment_id, recipient_email, status, template_data, created_at")
        .eq("user_id", userId)
        .eq("email_type", "appointment_reminder")
        .in("status", ["queued", "sending"])
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(start, end),
      "Unable to load queued appointment reminder events"
    )
  ]);
  const suppressions = await appointmentReminderSuppressionsService.listForOccurrences(
    userId,
    appointments.map((row) => ({
      appointmentId: String(row.id ?? ""),
      appointmentStartAt: String(row.appointment_date ?? "")
    }))
  );

  return {
    appointments,
    emailEvents,
    suppressions
  };
};

const loadQueuedRows = async (
  userId: string,
  settings: Map<string, boolean>,
  now: Date,
  window?: ScheduledSendsWindow
) => {
  const [rebook, birthday, thankYou] = await Promise.all([
    settings.get("rebook_nudges") === true
      ? loadAllRows(
        (start, end) => {
          let query = supabaseAdmin
            .from("rebook_nudges")
            .select("id, client_id, last_appointment_id, recipient_email, status, send_after, template_data")
            .eq("user_id", userId)
            .eq("status", "queued")
            .eq("approval_required", false)
            .gte("send_after", window?.startsAt ?? now.toISOString());
          if (window) query = query.lt("send_after", window.endsAt);
          return query.order("send_after", { ascending: true }).order("id", { ascending: true }).range(start, end);
        },
        "Unable to load scheduled rebook nudges"
      )
      : Promise.resolve([]),
    settings.get("birthday_reminders") === true
      ? loadAllRows(
        (start, end) => {
          let query = supabaseAdmin
            .from("birthday_reminders")
            .select("id, client_id, recipient_email, status, scheduled_send_at, template_data")
            .eq("user_id", userId)
            .eq("status", "queued")
            .gte("scheduled_send_at", window?.startsAt ?? now.toISOString());
          if (window) query = query.lt("scheduled_send_at", window.endsAt);
          return query.order("scheduled_send_at", { ascending: true }).order("id", { ascending: true }).range(start, end);
        },
        "Unable to load scheduled birthday reminders"
      )
      : Promise.resolve([]),
    settings.get("thank_you_emails") === true
      ? loadAllRows(
        (start, end) => {
          let query = supabaseAdmin
            .from("thank_you_emails")
            .select("id, client_id, appointment_id, recipient_email, status, send_after, template_data")
            .eq("user_id", userId)
            .eq("status", "queued")
            .eq("approval_required", false)
            .gte("send_after", window?.startsAt ?? now.toISOString());
          if (window) query = query.lt("send_after", window.endsAt);
          return query.order("send_after", { ascending: true }).order("id", { ascending: true }).range(start, end);
        },
        "Unable to load scheduled thank you emails"
      )
      : Promise.resolve([])
  ]);
  return { rebook, birthday, thankYou };
};

const loadCampaignCandidates = async (userId: string): Promise<ScheduledOutreachItemContract[]> => {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("id, name, status, send_mode, scheduled_for, scheduled_at")
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .order("scheduled_at", { ascending: true })
    .order("id", { ascending: true });
  handleSupabaseError(error, "Unable to load scheduled campaigns");

  return ((data ?? []) as Row[]).flatMap((campaign): ScheduledOutreachItemContract[] => {
    const campaignId = getString(campaign, "id");
    const sendAt = getString(campaign, "scheduled_for") ?? getString(campaign, "scheduled_at");
    if (!campaignId || !sendAt) return [];
    return [{
      id: encodeResourceId({ version: 1, kind: "campaign", source_id: campaignId }),
      kind: "campaign",
      status: "queued",
      channel: "email",
      send_at: sendAt,
      recipient: null,
      appointment_id: null,
      campaign_id: campaignId,
      title: getString(campaign, "name") ?? "Campaign",
      context_label: campaign.send_mode === "now" ? "Send now" : "Scheduled campaign",
      can_cancel: true,
      cancel_scope: "single_send",
      allowed_actions: ["view_campaign", "cancel"]
    }];
  });
};

const isFeatureAvailable = (entitlements: UserEntitlements, kind: ScheduledOutreachKind): boolean => {
  if (entitlements.status === "cancelled") {
    return false;
  }

  if (kind === "rebook_nudge") return entitlements.features.rebookNudges;
  if (kind === "birthday_reminder") return entitlements.features.birthdayReminders;
  if (kind === "thank_you_email") return entitlements.features.thankYouEmails;
  return true;
};

const toAppointmentCandidates = (
  source: Awaited<ReturnType<typeof loadAppointmentCandidates>>,
  clients: Map<string, Row>,
  now: Date
): ScheduledSendCandidate[] => {
  const eventsByOccurrence = new Map<string, Row>();
  for (const event of source.emailEvents) {
    const templateData = (event.template_data ?? {}) as Row;
    const appointmentStartAt = getString(templateData, "appointment_start_time");
    const appointmentId = getString(event, "appointment_id");
    if (appointmentId && appointmentStartAt) {
      eventsByOccurrence.set(`${appointmentId}:${appointmentStartAt}`, event);
    }
  }

  return source.appointments.flatMap((appointment) => {
    const appointmentId = getString(appointment, "id");
    const appointmentStartAt = getString(appointment, "appointment_date");
    const clientId = getString(appointment, "client_id");
    if (!appointmentId || !appointmentStartAt || !clientId) {
      return [];
    }

    const occurrenceKey = `${appointmentId}:${appointmentStartAt}`;
    if (source.suppressions.has(occurrenceKey)) {
      return [];
    }

    const event = eventsByOccurrence.get(occurrenceKey);
    const sendAt = new Date(new Date(appointmentStartAt).getTime() - APPOINTMENT_REMINDER_LEAD_MS).toISOString();
    if (!event && sendAt < now.toISOString()) {
      return [];
    }

    const client = clients.get(clientId);
    const resourceId = encodeResourceId({
      version: 1,
      kind: "appointment_reminder",
      source_id: appointmentId,
      occurrence_at: appointmentStartAt
    });

    return [{
      id: resourceId,
      kind: "appointment_reminder",
      status: event?.status === "sending" ? "sending" : "queued",
      channel: "email",
      send_at: sendAt,
      recipient: { client_id: clientId, display_name: getClientDisplayName(client) },
      appointment_id: appointmentId,
      campaign_id: null,
      title: "Appointment reminder",
      context_label: getString(appointment, "service_name"),
      can_cancel: event?.status !== "sending",
      cancel_scope: "single_send",
      allowed_actions: event?.status === "sending"
        ? ["view_appointment", "view_client"]
        : ["view_appointment", "view_client", "cancel"],
      eligibility_client_id: clientId,
      eligibility_to: getString(event, "recipient_email") ?? getString(client, "email"),
      eligibility_message_type: "appointment_reminder"
    } satisfies ScheduledSendCandidate];
  });
};

const toWorkflowCandidate = (
  kind: "rebook_nudge" | "birthday_reminder" | "thank_you_email",
  row: Row,
  clients: Map<string, Row>
): ScheduledSendCandidate | null => {
  const sourceId = getString(row, "id");
  const clientId = getString(row, "client_id");
  const sendAt = kind === "birthday_reminder"
    ? getString(row, "scheduled_send_at")
    : getString(row, "send_after");
  if (!sourceId || !clientId || !sendAt) {
    return null;
  }

  const client = clients.get(clientId);
  const appointmentId = kind === "thank_you_email"
    ? getString(row, "appointment_id")
    : kind === "rebook_nudge"
      ? getString(row, "last_appointment_id")
      : null;
  const title = kind === "rebook_nudge"
    ? "Rebook reminder"
    : kind === "birthday_reminder"
      ? "Birthday message"
      : "Thank-you email";
  const messageType: MessageType = kind === "rebook_nudge"
    ? "rebooking_prompt"
    : kind === "birthday_reminder"
      ? "birthday_reminder"
      : "marketing";

  return {
    id: encodeResourceId({ version: 1, kind, source_id: sourceId }),
    kind,
    status: "queued",
    channel: "email",
    send_at: sendAt,
    recipient: { client_id: clientId, display_name: getClientDisplayName(client) },
    appointment_id: appointmentId,
    campaign_id: null,
    title,
    context_label: null,
    can_cancel: true,
    cancel_scope: "single_send",
    allowed_actions: appointmentId
      ? ["view_appointment", "view_client", "cancel"]
      : ["view_client", "cancel"],
    eligibility_client_id: clientId,
    eligibility_to: getString(row, "recipient_email") ?? getString(client, "email"),
    eligibility_message_type: messageType
  };
};

const filterEligible = async (userId: string, candidates: ScheduledSendCandidate[]) => {
  const eligibility = new Map<string, Awaited<ReturnType<typeof communicationPreferencesService.canSendCommunicationsReadOnly>> extends Map<string, infer Value> ? Value : never>();
  for (let index = 0; index < candidates.length; index += LOOKUP_BATCH_SIZE) {
    const batch = candidates.slice(index, index + LOOKUP_BATCH_SIZE);
    const batchEligibility = await communicationPreferencesService.canSendCommunicationsReadOnly(
      userId,
      batch.map((candidate) => ({
        id: candidate.id,
        clientId: candidate.eligibility_client_id,
        channel: candidate.channel,
        to: candidate.eligibility_to,
        messageType: candidate.eligibility_message_type
      }))
    );
    batchEligibility.forEach((value, key) => eligibility.set(key, value));
  }

  return candidates.flatMap((candidate) => {
    if (eligibility.get(candidate.id)?.canSend !== true) {
      return [];
    }

    const {
      eligibility_client_id: _clientId,
      eligibility_to: _to,
      eligibility_message_type: _messageType,
      ...item
    } = candidate;
    return [item];
  });
};

export const outreachScheduledSendsService = {
  encodeResourceId,
  decodeResourceId: decodeScheduledSendResourceId,

  fromLegacyDashboardQueue(rows: Row[], limit = 3): ScheduledOutreachListContract {
    const normalized = rows.flatMap((row): ScheduledOutreachItemContract[] => {
      const automationKey = getString(row, "automation_key");
      const sourceId = getString(row, "reminder_id");
      const sendAt = getString(row, "send_at");
      const clientId = getString(row, "client_id");
      const displayName = getString(row, "client_name") ?? "Client";
      if (!sourceId || !sendAt) {
        return [];
      }

      const kind: Exclude<ScheduledOutreachKind, "campaign"> | null = automationKey === "appointment_reminders"
        ? "appointment_reminder"
        : automationKey === "rebook_nudges"
          ? "rebook_nudge"
          : automationKey === "birthday_reminders"
            ? "birthday_reminder"
            : automationKey === "thank_you_emails"
              ? "thank_you_email"
              : null;
      if (!kind) {
        return [];
      }

      const appointmentId = getString(row, "appointment_id");
      const occurrenceAt = kind === "appointment_reminder"
        ? getString(row, "appointment_start_time")
        : undefined;
      const cancellable = kind !== "appointment_reminder" || Boolean(appointmentId && occurrenceAt);
      const resourceSourceId = kind === "appointment_reminder" ? appointmentId : sourceId;
      if (!resourceSourceId) {
        return [];
      }

      const title = kind === "appointment_reminder"
        ? "Appointment reminder"
        : kind === "rebook_nudge"
          ? "Rebook reminder"
          : kind === "birthday_reminder"
            ? "Birthday message"
            : "Thank-you email";

      return [{
        id: encodeResourceId({
          version: 1,
          kind,
          source_id: resourceSourceId,
          ...(occurrenceAt ? { occurrence_at: occurrenceAt } : {})
        }),
        kind,
        status: row.status === "sending" ? "sending" : "queued",
        channel: row.channel === "sms" ? "sms" : "email",
        send_at: sendAt,
        recipient: clientId ? { client_id: clientId, display_name: displayName } : null,
        appointment_id: appointmentId,
        campaign_id: null,
        title,
        context_label: null,
        can_cancel: cancellable && row.status !== "sending",
        cancel_scope: cancellable ? "single_send" : null,
        allowed_actions: [
          ...(appointmentId ? ["view_appointment" as const] : []),
          ...(clientId ? ["view_client" as const] : []),
          ...(cancellable && row.status !== "sending" ? ["cancel" as const] : [])
        ]
      }];
    }).sort(compareItems);

    return {
      data: normalized.slice(0, limit),
      next_cursor: normalized.length > limit && normalized[limit - 1]
        ? encodeCursor(normalized[limit - 1] as ScheduledOutreachItemContract)
        : null,
      total_count: normalized.length
    };
  },

  async listForUser(userId: string, options: ListScheduledSendsOptions): Promise<ScheduledOutreachListContract> {
    const now = options.now ?? new Date();
    const timeZone = options.window ? await businessTimeZoneService.getForUser(userId) : null;
    const window = options.window && timeZone ? createWindow(timeZone, now) : undefined;
    const [settings, entitlements, campaigns] = await Promise.all([
      loadAutomationSettings(userId),
      entitlementsService.getEntitlementsForUser(userId),
      loadCampaignCandidates(userId)
    ]);
    const appointmentSource = await loadAppointmentCandidates(
      userId,
      settings.get("appointment_reminders") === true,
      now,
      window
    );
    const workflowRows = await loadQueuedRows(userId, settings, now, window);
    const clientIds = [
      ...appointmentSource.appointments,
      ...workflowRows.rebook,
      ...workflowRows.birthday,
      ...workflowRows.thankYou
    ].map((row) => getString(row, "client_id")).filter((id): id is string => Boolean(id));
    const clients = await loadClients(userId, clientIds);
    const candidates = [
      ...toAppointmentCandidates(appointmentSource, clients, now),
      ...workflowRows.rebook.map((row) => toWorkflowCandidate("rebook_nudge", row, clients)),
      ...workflowRows.birthday.map((row) => toWorkflowCandidate("birthday_reminder", row, clients)),
      ...workflowRows.thankYou.map((row) => toWorkflowCandidate("thank_you_email", row, clients))
    ].filter((item): item is ScheduledSendCandidate => item !== null)
      .filter((item) => isFeatureAvailable(entitlements, item.kind));
    const eligible = [...(await filterEligible(userId, candidates)), ...campaigns]
      .filter((item) => !options.status || item.status === options.status)
      .filter((item) => !options.kinds || options.kinds.includes(item.kind))
      .filter((item) => !window || isWithinWindow(item, window))
      .sort(window ? compareWindowedItems : compareItems);
    const totalCount = eligible.length;
    const cursorFilter = window ? getWindowCursorFilter(userId, options, window) : null;
    const cursor = options.cursor
      ? window
        ? decodeWindowedCursor(options.cursor, cursorFilter as string)
        : decodeCursor(options.cursor)
      : null;
    const remaining = cursor
      ? window
        ? eligible.filter((item) => isAfterWindowedCursor(item, cursor as WindowedCursorPayload))
        : eligible.filter((item) => isAfterCursor(item, cursor as CursorPayload))
      : eligible;
    const data = remaining.slice(0, options.limit);

    return {
      data,
      next_cursor: remaining.length > options.limit && data.length > 0
        ? window
          ? encodeWindowedCursor(data[data.length - 1] as ScheduledOutreachItemContract, cursorFilter as string)
          : encodeCursor(data[data.length - 1] as ScheduledOutreachItemContract)
        : null,
      total_count: totalCount,
      ...(window ? {
        category_counts: {
          reminders: eligible.filter((item) => item.kind === "appointment_reminder" || item.kind === "birthday_reminder").length,
          outreach: eligible.filter((item) => item.kind === "rebook_nudge" || item.kind === "thank_you_email").length,
          campaigns: eligible.filter((item) => item.kind === "campaign").length
        },
        window: {
          kind: window.kind,
          timezone: window.timezone,
          starts_at: window.startsAt,
          ends_at: window.endsAt
        }
      } : {})
    };
  },

  async cancelForUser(userId: string, resourceId: string, reason?: string | null): Promise<Row> {
    const resource = decodeScheduledSendResourceId(resourceId);
    switch (resource.kind) {
      case "appointment_reminder":
        if (!resource.occurrence_at) {
          throw new ApiError(400, "Appointment reminder occurrence is missing");
        }
        return appointmentReminderSuppressionsService.cancelOccurrence(
          userId,
          resource.source_id,
          resource.occurrence_at,
          reason
        );
      case "rebook_nudge":
        return rebookNudgesService.cancelForUser(userId, resource.source_id, reason);
      case "birthday_reminder":
        return birthdayRemindersService.cancelForUser(userId, resource.source_id, reason);
      case "thank_you_email":
        return thankYouEmailsService.cancelForUser(userId, resource.source_id, reason);
      case "campaign":
        return campaignSubmissionService.cancelForUser(userId, resource.source_id, reason);
    }
  }
};
