# Activity Referral Stats Contract

This endpoint powers referral metrics on the Activity surface without expanding the general Activity dashboard payload.

## Endpoint

```http
GET /api/activity/referrals?range=this_month
```

Authentication is required.

`range` is optional and currently supports only `this_month`. Month boundaries use the stylist's business timezone.

## Response

```ts
{
  data: {
    hasReferralData: boolean;
    range: "this_month";
    newClientsFromReferrals: number;
    appointmentsBookedFromReferrals: number;
    revenueFromReferrals: number;
    bookedValueFromReferrals: number;
    referralConversionRate: number;
    linksSent: number;
    linksClicked: number;
    topReferrer: {
      clientId: string;
      displayName: string;
      referralCount: number;
    } | null;
  };
}
```

## Metric Definitions

- `linksSent`: referral links created during the range.
- `linksClicked`: successful public referral resolutions during the range.
- `newClientsFromReferrals`: new client rows first attributed to a referral during the range.
- `appointmentsBookedFromReferrals`: non-cancelled appointments attributed to referrals during the range.
- `bookedValueFromReferrals`: sum of `price` for non-cancelled referred appointments in the range.
- `revenueFromReferrals`: sum of `price` for completed referred appointments in the range.
- `referralConversionRate`: `appointmentsBookedFromReferrals / linksClicked`, or `0` when there are no clicks.
- `topReferrer`: the client with the most non-cancelled referred appointments in the range. If there are no appointments but referred clients exist, it falls back to referred client attribution.

Use `hasReferralData` to decide whether to render an empty state.
