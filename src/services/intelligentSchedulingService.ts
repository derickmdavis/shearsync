import { getMinutesSinceMidnightForInstant } from "../lib/timezone";
import type { PublicAvailabilitySlot } from "../types/api";

export const MAX_INITIAL_INTELLIGENT_SLOTS = 5;
export const AWKWARD_GAP_THRESHOLD_MINUTES = 60;
export const LONG_SERVICE_THRESHOLD_MINUTES = 120;
export const PREFERRED_DISPLAY_INTERVAL_MINUTES = 30;

interface BusyBlock {
  start: string;
  end: string;
}

interface BusinessHours {
  start: string;
  end: string;
}

interface ScoredSlot {
  slot: PublicAvailabilitySlot;
  score: number;
  startMinutes: number;
}

export interface IntelligentSchedulingResult {
  slots: PublicAvailabilitySlot[];
  moreSlots: PublicAvailabilitySlot[];
  hasMore: boolean;
}

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const sortSlotsChronologically = (slots: PublicAvailabilitySlot[]): PublicAvailabilitySlot[] =>
  [...slots].sort((left, right) => left.start.localeCompare(right.start));

const isLongService = (durationMinutes: number): boolean => durationMinutes >= LONG_SERVICE_THRESHOLD_MINUTES;

const isMorningStart = (startMinutes: number): boolean => startMinutes < 12 * 60;

const isEarlyAfternoonStart = (startMinutes: number): boolean =>
  startMinutes >= 12 * 60 && startMinutes <= 13 * 60 + 30;

const getSlotMinutes = (slot: PublicAvailabilitySlot, timeZone: string): { start: number; end: number } => ({
  start: getMinutesSinceMidnightForInstant(slot.start, timeZone),
  end: getMinutesSinceMidnightForInstant(slot.end, timeZone)
});

const getBusyBlockMinutes = (block: BusyBlock, timeZone: string): { start: number; end: number } => ({
  start: getMinutesSinceMidnightForInstant(block.start, timeZone),
  end: getMinutesSinceMidnightForInstant(block.end, timeZone)
});

const getContainingBusinessHours = (
  slotStart: number,
  slotEnd: number,
  businessHours: BusinessHours[]
): { start: number; end: number } => {
  const matchingHours = businessHours
    .map((hours) => ({
      start: timeToMinutes(hours.start),
      end: timeToMinutes(hours.end)
    }))
    .find((hours) => slotStart >= hours.start && slotEnd <= hours.end);

  return matchingHours ?? {
    start: businessHours.length > 0 ? timeToMinutes(businessHours[0].start) : 0,
    end: businessHours.length > 0 ? timeToMinutes(businessHours[0].end) : 24 * 60
  };
};

const calculateGapsCreatedBySlot = (params: {
  slotStart: number;
  slotEnd: number;
  businessHours: { start: number; end: number };
  busyBlocks: Array<{ start: number; end: number }>;
}): {
  gapBefore: number;
  gapAfter: number;
  startsAfterBusyBlock: boolean;
  endsBeforeBusyBlock: boolean;
} => {
  const previousBusyBlock = [...params.busyBlocks]
    .filter((block) => block.end <= params.slotStart)
    .sort((left, right) => right.end - left.end)[0];
  const nextBusyBlock = [...params.busyBlocks]
    .filter((block) => block.start >= params.slotEnd)
    .sort((left, right) => left.start - right.start)[0];
  const previousBoundary = previousBusyBlock?.end ?? params.businessHours.start;
  const nextBoundary = nextBusyBlock?.start ?? params.businessHours.end;

  return {
    gapBefore: Math.max(0, params.slotStart - previousBoundary),
    gapAfter: Math.max(0, nextBoundary - params.slotEnd),
    startsAfterBusyBlock: previousBusyBlock?.end === params.slotStart,
    endsBeforeBusyBlock: nextBusyBlock?.start === params.slotEnd
  };
};

const scoreGap = (gapMinutes: number, adjacentToBusyBlock: boolean): number => {
  if (!adjacentToBusyBlock || gapMinutes === 0 || gapMinutes >= AWKWARD_GAP_THRESHOLD_MINUTES) {
    return 0;
  }

  return gapMinutes < PREFERRED_DISPLAY_INTERVAL_MINUTES ? -50 : -25;
};

