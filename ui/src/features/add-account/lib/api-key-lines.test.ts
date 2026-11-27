import { describe, expect, it } from "vitest";
import { keyRegion, parseApiKeyLines } from "./api-key-lines";

describe("parseApiKeyLines", () => {
  it("trims every line and skips blank ones", () => {
    expect(parseApiKeyLines("  ksk_a  \n\n\t\r\nksk_b\r\n", "us-east-1")).toEqual([
      { kiroApiKey: "ksk_a", authMethod: "api_key", region: "us-east-1" },
      { kiroApiKey: "ksk_b", authMethod: "api_key", region: "us-east-1" },
    ]);
  });

  it("sends no region for a key that carries its own", () => {
    expect(parseApiKeyLines("ksk_a|eu-central-1", "us-east-1")).toEqual([
      { kiroApiKey: "ksk_a|eu-central-1", authMethod: "api_key", region: "" },
    ]);
  });

  it("gives a plain key the selected region", () => {
    expect(parseApiKeyLines("ksk_plain", "eu-central-1")).toEqual([
      { kiroApiKey: "ksk_plain", authMethod: "api_key", region: "eu-central-1" },
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(parseApiKeyLines(" \n \n", "us-east-1")).toEqual([]);
  });
});

describe("keyRegion", () => {
  it("reads the region after the bar, trimmed and lowercased as the server does", () => {
    expect(keyRegion("ksk_a|EU-Central-1 ")).toBe("eu-central-1");
    expect(keyRegion("ksk_a| ap-northeast-1")).toBe("ap-northeast-1");
  });

  it("is null for a key without a bar", () => {
    expect(keyRegion("ksk_plain")).toBeNull();
  });
});
