import { randomUUID } from "crypto";
import { mock } from "node:test";
import { supabaseAdmin } from "../../lib/supabase";

type TableRow = Record<string, unknown>;
type TableState = Record<string, TableRow[]>;
type QueryLogEntry = { table: string; operation: "in"; column: string; values: unknown[] };
interface MockSupabaseOptions {
  queryLog?: QueryLogEntry[];
}
type SortDirection = { column: string; ascending: boolean };
type Filter =
  | { type: "eq"; column: string; value: unknown }
  | { type: "is"; column: string; value: unknown }
  | { type: "not"; column: string; operator: "is"; value: unknown }
  | { type: "neq"; column: string; value: unknown }
  | { type: "in"; column: string; values: unknown[] }
  | { type: "gte"; column: string; value: unknown }
  | { type: "gt"; column: string; value: unknown }
  | { type: "lte"; column: string; value: unknown }
  | { type: "lt"; column: string; value: unknown }
  | { type: "or"; conditions: OrFilter[] };
type SimpleOrFilter = { column: string; operator: "eq" | "neq" | "gte" | "gt" | "lte" | "lt" | "ilike" | "cs"; value: string };
type OrFilter = SimpleOrFilter | { type: "and"; conditions: SimpleOrFilter[] };

interface SelectOptions {
  count?: "exact";
  head?: boolean;
}

interface UpsertOptions {
  onConflict?: string;
}

const cloneRow = <T extends TableRow>(row: T): T => ({ ...row });

const cloneState = (state: TableState): TableState =>
  Object.fromEntries(Object.entries(state).map(([table, rows]) => [table, rows.map((row) => cloneRow(row))]));

const restoreState = (state: TableState, snapshot: TableState): void => {
  for (const table of Object.keys(state)) {
    delete state[table];
  }

  for (const [table, rows] of Object.entries(snapshot)) {
    state[table] = rows.map((row) => cloneRow(row));
  }
};

const splitTopLevel = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
};

const parseSimpleOrFilter = (filter: string): SimpleOrFilter | null => {
  const match = /^([^.]*)\.(eq|neq|gte|gt|lte|lt|ilike|cs)\.(.*)$/.exec(filter);
  if (!match) {
    return null;
  }

  const [, column, operator, rawValue] = match;
  const value = operator === "cs"
    ? rawValue.replace(/^\{"/, "").replace(/"\}$/, "").replace(/^\{/, "").replace(/\}$/, "")
    : rawValue;

  return { column, operator: operator as SimpleOrFilter["operator"], value };
};

const parseOrFilter = (filter: string): OrFilter | null => {
  if (filter.startsWith("and(") && filter.endsWith(")")) {
    const conditions = splitTopLevel(filter.slice(4, -1))
      .map((condition) => parseSimpleOrFilter(condition.trim()))
      .filter((condition): condition is SimpleOrFilter => condition !== null);

    return conditions.length > 0 ? { type: "and", conditions } : null;
  }

  return parseSimpleOrFilter(filter);
};

const isAndOrFilter = (filter: OrFilter): filter is { type: "and"; conditions: SimpleOrFilter[] } =>
  "type" in filter && filter.type === "and";

class MockQueryBuilder implements PromiseLike<{ data: unknown; error: null; count?: number | null }> {
  private action: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private sorts: SortDirection[] = [];
  private limitCount?: number;
  private rangeStart?: number;
  private rangeEnd?: number;
  private singleMode: "many" | "single" | "maybeSingle" = "many";
  private pendingInsert: TableRow[] = [];
  private upsertOptions: UpsertOptions = {};
  private pendingUpdate: TableRow | null = null;
  private selectOptions: SelectOptions = {};

  constructor(
    private readonly state: TableState,
    private readonly table: string,
    private readonly options: MockSupabaseOptions = {}
  ) {}

  select(_columns = "*", options?: SelectOptions) {
    this.selectOptions = options ?? {};
    return this;
  }

  insert(payload: TableRow | TableRow[]) {
    this.action = "insert";
    this.pendingInsert = (Array.isArray(payload) ? payload : [payload]).map((row) => cloneRow(row));
    return this;
  }

  upsert(payload: TableRow | TableRow[], options?: UpsertOptions) {
    this.action = "upsert";
    this.pendingInsert = (Array.isArray(payload) ? payload : [payload]).map((row) => cloneRow(row));
    this.upsertOptions = options ?? {};
    return this;
  }

