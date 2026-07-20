import { z } from "zod";
import { logger } from "../lib/logger";
import type { PlanTier } from "../lib/plans";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import {
  buildBusinessSnapshotPages,
  businessSnapshotConfiguration,
  businessSnapshotMetricCatalog,
  type BusinessSnapshotAppointment,
  type BusinessSnapshotPageConfiguration,
  type BusinessSnapshotPeriodWindow
} from "./insightsSnapshotService";

const planTierSchema = z.enum(["basic", "pro", "premium"]);
const metricIdSchema = z.string().refine(
  (value): value is keyof typeof businessSnapshotMetricCatalog => value in businessSnapshotMetricCatalog,
  "metric_id must be registered in the business snapshot metric catalog"
);

const metricAssignmentSchema = z.object({
  metric_id: metricIdSchema,
  enabled: z.boolean().default(true)
}).strict();

const pageSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  title: z.string().min(1).max(80),
  layout: z.enum(["grid_2x2", "list"]),
  period_behavior: z.literal("selected_period"),
  enabled: z.boolean().default(true),
  required_feature: z.string().min(1).max(80).optional(),
  metrics: z.array(metricAssignmentSchema).min(1).max(20)
}).strict().superRefine((page, context) => {
  const ids = page.metrics.map((metric) => metric.metric_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "metric assignments must be unique within a page", path: ["metrics"] });
  }
});

const databaseConfigurationSchema = z.object({
  id: z.string().uuid(),
  configuration_version: z.number().int().positive(),
  enabled: z.boolean(),
  pages: z.array(pageSchema).min(1).max(20),
  target_plan_tiers: z.array(planTierSchema).nullable(),
  rollout_percentage: z.number().int().min(0).max(100),
  updated_by: z.string().min(1).max(255),
  updated_at: z.string().datetime({ offset: true })
}).passthrough().superRefine((configuration, context) => {
  const pageIds = configuration.pages.map((page) => page.id);
  if (new Set(pageIds).size !== pageIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "page IDs must be unique", path: ["pages"] });
  }
});

export type RuntimeSnapshotConfiguration = z.infer<typeof databaseConfigurationSchema>;

export type ResolvedSnapshotConfiguration = {
  source: "database" | "fallback";
  configurationVersion: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  pages: readonly BusinessSnapshotPageConfiguration[];
};

const fallbackConfiguration = (): ResolvedSnapshotConfiguration => ({
  source: "fallback",
  configurationVersion: null,
  updatedAt: null,
  updatedBy: null,
  pages: businessSnapshotConfiguration
});

const isInRollout = (userId: string, configurationId: string, percentage: number): boolean => {
  if (percentage <= 0) return false;
  if (percentage >= 100) return true;

  // Stable, deterministic bucketing avoids a user seeing a different layout on
  // each refresh while keeping the database configuration free of formulas.
  let hash = 0;
  for (const character of `${configurationId}:${userId}`) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return hash % 100 < percentage;
};

const toPageConfigurations = (configuration: RuntimeSnapshotConfiguration): BusinessSnapshotPageConfiguration[] =>
  configuration.pages
    .filter((page) => page.enabled)
    .map((page) => ({
      id: page.id,
      title: page.title,
      layout: page.layout,
      periodBehavior: page.period_behavior,
      requiredFeature: page.required_feature,
      metricIds: page.metrics.filter((metric) => metric.enabled).map((metric) => metric.metric_id)
    }))
    .filter((page) => page.metricIds.length > 0);

const belongsToTarget = (configuration: RuntimeSnapshotConfiguration, planTier: PlanTier | undefined): boolean =>
  configuration.target_plan_tiers === null
  || (planTier !== undefined && configuration.target_plan_tiers.includes(planTier));

export const insightsSnapshotConfigurationService = {
  async resolveForUser(input: { userId: string; planTier?: PlanTier }): Promise<ResolvedSnapshotConfiguration> {
    const { data, error } = await supabaseAdmin
      .from("insight_snapshot_configurations")
      .select("id, configuration_version, enabled, pages, target_plan_tiers, rollout_percentage, updated_by, updated_at")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn("insights_snapshot_configuration_fallback", { reason: "query_failed", code: error.code });
      return fallbackConfiguration();
    }

    if (!data) return fallbackConfiguration();

    const parsed = databaseConfigurationSchema.safeParse(data as Row);
    if (!parsed.success) {
      logger.warn("insights_snapshot_configuration_fallback", {
        reason: "invalid_configuration",
        configurationId: (data as Row).id
      });
      return fallbackConfiguration();
    }

    const configuration = parsed.data;
    const pages = toPageConfigurations(configuration);
    if (!configuration.enabled || pages.length === 0 || !belongsToTarget(configuration, input.planTier)
      || !isInRollout(input.userId, configuration.id, configuration.rollout_percentage)) {
      return fallbackConfiguration();
    }

    return {
      source: "database",
      configurationVersion: configuration.configuration_version,
      updatedAt: configuration.updated_at,
      updatedBy: configuration.updated_by,
      pages
    };
  },

  async buildPagesForUser(input: {
    userId: string;
    planTier?: PlanTier;
    enabledFeatures?: ReadonlySet<string>;
    appointments: BusinessSnapshotAppointment[];
    periodWindow: BusinessSnapshotPeriodWindow;
    currency?: string;
  }) {
    const configuration = await this.resolveForUser({ userId: input.userId, planTier: input.planTier });
    return {
      configuration,
      pages: buildBusinessSnapshotPages({
        appointments: input.appointments,
        periodWindow: input.periodWindow,
        currency: input.currency,
        configuration: configuration.pages,
        enabledFeatures: input.enabledFeatures
      })
    };
  }
};
