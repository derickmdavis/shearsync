import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fixture from "./fixtures/insights-response.json";
import unavailableFixture from "./fixtures/insights-unavailable-response.json";
import {
  insightsQuerySchema,
  insightsHttpResponseSchema
} from "../validators/insightsValidators";

describe("Insights API contract", () => {
  it("accepts the mobile fixture, including independently unavailable sections", () => {
    assert.deepEqual(insightsHttpResponseSchema.parse(fixture), fixture);
  });

  it("accepts every documented unavailable state", () => {
    assert.deepEqual(insightsHttpResponseSchema.parse(unavailableFixture), unavailableFixture);
  });

  it("defaults the supported selector values", () => {
    assert.deepEqual(insightsQuerySchema.parse({}), {
      business_snapshot_period: "week",
      referral_period: "this_month"
    });
  });

  it("rejects a trend when the comparison is unavailable", () => {
    const invalid = structuredClone(fixture);
    const metric = invalid.data.business_snapshot.available
      ? invalid.data.business_snapshot.pages[0].metrics[1]
      : undefined;

    if (!metric?.comparison) {
      throw new Error("Fixture must contain an unavailable comparison");
    }

    metric.comparison.trend = "up";
    assert.throws(() => insightsHttpResponseSchema.parse(invalid));
  });
});
