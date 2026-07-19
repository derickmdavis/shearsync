import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAMPAIGN_ATTRIBUTION_WINDOW_DAYS,
  CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS,
  CAMPAIGN_MESSAGE_MAX_LENGTH,
  CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES,
  CAMPAIGN_MISSING_FIRST_NAME_FALLBACK,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_STATUSES,
  CAMPAIGN_SUBJECT_MAX_LENGTH,
  SCHEDULED_OUTREACH_KINDS
} from "../lib/outreachContracts";
import {
  campaignAudienceSchema,
  campaignContentSchema,
  campaignMessageSchema,
  campaignNameSchema,
  campaignStatusSchema,
  campaignSubjectSchema,
  createCampaignScheduleAtSchema,
  outreachAutomationsSchema,
  scheduledOutreachKindSchema,
  scheduledOutreachListSchema
} from "../validators/outreachValidators";
import {
  outreachAutomationsContractFixture,
  scheduledOutreachListContractFixture
} from "./fixtures/outreachContractFixtures";

describe("outreach contract constants", () => {
  it("defines the approved one-time campaign statuses without active or paused aliases", () => {
    assert.deepEqual(CAMPAIGN_STATUSES, [
      "draft",
      "scheduled",
      "sending",
      "completed",
      "partially_failed",
      "failed",
      "cancelled"
    ]);
    assert.equal(campaignStatusSchema.safeParse("draft").success, true);
    assert.equal(campaignStatusSchema.safeParse("cancelled").success, true);
    assert.equal(campaignStatusSchema.safeParse("drafted").success, false);
    assert.equal(campaignStatusSchema.safeParse("active").success, false);
    assert.equal(campaignStatusSchema.safeParse("paused").success, false);
  });

  it("excludes undefined review requests from scheduled outreach kinds", () => {
    assert.deepEqual(SCHEDULED_OUTREACH_KINDS, [
      "appointment_reminder",
      "rebook_nudge",
      "thank_you_email",
      "birthday_reminder",
      "campaign"
    ]);
    assert.equal(scheduledOutreachKindSchema.safeParse("review_request").success, false);
  });

  it("records approved content, scheduling, attribution, and fallback decisions", () => {
    assert.equal(CAMPAIGN_NAME_MAX_LENGTH, 60);
    assert.equal(CAMPAIGN_SUBJECT_MAX_LENGTH, 100);
    assert.equal(CAMPAIGN_MESSAGE_MAX_LENGTH, 2_000);
    assert.equal(CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES, 5);
    assert.equal(CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS, 12);
    assert.equal(CAMPAIGN_ATTRIBUTION_WINDOW_DAYS, 30);
    assert.equal(CAMPAIGN_MISSING_FIRST_NAME_FALLBACK, "there");
  });
});

describe("campaign content contracts", () => {
  it("accepts content at the approved limits", () => {
    assert.equal(campaignNameSchema.safeParse("N".repeat(60)).success, true);
    assert.equal(campaignSubjectSchema.safeParse("S".repeat(100)).success, true);
    assert.equal(campaignMessageSchema.safeParse("M".repeat(2_000)).success, true);
  });

  it("rejects content over the approved limits", () => {
    assert.equal(campaignNameSchema.safeParse("N".repeat(61)).success, false);
    assert.equal(campaignSubjectSchema.safeParse("S".repeat(101)).success, false);
    assert.equal(campaignMessageSchema.safeParse("M".repeat(2_001)).success, false);
  });

  it("allows only first_name personalization in campaign subject and message", () => {
    assert.equal(campaignContentSchema.safeParse({
      subject: "An appointment for {{first_name}}",
      message: "Hi {{ first_name }}, I would love to see you again."
    }).success, true);
    assert.equal(campaignSubjectSchema.safeParse("For {{business_name}}").success, false);
    assert.equal(campaignMessageSchema.safeParse("Hi {{client_name}}").success, false);
  });

  it("requires no client IDs for everyone and at least one for a specific audience", () => {
    assert.equal(campaignAudienceSchema.safeParse({ mode: "everyone", client_ids: [] }).success, true);
    assert.equal(campaignAudienceSchema.safeParse({
      mode: "specific",
      client_ids: ["33333333-3333-4333-8333-333333333333"]
    }).success, true);
    assert.equal(campaignAudienceSchema.safeParse({ mode: "everyone", client_ids: [
      "33333333-3333-4333-8333-333333333333"
    ] }).success, false);
    assert.equal(campaignAudienceSchema.safeParse({ mode: "specific", client_ids: [] }).success, false);
  });
});

describe("campaign schedule contract", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  const schema = createCampaignScheduleAtSchema(now);

  it("accepts the exact five-minute lead-time boundary", () => {
    assert.equal(schema.safeParse("2026-07-18T12:05:00.000Z").success, true);
  });

  it("rejects a schedule before the five-minute lead-time boundary", () => {
    assert.equal(schema.safeParse("2026-07-18T12:04:59.999Z").success, false);
  });

  it("accepts the exact 12-calendar-month boundary and rejects later schedules", () => {
    assert.equal(schema.safeParse("2027-07-18T12:00:00.000Z").success, true);
    assert.equal(schema.safeParse("2027-07-18T12:00:00.001Z").success, false);
  });

  it("clamps a leap-day 12-month horizon to the last day of February", () => {
    const leapDaySchema = createCampaignScheduleAtSchema(new Date("2024-02-29T12:00:00.000Z"));

    assert.equal(leapDaySchema.safeParse("2025-02-28T12:00:00.000Z").success, true);
    assert.equal(leapDaySchema.safeParse("2025-02-28T12:00:00.001Z").success, false);
  });
});

describe("representative outreach fixtures", () => {
  it("validates the normalized scheduled-outreach list fixture", () => {
    scheduledOutreachListSchema.parse(scheduledOutreachListContractFixture);
  });

  it("validates the normalized automations fixture", () => {
    outreachAutomationsSchema.parse(outreachAutomationsContractFixture);
  });
});