  update(payload: TableRow) {
    this.action = "update";
    this.pendingUpdate = cloneRow(payload);
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ type: "eq", column, value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ type: "is", column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    if (operator === "is") {
      this.filters.push({ type: "not", column, operator, value });
    }

    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ type: "neq", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.options.queryLog?.push({ table: this.table, operation: "in", column, values: [...values] });
    this.filters.push({ type: "in", column, values });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ type: "gte", column, value });
    return this;
  }

  gt(column: string, value: unknown) {
    this.filters.push({ type: "gt", column, value });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ type: "lte", column, value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ type: "lt", column, value });
    return this;
  }

  or(filters: string) {
    const conditions = splitTopLevel(filters)
      .map((filter) => parseOrFilter(filter.trim()))
      .filter((filter): filter is OrFilter => filter !== null);

    this.filters.push({ type: "or", conditions });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.sorts.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  range(start: number, end: number) {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }

  single() {
    this.singleMode = "single";
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  then<TResult1 = { data: unknown; error: null; count?: number | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute() {
    switch (this.action) {
      case "insert":
        return this.executeInsert();
      case "upsert":
        return this.executeUpsert();
      case "update":
        return this.executeUpdate();
      case "delete":
        return this.executeDelete();
      default:
        return this.executeSelect();
    }
  }

  private getTableRows(): TableRow[] {
    if (!this.state[this.table]) {
      this.state[this.table] = [];
    }

    return this.state[this.table];
  }

  private applyFilters(rows: TableRow[]): TableRow[] {
    return rows.filter((row) =>
      this.filters.every((filter) => {
        switch (filter.type) {
          case "eq":
            return row[filter.column] === filter.value;
          case "is":
            if (filter.value === null) {
              return row[filter.column] === null || row[filter.column] === undefined;
            }

            return row[filter.column] === filter.value;
          case "not":
            if (filter.operator === "is" && filter.value === null) {
              return row[filter.column] !== null && row[filter.column] !== undefined;
            }

            return row[filter.column] !== filter.value;
          case "neq":
            return row[filter.column] !== filter.value;
          case "in":
            return filter.values.includes(row[filter.column]);
          case "gte":
            return String(row[filter.column] ?? "") >= String(filter.value ?? "");
          case "gt":
            return String(row[filter.column] ?? "") > String(filter.value ?? "");
          case "lte":
            return String(row[filter.column] ?? "") <= String(filter.value ?? "");
          case "lt":
            return String(row[filter.column] ?? "") < String(filter.value ?? "");
          case "or":
            return filter.conditions.some((condition) => this.matchesOrFilter(row, condition));
        }
      })
    );
  }

  private matchesOrFilter(row: TableRow, filter: OrFilter): boolean {
    if (isAndOrFilter(filter)) {
      return filter.conditions.every((condition) => this.matchesSimpleOrFilter(row, condition));
    }

    return this.matchesSimpleOrFilter(row, filter);
  }

  private matchesSimpleOrFilter(row: TableRow, filter: SimpleOrFilter): boolean {
    const value = row[filter.column];

    if (filter.operator === "ilike") {
      const pattern = filter.value.replace(/^%/, "").replace(/%$/, "").toLowerCase();
      return String(value ?? "").toLowerCase().includes(pattern);
    }

    if (filter.operator === "cs") {
      if (!Array.isArray(value)) {
        return false;
      }

      return value.some((item) => String(item) === filter.value);
    }

    const rowValue = String(value ?? "");
    switch (filter.operator) {
      case "eq":
        return rowValue === filter.value;
      case "neq":
        return rowValue !== filter.value;
      case "gte":
        return rowValue >= filter.value;
      case "gt":
        return rowValue > filter.value;
      case "lte":
        return rowValue <= filter.value;
      case "lt":
        return rowValue < filter.value;
    }
  }

  private applySorts(rows: TableRow[]): TableRow[] {
    if (this.sorts.length === 0) {
      return rows;
    }

    return [...rows].sort((left, right) => {
      for (const sort of this.sorts) {
        const leftValue = left[sort.column];
        const rightValue = right[sort.column];

        if (leftValue === rightValue) {
          continue;
        }

        if (leftValue === undefined || leftValue === null) {
          return sort.ascending ? 1 : -1;
        }

        if (rightValue === undefined || rightValue === null) {
          return sort.ascending ? -1 : 1;
        }

        if (leftValue < rightValue) {
          return sort.ascending ? -1 : 1;
        }

        if (leftValue > rightValue) {
          return sort.ascending ? 1 : -1;
        }
      }

      return 0;
    });
  }

  private finalizeRows(rows: TableRow[]) {
    const sortedRows = this.applySorts(rows);
    const rangedRows =
      this.rangeStart !== undefined && this.rangeEnd !== undefined
        ? sortedRows.slice(this.rangeStart, this.rangeEnd + 1)
        : sortedRows;
    const limitedRows = this.limitCount !== undefined ? rangedRows.slice(0, this.limitCount) : rangedRows;

    if (this.singleMode === "single") {
      return {
        data: limitedRows[0] ?? null,
        error: null
      };
    }

    if (this.singleMode === "maybeSingle") {
      return {
        data: limitedRows[0] ?? null,
        error: null
      };
    }

    if (this.selectOptions.head) {
      return {
        data: null,
        error: null,
        count: sortedRows.length
      };
    }

    return {
      data: limitedRows.map((row) => cloneRow(row)),
      error: null,
      count: this.selectOptions.count === "exact" ? sortedRows.length : undefined
    };
  }

  private executeSelect() {
    return this.finalizeRows(this.applyFilters(this.getTableRows()));
  }

  private executeInsert() {
    const tableRows = this.getTableRows();
    const insertedRows = this.pendingInsert.map((row) => {
      const nextRow = {
        id: row.id ?? randomUUID(),
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
        ...row
      };
      tableRows.push(nextRow);
      return nextRow;
    });

    return this.finalizeRows(insertedRows);
  }

  private executeUpsert() {
    const tableRows = this.getTableRows();
    const conflictColumns = (this.upsertOptions.onConflict ?? "id")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    const upsertedRows = this.pendingInsert.map((row) => {
      const existingRow = tableRows.find((candidate) =>
        conflictColumns.length > 0
        && conflictColumns.every((column) => candidate[column] === row[column])
      );

      if (existingRow) {
        Object.assign(existingRow, row, { updated_at: new Date().toISOString() });
        return existingRow;
      }

      const nextRow = {
        id: row.id ?? randomUUID(),
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
        ...row
      };
      tableRows.push(nextRow);
      return nextRow;
    });

    return this.finalizeRows(upsertedRows);
  }

  private executeUpdate() {
    const matchingRows = this.applyFilters(this.getTableRows());
    const updatedRows = matchingRows.map((row) => {
      Object.assign(row, this.pendingUpdate ?? {}, { updated_at: new Date().toISOString() });
      return row;
    });

    return this.finalizeRows(updatedRows);
  }

  private executeDelete() {
    const tableRows = this.getTableRows();
    const matchingRows = this.applyFilters(tableRows);
    const idsToDelete = new Set(matchingRows.map((row) => row.id));
    this.state[this.table] = tableRows.filter((row) => !idsToDelete.has(row.id));
    return this.finalizeRows(matchingRows);
  }
}

const getRows = (state: TableState, table: string): TableRow[] => {
  if (!state[table]) {
    state[table] = [];
  }

  return state[table];
};

const upsertByUserId = (state: TableState, table: string, row: TableRow): TableRow => {
  const rows = getRows(state, table);
  const existing = rows.find((candidate) => candidate.user_id === row.user_id);
  const timestamp = new Date().toISOString();

  if (existing) {
    Object.assign(existing, row, { updated_at: timestamp });
    return existing;
  }

  const nextRow = {
    created_at: timestamp,
    updated_at: timestamp,
    ...row
  };
  rows.push(nextRow);
  return nextRow;
};

const executeClientsListRpc = (state: TableState, args: Record<string, unknown>) => {
  const userId = String(args.p_user_id ?? "");
  const search = typeof args.p_search === "string" ? args.p_search.trim().toLowerCase() : "";
  const page = Math.max(1, Number(args.p_page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(args.p_page_size ?? 25)));
  const filter = String(args.p_filter ?? "all");
  const sort = String(args.p_sort ?? "updated_at");
  const direction = String(args.p_direction ?? "desc") === "asc" ? 1 : -1;
  const now = new Date();
  const settings = getRows(state, "rebook_nudge_settings").find((row) => row.user_id === userId);
  const defaultIntervalDays = Number(settings?.default_rebook_interval_days ?? 90);
  const timeZone = String(getRows(state, "users").find((row) => row.id === userId)?.timezone ?? "America/Denver");
  const getYearInTimeZone = (instant: Date): number => Number(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric"
  }).formatToParts(instant).find((part) => part.type === "year")?.value);
  const currentYear = getYearInTimeZone(now);

  const matchesSearch = (client: TableRow): boolean => {
    if (!search) return true;
    const fields = ["first_name", "last_name", "preferred_name", "email", "phone", "phone_normalized", "instagram", "notes"];
    return fields.some((field) => String(client[field] ?? "").toLowerCase().includes(search))
      || (Array.isArray(client.tags) && client.tags.some((tag) => String(tag).toLowerCase() === search));
  };

  const summarized: TableRow[] = getRows(state, "clients")
    .filter((client) => client.user_id === userId && !client.deleted_at && matchesSearch(client))
    .map((client) => {
      const appointments = getRows(state, "appointments")
        .filter((appointment) => appointment.user_id === userId && appointment.client_id === client.id);
      const completed = appointments
        .filter((appointment) => appointment.status === "completed" && new Date(String(appointment.appointment_date)).getTime() <= now.getTime())
        .sort((left, right) => String(left.appointment_date).localeCompare(String(right.appointment_date)));
      const upcoming = appointments
        .filter((appointment) => appointment.status !== "cancelled" && new Date(String(appointment.appointment_date)).getTime() > now.getTime())
        .sort((left, right) => String(left.appointment_date).localeCompare(String(right.appointment_date)));
      const preference = getRows(state, "client_rebooking_preferences")
        .find((row) => row.user_id === userId && row.client_id === client.id);
      const averageIntervalDays = completed.length > 1
        ? Math.round(completed.slice(1).reduce((sum, appointment, index) =>
          sum + (new Date(String(appointment.appointment_date)).getTime() - new Date(String(completed[index].appointment_date)).getTime()) / 86_400_000, 0
        ) / (completed.length - 1))
        : null;
      const lastCompleted = completed.at(-1);
      const nextAppointment = upcoming[0];
      const rebookIntervalDays = Number(preference?.preferred_interval_days ?? averageIntervalDays ?? defaultIntervalDays);
      const needsRebook = Boolean(lastCompleted)
        && !nextAppointment
        && new Date(String(lastCompleted?.appointment_date)).getTime() + rebookIntervalDays * 86_400_000 <= now.getTime();
      const completedSpend = completed.reduce((sum, appointment) => sum + Number(appointment.price ?? 0), 0);
      const totalSpend = completed.length > 0 ? completedSpend : Number(client.total_spend ?? 0);
      const firstCompleted = completed[0];

      return {
        ...cloneRow(client),
        total_spend: totalSpend,
        completed_visit_count: completed.length,
        first_completed_visit_at: firstCompleted?.appointment_date ?? null,
        last_completed_visit_at: lastCompleted?.appointment_date ?? null,
        next_appointment_at: nextAppointment?.appointment_date ?? null,
        has_future_appointment: Boolean(nextAppointment),
        needs_rebook: needsRebook,
        last_service: lastCompleted?.service_name ?? null,
        is_first_time: Boolean(firstCompleted)
          && getYearInTimeZone(new Date(String(firstCompleted?.appointment_date))) === currentYear
      };
    });

  const ranked = [...summarized].sort((left, right) =>
    Number(right.total_spend) - Number(left.total_spend) || String(left.id).localeCompare(String(right.id))
  );
  const topSpenderIds = new Set(ranked.slice(0, Math.ceil(ranked.length * 0.1)).map((client) => client.id));
  const topSpenders = ranked.filter((client) => topSpenderIds.has(client.id));
  const topSpenderThreshold = topSpenders.length > 0
    ? Math.min(...topSpenders.map((client) => Number(client.total_spend)))
    : 0;
  const insights = {
    overdue: {
      count: summarized.filter((client) => client.needs_rebook === true).length,
      supportingText: "Rebooking due"
    },
    firstTime: {
      count: summarized.filter((client) => client.is_first_time === true).length,
      supportingText: "This year"
    },
    topSpenders: {
      count: topSpenders.length,
      supportingText: `$${topSpenderThreshold.toFixed(2)}+ lifetime`,
      thresholdAmount: topSpenderThreshold,
      period: "lifetime",
      percentile: 10
    }
  };
  const filtered = summarized.filter((client) =>
    filter === "all" || filter === "active"
      || (filter === "vip" && client.is_vip === true)
      || (filter === "overdue" && client.needs_rebook === true)
      || (filter === "first_time" && client.is_first_time === true)
      || (filter === "top_spenders" && topSpenderIds.has(client.id))
  );
  const sorted = [...filtered].sort((left, right) => {
    const column = sort === "name" ? "last_name" : sort === "spend" ? "total_spend" : sort === "last_visit" ? "last_completed_visit_at" : sort;
    const first = left[column] ?? null;
    const second = right[column] ?? null;
    if (first === second) return String(left.id).localeCompare(String(right.id));
    if (first === null) return 1;
    if (second === null) return -1;
    return (first < second ? -1 : 1) * direction;
  });

  return {
    data: sorted.slice((page - 1) * pageSize, page * pageSize).map((client) => ({
      client: Object.fromEntries(Object.entries(client).filter(([key]) => key !== "is_first_time")),
      total_count: filtered.length,
      insights
    })),
    error: null
  };
};

