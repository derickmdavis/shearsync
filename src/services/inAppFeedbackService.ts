import { requireFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { supabaseAdmin } from "../lib/supabase";
import type { InAppFeedback } from "../types/api";
import { handleSupabaseError, type Row } from "./db";

interface InAppFeedbackRow extends Row {
  id: string;
  user_id: string;
  rating: number;
  feedback_text: string | null;
  created_at: string;
}

export interface CreateInAppFeedbackInput {
  rating: number;
  feedbackText?: string | null;
}

const normalizeFeedbackText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const toInAppFeedback = (row: InAppFeedbackRow): InAppFeedback => ({
  id: row.id,
  rating: row.rating,
  feedbackText: row.feedback_text,
  createdAt: row.created_at
});

export const inAppFeedbackService = {
  async createForUser(userId: string, input: CreateInAppFeedbackInput): Promise<InAppFeedback> {
    const { data, error } = await supabaseAdmin
      .from("in_app_feedback")
      .insert({
        user_id: userId,
        rating: input.rating,
        feedback_text: normalizeFeedbackText(input.feedbackText),
        source: "mobile_app"
      })
      .select("id, user_id, rating, feedback_text, created_at")
      .single();

    handleSupabaseError(error, "Unable to submit feedback");
    const feedback = toInAppFeedback(requireFound(data as InAppFeedbackRow | null, "Feedback was not created"));

    logger.info("in_app_feedback_submitted", {
      feedbackId: feedback.id,
      userId,
      rating: feedback.rating
    });

    return feedback;
  }
};
