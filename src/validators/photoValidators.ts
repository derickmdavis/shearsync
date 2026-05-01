import { z } from "zod";

export const createPhotoSchema = z.object({
  client_id: z.string().uuid(),
  file_path: z.string().min(1).max(1000),
  photo_type: z.enum(["before", "after", "inspiration", "other"]).default("other"),
  caption: z.string().max(1000).optional()
});

