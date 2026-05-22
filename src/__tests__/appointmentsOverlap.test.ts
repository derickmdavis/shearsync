import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appointmentsOverlap } from "../lib/appointments";

describe("appointment overlap checks", () => {
  it("compares instants rather than ISO string formatting", () => {
    assert.equal(
      appointmentsOverlap(
        "2026-05-22T12:00:00-06:00",
        30,
        "2026-05-22T18:15:00.000Z",
        30
      ),
      true
    );

    assert.equal(
      appointmentsOverlap(
        "2026-05-22T12:00:00-06:00",
        30,
        "2026-05-22T12:30:00-06:00",
        30
      ),
      false
    );
  });
});
