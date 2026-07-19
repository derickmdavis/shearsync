import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { hashToken } from "./communications";
import { ApiError } from "./errors";

const ISSUER = "shearsync-campaign-validation";
const AUDIENCE = "campaign-submission";
const TYPE = "campaign_validation";
export const CAMPAIGN_VALIDATION_TOKEN_TTL_SECONDS = 15 * 60;

interface CampaignValidationClaims extends jwt.JwtPayload {
  typ: typeof TYPE;
  campaign_id: string;
  user_id: string;
  revision: number;
  nonce: string;
  submission_hash: string;
}

const secret = (): string => env.SUPABASE_JWT_SECRET ?? env.SUPABASE_SERVICE_ROLE_KEY;

export const createCampaignValidationToken = (claims: Omit<CampaignValidationClaims, keyof jwt.JwtPayload | "typ">): string =>
  jwt.sign({ typ: TYPE, ...claims }, secret(), {
    algorithm: "HS256",
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: CAMPAIGN_VALIDATION_TOKEN_TTL_SECONDS
  });

export const verifyCampaignValidationToken = (
  token: string,
  expected: Pick<CampaignValidationClaims, "campaign_id" | "user_id" | "revision" | "submission_hash"> & {
    validation_nonce_hash: string | null;
  }
): Pick<CampaignValidationClaims, "nonce" | "submission_hash"> => {
  try {
    const claims = jwt.verify(token, secret(), {
      algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE
    }) as CampaignValidationClaims;
    if (
      claims.typ !== TYPE
      || claims.campaign_id !== expected.campaign_id
      || claims.user_id !== expected.user_id
      || claims.revision !== expected.revision
      || claims.submission_hash !== expected.submission_hash
      || !expected.validation_nonce_hash
      || hashToken(claims.nonce) !== expected.validation_nonce_hash
    ) {
      throw new Error("mismatch");
    }
    return { nonce: claims.nonce, submission_hash: claims.submission_hash };
  } catch {
    throw new ApiError(409, "Campaign validation is invalid, expired, or no longer matches this draft");
  }
};
