import type {
  OutreachAutomationControlContract,
  OutreachAutomationKey,
  OutreachAutomationsContract
} from "../lib/outreachContracts";
import type { PlanFeatureKey, UserEntitlements } from "../lib/plans";
import { supabaseAdmin } from "../lib/supabase";
import {
  appointmentEmailTemplatesService,
  type CustomizableAppointmentEmailType
} from "./appointmentEmailTemplatesService";
import { birthdayReminderSettingsService } from "./birthdayReminderSettingsService";
import { birthdayRemindersService } from "./birthdayRemindersService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { customersReachedService } from "./customersReachedService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";
import { outreachScheduledSendsService } from "./outreachScheduledSendsService";
import { rebookNudgeSettingsService } from "./rebookNudgeSettingsService";
import { rebookNudgesService } from "./rebookNudgesService";
import { thankYouEmailSettingsService } from "./thankYouEmailSettingsService";
import { thankYouEmailsService } from "./thankYouEmailsService";

const SMS_UNAVAILABLE_REASON = "Outbound SMS is not available yet.";
const FEATURE_UNAVAILABLE_REASON = "This automation is not available for the current plan.";
const SUBJECT_MAX_LENGTH = 160;
const MESSAGE_MAX_LENGTH = 4_000;

const controls = [
  "email_confirmations",
  "appointment_reminders",
  "rebook_nudges",
  "thank_you_emails",
  "birthday_reminders",
  "waitlist_match"
] as const;

const labels: Record<(typeof controls)[number], string> = {
  email_confirmations: "Email Confirmations",
  appointment_reminders: "Appointment Reminders",
  rebook_nudges: "Rebook Nudges",
  thank_you_emails: "Thank You Emails",
  birthday_reminders: "Birthday Reminders",
  waitlist_match: "Waitlist Match"
};

const features: Partial<Record<(typeof controls)[number], PlanFeatureKey>> = {
  rebook_nudges: "rebookNudges",
  thank_you_emails: "thankYouEmails",
  birthday_reminders: "birthdayReminders",
  waitlist_match: "waitlistMatch"
};

const featureAvailable = (entitlements: UserEntitlements, key: (typeof controls)[number]): boolean => {
  const feature = features[key];
  return entitlements.status !== "cancelled" && (!feature || entitlements.features[feature]);
};

const contentRules = (tokens: readonly string[]) => ({
  subject_max_length: SUBJECT_MAX_LENGTH,
  message_max_length: MESSAGE_MAX_LENGTH,
  available_tokens: [...tokens]
});

const channels = (available: boolean, enabled: boolean) => ({
  email: {
    available,
    enabled: available && enabled,
    unavailable_reason: available ? null : FEATURE_UNAVAILABLE_REASON
  },
  sms: { available: false, enabled: false, unavailable_reason: SMS_UNAVAILABLE_REASON }
});

const statusLabel = (available: boolean, enabled: boolean, pending: number, queued: number): string => {
  if (!available) return "Upgrade required";
  if (!enabled) return "Off";
  if (pending > 0) return `${pending} need approval`;
  return queued > 0 ? `${queued} queued` : "On";
};

