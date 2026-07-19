export const CAMPAIGN_LIFECYCLE_STATUSES = ["draft", "scheduled", "sending", "completed"] as const;
export const CAMPAIGN_EXCEPTION_STATUSES = ["partially_failed", "failed", "cancelled"] as const;
export const CAMPAIGN_STATUSES = [
  ...CAMPAIGN_LIFECYCLE_STATUSES,
  ...CAMPAIGN_EXCEPTION_STATUSES
] as const;

export const CAMPAIGN_KINDS = ["one_time"] as const;
export const CAMPAIGN_SEND_MODES = ["now", "scheduled"] as const;
export const CAMPAIGN_LINK_TYPES = ["booking_link", "referral_link"] as const;
export const CAMPAIGN_AUDIENCE_MODES = ["everyone", "specific"] as const;
export const CAMPAIGN_PERSONALIZATION_TOKENS = ["first_name"] as const;
export const CAMPAIGN_RECIPIENT_EXCLUSION_REASONS = [
  "missing_email",
  "invalid_email",
  "email_marketing_disabled",
  "globally_unsubscribed",
  "client_deleted",
  "duplicate_recipient",
  "not_owned_or_not_found"
] as const;

export const SCHEDULED_OUTREACH_KINDS = [
  "appointment_reminder",
  "rebook_nudge",
  "thank_you_email",
  "birthday_reminder",
  "campaign"
] as const;
export const SCHEDULED_OUTREACH_STATUSES = [
  "queued",
  "sending",
  "sent",
  "cancelled",
  "skipped",
  "failed"
] as const;
export const OUTREACH_CHANNELS = ["email", "sms"] as const;
export const SCHEDULED_OUTREACH_CANCEL_SCOPES = ["single_send"] as const;
export const SCHEDULED_OUTREACH_ACTIONS = [
  "view_appointment",
  "view_client",
  "view_campaign",
  "cancel"
] as const;

export const OUTREACH_AUTOMATION_KEYS = [
  "rebook_nudges",
  "appointment_reminders",
  "email_confirmations",
  "no_show_follow_up",
  "waitlist_match",
  "birthday_reminders",
  "thank_you_emails"
] as const;
export const OUTREACH_AUTOMATION_MODES = ["automatic", "approval_required"] as const;

export const CAMPAIGN_NAME_MAX_LENGTH = 60;
export const CAMPAIGN_SUBJECT_MAX_LENGTH = 100;
export const CAMPAIGN_MESSAGE_MAX_LENGTH = 2_000;
export const CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES = 5;
export const CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS = 12;
export const CAMPAIGN_ATTRIBUTION_WINDOW_DAYS = 30;
export const CAMPAIGN_MISSING_FIRST_NAME_FALLBACK = "there";

export type CampaignLifecycleStatus = (typeof CAMPAIGN_LIFECYCLE_STATUSES)[number];
export type CampaignExceptionStatus = (typeof CAMPAIGN_EXCEPTION_STATUSES)[number];
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];
export type CampaignSendMode = (typeof CAMPAIGN_SEND_MODES)[number];
export type CampaignLinkType = (typeof CAMPAIGN_LINK_TYPES)[number];
export type CampaignAudienceMode = (typeof CAMPAIGN_AUDIENCE_MODES)[number];
export type CampaignPersonalizationToken = (typeof CAMPAIGN_PERSONALIZATION_TOKENS)[number];
export type CampaignRecipientExclusionReason = (typeof CAMPAIGN_RECIPIENT_EXCLUSION_REASONS)[number];
export type ScheduledOutreachKind = (typeof SCHEDULED_OUTREACH_KINDS)[number];
export type ScheduledOutreachStatus = (typeof SCHEDULED_OUTREACH_STATUSES)[number];
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
export type ScheduledOutreachCancelScope = (typeof SCHEDULED_OUTREACH_CANCEL_SCOPES)[number];
export type ScheduledOutreachAction = (typeof SCHEDULED_OUTREACH_ACTIONS)[number];
export type OutreachAutomationKey = (typeof OUTREACH_AUTOMATION_KEYS)[number];
export type OutreachAutomationMode = (typeof OUTREACH_AUTOMATION_MODES)[number];

export interface CampaignAudienceContract {
  mode: CampaignAudienceMode;
  client_ids: string[];
}

export interface CampaignContentContract {
  subject: string;
  message: string;
}

export interface CampaignDraftContract {
  id: string;
  status: "draft";
  campaign_kind: "one_time";
  revision: number;
  name: string | null;
  send_mode: CampaignSendMode;
  send_at: string | null;
  timezone: string;
  link_type: CampaignLinkType | null;
  template_id: string | null;
  template_version: number | null;
  audience: CampaignAudienceContract;
  content: {
    subject: string | null;
    message: string | null;
  };
  created_at: string;
  updated_at: string;
}

export interface ScheduledOutreachRecipientContract {
  client_id: string;
  display_name: string;
}

export interface ScheduledOutreachItemContract {
  id: string;
  kind: ScheduledOutreachKind;
  status: ScheduledOutreachStatus;
  channel: OutreachChannel;
  send_at: string;
  recipient: ScheduledOutreachRecipientContract | null;
  appointment_id: string | null;
  campaign_id: string | null;
  title: string;
  context_label: string | null;
  can_cancel: boolean;
  cancel_scope: ScheduledOutreachCancelScope | null;
  allowed_actions: ScheduledOutreachAction[];
}

export interface ScheduledOutreachListContract {
  data: ScheduledOutreachItemContract[];
  next_cursor: string | null;
  total_count?: number;
}

export interface OutreachAutomationControlContract {
  key: OutreachAutomationKey;
  label: string;
  enabled: boolean;
  feature_available: boolean;
  unavailable_reason: string | null;
  mode: OutreachAutomationMode | null;
  pending_approval_count: number;
  queued_count: number;
  scheduled_count: number;
  status_label: string;
  settings_version: number | null;
  channels: {
    email: OutreachAutomationChannelCapability;
    sms: OutreachAutomationChannelCapability;
  };
  timing: Record<string, number | boolean | null>;
  settings: Record<string, unknown>;
  content_rules: OutreachAutomationContentRules | null;
  templates: OutreachAutomationTemplateContract[];
  mutation: OutreachAutomationMutationContract | null;
}

export interface OutreachAutomationChannelCapability {
  available: boolean;
  enabled: boolean;
  unavailable_reason: string | null;
}

export interface OutreachAutomationContentRules {
  subject_max_length: number;
  message_max_length: number;
  available_tokens: string[];
}

export interface OutreachAutomationTemplateContract {
  emailType: string;
  subjectTemplate: string | null;
  customMessageBlock: string | null;
  configured: boolean;
  availableTokens: string[];
  mutation: OutreachAutomationMutationContract;
}

export interface OutreachAutomationMutationContract {
  method: "PATCH";
  path: string;
}

export interface OutreachAutomationsContract {
  account_timezone: string;
  summary: {
    enabled_count: number;
    available_count: number;
    total_count: number;
  };
  controls: OutreachAutomationControlContract[];
  customers_reached: {
    unique_clients: number;
    window_start: string;
    window_end: string;
    timezone: string;
    window_kind: "rolling";
    window_days: number;
    included_message_types: string[];
  };
}
