import { randomUUID } from "crypto";
import { mock } from "node:test";
import { supabaseAdmin } from "../../lib/supabase";

type TableRow = Record<string, unknown>;
type TableState = Record<string, TableRow[]>;
type SortDirection = { column: string; ascending: boolean };
type Filter =
  | { type: "eq"; column: string; value: unknown }
  | { type: "neq"; column: string; value: unknown }
  | { type: "in"; column: string; values: unknown[] }
  | { type: "gte"; column: string; value: unknown }
  | { type: "lt"; column: string; value: unknown };

interface SelectOptions {
  count?: "exact";
  head?: boolean;
}

const cloneRow = <T extends TableRow>(row: T): T => ({ ...row });

const cloneState = (state: TableState): TableState =>
  Object.fromEntries(Object.entries(state).map(([table, rows]) => [table, rows.map((row) => cloneRow(row))]));

class MockQueryBuilder implements PromiseLike<{ data: unknown; error: null; count?: number | null }> {
  private action: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private sorts: SortDirection[] = [];
  private limitCount?: number;
  private singleMode: "many" | "single" | "maybeSingle" = "many";
  private pendingInsert: TableRow[] = [];
  private pendingUpdate: TableRow | null = null;
  private selectOptions: SelectOptions = {};

  constructor(
    private readonly state: TableState,
    private readonly table: string
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

  neq(column: string, value: unknown) {
    this.filters.push({ type: "neq", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ type: "in", column, values });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ type: "gte", column, value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ type: "lt", column, value });
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
        const value = row[filter.column];

        switch (filter.type) {
          case "eq":
            return value === filter.value;
          case "neq":
            return value !== filter.value;
          case "in":
            return filter.values.includes(value);
          case "gte":
            return String(value ?? "") >= String(filter.value ?? "");
          case "lt":
            return String(value ?? "") < String(filter.value ?? "");
        }
      })
    );
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
    const limitedRows = this.limitCount !== undefined ? sortedRows.slice(0, this.limitCount) : sortedRows;

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
        count: limitedRows.length
      };
    }

    return {
      data: limitedRows.map((row) => cloneRow(row)),
      error: null
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

export const installMockSupabase = (initialState: TableState) => {
  const state = cloneState(initialState);
  const restore = mock.method(supabaseAdmin, "from", (table: string) => new MockQueryBuilder(state, table));

  return {
    state,
    restore: () => restore.mock.restore()
  };
};
