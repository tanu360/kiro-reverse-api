import { describe, expect, it } from "vitest";
import { isMicrosoftCredential, mapCredential, parseCredentialsJson } from "./credentials-mapping";

describe("parseCredentialsJson", () => {
  it("wraps a single object in a list", () => {
    expect(parseCredentialsJson('{"refreshToken":"r1"}')).toEqual([{ refreshToken: "r1" }]);
  });

  it("keeps an array as is", () => {
    expect(parseCredentialsJson(' [{"refreshToken":"r1"},{"refreshToken":"r2"}] ')).toHaveLength(2);
  });

  it("maps the Kiro Account Manager export, credentials first", () => {
    const text = JSON.stringify({
      accounts: [
        {
          userId: "u-1",
          profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
          idp: "Github",
          region: "eu-central-1",
          refreshToken: "outer",
          credentials: {
            refreshToken: "inner",
            accessToken: "a",
            clientId: "c",
            clientSecret: "s",
            authMethod: "social",
            tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
          },
        },
        { refreshToken: "only-outer", provider: "Google" },
      ],
    });
    expect(parseCredentialsJson(text)).toEqual([
      {
        refreshToken: "inner",
        accessToken: "a",
        kiroApiKey: "",
        clientId: "c",
        clientSecret: "s",
        region: "eu-central-1",
        authMethod: "social",
        provider: "Github",
        userId: "u-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
        tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
        issuerUrl: "",
        scopes: "",
      },
      {
        refreshToken: "only-outer",
        accessToken: "",
        kiroApiKey: "",
        clientId: "",
        clientSecret: "",
        region: "",
        authMethod: "",
        provider: "Google",
        userId: "",
        profileArn: "",
        tokenEndpoint: "",
        issuerUrl: "",
        scopes: "",
      },
    ]);
  });

  it("throws on text that is not JSON", () => {
    expect(() => parseCredentialsJson("{nope")).toThrow();
    expect(() => parseCredentialsJson("")).toThrow();
  });
});

describe("mapCredential", () => {
  it("maps a ksk_ access token without a refresh token to an API key payload", () => {
    expect(mapCredential({ accessToken: "ksk_abc", region: "eu-central-1" })).toEqual({
      kind: "request",
      payload: { kiroApiKey: "ksk_abc", authMethod: "api_key", region: "eu-central-1" },
    });
  });

  it("maps an api_key auth method and an explicit kiroApiKey", () => {
    expect(mapCredential({ authMethod: "APIKey", accessToken: "plain" })).toEqual({
      kind: "request",
      payload: { kiroApiKey: "plain", authMethod: "api_key", region: "" },
    });
    expect(mapCredential({ kiroApiKey: "ksk_x", refreshToken: "r" })).toEqual({
      kind: "request",
      payload: { kiroApiKey: "ksk_x", authMethod: "api_key", region: "" },
    });
  });

  it("keeps a ksk_ access token as OAuth when a refresh token is present", () => {
    const mapped = mapCredential({ accessToken: "ksk_abc", refreshToken: "r" });
    expect(mapped).toMatchObject({ kind: "request", payload: { authMethod: "social" } });
  });

  it("sends Microsoft aliases as external_idp", () => {
    expect(
      mapCredential({
        refreshToken: "r",
        provider: "AzureAD",
        clientId: "11111111-2222-3333-4444-555555555555",
        tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      }),
    ).toEqual({
      kind: "request",
      payload: {
        refreshToken: "r",
        accessToken: "",
        clientId: "11111111-2222-3333-4444-555555555555",
        authMethod: "external_idp",
        provider: "AzureAD",
        region: "",
        userId: "",
        profileArn: "",
        tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
        issuerUrl: "",
        scopes: "",
      },
    });
  });

  it("detects Microsoft from a token endpoint alone", () => {
    expect(isMicrosoftCredential({ tokenEndpoint: "https://x" })).toBe(true);
    expect(isMicrosoftCredential({ authMethod: "Entra-ID" })).toBe(true);
    expect(isMicrosoftCredential({ provider: "Google" })).toBe(false);
  });

  it("maps clientId and clientSecret to idc with the BuilderId default provider", () => {
    expect(mapCredential({ refreshToken: "r", clientId: "c", clientSecret: "s" })).toEqual({
      kind: "request",
      payload: {
        refreshToken: "r",
        accessToken: "",
        clientId: "c",
        clientSecret: "s",
        authMethod: "idc",
        provider: "BuilderId",
        region: "us-east-1",
      },
    });
  });

  it("maps everything else to social with the Google default provider", () => {
    expect(mapCredential({ refreshToken: "r", region: "eu-central-1" })).toEqual({
      kind: "request",
      payload: {
        refreshToken: "r",
        accessToken: "",
        clientId: "",
        clientSecret: "",
        authMethod: "social",
        provider: "Google",
        region: "eu-central-1",
      },
    });
  });

  it("honours an explicit idc auth method and provider", () => {
    expect(
      mapCredential({ refreshToken: "r", authMethod: "IdC", provider: "Enterprise" }),
    ).toMatchObject({ payload: { authMethod: "idc", provider: "Enterprise" } });
  });

  it("counts an item without a refresh token as failed", () => {
    expect(mapCredential({ provider: "Google" })).toEqual({ kind: "missingRefreshToken" });
    expect(mapCredential({})).toEqual({ kind: "missingRefreshToken" });
  });
});
