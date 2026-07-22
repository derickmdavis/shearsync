import { getCurrentLocalDate, resolveBusinessTimeZone } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import { PLAN_CONFIG, type PlanTier } from "../lib/plans";
import { logger } from "../lib/logger";
import { insightsResponseSchema, type InsightsQuery, type InsightsResponse } from "../validators/insightsValidators";
import { handleSupabaseError } from "./db";
import { getBusinessSnapshotPeriodWindow } from "./insightsSnapshotService";
import { insightsSnapshotConfigurationService } from "./insightsSnapshotConfigurationService";
import { insightsAppointmentChangesService } from "./insightsAppointmentChangesService";
import { referralLinksService } from "./referralLinksService";
import { insightsCampaignsService } from "./insightsCampaignsService";
import { insightsCampaignPresentationService } from "./insightsCampaignPresentationService";
import { insightsReferralPresentationService } from "./insightsReferralPresentationService";
import { usersService } from "./usersService";

const toPlanTier = (value: unknown): PlanTier | undefined =>
  value === "basic" || value === "pro" || value === "premium" ? value : undefined;

const hasEmailCampaigns = (user: Record<string, unknown> | null): boolean => {
  const tier = toPlanTier(user?.plan_tier);
  return user?.plan_status !== "cancelled"
    && !!tier
    && PLAN_CONFIG[tier].features.emailCampaigns;
};

type InsightsSection = "business_snapshot" | "campaigns" | "referrals" | "appointment_changes";

const isSectionEnabled = (section: InsightsSection) => {
  const configuredSections = process.env.INSIGHTS_ENABLED_SECTIONS;
  if (!configuredSections) return true;

  return new Set(configuredSections.split(",").map((value) => value.trim())).has(section);
};

const logSectionResult = (
  section: InsightsSection,
  userId: string,
  startedAt: number,
  failureReason?: string
) => {
  const metadata = {
    section,
    userId,
    latency_ms: Date.now() - startedAt,
    ...(failureReason ? { failure_reason: failureReason } : {})
  };

  if (failureReason) {
    logger.warn("insights_section_unavailable", metadata);
  } else {
    logger.info("insights_section_calculated", metadata);
  }
};

