import { afterEach, describe, expect, it, vi } from "vitest";
import { claimMockPassword, mockDb, resetMockDb } from "./db";

afterEach(() => vi.unstubAllEnvs());

describe("browser mock auth persistence", () => {
  it("keeps first-run claimed and the changed password when the mock database reloads", () => {
    vi.stubEnv("VITE_MOCK", "1");
    vi.stubEnv("MODE", "mock");
    claimMockPassword("changed-dev-password");
    resetMockDb();
    expect(mockDb.firstRunPending).toBe(false);
    expect(mockDb.adminPassword).toBe("changed-dev-password");
  });

  it("does not let browser mock state change the regular test seed", () => {
    localStorage.setItem("kiro_mock_first_run_done", "1");
    resetMockDb();
    expect(mockDb.firstRunPending).toBe(true);
    expect(mockDb.adminPassword).toBe("12345678");
  });
});
