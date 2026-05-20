import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyIntelligentScheduling,
  MAX_INITIAL_INTELLIGENT_SLOTS,
  scoreAvailabilitySlot
} from "../services/intelligentSchedulingService";
import type { PublicAvailabilitySlot } from "../types/api";

const timeZone = "UTC";
const date = "2026-05-20";

const slot = (start: string, durationMinutes: number): PublicAvailabilitySlot => {
  const [hourText, minuteText] = start.split(":");
  const startDate = new Date(Date.UTC(2026, 4, 20, Number(hourText), Number(minuteText), 0, 0));
  const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);

  return {
    start: `${date}T${start}:00+00:00`,
    end: `${date}T${String(endDate.getUTCHours()).padStart(2, "0")}:${String(endDate.getUTCMinutes()).padStart(2, "0")}:00+00:00`
  };
};

const everyFifteenMinutes = (startHour: number, endHour: number, durationMinutes: number): PublicAvailabilitySlot[] => {
  const slots: PublicAvailabilitySlot[] = [];

  for (let minutes = startHour * 60; minutes <= endHour * 60; minutes += 15) {
    slots.push(slot(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, durationMinutes));
  }

  return slots;
};

const starts = (slots: PublicAvailabilitySlot[]): string[] => slots.map((item) => item.start.slice(11, 16));

const defaultParams = {
  existingBusyBlocks: [],
  businessHours: [{ start: "09:00", end: "17:00" }],
  timeZone
};

describe("Intelligent scheduling", () => {
  it("returns all valid slots chronologically when disabled", () => {
    const validSlots = everyFifteenMinutes(9, 14, 180);
    const result = applyIntelligentScheduling({
      ...defaultParams,
      validSlots,
      serviceDurationMinutes: 180,
      enabled: false
    });

    assert.equal(result.slots.length, validSlots.length);
    assert.deepEqual(starts(result.slots).slice(0, 4), ["09:00", "09:15", "09:30", "09:45"]);
    assert.deepEqual(result.moreSlots, []);
    assert.equal(result.hasMore, false);
  });

  it("prioritizes clean morning and early-afternoon starts for a long open-day service", () => {
    const validSlots = everyFifteenMinutes(9, 14, 180);
    const result = applyIntelligentScheduling({
      ...defaultParams,
      validSlots,
      serviceDurationMinutes: 180,
      enabled: true
    });
    const initialStarts = starts(result.slots);

    assert.equal(result.slots.length, MAX_INITIAL_INTELLIGENT_SLOTS);
    assert.equal(result.hasMore, true);
    assert.equal(new Set([...result.slots, ...result.moreSlots].map((item) => item.start)).size, validSlots.length);
    assert.ok(initialStarts.includes("09:00"));
    assert.ok(initialStarts.includes("09:30") || initialStarts.includes("10:00"));
    assert.ok(initialStarts.some((start) => start >= "12:00" && start <= "13:30"));
    assert.deepEqual(initialStarts, [...initialStarts].sort());
    assert.deepEqual(starts(result.moreSlots), [...starts(result.moreSlots)].sort());
  });

  it("keeps short-service initial results clean and chronological", () => {
    const validSlots = everyFifteenMinutes(9, 16, 60);
    const result = applyIntelligentScheduling({
      ...defaultParams,
      validSlots,
      serviceDurationMinutes: 60,
      enabled: true
    });

    assert.deepEqual(starts(result.slots), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
    assert.equal(result.moreSlots.some((item) => item.start.includes("T09:15:00")), true);
    assert.equal(result.moreSlots.some((item) => item.start.includes("T09:45:00")), true);
  });

  it("scores a slot stacked after an appointment higher than awkward 15 and 45 minute gaps", () => {
    const busyBlock = { start: `${date}T09:00:00+00:00`, end: `${date}T10:00:00+00:00` };
    const ten = scoreAvailabilitySlot({
      ...defaultParams,
      existingBusyBlocks: [busyBlock],
      slot: slot("10:00", 90),
      serviceDurationMinutes: 90
    });
    const tenFifteen = scoreAvailabilitySlot({
      ...defaultParams,
      existingBusyBlocks: [busyBlock],
      slot: slot("10:15", 90),
      serviceDurationMinutes: 90
    });
    const tenFortyFive = scoreAvailabilitySlot({
      ...defaultParams,
      existingBusyBlocks: [busyBlock],
      slot: slot("10:45", 90),
      serviceDurationMinutes: 90
    });

    assert.ok(ten.score > tenFifteen.score);
    assert.ok(ten.score > tenFortyFive.score);
  });

  it("scores a long slot that ends before the next appointment highly", () => {
    const busyBlock = { start: `${date}T14:00:00+00:00`, end: `${date}T15:00:00+00:00` };
    const eleven = scoreAvailabilitySlot({
      ...defaultParams,
      existingBusyBlocks: [busyBlock],
      slot: slot("11:00", 180),
      serviceDurationMinutes: 180
    });
    const elevenThirty = scoreAvailabilitySlot({
      ...defaultParams,
      existingBusyBlocks: [busyBlock],
      slot: slot("11:30", 180),
      serviceDurationMinutes: 180
    });

    assert.ok(eleven.score > elevenThirty.score);
  });

  it("pushes valid awkward 15 and 45 minute starts behind better options", () => {
    const validSlots = everyFifteenMinutes(10, 14, 90);
    const result = applyIntelligentScheduling({
      ...defaultParams,
      existingBusyBlocks: [{ start: `${date}T09:00:00+00:00`, end: `${date}T10:00:00+00:00` }],
      validSlots,
      serviceDurationMinutes: 90,
      enabled: true
    });
    const initialStarts = starts(result.slots);

    assert.equal(initialStarts.includes("10:15"), false);
    assert.equal(initialStarts.includes("10:45"), false);
    assert.equal(starts(result.moreSlots).includes("10:15"), true);
    assert.equal(starts(result.moreSlots).includes("10:45"), true);
  });

  it("returns five or fewer valid slots without splitting into moreSlots", () => {
    const validSlots = [slot("09:00", 60), slot("10:00", 60), slot("11:00", 60), slot("12:00", 60)];
    const result = applyIntelligentScheduling({
      ...defaultParams,
      validSlots,
      serviceDurationMinutes: 60,
      enabled: true
    });

    assert.deepEqual(result.slots, validSlots);
    assert.deepEqual(result.moreSlots, []);
    assert.equal(result.hasMore, false);
  });

  it("returns an empty result when there are no valid slots", () => {
    const result = applyIntelligentScheduling({
      ...defaultParams,
      validSlots: [],
      serviceDurationMinutes: 60,
      enabled: true
    });

    assert.deepEqual(result.slots, []);
    assert.deepEqual(result.moreSlots, []);
    assert.equal(result.hasMore, false);
  });

  it("scores using local business time rather than UTC wall clock", () => {
    const denverSlot = {
      start: "2026-05-20T09:00:00-06:00",
      end: "2026-05-20T12:00:00-06:00"
    };
    const scored = scoreAvailabilitySlot({
      slot: denverSlot,
      existingBusyBlocks: [],
      businessHours: [{ start: "09:00", end: "17:00" }],
      serviceDurationMinutes: 180,
      timeZone: "America/Denver"
    });

    assert.equal(scored.startMinutes, 9 * 60);
    assert.ok(scored.score > 0);
  });
});
