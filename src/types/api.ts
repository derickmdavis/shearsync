import type { ActivityType } from "../lib/activityTypes";

export { ACTIVITY_TYPES, isActivityType } from "../lib/activityTypes";
export type { ActivityType } from "../lib/activityTypes";

export type AppointmentStatus = "pending" | "scheduled" | "completed" | "cancelled" | "no_show";
export type BookingSource = "public" | "internal";
export type ReminderStatus = "open" | "done" | "dismissed" | "sent";
export type ReminderChannel = "sms" | "email";
export type ReminderType = "appointment_reminder" | "follow_up" | "general";
export type PhotoType = "before" | "after" | "inspiration" | "other";
export type BookingSettingsMaxReschedules = number | "unlimited";
export type AvailabilityClientAudience = "all" | "new" | "returning";

export interface BookingCreatedActivityMetadata {
  client_name: string;
  service_name: string;
  appointment_start_time: string;
  current_appointment_status?: AppointmentStatus;
}

export interface AppointmentCancelledActivityMetadata {
  client_name: string;
  service_name: string;
  appointment_start_time: string;
  cancelled_by: "client" | "stylist";
}

export interface AppointmentRescheduledActivityMetadata {
  client_name: string;
  service_name: string;
  old_start_time: string;
  new_start_time: string;
}

export interface ReminderSentActivityMetadata {
  client_name: string;
  channel: ReminderChannel;
  reminder_type: ReminderType;
  appointment_start_time: string | null;
}

export type ActivityEventMetadata =
  | BookingCreatedActivityMetadata
  | AppointmentCancelledActivityMetadata
  | AppointmentRescheduledActivityMetadata
  | ReminderSentActivityMetadata;

export interface AuthUser {
  id: string;
  email?: string;
}

export interface RequestAuth {
  userId: string;
  email?: string;
  source: "jwt" | "dev";
}

export interface BookingSettings {
  leadTimeHours: number;
  sameDayBookingAllowed: boolean;
  sameDayBookingCutoff: string;
  maxBookingWindowDays: number;
  cancellationWindowHours: number;
  lateCancellationFeeEnabled: boolean;
  lateCancellationFeeType: "flat" | "percent";
  lateCancellationFeeValue: number;
  allowCancellationAfterCutoff: boolean;
  rescheduleWindowHours: number;
  maxReschedules: BookingSettingsMaxReschedules;
  sameDayReschedulingAllowed: boolean;
  preserveAppointmentHistory: boolean;
  newClientApprovalRequired: boolean;
  newClientBookingWindowDays: number;
  restrictServicesForNewClients: boolean;
  restrictedServiceIds: string[];
}

export interface ServiceCatalogItem {
  id: string;
  name: string;
  duration: number;
  durationMinutes: number;
  price: number;
  priceAmount: number;
  visible: boolean;
  category?: string;
  description?: string;
  isDefault: boolean;
  sortOrder: number;
}

