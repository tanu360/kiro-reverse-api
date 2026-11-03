import { describe, expect, it } from "vitest";
import { buildLocalCachePayload, jwtClaims, localCacheErrorField, UUID_RE } from "./local-cache";

describe("localCacheErrorField", () => {
  it("puts token problems under kiro-auth-token.json", () => {
    for (const key of ["tokenMissing", "tokenInvalid", "refreshTokenMissing"] as const) {
      expect(localCacheErrorField(key, true)).toBe("token");
    }
    expect(localCacheErrorField("microsoftTenantMissing", true)).toBe("token");
  });

  it("puts client problems under {hash}.json while that field is shown", () => {
    for (const key of [
      "clientInvalid",
      "clientSecretMissing",
      "clientMissing",
      "clientMissingNamed",
      "microsoftClientIdMissing",
    ] as const) {
      expect(localCacheErrorField(key, true)).toBe("client");
      expect(localCacheErrorField(key, false)).toBe("token");
    }
  });
});

const CLIENT_ID = "0f3c2b1a-9d8e-4c7b-a6f5-e4d3c2b1a098";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(claims: Record<string, unknown>): string {
  return `${base64url({ alg: "none" })}.${base64url(claims)}.sig`;
}

describe("jwtClaims", () => {
  it("decodes a base64url payload that needs padding", () => {
    // 'ab?' encodes to base64 with '/' and needs one '=' of padding.
    expect(jwtClaims(jwt({ aud: CLIENT_ID, n: "ab?" }))).toEqual({ aud: CLIENT_ID, n: "ab?" });
  });

  it("returns an empty object for anything that is not a JWT", () => {
    expect(jwtClaims("")).toEqual({});
    expect(jwtClaims("not-a-jwt")).toEqual({});
    expect(jwtClaims("a.%%%.c")).toEqual({});
  });

  it("matches UUIDs case-insensitively", () => {
    expect(UUID_RE.test(CLIENT_ID.toUpperCase())).toBe(true);
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
  });
});

describe("buildLocalCachePayload", () => {
  it("requires the token file", () => {
    expect(
      buildLocalCachePayload({ provider: "BuilderId", tokenJson: "  ", clientJson: "" }),
    ).toEqual({ ok: false, error: { key: "tokenMissing" } });
  });

  it("rejects token JSON that does not parse", () => {
    expect(
      buildLocalCachePayload({ provider: "BuilderId", tokenJson: "{", clientJson: "" }),
    ).toEqual({ ok: false, error: { key: "tokenInvalid" } });
  });

  it("requires a refresh token", () => {
    expect(
      buildLocalCachePayload({
        provider: "Google",
        tokenJson: '{"accessToken":"a"}',
        clientJson: "",
      }),
    ).toEqual({ ok: false, error: { key: "refreshTokenMissing" } });
  });

  it("rejects client JSON that does not parse for IdC", () => {
    expect(
      buildLocalCachePayload({
        provider: "BuilderId",
        tokenJson: '{"refreshToken":"r"}',
        clientJson: "nope",
      }),
    ).toEqual({ ok: false, error: { key: "clientInvalid" } });
  });

  it("reads the Microsoft client ID from the access token audience", () => {
    const result = buildLocalCachePayload({
      provider: "Microsoft",
      tokenJson: JSON.stringify({
        refreshToken: "r",
        accessToken: jwt({ aud: `api://${CLIENT_ID}/.default`, iss: "https://sts.windows.net/t/" }),
        region: "us-east-1",
        tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      }),
      clientJson: "",
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        refreshToken: "r",
        accessToken: expect.any(String),
        clientId: CLIENT_ID,
        authMethod: "external_idp",
        provider: "AzureAD",
        region: "us-east-1",
        userId: "",
        profileArn: "",
        tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
        issuerUrl: "",
        scopes: "",
      },
    });
  });

  it("detects Microsoft from the token file even with another provider chosen", () => {
    const result = buildLocalCachePayload({
      provider: "BuilderId",
      tokenJson: JSON.stringify({
        refreshToken: "r",
        authMethod: "ExternalIdp",
        clientId: CLIENT_ID,
        issuerUrl: "https://login.microsoftonline.com/t/v2.0",
      }),
      clientJson: "",
    });
    expect(result).toMatchObject({ ok: true, payload: { authMethod: "external_idp" } });
  });

  it("asks for the Microsoft client ID when none is a UUID", () => {
    expect(
      buildLocalCachePayload({
        provider: "Microsoft",
        tokenJson: '{"refreshToken":"r","clientId":"abc","tokenEndpoint":"https://x"}',
        clientJson: "",
      }),
    ).toEqual({ ok: false, error: { key: "microsoftClientIdMissing" } });
  });

  it("asks for the Microsoft tenant when nothing names it", () => {
    expect(
      buildLocalCachePayload({
        provider: "Microsoft",
        tokenJson: JSON.stringify({ refreshToken: "r", clientId: CLIENT_ID }),
        clientJson: "",
      }),
    ).toEqual({ ok: false, error: { key: "microsoftTenantMissing" } });
  });

  it("names the missing IdC client file after clientIdHash", () => {
    expect(
      buildLocalCachePayload({
        provider: "Enterprise",
        tokenJson: '{"refreshToken":"r","clientIdHash":" abc123 "}',
        clientJson: "",
      }),
    ).toEqual({
      ok: false,
      error: { key: "clientMissingNamed", params: { file: "abc123" }, hint: "microsoftChoiceHint" },
    });
  });

  it("asks for the client file without a clientIdHash", () => {
    expect(
      buildLocalCachePayload({
        provider: "BuilderId",
        tokenJson: '{"refreshToken":"r"}',
        clientJson: "",
      }),
    ).toEqual({ ok: false, error: { key: "clientMissing", hint: "microsoftChoiceHint" } });
  });

  it("requires clientId and clientSecret in the client file", () => {
    expect(
      buildLocalCachePayload({
        provider: "BuilderId",
        tokenJson: '{"refreshToken":"r"}',
        clientJson: '{"clientId":"c"}',
      }),
    ).toEqual({ ok: false, error: { key: "clientSecretMissing" } });
  });

  it("builds the IdC payload", () => {
    expect(
      buildLocalCachePayload({
        provider: "Enterprise",
        tokenJson: '{"refreshToken":"r","accessToken":"a","region":"eu-central-1"}',
        clientJson: '{"clientId":"c","clientSecret":"s"}',
      }),
    ).toEqual({
      ok: true,
      payload: {
        refreshToken: "r",
        accessToken: "a",
        clientId: "c",
        clientSecret: "s",
        region: "eu-central-1",
        authMethod: "idc",
        provider: "Enterprise",
      },
    });
  });

  it("skips the client file for Google", () => {
    expect(
      buildLocalCachePayload({
        provider: "Google",
        tokenJson: '{"refreshToken":"r"}',
        clientJson: "not json at all",
      }),
    ).toEqual({
      ok: true,
      payload: {
        refreshToken: "r",
        accessToken: "",
        clientId: "",
        clientSecret: "",
        region: "",
        authMethod: "social",
        provider: "Google",
      },
    });
  });
});
