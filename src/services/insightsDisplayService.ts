import { calculatePercentChange } from "../lib/appointmentMetrics";
import { getCurrentLocalDate } from "../lib/timezone";
import type { InsightsQuery, InsightsResponse } from "../validators/insightsValidators";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";
import { customersReachedService } from "./customersReachedService";
import { insightsAppointmentChangesService } from "./insightsAppointmentChangesService";
import { insightsCampaignsService } from "./insightsCampaignsService";
import { evaluateBusinessSnapshotMetrics, getBusinessSnapshotPeriodWindow } from "./insightsSnapshotService";
import { referralLinksService } from "./referralLinksService";
import { insightsContentService } from "./insightsContentService";

const formatCount = (value: number): string => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const formatMoney = (value: number, currency = "USD"): string => new Intl.NumberFormat("en-US", {
  style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(value);
const formatPercent = (value: number): string => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.abs(value))}%`;

const comparison = (current: number, previous: number) => {
  const percentChange = calculatePercentChange(current, previous);
  if (percentChange === null) return null;
  return {
    display_value: formatPercent(percentChange),
    tone: percentChange > 0 ? "positive" as const : percentChange < 0 ? "negative" as const : "neutral" as const
  };
};

const comparisonLabel = (label: string, value: ReturnType<typeof comparison>): string => {
  if (!value) return label;
  const direction = value.tone === "positive" ? "up" : value.tone === "negative" ? "down" : "unchanged";
  return `${label}, ${direction} ${value.display_value}`;
};

/** Converts calculated aggregates into the mobile client's complete display model. */
export const insightsDisplayService = {
  async getPerformanceSnapshot(input: {
    userId: string;
    accountTimeZone: string;
    query: InsightsQuery;
    now: Date;
    calculatedAt: string;
  }): Promise<InsightsResponse["performance_snapshot"]> {
    try {
      const content = await insightsContentService.load();
      const text = (key: string, fallback: string, values?: Record<string, string | number>) =>
        insightsContentService.text(content, key, fallback, values);
      const periodWindow = getBusinessSnapshotPeriodWindow(
        input.query.business_snapshot_period,
        getCurrentLocalDate(input.accountTimeZone, input.now),
        input.accountTimeZone
      );
      const { data, error } = await supabaseAdmin
        .from("appointments")
        .select("appointment_date, price, client_id, status")
        .eq("user_id", input.userId)
        .neq("status", "cancelled")
        .gte("appointment_date", periodWindow.queryStartIso)
        .lt("appointment_date", periodWindow.queryEndIso);
      handleSupabaseError(error, "Unable to load Insights performance snapshot appointments");

      const results = evaluateBusinessSnapshotMetrics({
        appointments: (data ?? []) as Array<{ appointment_date: string; price?: number | string; client_id?: string | null; status?: string }> ,
        periodWindow
      });
      const business = (["booked_revenue", "appointments_booked", "rebooking_rate", "average_ticket"] as const).map((id) => {
        const result = results.get(id);
        if (!result) throw new Error(`Missing business metric ${id}`);
        const displayValue = result.value.kind === "money"
          ? formatMoney(result.currentNumber, result.value.currency)
          : result.value.kind === "percent" ? `${formatCount(result.currentNumber)}%` : formatCount(result.currentNumber);
        const metricComparison = comparison(result.currentNumber, result.previousNumber);
        const label = id === "appointments_booked" ? text("insights.metric.appointments_booked.label", "Appts Booked")
          : id === "average_ticket" ? text("insights.metric.average_ticket.label", "Average Ticket")
          : id === "rebooking_rate" ? text("insights.metric.rebooking_rate.label", "Rebooking Rate")
          : text("insights.metric.booked_revenue.label", "Booked Revenue");
        const supportingText = id === "booked_revenue" ? text("insights.metric.booked_revenue.supporting", "{{count}} booked appts", { count: formatCount(result.currentNumber) })
          : id === "appointments_booked" ? text("insights.metric.appointments_booked.supporting", "All appointments")
          : id === "rebooking_rate" ? text("insights.metric.rebooking_rate.supporting", "Returned clients")
          : text("insights.metric.average_ticket.supporting", "Booked appointments");
        const iconKey: "revenue" | "appointments" | "rebooking" | "average_ticket" = id === "booked_revenue"
          ? "revenue" : id === "appointments_booked" ? "appointments" : id === "rebooking_rate" ? "rebooking" : "average_ticket";
        return {
          id, label, display_value: displayValue, supporting_text: supportingText, comparison: metricComparison,
          icon_key: iconKey,
          accessibility_label: metricComparison
            ? text("insights.metric.accessibility.with_comparison", "{{displayValue}} {{label}}, {{direction}} {{comparison}}", {
              displayValue, label: label.toLowerCase(), direction: metricComparison.tone === "positive" ? "up" : metricComparison.tone === "negative" ? "down" : "unchanged", comparison: metricComparison.display_value
            })
            : text("insights.metric.accessibility.without_comparison", "{{displayValue}} {{label}}", { displayValue, label: label.toLowerCase() })
        };
      });

      const [campaigns, customersReached, referrals] = await Promise.all([
        insightsCampaignsService.getForUser(input.userId, input.accountTimeZone, input.now),
        customersReachedService.getForUser(input.userId, input.accountTimeZone, input.now),
        referralLinksService.getInsightsReferralStats(input.userId, {
          range: input.query.referral_period, timeZone: input.accountTimeZone, now: input.now
        })
      ]);
      const emails = formatCount(campaigns.emailsSent);
      const reached = formatCount(customersReached.unique_clients);
      const conversions = formatCount(referrals.appointmentsBooked);
      const referralCount = formatCount(referrals.linksSent);
      const referralComparison = null; // The established referral aggregate has no prior-period counterpart.

      return {
        available: true,
        calculated_at: input.calculatedAt,
        period_selection: {
          active: input.query.business_snapshot_period,
          options: [{ id: "week", label: text("insights.period.week", "This Week") }, { id: "month", label: text("insights.period.month", "This Month") }]
        },
        pages: [
          { id: "business_metrics", title: text("insights.page.business_metrics.title", "Business Metrics"), layout: "grid_2x2", metrics: business as [typeof business[number], typeof business[number], typeof business[number], typeof business[number]] },
          {
            id: "outreach_metrics", title: text("insights.page.outreach_metrics.title", "Outreach Metrics"), layout: "grid_2x2", metrics: [
              { id: "emails_sent", label: text("insights.metric.emails_sent.label", "Emails Sent"), display_value: emails, supporting_text: text("insights.metric.emails_sent.supporting", "{{periodLabel}}", { periodLabel: campaigns.period.label }), comparison: null, icon_key: "emails_sent", accessibility_label: text("insights.metric.emails_sent.accessibility", "{{count}} emails sent {{periodLabel}}", { count: emails, periodLabel: campaigns.period.label.toLowerCase() }) },
              { id: "customers_reached", label: text("insights.metric.customers_reached.label", "Customers Reached"), display_value: reached, supporting_text: text("insights.metric.customers_reached.supporting", "Unique clients • Last {{days}} days", { days: customersReached.window_days }), comparison: null, icon_key: "customers_reached", accessibility_label: text("insights.metric.customers_reached.accessibility", "{{count}} customers reached in the last {{days}} days", { count: reached, days: customersReached.window_days }) },
              { id: "referral_conversions", label: text("insights.metric.referral_conversions.label", "Referral Conversions"), display_value: conversions, supporting_text: text("insights.metric.referral_conversions.supporting", "Booked from referrals • {{periodLabel}}", { periodLabel: referrals.period.label }), comparison: referralComparison, icon_key: "referral_conversions", accessibility_label: text("insights.metric.referral_conversions.accessibility", "{{count}} referral conversions for {{periodLabel}}", { count: conversions, periodLabel: referrals.period.label.toLowerCase() }) },
              { id: "referrals", label: text("insights.metric.referrals.label", "Referrals"), display_value: referralCount, supporting_text: text("insights.metric.referrals.supporting", "Referral links created • {{periodLabel}}", { periodLabel: referrals.period.label }), comparison: null, icon_key: "referrals", accessibility_label: text("insights.metric.referrals.accessibility", "{{count}} referrals for {{periodLabel}}", { count: referralCount, periodLabel: referrals.period.label.toLowerCase() }) }
            ]
          }
        ],
        swipe_hint: { forward_label: text("insights.swipe.forward", "Swipe to view Outreach metrics"), backward_label: text("insights.swipe.backward", "Swipe to view Business metrics") }
      };
    } catch {
      return { available: false, reason: "temporarily_unavailable", message: "Metrics are temporarily unavailable.", retry_after_seconds: 60, calculated_at: input.calculatedAt };
    }
  },

  async getTodayActivity(input: { userId: string; now: Date; calculatedAt: string }): Promise<InsightsResponse["today_activity"]> {
    try {
      const content = await insightsContentService.load();
      const text = (key: string, fallback: string, values?: Record<string, string | number>) => insightsContentService.text(content, key, fallback, values);
      const activity = await insightsAppointmentChangesService.getForUser(input.userId, input.now);
      const bookings = formatCount(activity.newAppointments.currentCount);
      const cancellations = formatCount(activity.cancellations.currentCount);
      return {
        available: true, calculated_at: input.calculatedAt,
        heading: text("insights.today_activity.heading", "Today • Last 24 Hours"), accessibility_label: text("insights.today_activity.accessibility", "Today’s activity over the last 24 hours"),
        metrics: [
          { id: "new_appointments", label: text("insights.today_activity.new_appointments.label", "New Appointments"), display_value: bookings, icon_key: "new_appointments", accessibility_label: text("insights.today_activity.new_appointments.accessibility", "{{count}} new appointments in the last 24 hours", { count: bookings }) },
          { id: "cancellations", label: text("insights.today_activity.cancellations.label", "Cancellations"), display_value: cancellations, icon_key: "cancellations", accessibility_label: text("insights.today_activity.cancellations.accessibility", "{{count}} cancellations in the last 24 hours", { count: cancellations }) }
        ]
      };
    } catch {
      return { available: false, reason: "temporarily_unavailable", message: "Metrics are temporarily unavailable.", retry_after_seconds: 60, calculated_at: input.calculatedAt };
    }
  }
};
