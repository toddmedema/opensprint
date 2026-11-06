import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_SIZE, parseSettings, TASK_SIZES } from "../types/settings.js";

describe("project task size", () => {
  it.each(TASK_SIZES)("round-trips the %s preference", (taskSize) => {
    const settings = parseSettings({ taskSize });
    expect(settings.taskSize).toBe(taskSize);
    expect(parseSettings(JSON.parse(JSON.stringify(settings))).taskSize).toBe(taskSize);
  });
  it.each([undefined, null, "tiny", 3, {}])(
    "defaults missing or invalid stored values (%j) to Balanced",
    (taskSize) => {
      expect(parseSettings({ taskSize }).taskSize).toBe(DEFAULT_TASK_SIZE);
    }
  );
});
