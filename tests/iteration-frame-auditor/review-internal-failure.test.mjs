import { expect, it, vi } from "vitest";

// AGS 3.0 error model P1 (D-0117 residual): an internal validator failure is not reported as a review input error.
vi.mock("../../skills/iteration-frame-auditor/scripts/schema-validation.mjs", () => ({
  validateReviewSchema: () => true,
  validateComparisonSchema: () => true,
  validateRequestSchema: () => { throw new TypeError("internal validator failure"); },
}));
const { validateReview } = await import("../../skills/iteration-frame-auditor/scripts/core.mjs");

it("propagates a non-InputError from request validation", () => {
  expect(() => validateReview({}, {}, {}, `sha256:${"0".repeat(64)}`)).toThrow(TypeError);
});
