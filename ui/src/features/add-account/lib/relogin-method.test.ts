import { describe, expect, it } from "vitest";
import { reloginCookieProvider, reloginMethod, reloginRegion } from "./relogin-method";

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