export const insightsService = {
  async getForUser(userId: string, query: InsightsQuery, now = new Date()): Promise<InsightsResponse> {
    const generatedAt = now.toISOString();
    const user = await usersService.getById(userId);
    const accountTimeZone = resolveBusinessTimeZone(user);

    const getBusinessSnapshot = async (): Promise<InsightsResponse["business_snapshot"]> => {
      const startedAt = Date.now();
      if (!isSectionEnabled("business_snapshot")) {
        logSectionResult("business_snapshot", userId, startedAt, "feature_disabled");
        return {
          available: false,
          reason: "feature_unavailable",
          message: "Business snapshot is not enabled for this account."
        };
      }

      try {
      const todayDate = getCurrentLocalDate(accountTimeZone, now);
      const periodWindow = getBusinessSnapshotPeriodWindow(
        query.business_snapshot_period,
        todayDate,
        accountTimeZone
      );
      const { data, error } = await supabaseAdmin
        .from("appointments")
        .select("appointment_date, price, client_id, status")
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .gte("appointment_date", periodWindow.queryStartIso)
        .lt("appointment_date", periodWindow.queryEndIso);
      handleSupabaseError(error, "Unable to load Insights business snapshot appointments");

      const snapshot = await insightsSnapshotConfigurationService.buildPagesForUser({
        userId,
        planTier: toPlanTier(user?.plan_tier),
        appointments: (data ?? []) as Array<{
          appointment_date: string;
          price?: number | string;
          client_id?: string | null;
          status?: string;
        }>,
        periodWindow
      });

        const businessSnapshot: InsightsResponse["business_snapshot"] = {
        available: true,
        calculated_at: generatedAt,
        pages: snapshot.pages
      };
        logSectionResult("business_snapshot", userId, startedAt);
        return businessSnapshot;
      } catch (error) {
        logSectionResult("business_snapshot", userId, startedAt, error instanceof Error ? error.message : "unknown_error");
        return {
        available: false,
        reason: "temporarily_unavailable",
        message: "Business snapshot is temporarily unavailable.",
        retry_after_seconds: 30
      };
      }
    };

    const getReferrals = async (): Promise<InsightsResponse["referrals"]> => {
      const startedAt = Date.now();
      if (!isSectionEnabled("referrals")) {
        logSectionResult("referrals", userId, startedAt, "feature_disabled");
        return { available: false, reason: "feature_unavailable", message: "Referral insights are not enabled for this account." };
      }
      try {
      const referralStats = await referralLinksService.getInsightsReferralStats(userId, {
        range: query.referral_period,
        timeZone: accountTimeZone,
        now
      });
        const referrals: InsightsResponse["referrals"] = {
        available: true,
        calculated_at: generatedAt,
        period: {
          label: referralStats.period.label,
          start_at: referralStats.period.startAt,
          end_at: referralStats.period.endAt
        },
        ...insightsReferralPresentationService.build(referralStats)
      };
        logSectionResult("referrals", userId, startedAt);
        return referrals;
      } catch (error) {
        logSectionResult("referrals", userId, startedAt, error instanceof Error ? error.message : "unknown_error");
        return {
        available: false,
        reason: "temporarily_unavailable",
        message: "Referral insights are temporarily unavailable.",
        retry_after_seconds: 30
      };
      }
    };

    const getCampaigns = async (): Promise<InsightsResponse["campaigns"]> => {
      const startedAt = Date.now();
      if (!isSectionEnabled("campaigns")) {
        logSectionResult("campaigns", userId, startedAt, "feature_disabled");
        return { available: false, reason: "feature_unavailable", message: "Campaign insights are not enabled for this account." };
      }
      if (!hasEmailCampaigns(user)) {
        logSectionResult("campaigns", userId, startedAt, "feature_unavailable");
        return { available: false, reason: "feature_unavailable", message: "Campaign insights are not available for the current plan." };
      }
      try {
      const campaignStats = await insightsCampaignsService.getForUser(userId, accountTimeZone, now);
        const campaigns: InsightsResponse["campaigns"] = {
        available: true,
        calculated_at: generatedAt,
        period: {
          label: campaignStats.period.label,
          start_at: campaignStats.period.startAt,
          end_at: campaignStats.period.endAt
        },
        ...insightsCampaignPresentationService.build(campaignStats)
      };
        logSectionResult("campaigns", userId, startedAt);
        return campaigns;
      } catch (error) {
        logSectionResult("campaigns", userId, startedAt, error instanceof Error ? error.message : "unknown_error");
        return {
        available: false,
        reason: "temporarily_unavailable",
        message: "Campaign insights are temporarily unavailable.",
        retry_after_seconds: 30
      };
      }
    };

    const getAppointmentChanges = async (): Promise<InsightsResponse["appointment_changes"]> => {
      const startedAt = Date.now();
      if (!isSectionEnabled("appointment_changes")) {
        logSectionResult("appointment_changes", userId, startedAt, "feature_disabled");
        return { available: false, reason: "feature_unavailable", message: "Appointment changes are not enabled for this account." };
      }
      try {
      const changes = await insightsAppointmentChangesService.getForUser(userId, now);
        const appointmentChanges: InsightsResponse["appointment_changes"] = {
        available: true,
        calculated_at: generatedAt,
        window: {
          label: changes.window.label,
          current_start_at: changes.window.currentStartAt,
          current_end_at: changes.window.currentEndAt,
          previous_start_at: changes.window.previousStartAt,
          previous_end_at: changes.window.previousEndAt
        },
        new_appointments: {
          current_count: changes.newAppointments.currentCount,
          previous_count: changes.newAppointments.previousCount,
          percent_change: changes.newAppointments.percentChange
        },
        cancellations: {
          current_count: changes.cancellations.currentCount,
          previous_count: changes.cancellations.previousCount,
          percent_change: changes.cancellations.percentChange
        }
      };
        logSectionResult("appointment_changes", userId, startedAt);
        return appointmentChanges;
      } catch (error) {
        logSectionResult("appointment_changes", userId, startedAt, error instanceof Error ? error.message : "unknown_error");
        return {
        available: false,
        reason: "temporarily_unavailable",
        message: "Appointment changes are temporarily unavailable.",
        retry_after_seconds: 30
      };
      }
    };

    const [businessSnapshot, referrals, campaigns, appointmentChanges] = await Promise.all([
      getBusinessSnapshot(),
      getReferrals(),
      getCampaigns(),
      getAppointmentChanges()
    ]);

    // These are reserved contract sections. They intentionally remain explicit
    // unavailable states until their dedicated aggregate implementations ship.
    return insightsResponseSchema.parse({
      contract_version: "2026-07-22",
      generated_at: generatedAt,
      account_timezone: accountTimeZone,
      business_snapshot: businessSnapshot,
      campaigns,
      referrals,
      appointment_changes: appointmentChanges
    });
  }
};