const executeApprovalSettingsRpc = (state: TableState, functionName: string, args: Record<string, unknown>) => {
  const snapshot = cloneState(state);

  try {
    const userId = String(args.p_user_id ?? "");
    const approvalRequired = args.p_approval_required === true;
    const timestamp = new Date().toISOString();
    let settings: TableRow;

    switch (functionName) {
      case "create_campaign_draft": {
        const templateId = typeof args.p_template_id === "string" ? args.p_template_id : null;
        const template = templateId
          ? getRows(state, "campaign_templates").find((row) => row.id === templateId && row.active === true)
          : undefined;
        if (templateId && !template) throw new Error("campaign_template_not_found");
        const campaign = {
          id: randomUUID(),
          user_id: userId,
          name: null,
          status: "draft",
          campaign_kind: "one_time",
          send_mode: "now",
          scheduled_for: null,
          timezone_snapshot: args.p_timezone,
          link_type: template?.link_type ?? null,
          template_id: template?.id ?? null,
          template_version: template?.version ?? null,
          subject_snapshot: template?.subject ?? null,
          message_snapshot: template?.message ?? null,
          audience_mode: "everyone",
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp
        };
        getRows(state, "campaigns").push(campaign);
        getRows(state, "campaign_runs").push({
          id: randomUUID(), campaign_id: campaign.id, user_id: userId,
          sequence_number: 1, status: "draft", scheduled_for: null,
          created_at: timestamp, updated_at: timestamp
        });
        return { data: cloneRow(campaign), error: null };
      }

      case "update_campaign_draft": {
        const campaign = getRows(state, "campaigns").find((row) =>
          row.id === args.p_campaign_id && row.user_id === userId && row.status === "draft"
        );
        if (!campaign) throw new Error("campaign_draft_not_found");
        if (campaign.revision !== args.p_expected_revision) {
          return {
            data: null,
            error: {
              message: "campaign_revision_conflict",
              details: JSON.stringify({ current_revision: campaign.revision }),
              hint: null,
              code: "P0001"
            }
          };
        }
        const templateId = args.p_has_template && typeof args.p_template_id === "string" ? args.p_template_id : null;
        const template = templateId
          ? getRows(state, "campaign_templates").find((row) => row.id === templateId && row.active === true)
          : undefined;
        if (templateId && !template) throw new Error("campaign_template_not_found");

        if (args.p_has_name) campaign.name = typeof args.p_name === "string" && args.p_name.trim() ? args.p_name.trim() : null;
        if (args.p_has_send_mode) {
          campaign.send_mode = args.p_send_mode;
          if (args.p_send_mode === "now") campaign.scheduled_for = null;
        }
        if (args.p_has_scheduled_for) campaign.scheduled_for = args.p_scheduled_for;
        if (args.p_has_timezone) campaign.timezone_snapshot = args.p_timezone;
        if (args.p_has_template) {
          campaign.template_id = template?.id ?? null;
          campaign.template_version = template?.version ?? null;
          if (template) {
            campaign.link_type = template.link_type;
            campaign.subject_snapshot = template.subject;
            campaign.message_snapshot = template.message;
          }
        }
        if (args.p_has_link_type) campaign.link_type = args.p_link_type;
        if (args.p_has_subject) campaign.subject_snapshot = args.p_subject;
        if (args.p_has_message) campaign.message_snapshot = args.p_message;
        if (args.p_has_audience) {
          campaign.audience_mode = args.p_audience_mode;
          state.campaign_audience_selections = getRows(state, "campaign_audience_selections")
            .filter((row) => row.campaign_id !== campaign.id || row.user_id !== userId);
          if (args.p_audience_mode === "specific") {
            for (const clientId of (args.p_client_ids as unknown[] ?? [])) {
              const owned = getRows(state, "clients").some((row) => row.id === clientId && row.user_id === userId);
              if (!owned) throw new Error("campaign_audience_client_not_owned");
              getRows(state, "campaign_audience_selections").push({
                campaign_id: campaign.id, user_id: userId, client_id: clientId, created_at: timestamp
              });
            }
          }
        }
        campaign.revision = Number(campaign.revision) + 1;
        campaign.updated_at = timestamp;
        campaign.validated_at = null;
        campaign.validation_nonce_hash = null;
        return { data: cloneRow(campaign), error: null };
      }

      case "submit_campaign": {
        const idempotencyKey = String(args.p_idempotency_key ?? "");
        const requestHash = String(args.p_request_hash ?? "");
        const existing = getRows(state, "campaign_idempotency_records").find((row) =>
          row.user_id === userId && row.scope === "campaign_submit" && row.idempotency_key === idempotencyKey
        );
        if (existing) {
          if (existing.request_hash !== requestHash) throw new Error("campaign_idempotency_key_reused");
          return { data: cloneRow(existing.response_body as TableRow), error: null };
        }
        const campaign = getRows(state, "campaigns").find((row) => row.id === args.p_campaign_id && row.user_id === userId);
        if (!campaign || campaign.status !== "draft") throw new Error("campaign_not_draft");
        if (campaign.revision !== args.p_expected_revision) throw new Error("campaign_revision_conflict");
        if (campaign.validation_nonce_hash !== args.p_validation_nonce_hash) throw new Error("campaign_validation_invalid");
        const recipients = Array.isArray(args.p_recipients) ? args.p_recipients as TableRow[] : [];
        const eligibleCount = recipients.filter((recipient) => recipient.eligibility_status === "eligible").length;
        if (eligibleCount === 0) throw new Error("campaign_has_no_eligible_recipients");
        const run = getRows(state, "campaign_runs").find((row) => row.campaign_id === campaign.id && row.sequence_number === 1);
        if (!run) throw new Error("campaign_initial_run_required");
        campaign.status = "scheduled";
        campaign.scheduled_at = timestamp;
        campaign.validation_nonce_hash = null;
        campaign.updated_at = timestamp;
        run.status = "scheduled";
        run.scheduled_for = campaign.send_mode === "now" ? timestamp : campaign.scheduled_for;
        run.recipient_total = recipients.length;
        run.eligible_count = eligibleCount;
        run.excluded_count = recipients.length - eligibleCount;
        run.pending_count = 0;
        run.updated_at = timestamp;
        for (const recipient of recipients) {
          getRows(state, "campaign_recipients").push({
            id: randomUUID(), campaign_id: campaign.id, campaign_run_id: run.id, user_id: userId,
            ...recipient,
            status: recipient.eligibility_status === "eligible" ? "queued" : "skipped",
            created_at: timestamp, updated_at: timestamp
          });
        }
        const response = {
          campaign_id: campaign.id, run_id: run.id, status: "scheduled", send_mode: campaign.send_mode,
          scheduled_for: campaign.scheduled_for ?? run.scheduled_for,
          recipient_total: recipients.length, eligible_count: eligibleCount, excluded_count: recipients.length - eligibleCount
        };
        getRows(state, "campaign_idempotency_records").push({
          id: randomUUID(), user_id: userId, scope: "campaign_submit", idempotency_key: idempotencyKey,
          request_hash: requestHash, response_body: response, response_status: 200,
          completed_at: timestamp, created_at: timestamp, updated_at: timestamp
        });
        return { data: response, error: null };
      }

      case "cancel_campaign_submission": {
        const campaign = getRows(state, "campaigns").find((row) => row.id === args.p_campaign_id && row.user_id === userId);
        if (!campaign) throw new Error("campaign_not_found");
        if (campaign.status === "sending") throw new Error("campaign_already_sending");
        if (campaign.status === "cancelled") return { data: { campaign_id: campaign.id, status: "cancelled", cancelled_recipients: 0 }, error: null };
        if (campaign.status !== "scheduled") throw new Error("campaign_not_cancellable");
        campaign.status = "cancelled";
        campaign.cancelled_at = timestamp;
        const run = getRows(state, "campaign_runs").find((row) => row.campaign_id === campaign.id && row.sequence_number === 1);
        if (run) { run.status = "cancelled"; run.cancelled_at = timestamp; }
        let cancelled = 0;
        for (const recipient of getRows(state, "campaign_recipients")) {
          if (recipient.campaign_id === campaign.id && (recipient.status === "queued" || recipient.status === "pending")) {
            recipient.status = "cancelled";
            recipient.cancelled_at = timestamp;
            cancelled += 1;
          }
        }
        return { data: { campaign_id: campaign.id, status: "cancelled", cancelled_recipients: cancelled }, error: null };
      }

      case "claim_campaign_recipients": {
        const limit = Math.max(1, Math.min(Number(args.p_limit ?? 25), 100));
        const staleBefore = String(args.p_stale_before ?? "");
        const claimed = getRows(state, "campaign_recipients")
          .filter((recipient) => {
            const campaign = getRows(state, "campaigns").find((row) => row.id === recipient.campaign_id);
            const run = getRows(state, "campaign_runs").find((row) => row.id === recipient.campaign_run_id);
            const due = !run?.scheduled_for || String(run.scheduled_for) <= timestamp;
            return Boolean(campaign && run && due)
              && (campaign?.status === "scheduled" || campaign?.status === "sending")
              && (run?.status === "scheduled" || run?.status === "sending")
              && (recipient.status === "queued"
                || (recipient.status === "failed" && Number(recipient.attempt_count ?? 0) < Number(args.p_max_attempts ?? 3))
                || (recipient.status === "sending" && String(recipient.sending_started_at ?? "") < staleBefore));
          })
          .slice(0, limit);
        for (const recipient of claimed) {
          recipient.status = "sending";
          recipient.attempt_count = Number(recipient.attempt_count ?? 0) + 1;
          recipient.last_attempt_at = timestamp;
          recipient.sending_started_at = timestamp;
          recipient.error_code = null;
          recipient.error_message = null;
          const campaign = getRows(state, "campaigns").find((row) => row.id === recipient.campaign_id);
          const run = getRows(state, "campaign_runs").find((row) => row.id === recipient.campaign_run_id);
          if (campaign?.status === "scheduled") {
            campaign.status = "sending";
            campaign.sending_started_at = campaign.sending_started_at ?? timestamp;
          }
          if (run?.status === "scheduled") {
            run.status = "sending";
            run.started_at = run.started_at ?? timestamp;
          }
        }
        return { data: claimed.map((row) => cloneRow(row)), error: null };
      }

      case "finalize_campaign_runs": {
        const runIds = Array.isArray(args.p_run_ids) ? args.p_run_ids.map(String) : [];
        for (const run of getRows(state, "campaign_runs").filter((row) => runIds.includes(String(row.id)))) {
          const recipients = getRows(state, "campaign_recipients").filter((row) => row.campaign_run_id === run.id);
          const pending = recipients.some((row) =>
            ["pending", "queued", "sending"].includes(String(row.status))
            || (row.status === "failed" && Number(row.attempt_count ?? 0) < Number(args.p_max_attempts ?? 3))
          );
          if (pending) continue;
          const failed = recipients.filter((row) => row.status === "failed").length;
          const sent = recipients.filter((row) => row.status === "sent" || row.status === "delivered").length;
          const status = sent === 0 && failed > 0 ? "failed" : failed > 0 ? "partially_failed" : "completed";
          Object.assign(run, { status, completed_at: timestamp, pending_count: 0, sending_count: 0, sent_count: sent, failed_count: failed });
          const campaign = getRows(state, "campaigns").find((row) => row.id === run.campaign_id);
          if (campaign) Object.assign(campaign, { status, completed_at: timestamp, failure_summary: { sent_count: sent, failed_count: failed } });
        }
        return { data: null, error: null };
      }

      case "get_campaign_reporting_summaries_v2": {
        const campaignIds = Array.isArray(args.p_campaign_ids) ? args.p_campaign_ids.map(String) : [];
        const summaries = getRows(state, "campaigns")
          .filter((campaign) => campaign.user_id === userId && campaignIds.includes(String(campaign.id)))
          .map((campaign) => {
            const recipients = getRows(state, "campaign_recipients").filter((row) => row.campaign_id === campaign.id && row.user_id === userId);
            const count = (predicate: (row: TableRow) => boolean): number => recipients.filter(predicate).length;
            const appointments = getRows(state, "appointments").filter((row) =>
              row.campaign_id === campaign.id && row.user_id === userId && row.status !== "cancelled"
            );
            const events = getRows(state, "campaign_delivery_events").filter((row) => row.campaign_id === campaign.id && row.user_id === userId);
            const eventCount = (type: string, predicate: (row: TableRow) => boolean = () => true) => events.filter((row) => row.event_type === type && predicate(row)).length;
            const uniqueEventCount = (type: string) => new Set(events.filter((row) => row.event_type === type).map((row) => row.campaign_recipient_id)).size;
            return {
              campaign_id: campaign.id,
              recipient_total: recipients.length,
              eligible_count: count((row) => row.eligibility_status === "eligible"),
              excluded_count: count((row) => row.eligibility_status === "excluded"),
              pending_count: count((row) => row.status === "pending"),
              queued_count: count((row) => row.status === "queued"),
              sending_count: count((row) => row.status === "sending"),
              sent_count: count((row) => row.status === "sent"),
              delivered_count: count((row) => row.status === "delivered"),
              failed_count: count((row) => row.status === "failed"),
              skipped_count: count((row) => row.status === "skipped"),
              cancelled_count: count((row) => row.status === "cancelled"),
              attributed_booking_count: appointments.length,
              booked_revenue_cents: appointments.reduce((sum, row) => sum + Math.round(Number(row.price ?? 0) * 100), 0),
              delivered_raw: eventCount("delivered"), opens_raw: eventCount("opened"), opens_unique: uniqueEventCount("opened"),
              opens_automated: eventCount("opened", (row) => row.is_automated === true), opens_privacy_limited: eventCount("opened", (row) => row.privacy_limited === true),
              clicks_raw: eventCount("clicked"), clicks_unique: uniqueEventCount("clicked"),
              clicks_automated: eventCount("clicked", (row) => row.is_automated === true), clicks_privacy_limited: eventCount("clicked", (row) => row.privacy_limited === true)
            };
          });
        return { data: summaries, error: null };
      }

      case "cancel_appointment_reminder_occurrence": {
        const appointmentId = String(args.p_appointment_id ?? "");
        const appointmentStartAt = String(args.p_appointment_start_at ?? "");
        const appointment = getRows(state, "appointments").find((row) =>
          row.user_id === userId
          && row.id === appointmentId
          && row.appointment_date === appointmentStartAt
          && (row.status === "pending" || row.status === "scheduled")
        );
        if (!appointment) {
          throw new Error("appointment_reminder_occurrence_not_found");
        }

        const event = getRows(state, "appointment_email_events").find((row) => {
          const templateData = (row.template_data ?? {}) as TableRow;
          return row.user_id === userId
            && row.appointment_id === appointmentId
            && row.email_type === "appointment_reminder"
            && templateData.appointment_start_time === appointmentStartAt;
        });
        if (event?.status === "sending") {
          throw new Error("appointment_reminder_already_sending");
        }
        if (event?.status === "sent") {
          throw new Error("appointment_reminder_already_sent");
        }

        const suppressions = getRows(state, "appointment_reminder_suppressions");
        let suppression = suppressions.find((row) =>
          row.user_id === userId
          && row.appointment_id === appointmentId
          && row.appointment_start_at === appointmentStartAt
        );
        const reason = typeof args.p_reason === "string" && args.p_reason.trim()
          ? args.p_reason.trim()
          : null;
        if (!suppression) {
          suppression = {
            id: randomUUID(),
            user_id: userId,
            appointment_id: appointmentId,
            appointment_start_at: appointmentStartAt,
            reason,
            created_by: userId,
            created_at: timestamp
          };
          suppressions.push(suppression);
        } else if (reason) {
          suppression.reason = reason;
        }

        if (event && (event.status === "queued" || event.status === "failed")) {
          Object.assign(event, {
            status: "skipped",
            error: "Appointment reminder cancelled by stylist",
            updated_at: timestamp
          });
        }

        return {
          data: {
            id: suppression.id,
            appointment_id: appointmentId,
            appointment_start_at: appointmentStartAt,
            status: "cancelled",
            reason: suppression.reason ?? null,
            created_at: suppression.created_at
          },
          error: null
        };
      }

      case "upsert_birthday_reminder_settings_with_approval_mode":
        settings = upsertByUserId(state, "birthday_reminder_settings", {
          user_id: userId,
          approval_required: approvalRequired
        });

        for (const row of getRows(state, "birthday_reminders")) {
          if (row.user_id !== userId) {
            continue;
          }

          if (approvalRequired && row.status === "queued" && String(row.scheduled_send_at ?? "") >= timestamp) {
            Object.assign(row, { status: "pending_approval", error: null, updated_at: timestamp });
          } else if (!approvalRequired && row.status === "pending_approval") {
            Object.assign(row, { status: "queued", error: null, updated_at: timestamp });
          }
        }
        return { data: cloneRow(settings), error: null };

      case "upsert_rebook_nudge_settings_with_approval_mode":
        settings = upsertByUserId(state, "rebook_nudge_settings", {
          user_id: userId,
          approval_required: approvalRequired,
          ...(
            args.p_has_default_rebook_interval_days
              ? { default_rebook_interval_days: args.p_default_rebook_interval_days }
              : {}
          ),
          ...(args.p_has_subject_template ? { subject_template: args.p_subject_template } : {}),
          ...(args.p_has_custom_message_block ? { custom_message_block: args.p_custom_message_block } : {})
        });

        for (const row of getRows(state, "rebook_nudges")) {
          if (row.user_id !== userId) {
            continue;
          }

          if (approvalRequired && row.status === "queued" && row.approval_required === false) {
            Object.assign(row, {
              status: "pending_approval",
              approval_required: true,
              error: null,
              updated_at: timestamp
            });
          } else if (!approvalRequired && row.status === "pending_approval") {
            Object.assign(row, {
              status: "queued",
              approval_required: false,
              approved_at: timestamp,
              approved_by: userId,
              error: null,
              updated_at: timestamp
            });
          }
        }
        return { data: cloneRow(settings), error: null };

      case "get_insights_campaign_aggregate": {
        const startAt = String(args.p_start_at ?? "");
        const endAt = String(args.p_end_at ?? "");
        const campaigns = getRows(state, "campaigns").filter((row) => row.user_id === userId);
        const sentByCampaign = new Map<string, number>();
        const bookingsByCampaign = new Map<string, { count: number; revenueMinor: number }>();

        for (const recipient of getRows(state, "campaign_recipients")) {
          const campaignId = typeof recipient.campaign_id === "string" ? recipient.campaign_id : null;
          const sentAt = typeof recipient.sent_at === "string" ? recipient.sent_at : null;
          if (recipient.user_id === userId && campaignId && sentAt && sentAt >= startAt && sentAt < endAt) {
            sentByCampaign.set(campaignId, (sentByCampaign.get(campaignId) ?? 0) + 1);
          }
        }

        for (const appointment of getRows(state, "appointments")) {
          const campaignId = typeof appointment.campaign_id === "string" ? appointment.campaign_id : null;
          const attributedAt = typeof appointment.campaign_attributed_at === "string" ? appointment.campaign_attributed_at : null;
          if (
            appointment.user_id === userId
            && campaignId
            && appointment.status !== "cancelled"
            && attributedAt
            && attributedAt >= startAt
            && attributedAt < endAt
          ) {
            const current = bookingsByCampaign.get(campaignId) ?? { count: 0, revenueMinor: 0 };
            const price = Number(appointment.price ?? 0);
            bookingsByCampaign.set(campaignId, {
              count: current.count + 1,
              revenueMinor: current.revenueMinor + (Number.isFinite(price) ? Math.round(price * 100) : 0)
            });
          }
        }

        const metricCampaigns = campaigns
          .filter((campaign) => sentByCampaign.has(String(campaign.id)) || bookingsByCampaign.has(String(campaign.id)))
          .map((campaign) => {
            const campaignId = String(campaign.id);
            const bookings = bookingsByCampaign.get(campaignId) ?? { count: 0, revenueMinor: 0 };
            return {
              campaign,
              emailsSent: sentByCampaign.get(campaignId) ?? 0,
              appointmentsBooked: bookings.count,
              attributedRevenueMinor: bookings.revenueMinor
            };
          });
        const top = [...metricCampaigns].sort((left, right) =>
          right.attributedRevenueMinor - left.attributedRevenueMinor
          || right.appointmentsBooked - left.appointmentsBooked
          || right.emailsSent - left.emailsSent
          || String(left.campaign.id).localeCompare(String(right.campaign.id))
        )[0];

        return {
          data: [{
            has_campaign_history: campaigns.length > 0,
            emails_sent: metricCampaigns.reduce((total, campaign) => total + campaign.emailsSent, 0),
            appointments_booked: metricCampaigns.reduce((total, campaign) => total + campaign.appointmentsBooked, 0),
            attributed_revenue_minor: metricCampaigns.reduce((total, campaign) => total + campaign.attributedRevenueMinor, 0),
            top_campaign_id: top?.campaign.id ?? null,
            top_campaign_name: top?.campaign.name ?? null,
            top_campaign_status: top?.campaign.status ?? null,
            top_campaign_emails_sent: top?.emailsSent ?? 0,
            top_campaign_appointments_booked: top?.appointmentsBooked ?? 0,
            top_campaign_attributed_revenue_minor: top?.attributedRevenueMinor ?? 0
          }],
          error: null
        };
      }

      case "upsert_thank_you_email_settings_with_approval_mode":
        settings = upsertByUserId(state, "thank_you_email_settings", {
          user_id: userId,
          approval_required: approvalRequired,
          ...(args.p_has_send_delay_hours ? { send_delay_hours: args.p_send_delay_hours } : {}),
          ...(args.p_has_subject_template ? { subject_template: args.p_subject_template } : {}),
          ...(args.p_has_custom_message_block ? { custom_message_block: args.p_custom_message_block } : {})
        });

        for (const row of getRows(state, "thank_you_emails")) {
          if (row.user_id !== userId) {
            continue;
          }

          if (approvalRequired && row.status === "queued" && row.approval_required === false) {
            Object.assign(row, {
              status: "pending_approval",
              approval_required: true,
              error: null,
              updated_at: timestamp
            });
          } else if (!approvalRequired && row.status === "pending_approval") {
            Object.assign(row, {
              status: "queued",
              approval_required: false,
              approved_at: timestamp,
              approved_by: userId,
              error: null,
              updated_at: timestamp
            });
          }
        }
        return { data: cloneRow(settings), error: null };

      default:
        return {
          data: null,
          error: {
            message: `Unsupported mock RPC: ${functionName}`,
            details: null,
            hint: null,
            code: "MOCK_RPC_UNSUPPORTED"
          }
        };
    }
  } catch (error) {
    restoreState(state, snapshot);
    return {
      data: null,
      error: {
        message: error instanceof Error ? error.message : "Mock RPC failed",
        details: null,
        hint: null,
        code: "MOCK_RPC_FAILED"
      }
    };
  }
};

export const installMockSupabase = (initialState: TableState, options: MockSupabaseOptions = {}) => {
  const state = cloneState(initialState);
  const fromRestore = mock.method(supabaseAdmin, "from", (table: string) => new MockQueryBuilder(state, table, options));
  const rpcRestore = mock.method(supabaseAdmin, "rpc", (functionName: string, args: Record<string, unknown> = {}) =>
    functionName === "list_clients_with_summaries"
      ? executeClientsListRpc(state, args)
      : executeApprovalSettingsRpc(state, functionName, args)
  );

  return {
    state,
    restore: () => {
      rpcRestore.mock.restore();
      fromRestore.mock.restore();
    }
  };
};
