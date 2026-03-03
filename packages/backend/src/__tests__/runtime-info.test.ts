import { describe, it, expect, afterEach } from "vitest";
import {
  detectBackendRuntime,
  getBackendRuntimeInfo,
  setBackendRuntimeInfoForTesting,
} from "../utils/runtime-info.js";

describe("runtime-info", () => {
  afterEach(() => {
    setBackendRuntimeInfoForTesting(null);
  });

  it("detects native Linux as non-WSL", () => {
    expect(
      detectBackendRuntime({
        platform: "linux",
        env: {},
        osRelease: "6.8.0-generic",
        procVersion: "Linux version 6.8.0-generic",
      })
    ).toEqual({
      platform: "linux",
      isWsl: false,
      wslDistroName: null,
      repoPathPolicy: "any",
    });
  });

  it("detects WSL from environment variables", () => {
    expect(
      detectBackendRuntime({
        platform: "linux",
        env: {
          WSL_DISTRO_NAME: "Ubuntu",
          WSL_INTEROP: "/run/WSL/123_interop",
        } as NodeJS.ProcessEnv,
        osRelease: "6.8.0-generic",
        procVersion: "Linux version 6.8.0-generic",
      })
    ).toEqual({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });
  });

  it("detects WSL from microsoft in os.release", () => {
    expect(
      detectBackendRuntime({
        platform: "linux",
        env: {},
        osRelease: "5.15.167.4-microsoft-standard-WSL2",
        procVersion: "Linux version 5.15.167.4",
      })
    ).toEqual({
      platform: "linux",
      isWsl: true,
      wslDistroName: null,
      repoPathPolicy: "linux_fs_only",
    });
  });

  it("allows tests to override the runtime info", () => {
    setBackendRuntimeInfoForTesting({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });

    expect(getBackendRuntimeInfo()).toEqual({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });
  });
});