export const scoreAvailabilitySlot = (params: {
  slot: PublicAvailabilitySlot;
  existingBusyBlocks: BusyBlock[];
  businessHours: BusinessHours[];
  serviceDurationMinutes: number;
  timeZone: string;
}): ScoredSlot => {
  const { start: slotStart, end: slotEnd } = getSlotMinutes(params.slot, params.timeZone);
  const containingHours = getContainingBusinessHours(slotStart, slotEnd, params.businessHours);
  const busyBlockMinutes = params.existingBusyBlocks.map((block) => getBusyBlockMinutes(block, params.timeZone));
  const gaps = calculateGapsCreatedBySlot({
    slotStart,
    slotEnd,
    businessHours: containingHours,
    busyBlocks: busyBlockMinutes
  });
  const minutesAfterOpen = Math.max(0, slotStart - containingHours.start);
  const minutesBeforeClose = Math.max(0, containingHours.end - slotEnd);
  const openDayInWindow = busyBlockMinutes.every(
    (block) => block.end <= containingHours.start || block.start >= containingHours.end
  );
  const longService = isLongService(params.serviceDurationMinutes);
  let score = 0;

  if (slotStart === containingHours.start) score += 40;
  if (gaps.startsAfterBusyBlock) score += 35;
  if (gaps.endsBeforeBusyBlock) score += 35;
  if (slotStart % 60 === 0) score += 20;
  else if (slotStart % PREFERRED_DISPLAY_INTERVAL_MINUTES === 0) score += 15;
  if (!gaps.startsAfterBusyBlock && !gaps.endsBeforeBusyBlock) score += 25;
  if (gaps.gapBefore >= AWKWARD_GAP_THRESHOLD_MINUTES || gaps.gapAfter >= AWKWARD_GAP_THRESHOLD_MINUTES) score += 20;

  score += scoreGap(gaps.gapBefore, gaps.startsAfterBusyBlock);
  score += scoreGap(gaps.gapAfter, gaps.endsBeforeBusyBlock);

  if (slotStart % PREFERRED_DISPLAY_INTERVAL_MINUTES !== 0) score -= 10;

  if (
    (gaps.startsAfterBusyBlock && gaps.gapBefore > 0 && gaps.gapBefore < AWKWARD_GAP_THRESHOLD_MINUTES) ||
    (gaps.endsBeforeBusyBlock && gaps.gapAfter > 0 && gaps.gapAfter < AWKWARD_GAP_THRESHOLD_MINUTES)
  ) {
    score -= 20;
  }

  if (longService) {
    if (isMorningStart(slotStart)) score += 20;
    if (isEarlyAfternoonStart(slotStart)) score += 35;
    if (slotEnd === containingHours.end) score += 10;
    if (slotStart > 13 * 60 + 30) score -= 15;
    if (openDayInWindow && minutesAfterOpen >= AWKWARD_GAP_THRESHOLD_MINUTES && minutesBeforeClose >= AWKWARD_GAP_THRESHOLD_MINUTES) {
      score -= 20;
    }
    if (minutesAfterOpen < AWKWARD_GAP_THRESHOLD_MINUTES && minutesBeforeClose < AWKWARD_GAP_THRESHOLD_MINUTES && slotEnd !== containingHours.end) {
      score -= 20;
    }
  }

  // A tiny deterministic chronological nudge keeps equal-quality short-service slots client-friendly.
  score -= Math.floor(minutesAfterOpen / PREFERRED_DISPLAY_INTERVAL_MINUTES) * 2;

  return {
    slot: params.slot,
    score,
    startMinutes: slotStart
  };
};

export const applyIntelligentScheduling = (params: {
  validSlots: PublicAvailabilitySlot[];
  existingBusyBlocks: BusyBlock[];
  businessHours: BusinessHours[];
  serviceDurationMinutes: number;
  timeZone: string;
  enabled: boolean;
}): IntelligentSchedulingResult => {
  const chronologicalSlots = sortSlotsChronologically(params.validSlots);

  if (!params.enabled || chronologicalSlots.length <= MAX_INITIAL_INTELLIGENT_SLOTS) {
    return {
      slots: chronologicalSlots,
      moreSlots: [],
      hasMore: false
    };
  }

  const selectedKeys = new Set(
    chronologicalSlots
      .map((slot) => scoreAvailabilitySlot({
        slot,
        existingBusyBlocks: params.existingBusyBlocks,
        businessHours: params.businessHours,
        serviceDurationMinutes: params.serviceDurationMinutes,
        timeZone: params.timeZone
      }))
      .sort((left, right) =>
        right.score - left.score
        || Math.abs(left.startMinutes % PREFERRED_DISPLAY_INTERVAL_MINUTES)
          - Math.abs(right.startMinutes % PREFERRED_DISPLAY_INTERVAL_MINUTES)
        || left.slot.start.localeCompare(right.slot.start)
      )
      .slice(0, MAX_INITIAL_INTELLIGENT_SLOTS)
      .map((scoredSlot) => scoredSlot.slot.start)
  );

  const slots = chronologicalSlots.filter((slot) => selectedKeys.has(slot.start));
  const moreSlots = chronologicalSlots.filter((slot) => !selectedKeys.has(slot.start));

  return {
    slots,
    moreSlots,
    hasMore: moreSlots.length > 0
  };
};
