/**
 * Provider-neutral SMS template taxonomy. Rendering, persistence, queueing, and
 * provider dispatch deliberately live in separate layers.
 */
export const smsTemplateTypes = ["appointment_reminder"] as const;

export type SmsTemplateType = typeof smsTemplateTypes[number];

export interface SmsTemplateDefinition {
  type: SmsTemplateType;
  channel: "sms";
  description: string;
  requiredInputs: readonly string[];
  optionalInputs: readonly string[];
  defaultBodies: {
    withService: string;
    withoutService: string;
  };
}

export const appointmentReminderSmsTemplateTokens = [
  "businessName",
  "clientFirstName",
  "appointmentDateTime",
  "serviceName",
  "bookingManagementUrl"
] as const;

export type AppointmentReminderSmsTemplateToken = typeof appointmentReminderSmsTemplateTokens[number];

/** Preformatted display values keep date/timezone formatting outside the SMS template layer. */
export interface AppointmentReminderSmsTemplateInput {
  businessName: string;
  clientFirstName: string;
  appointmentDateTime: string;
  serviceName?: string | null;
  /** Optional public booking-management URL; a future renderer decides whether it fits safely. */
  bookingManagementUrl?: string | null;
}

export const smsTemplateDefinitions: Record<SmsTemplateType, SmsTemplateDefinition> = {
  appointment_reminder: {
    type: "appointment_reminder",
    channel: "sms",
    description: "Reminder sent before a scheduled appointment.",
    requiredInputs: ["businessName", "clientFirstName", "appointmentDateTime"],
    optionalInputs: ["serviceName", "bookingManagementUrl"],
    defaultBodies: {
      withService: "{{businessName}}: Hi {{clientFirstName}}, reminder: your {{serviceName}} is {{appointmentDateTime}}. Reply STOP to opt out.",
      withoutService: "{{businessName}}: Hi {{clientFirstName}}, reminder: your appointment is {{appointmentDateTime}}. Reply STOP to opt out."
    }
  }
};

export const isSmsTemplateType = (value: unknown): value is SmsTemplateType =>
  typeof value === "string" && (smsTemplateTypes as readonly string[]).includes(value);
