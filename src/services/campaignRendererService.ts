import { ApiError } from "../lib/errors";
import {
  CAMPAIGN_MISSING_FIRST_NAME_FALLBACK,
  type CampaignLinkType
} from "../lib/outreachContracts";
import { extractCampaignTokens } from "../validators/outreachValidators";

export const CAMPAIGN_RENDER_VERSION = 1;

export interface CampaignRenderLinks {
  primary_url: string;
  unsubscribe_url: string;
  preferences_url: string;
}

export interface CampaignRenderResult {
  render_version: number;
  subject: string;
  text: string;
  html: string;
  automatic_section: {
    kind: CampaignLinkType;
    text: string;
    html: string;
  };
  preference_controls: {
    text: string;
    html: string;
  };
  used_missing_first_name_fallback: boolean;
}

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");

const toHtmlParagraphs = (value: string): string => value
  .split(/\r?\n\r?\n/)
  .filter((paragraph) => paragraph.length > 0)
  .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
  .join("");

const assertSupportedTokens = (value: string): void => {
  const unsupported = extractCampaignTokens(value).find((token) => token !== "first_name");
  if (unsupported) {
    throw new ApiError(400, `Unsupported campaign personalization token: ${unsupported}`);
  }
};

const replaceFirstName = (value: string, firstName: string): string =>
  value.replace(/{{\s*first_name\s*}}/g, firstName);

export const campaignRendererService = {
  render(input: {
    subject: string;
    message: string;
    linkType: CampaignLinkType;
    firstName?: string | null;
    links: CampaignRenderLinks;
  }): CampaignRenderResult {
    assertSupportedTokens(input.subject);
    assertSupportedTokens(input.message);

    const suppliedFirstName = input.firstName?.trim() ?? "";
    const firstName = suppliedFirstName || CAMPAIGN_MISSING_FIRST_NAME_FALLBACK;
    const usedFallback = suppliedFirstName.length === 0;
    const subject = replaceFirstName(input.subject, firstName);
    const message = replaceFirstName(input.message, firstName);
    const actionLabel = input.linkType === "booking_link"
      ? "Book your next appointment"
      : "Share your personal referral link";
    const automaticText = `${actionLabel}: ${input.links.primary_url}`;
    const automaticHtml = `<p><a href="${escapeHtml(input.links.primary_url)}">${escapeHtml(actionLabel)}</a></p>`;
    const controlsText = `Unsubscribe: ${input.links.unsubscribe_url}\nManage preferences: ${input.links.preferences_url}`;
    const controlsHtml = `<p><a href="${escapeHtml(input.links.unsubscribe_url)}">Unsubscribe</a> · <a href="${escapeHtml(input.links.preferences_url)}">Manage preferences</a></p>`;

    return {
      render_version: CAMPAIGN_RENDER_VERSION,
      subject,
      text: [message, automaticText, controlsText].join("\n\n"),
      html: [toHtmlParagraphs(message), automaticHtml, controlsHtml].join(""),
      automatic_section: { kind: input.linkType, text: automaticText, html: automaticHtml },
      preference_controls: { text: controlsText, html: controlsHtml },
      used_missing_first_name_fallback: usedFallback
    };
  }
};
