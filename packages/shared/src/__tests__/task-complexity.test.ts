import { describe, it, expect } from "vitest";
import {
  clampTaskComplexity,
  complexityToDisplay,
  TASK_COMPLEXITY_MIN,
  TASK_COMPLEXITY_MAX,
} from "../types/task.js";

describe("complexityToDisplay", () => {
  it("returns Simple for 1-5", () => {
    for (let i = 1; i <= 5; i++) {
      expect(complexityToDisplay(i)).toBe("Simple");
    }
  });

  it("returns Complex for 6-10", () => {
    for (let i = 6; i <= 10; i++) {
      expect(complexityToDisplay(i)).toBe("Complex");
    }
  });

  it("returns null for undefined or invalid", () => {
    expect(complexityToDisplay(undefined)).toBeNull();
    expect(complexityToDisplay(null as unknown as number)).toBeNull();
    expect(complexityToDisplay(0)).toBeNull();
    expect(complexityToDisplay(11)).toBeNull();
  });
});

describe("clampTaskComplexity", () => {
  it("returns value for valid integer 1-10", () => {
    for (let i = 1; i <= 10; i++) {
      expect(clampTaskComplexity(i)).toBe(i);
    }
  });

  it("returns undefined for invalid types", () => {
    expect(clampTaskComplexity(undefined)).toBeUndefined();
    expect(clampTaskComplexity(null)).toBeUndefined();
    expect(clampTaskComplexity("5")).toBeUndefined();
    expect(clampTaskComplexity(5.5)).toBeUndefined();
    expect(clampTaskComplexity(NaN)).toBeUndefined();
  });

  it("returns undefined for out-of-range integers", () => {
    expect(clampTaskComplexity(0)).toBeUndefined();
    expect(clampTaskComplexity(11)).toBeUndefined();
    expect(clampTaskComplexity(-1)).toBeUndefined();
  });

  it("exports valid range constants", () => {
    expect(TASK_COMPLEXITY_MIN).toBe(1);
    expect(TASK_COMPLEXITY_MAX).toBe(10);
  });
});
