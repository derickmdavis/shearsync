# Frontend Clients List Contract

## Endpoint

`GET /api/clients`

Auth is required. Results are always scoped to the authenticated stylist/business on the backend.

## Query Parameters

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `search` | string | omitted | Optional. 1-200 chars after trimming. Searches client name, preferred name, email, phone, normalized phone, Instagram, notes, and exact tag matches. |
| `page` | number | `1` | 1-based page number. |
| `pageSize` | number | `25` | Max `100`. Use `25` for normal list/search UI. |
| `sort` | string | `updated_at` | Supported: `updated`, `updated_at`, `name`, `spend`, `total_spend`, `last_visit`, `last_visit_at`. |
| `direction` | string | `desc` | Supported: `asc`, `desc`. |
| `filter` | string | `all` | Supported: `all`, `active`, `vip`. `active` currently means all non-deleted clients because clients do not have an archive/status column yet. |

Example:

```http
GET /api/clients?search=maria&page=1&pageSize=25&sort=spend&direction=desc&filter=vip
```

## Response Shape

```ts
type ClientsListResponse = {
  data: ClientRecord[];
  page: number;
  pageSize: number;
  totalCount: number;
  nextCursor: string | null;
};
```

`nextCursor` is a stringified next page number for now. Treat it as opaque on the frontend. If it is `null`, there is no next page.

## Client Fields

Each `ClientRecord` includes persisted client fields plus the existing summary metadata:

```ts
type ClientRecord = {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  instagram: string | null;
  birthday: string | null;
  notes: string | null;
  preferred_contact_method: "text" | "call" | "email" | "instagram" | null;
  tags: string[] | null;
  source: "referral" | "instagram" | "walk-in" | "existing-client" | "other" | null;
  reminder_consent: boolean | null;
  total_spend: number | string | null;
  last_visit_at: string | null;
  created_at: string;
  updated_at: string;
  next_appointment_at: string | null;
  has_future_appointment: boolean;
  needs_rebook: boolean;
  last_service: string | null;
};
```

`total_spend` may arrive as a string from Supabase/Postgres numeric serialization. The UI should normalize it before numeric formatting.

## Frontend Behavior

- Do not fetch all clients to search locally.
- Keep list state in the URL or component state: `search`, `page`, `pageSize`, `sort`, `direction`, `filter`.
- Debounce `search` input, ideally 250-400ms.
- Reset `page` to `1` whenever `search`, `filter`, `sort`, or `direction` changes.
- Keep previous data visible while a new page/search request is loading if the frontend data library supports it.
- Use `totalCount` for "showing X-Y of Z" and page count.
- Use `nextCursor !== null` or `page * pageSize < totalCount` to enable the next-page control.
- Send no `search` param for an empty search box.

## Filter Notes

Backend-backed today:

- `all`: all authenticated stylist-owned clients.
- `active`: same as `all` until a client archive/status field exists.
- `vip`: clients whose `tags` contains `VIP` or `vip`.

Not yet accepted by `GET /api/clients`:

- `needs_rebook`
- `needs_follow_up`
- `has_future_appointment`

Those require SQL-backed summary state or dedicated filter queries before they can be paginated correctly. The response still includes `needs_rebook` and `has_future_appointment` for each returned row, but the frontend should not expect backend filtering on those values yet.

## Recommended Request Builder

```ts
const params = new URLSearchParams();

if (search.trim()) params.set("search", search.trim());
params.set("page", String(page));
params.set("pageSize", String(pageSize));
params.set("sort", sort);
params.set("direction", direction);
params.set("filter", filter);

const response = await api.get<ClientsListResponse>(`/api/clients?${params}`);
```

## Compatibility

Existing consumers that only read `response.data` can continue to do so. New clients should use the pagination metadata and stop assuming `data` contains every client.
