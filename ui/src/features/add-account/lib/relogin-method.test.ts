import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import {
  reloginCookieProvider,
  reloginKeepsOff,
  reloginLocalProvider,
  reloginMethod,
  reloginRegion,
} from "./relogin-method";

describe("reloginMethod", () => {
  it.each([
    [{ provider: "BuilderId", authMethod: "idc" }, "builderid"],
    [{ provider: "", authMethod: "idc" }, "iam"],
    [{ provider: "Enterprise", authMethod: "idc" }, "iam"],
    [{ provider: "AzureAD", authMethod: "external_idp" }, "microsoft"],
    [{ provider: "", authMethod: "external_idp" }, "microsoft"],
    [{ provider: "Google", authMethod: "social" }, "cookie"],
    [{ provider: "Github", authMethod: "social" }, "cookie"],
    [{ provider: "", authMethod: "social" }, "cookie"],
    [{ provider: "APIKey", authMethod: "api_key" }, "apikey"],
    [{ provider: "Mystery", authMethod: "" }, "credentials"],
    [{ provider: "", authMethod: "" }, "credentials"],
  ] as const)("%o opens %s", (account, method) => {
    expect(reloginMethod(account)).toBe(method);
  });
});

describe("relogin prefills", () => {
  it("picks the cookie provider from the account", () => {
    expect(reloginCookieProvider({ provider: "GitHub" })).toBe("Github");
    expect(reloginCookieProvider({ provider: "Google" })).toBe("Google");
    expect(reloginCookieProvider(null)).toBe("Google");
  });

  it("starts the region at the account's, else us-east-1", () => {
    expect(reloginRegion({ region: "eu-central-1" })).toBe("eu-central-1");
    expect(reloginRegion({ region: "" })).toBe("us-east-1");
    expect(reloginRegion(null)).toBe("us-east-1");
  });
});

describe("reloginLocalProvider", () => {
  it.each([
    [{ provider: "BuilderId", authMethod: "idc" }, "BuilderId"],
    [{ provider: "", authMethod: "idc" }, "Enterprise"],
    [{ provider: "Enterprise", authMethod: "idc" }, "Enterprise"],
    [{ provider: "AzureAD", authMethod: "external_idp" }, "Microsoft"],
    [{ provider: "Google", authMethod: "social" }, "Google"],
    [{ provider: "Github", authMethod: "social" }, "Github"],
    [{ provider: "", authMethod: "social" }, "Google"],
    [{ provider: "APIKey", authMethod: "api_key" }, "BuilderId"],
    [{ provider: "Mystery", authMethod: "" }, "BuilderId"],
  ] as const)("%o picks %s", (account, provider) => {
    expect(reloginLocalProvider(account)).toBe(provider);
  });

  it("starts at Builder ID outside re-login", () => {
    expect(reloginLocalProvider(null)).toBe("BuilderId");
  });
});

describe("reloginKeepsOff", () => {
  const on: Pick<Account, "enabled" | "silent" | "banStatus"> = {
    enabled: true,
    silent: false,
    banStatus: "",
  };

  it("is true for an account the admin switched off or silenced", () => {
    expect(reloginKeepsOff({ ...on, enabled: false })).toBe(true);
    expect(reloginKeepsOff({ ...on, enabled: false, banStatus: "DISABLED" })).toBe(true);
    expect(reloginKeepsOff({ ...on, enabled: false, silent: true })).toBe(true);
    // The sign-in lifts the ban but not the silence.
    expect(reloginKeepsOff({ ...on, enabled: false, silent: true, banStatus: "BANNED" })).toBe(
      true,
    );
  });

  it("is false for an account that is on, or held only by a ban the sign-in lifts", () => {
    expect(reloginKeepsOff(on)).toBe(false);
    expect(reloginKeepsOff({ ...on, banStatus: "ACTIVE" })).toBe(false);
    expect(reloginKeepsOff({ ...on, enabled: false, banStatus: "BANNED" })).toBe(false);
  });
});
