# Frontend Auth and Signup Handoff

This document describes the client contract for the new sign-in and sign-up
flow. It supplements the [Account Access Handoff](frontend-account-access-handoff.md),
which remains the source for inactive-account and product-route behavior.

## Release dependency

The signup contract is live only after both database migrations and the API
deployment are in production:

1. `202605190001_auth_user_booking_bootstrap.sql` creates the `auth.users`
   provisioning trigger.
2. `202608180007_require_unique_user_phone_and_signup_trial.sql` makes phone
   numbers required and unique, and updates that trigger to create the trial.

Until both are applied, do not treat a successful Supabase auth signup as a
guarantee that the account can enter the app.

The mobile/web Supabase URL and anon key must point to the same production
Supabase project configured by the API. The API validates the Supabase access
token before it accepts authenticated requests; a token from another project
will not work.

## Signup request

Create the Supabase auth user with these exact metadata keys:

```ts
const { data, error } = await supabase.auth.signUp({
  email: email.trim(),
  password,
  options: {
    data: {
      full_name: fullName.trim(),
      business_name: businessName.trim(),
      phone_number: phoneNumber.trim()
    }
  }
});
```

Use a single `full_name` field. Do **not** split the owner name into first and
last name: the account profile stores `full_name`. (Client records are a
separate model and may use first/last name fields.)

`phone_number` is required and unique across accounts. Accept either a normal
US 10-digit number (for example `(303) 555-1234`), an 11-digit US number
beginning with `1`, or a real E.164 number such as `+442071838750`. The backend
stores it canonically as E.164; `(303) 555-1234` becomes `+13035551234`.
Validate that a supplied E.164 country code does not start with `0` and is 10
through 15 digits after the `+`.

Do not create client-side placeholder numbers. The `+999…` numbers created by
the migration are legacy-only, non-routable remediation values—not valid
signup input.

## What a successful auth signup provisions

The `auth.users` insert trigger creates the required records in the same
database transaction:

- the owner profile (`public.users`) with the supplied name, business name,
  and normalized phone number;
- `account_status: "active"`;
- `activated_at` set to the signup time;
- `current_period_ends_at` set to 15 days after signup;
- `deactivated_at: null`;
- a stylist/public-booking record and default booking rules.

The account starts with no services, clients, or appointments. Show the normal
empty-state/onboarding experience after access is confirmed.

The backend enforces phone presence and uniqueness. For any signup failure,
show a friendly non-enumerating message such as: “We couldn’t create your
account. Check your phone number or try a different one.” Do not surface raw
database/trigger error text or claim which email or phone is already in use.

## Email confirmation behavior

If Supabase **Confirm email** is enabled, `signUp` can successfully return a
user while returning no session. This is not a signup error.

In that case:

1. Show a “Check your email to confirm your account” screen.
2. Do not call authenticated API routes or enter the product app yet.
3. When the user confirms and a `SIGNED_IN` session is available (either via
   the confirmation redirect or a later normal sign-in), continue with the
   access gate below.

The provisioning trigger runs when Supabase creates the auth user, so the
profile and 15-day trial already exist while confirmation is pending. The
client should preserve enough local navigation intent to resume onboarding
after confirmation; it must not rely only on an in-memory post-signup flag.

If email confirmation is disabled, `signUp` should return a session and the
client can immediately run the same access gate.

## Sign-in and session restoration

Sign in with Supabase password auth. For every API call, send the session
access token:

```http
Authorization: Bearer <supabase-access-token>
```

After password sign-in, confirmation redirect, or restored native session,
call the access endpoint **before** rendering the normal app or loading product
data:

```http
GET /api/account/access
Authorization: Bearer <supabase-access-token>
```

```ts
type AccountAccess = {
  status: "active" | "inactive";
  isActive: boolean;
  activatedAt: string | null;
  currentPeriodEndsAt: string | null;
  deactivatedAt: string | null;
};

// API response: { data: AccountAccess }
```

`data.isActive` is the only access decision the client should use. Do not
calculate expiry using the device clock or cached profile data.

## Trial expiry and inactive handling

When an active trial reaches `currentPeriodEndsAt`, the backend makes the
account inactive on the next access evaluation. A daily backend job also
updates expired dormant accounts. The UI does not need to wait for that job:
the access endpoint is authoritative immediately after expiry.

- If `isActive` is `true`, enter the normal app.
- If `isActive` is `false`, route to the inactive-account/renewal screen and
  do not start product queries.
- If a product request returns `403` with
  `error.details.code === "account_inactive"`, clear product query cache,
  refetch access once, and route to the inactive screen.
- Handle `401` as a session refresh/sign-in issue, not an inactive-account
  issue.

For now, inactive accounts are blocked from normal product APIs, including
clients, appointments, and settings. The planned read-only experience has not
been released yet, so do not build an editable or partial normal app for an
inactive account.

## Updating a profile phone number

For later profile edits, use the existing endpoint:

```http
PATCH /api/settings/profile
Authorization: Bearer <supabase-access-token>
Content-Type: application/json

{ "phone_number": "(303) 555-1234" }
```

It applies the same canonicalization and returns the updated profile in
`{ data: ... }`. Update local profile state from the server response, so it
shows the canonical `+13035551234` value. A phone number cannot be cleared or
set to a number currently used by another account.

## Still frontend work

- Treat a no-session signup under email confirmation as a confirmation state,
  not an error, and resume onboarding after a session exists.
- Implement Forgot Password with Supabase’s password-reset flow; there is no
  separate API endpoint for it.
- Persist onboarding progress if users should be able to resume after closing
  the app during onboarding.
- Add integration coverage for a new signup, confirmation-required signup,
  restored session, invalid/duplicate phone, and expired/inactive account.

## QA checklist

1. Create a new account with all three metadata fields and a valid unique phone
   number; verify `/api/account/access` returns `active`, `isActive: true`,
   `deactivatedAt: null`, and a period end about 15 days ahead.
2. Verify both formatted US input and E.164 input work, and that the returned
   profile phone is canonical E.164.
3. Verify missing, malformed, or duplicate numbers show a safe signup error
   and never enter the app.
4. With email confirmation enabled, verify signup shows confirmation UI rather
   than an error, then confirmation/sign-in continues through the access gate.
5. Verify an expired account reaches the inactive screen before any product
   data loads, and a later `403 account_inactive` redirects there as well.
