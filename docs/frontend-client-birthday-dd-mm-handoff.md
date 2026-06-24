# Client Birthday DD/MM Frontend Handoff

This handoff covers the frontend changes for storing client birthdays as day/month only instead of full dates.

## Goal

Client birthdays no longer include a birth year.

The frontend should send and display birthdays as:

```txt
DD/MM
```

Examples:

- `12/05`
- `04/01`
- `29/02`

Do not send full dates like `1994-05-12`.

## Backend Contract

Affected client endpoints:

```http
GET /api/clients
GET /api/clients/:id
POST /api/clients
PATCH /api/clients/:id
```

The `birthday` field is:

```ts
type ClientBirthday = string | null; // DD/MM
```

Create/update request examples:

```ts
type CreateOrUpdateClientRequest = {
  birthday?: "12/05" | null;
};
```

Use `null` to clear a birthday. Omit `birthday` when the form did not change it.

## Validation Rules

Backend validation accepts only valid `DD/MM` values:

- Must be exactly two digits, slash, two digits.
- Day must be valid for that month.
- `29/02` is valid.
- `31/02`, `31/04`, `00/12`, `12/00`, and `1994-05-12` are invalid.

Recommended frontend validation:

```ts
function isValidBirthday(value: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;

  const day = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12 || day < 1) return false;

  const lastDay = new Date(Date.UTC(2024, month, 0)).getUTCDate();
  return day <= lastDay;
}
```

Use leap year `2024` so `29/02` remains valid.

## Form UI

Recommended input behavior:

- Use separate day and month controls if possible.
- If using one text input, mask or format as `DD/MM`.
- Preserve leading zeroes.
- Show a concise error such as `Enter a valid birthday as DD/MM`.

Suggested labels:

- Field label: `Birthday`
- Placeholder: `DD/MM`
- Helper text: `Day and month only`

Avoid asking for or storing year of birth.

## Display UI

Client rows/details now receive:

```ts
birthday: "12/05" | null
```

Recommended display options:

- Compact CRM lists: `12/05`
- Friendlier detail surfaces: convert to `May 12`

Example formatter:

```ts
function formatBirthdayLabel(birthday: string | null): string | null {
  if (!birthday || !isValidBirthday(birthday)) return null;

  const [dayText, monthText] = birthday.split("/");
  const date = new Date(Date.UTC(2024, Number(monthText) - 1, Number(dayText)));

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  }).format(date);
}
```

## Upcoming Birthday Reminders

Endpoint:

```http
GET /api/reminders/birthdays?window_days=30&limit=50
```

Response items now have mixed birthday/date fields:

```ts
type UpcomingBirthdayReminder = {
  client_id: string;
  client_name: string;
  birthday: string; // DD/MM
  next_birthday: string; // YYYY-MM-DD occurrence date
  days_until: number;
  turning_age: null;
  reminder_consent: boolean | null;
  preferred_contact_method: "text" | "call" | "email" | "instagram" | null;
  phone: string | null;
  email: string | null;
};
```

Important distinctions:

- `birthday` is the stored day/month value.
- `next_birthday` is the computed next calendar occurrence and can be used for sorting/date labels.
- `turning_age` is always `null` because the backend no longer stores a birth year.

Recommended UI:

- Remove age copy such as `turning 32`.
- Use `days_until` and/or `next_birthday` for timing copy.
- Use backend-provided ordering if rendering the returned list directly.

## Migration Notes

Existing saved birthdays were migrated from full dates to `DD/MM`.

Frontend code should remove assumptions that:

- `birthday` can be parsed by `new Date(birthday)`.
- `birthday` is ISO `YYYY-MM-DD`.
- a birthday includes a year.
- age can be calculated from `birthday`.

If old cached data can exist locally, either clear that cache after deploy or normalize legacy `YYYY-MM-DD` values client-side before editing:

```ts
function normalizeBirthdayForForm(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{2}\/\d{2}$/.test(value)) return value;

  const legacy = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (legacy) {
    return `${legacy[3]}/${legacy[2]}`;
  }

  return null;
}
```

This compatibility helper is only for local stale data or defensive form hydration. New API writes should use `DD/MM`.
