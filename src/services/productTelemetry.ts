import type { RecordProductEventInput } from "./productEventsService";
import { productEventsService } from "./productEventsService";

export const recordProductTelemetry = async (input: RecordProductEventInput): Promise<void> => {
  try {
    await productEventsService.recordProductEvent(input);
  } catch (error) {
    console.warn("[PRODUCT_TELEMETRY] record failed", {
      eventType: input.eventType,
      accountUserId: input.accountUserId ?? null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