export const outreachAutomationsService = {
  async getForUser(userId: string): Promise<OutreachAutomationsContract> {
    const [timezone, entitlements, settingsResult, rebookSettings, birthdaySettings, thankYouSettings, templates] =
      await Promise.all([
        businessTimeZoneService.getForUser(userId),
        entitlementsService.getEntitlementsForUser(userId),
        supabaseAdmin.from("automation_settings").select("key, enabled, updated_at").eq("user_id", userId),
        rebookNudgeSettingsService.getRawForUser(userId),
        birthdayReminderSettingsService.getRawForUser(userId),
        thankYouEmailSettingsService.getRawForUser(userId),
        appointmentEmailTemplatesService.getForUser(userId)
      ]);
    handleSupabaseError(settingsResult.error, "Unable to load outreach automation settings");

    const settings = new Map(((settingsResult.data ?? []) as Row[]).map((row) => [String(row.key), row]));
    const enabled = (key: string) => settings.get(key)?.enabled === true;
    const [rebookCounts, birthdayCounts, thankYouCounts, appointmentScheduled, customersReached] = await Promise.all([
      rebookNudgesService.getCountsForUser(userId),
      birthdayRemindersService.getCountsForUser(userId),
      thankYouEmailsService.getCountsForUser(userId),
      outreachScheduledSendsService.listForUser(userId, {
        status: "queued", kinds: ["appointment_reminder"], limit: 1
      }),
      customersReachedService.getForUser(userId, timezone)
    ]);

    const templatesByType = new Map(templates.map((template) => [template.emailType, template]));
    const template = (emailType: CustomizableAppointmentEmailType) => {
      const value = templatesByType.get(emailType);
      return value ? [{
        ...value,
        mutation: { method: "PATCH" as const, path: `/api/settings/email-templates/${emailType}` }
      }] : [];
    };
    const appointmentTokens = appointmentEmailTemplatesService.availableTemplateTokens;

    const build = (
      key: (typeof controls)[number],
      options: Partial<OutreachAutomationControlContract> = {}
    ): OutreachAutomationControlContract => {
      const available = featureAvailable(entitlements, key);
      const isEnabled = available && enabled(key);
      const pending = options.pending_approval_count ?? 0;
      const queued = options.queued_count ?? 0;
      return {
        key: key as OutreachAutomationKey,
        label: labels[key],
        enabled: isEnabled,
        feature_available: available,
        unavailable_reason: available ? null : FEATURE_UNAVAILABLE_REASON,
        mode: null,
        pending_approval_count: pending,
        queued_count: queued,
        scheduled_count: options.scheduled_count ?? queued,
        status_label: statusLabel(available, isEnabled, pending, queued),
        settings_version: null,
        channels: channels(available, isEnabled),
        timing: {},
        settings: {},
        content_rules: null,
        templates: [],
        mutation: { method: "PATCH", path: `/api/activity/automation/settings/${key}` },
        ...options
      };
    };

    const resultControls: OutreachAutomationControlContract[] = [
      build("email_confirmations", {
        templates: (["appointment_scheduled", "appointment_pending", "appointment_confirmed"] as const).flatMap(template),
        content_rules: contentRules(appointmentTokens)
      }),
      build("appointment_reminders", {
        queued_count: appointmentScheduled.total_count ?? 0,
        scheduled_count: appointmentScheduled.total_count ?? 0,
        timing: { lead_time_minutes: 1_440, lead_time_editable: false },
        settings: { leadTimeMinutes: 1_440, individualCancellationSupported: true },
        templates: template("appointment_reminder"),
        content_rules: contentRules(appointmentTokens)
      }),
      build("rebook_nudges", {
        mode: rebookSettings?.approval_required === false ? "automatic" : "approval_required",
        pending_approval_count: rebookCounts.pending_approval,
        queued_count: rebookCounts.queued,
        scheduled_count: rebookCounts.queued,
        timing: {
          default_interval_days: Number(rebookSettings?.default_rebook_interval_days ?? rebookNudgeSettingsService.defaultIntervalDays),
          minimum_interval_days: 1,
          maximum_interval_days: 730
        },
        settings: {
          approvalRequired: rebookSettings?.approval_required !== false,
          defaultRebookIntervalDays: Number(rebookSettings?.default_rebook_interval_days ?? rebookNudgeSettingsService.defaultIntervalDays),
          subjectTemplate: typeof rebookSettings?.subject_template === "string" ? rebookSettings.subject_template : null,
          customMessageBlock: typeof rebookSettings?.custom_message_block === "string" ? rebookSettings.custom_message_block : null,
          configured: Boolean(rebookSettings),
          availableTokens: [...rebookNudgeSettingsService.availableTemplateTokens]
        },
        content_rules: contentRules(rebookNudgeSettingsService.availableTemplateTokens),
        mutation: { method: "PATCH", path: "/api/settings/rebook-nudges" }
      }),
      build("thank_you_emails", {
        mode: thankYouSettings?.approval_required === false ? "automatic" : "approval_required",
        pending_approval_count: thankYouCounts.pending_approval,
        queued_count: thankYouCounts.queued,
        scheduled_count: thankYouCounts.queued,
        timing: {
          send_delay_hours: Number(thankYouSettings?.send_delay_hours ?? thankYouEmailSettingsService.defaultSendDelayHours),
          minimum_send_delay_hours: 0,
          maximum_send_delay_hours: 720
        },
        settings: {
          approvalRequired: thankYouSettings?.approval_required !== false,
          sendDelayHours: Number(thankYouSettings?.send_delay_hours ?? thankYouEmailSettingsService.defaultSendDelayHours),
          subjectTemplate: typeof thankYouSettings?.subject_template === "string" ? thankYouSettings.subject_template : null,
          customMessageBlock: typeof thankYouSettings?.custom_message_block === "string" ? thankYouSettings.custom_message_block : null,
          configured: Boolean(thankYouSettings),
          availableTokens: [...thankYouEmailSettingsService.availableTemplateTokens]
        },
        content_rules: contentRules(thankYouEmailSettingsService.availableTemplateTokens),
        mutation: { method: "PATCH", path: "/api/settings/thank-you-emails" }
      }),
      build("birthday_reminders", {
        mode: birthdaySettings?.approval_required === false ? "automatic" : "approval_required",
        pending_approval_count: birthdayCounts.pending_approval,
        queued_count: birthdayCounts.queued,
        scheduled_count: birthdayCounts.queued,
        settings: { approvalRequired: birthdaySettings?.approval_required !== false, configured: Boolean(birthdaySettings) },
        templates: template("birthday_reminder"),
        content_rules: contentRules(appointmentTokens),
        mutation: { method: "PATCH", path: "/api/settings/birthday-reminders" }
      }),
      build("waitlist_match")
    ];

    return {
      account_timezone: timezone,
      summary: {
        enabled_count: resultControls.filter((control) => control.enabled).length,
        available_count: resultControls.filter((control) => control.feature_available).length,
        total_count: resultControls.length
      },
      controls: resultControls,
      customers_reached: customersReached
    };
  }
};
