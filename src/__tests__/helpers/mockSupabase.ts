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

export const installMockSupabase = (initialState: TableState, options: MockSupabaseOptions = {}) => {
  const state = cloneState(initialState);
  const restore = mock.method(supabaseAdmin, "from", (table: string) => new MockQueryBuilder(state, table, options));

  return {
    state,
    restore: () => restore.mock.restore()
  };
};