export interface OffDay {
  id: string;
  date: string;
  label: string | null;
  reason: string | null;
  isRecurring: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileOverviewMetric {
  id: string;
  label: string;
  value: string;
  change: string;
  detail: string;
}

export type ProfileOverviewPeriod = "week" | "month";

export interface ProfileOverviewChartBar {
  label: string;
  value: number;
  highlighted: boolean;
}

export interface ProfileOverviewDaySummary {
  day: string;
  hours: string;
}

export interface AvailabilityWindowInput {
  startTime: string;
  endTime: string;
  clientAudience: AvailabilityClientAudience;
}

export interface AvailabilityDaySettings {
  dayOfWeek: number;
  isOpen: boolean;
  windows: AvailabilityWindowInput[];
}

export interface AvailabilitySettingsResponse {
  timezone: string;
  days: AvailabilityDaySettings[];
}

export interface ProfileOverviewResponse {
  avatarImageId: string | null;
  profile: {
    displayName: string;
    planLabel: string;
    locationLabel: string;
  };
  hero: {
    title: string;
    rangeLabel: string;
    value: string;
    appointmentCount: number;
    appointmentCountLabel: string;
    trendLabel: string;
    comparisonLabel: string;
    chartBars: ProfileOverviewChartBar[];
  };
  performance: {
    period: ProfileOverviewPeriod;
    periodLabel: string;
    metrics: ProfileOverviewMetric[];
  };
  availability: ProfileOverviewDaySummary[];
  availabilitySettings: AvailabilitySettingsResponse;
  settingsSummary: {
    booking: {
      badge: string;
      detail: string;
    };
    services: {
      badge: string;
      detail: string;
    };
    messaging: {
      badge: string;
      detail: string;
    };
    business: {
      detail: string;
    };
    account: {
      detail: string;
    };
  };
  services: Array<{
    id: string;
    name: string;
    duration: string;
    price: string;
  }>;
  bookingRules: string[];
  messagingSettings: string[];
  metrics: ProfileOverviewMetric[];
  revenueForecast: {
    nextWeek: string;
    nextMonth: string;
  };
  chartPoints: Array<{
    label: string;
    revenue: number;
    appointments: number;
  }>;
}

export interface PublicBookingConfirmation {
  appointment_id: string;
  client_id: string;
  stylist_slug: string;
  stylist_display_name: string;
  business_name: string | null;
  service_id: string;
  service_name: string;
  service_duration_minutes: number;
  service_price: number;
  appointment_date: string;
  appointment_end: string;
  business_timezone: string;
  status: AppointmentStatus;
}

export interface PublicBookingIntakeResponse {
  matchStatus: "matched" | "not_found" | "ambiguous";
  clientFound: boolean;
  isExistingClient: boolean;
  bookingContextToken: string;
  bookingEnabled: boolean;
  candidateCount?: number;
  client: {
    id?: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phoneMasked: string;
  };
  submittedContact: {
    fullName: string;
    phoneNormalized: string;
    email: string | null;
  };
  recommendedService: {
    serviceId: string;
    serviceName: string;
    reason: "last_completed_service" | "last_booked_service" | "default_service";
  } | null;
  bookingBehavior: {
    requiresApproval: boolean;
    restrictedToNewClientRules: boolean;
    canUseReturningClientRules: boolean;
    message: string;
  };
  nextStep?: "collect_email_or_name";
}

export interface PublicStylistProfile {
  id: string;
  slug: string;
  display_name: string;
  bio: string | null;
  cover_photo_url: string | null;
  booking_enabled: boolean;
  business_name: string | null;
  phone_number: string | null;
  timezone: string;
}

export interface PublicAvailabilitySlot {
  start: string;
  end: string;
}

export interface PublicAvailabilitySlotsResponse {
  date: string;
  timezone: string;
  service: {
    id: string;
    name: string;
    duration_minutes: number;
    price: number;
  };
  slots: PublicAvailabilitySlot[];
}

export interface InternalAppointmentContextSlot extends PublicAvailabilitySlot {
  label: string;
}

export interface InternalAppointmentContext {
  date: string;
  availableSlots: InternalAppointmentContextSlot[];
  existingAppointments: PublicAvailabilitySlot[];
  blockedTimes: PublicAvailabilitySlot[];
}

export interface ActivityEventItem {
  id: string;
  activity_type: ActivityType;
  title: string;
  description: string | null;
  occurred_at: string;
  client_id: string | null;
  appointment_id: string | null;
  current_appointment_status?: AppointmentStatus;
  metadata: ActivityEventMetadata | null;
}

export interface ActivityGroupSummary {
  new_bookings: number;
  cancellations: number;
  reschedules: number;
  reminders_sent: number;
}

export interface ActivityDayGroup {
  date: string;
  label: string;
  summary: ActivityGroupSummary;
  events: ActivityEventItem[];
}

export interface ActivityFeedResponse {
  groups: ActivityDayGroup[];
  next_cursor: string | null;
}

export interface AppointmentActivityResponse {
  events: ActivityEventItem[];
}

export type ClientActionPriority = "high" | "medium" | "low";

export interface PendingAppointmentApprovalPreviewItem {
  appointment_id: string;
  client_id: string | null;
  client_name: string | null;
  appointment_date: string;
  service_name: string | null;
  status: "pending";
}

export interface PendingAppointmentApprovalActionItem {
  id: "pending-appointment-approvals";
  type: "pending_appointment_approvals";
  label: string;
  priority: "high";
  count: number;
  preview: PendingAppointmentApprovalPreviewItem[];
}

export interface ClientRequiringRebookPreviewItem {
  client_id: string;
  client_name: string | null;
  last_appointment_date: string;
  last_service_name: string | null;
}

export interface ClientsRequiringRebookActionItem {
  id: "clients-requiring-rebook";
  type: "clients_requiring_rebook";
  label: string;
  priority: "medium";
  count: number;
  preview: ClientRequiringRebookPreviewItem[];
}

export type ClientActionItem = PendingAppointmentApprovalActionItem | ClientsRequiringRebookActionItem;

export interface ClientActionsResponse {
  items: ClientActionItem[];
}
