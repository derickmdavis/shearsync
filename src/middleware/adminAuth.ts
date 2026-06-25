import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";

const normalizeEmail = (value: string | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

export const requireAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  const email = normalizeEmail(req.auth?.email);
  const userId = req.auth?.userId;

  if (!email || !userId) {
    next(new ApiError(403, "Admin access required"));
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("email, is_active")
    .eq("email", email)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    next(new ApiError(500, "Unable to validate admin access"));
    return;
  }

  if (!data) {
    next(new ApiError(403, "Admin access required"));
    return;
  }

  req.admin = {
    email,
    userId
  };

  next();
};
