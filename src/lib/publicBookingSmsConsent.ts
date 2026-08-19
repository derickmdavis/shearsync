/**
 * This copy must stay synchronized with the disclosure next to the public
 * booking checkbox. The browser submits only an affirmative boolean; the API
 * owns the recorded disclosure so a client cannot choose the audit text.
 */
export const publicBookingSmsConsent = {
  version: "public-booking-appointment-sms-v1",
  text: "I agree to receive appointment-related text messages. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our Terms of Service."
} as const;
