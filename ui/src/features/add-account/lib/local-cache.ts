import type { CredentialsImportRequest } from "@/lib/api/types";
import { isMicrosoftCredential, isRecord, textField } from "./credentials-mapping";

export type LocalProvider = "BuilderId" | "Enterprise" | "Google" | "Github" | "Microsoft";

export const LOCAL_PROVIDERS: readonly LocalProvider[] = [
  "BuilderId",
  "Enterprise",
  "Google",
  "Github",
  "Microsoft",
];

/** Social sign-ins have no client file. */
export function isSocialProvider(provider: LocalProvider): boolean {
  return provider === "Google" || provider === "Github";
}

export type LocalCacheErrorKey =
  | "tokenMissing"
  | "tokenInvalid"
  | "refreshTokenMissing"
  | "clientInvalid"
  | "microsoftClientIdMissing"
  | "microsoftTenantMissing"
  | "clientMissingNamed"
  | "clientMissing"
  | "clientSecretMissing";

/** A validation message: `local.<key>` in the add-account namespace, plus an optional hint. */
export interface LocalCacheError {
  key: LocalCacheErrorKey;
  params?: { file: string };
  hint?: "microsoftChoiceHint";
}

/**
 * The textarea a validation message belongs under: kiro-auth-token.json ("token") or
 * {hash}.json ("client"). A client-file problem goes under the token file when the client
 * field is hidden (social providers), since that is the only file on screen.
 */
export function localCacheErrorField(
  key: LocalCacheErrorKey,
  clientShown: boolean,
): "token" | "client" {
  const client =
    key === "clientInvalid" ||
    key === "clientSecretMissing" ||
    key === "clientMissing" ||
    key === "clientMissingNamed" ||
    key === "microsoftClientIdMissing";
  return client && clientShown ? "client" : "token";
}

export type LocalCacheResult =
  | { ok: true; payload: CredentialsImportRequest }
  | { ok: false; error: LocalCacheError };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The claims of a JWT, decoded from base64url with the padding restored; {} when unreadable. */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return isRecord(claims) ? claims : {};
  } catch {
    return {};
  }
}

const LOCAL_MICROSOFT_ALIASES = [
  "externalidp",
  "external",
  "microsoft",
  "m365",
  "office365",
  "azure",
  "azuread",
  "entra",
  "entraid",
];

/** Kiro IDE spells Microsoft sign-ins its own way ("ExternalIdp"), so case and separators fold. */
function isLocalMicrosoftToken(data: Record<string, unknown>): boolean {
  const fold = (value: unknown) =>
    textField(value)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return (
    isMicrosoftCredential(data) ||
    LOCAL_MICROSOFT_ALIASES.includes(fold(data.authMethod)) ||
    LOCAL_MICROSOFT_ALIASES.includes(fold(data.provider))
  );
}

/** The Entra access token is audience-bound to the Kiro app, so it names the client ID. */
function microsoftClientIdFromToken(accessToken: string): string {
  const claims = jwtClaims(accessToken);
  const aud = textField(Array.isArray(claims.aud) ? claims.aud[0] : claims.aud)
    .replace(/^api:\/\//i, "")
    .replace(/\/.*$/, "");
  return [aud, textField(claims.azp), textField(claims.appid)].find((v) => UUID_RE.test(v)) ?? "";
}

function microsoftPayload(
  token: Record<string, unknown>,
  client: Record<string, unknown> | null,
): LocalCacheResult {
  const pick = (key: string) => (textField(token[key]) || textField(client?.[key])).trim();
  const accessToken = textField(token.accessToken);
  const clientId = pick("clientId") || microsoftClientIdFromToken(accessToken);
  if (!UUID_RE.test(clientId)) return { ok: false, error: { key: "microsoftClientIdMissing" } };
  const tokenEndpoint = pick("tokenEndpoint");
  const issuerUrl = pick("issuerUrl");
  const userId = textField(token.userId).trim();
  if (!tokenEndpoint && !issuerUrl && !userId && !jwtClaims(accessToken).iss) {
    return { ok: false, error: { key: "microsoftTenantMissing" } };
  }
  return {
    ok: true,
    payload: {
      refreshToken: textField(token.refreshToken),
      accessToken,
      clientId,
      authMethod: "external_idp",
      provider: "AzureAD",
      region: textField(token.region),
      userId,
      profileArn: textField(token.profileArn),
      tokenEndpoint,
      issuerUrl,
      scopes: pick("scopes"),
    },
  };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Validates the pasted kiro-auth-token.json and {hash}.json and builds one import request.
 * The checks run in the old admin panel's order, so the first problem found is reported.
 */
export function buildLocalCachePayload(input: {
  provider: LocalProvider;
  tokenJson: string;
  clientJson: string;
}): LocalCacheResult {
  const { provider } = input;
  const tokenJson = input.tokenJson.trim();
  const clientJson = input.clientJson.trim();
  const social = isSocialProvider(provider);

  if (!tokenJson) return { ok: false, error: { key: "tokenMissing" } };
  const token = parseObject(tokenJson);
  if (!token) return { ok: false, error: { key: "tokenInvalid" } };
  if (!textField(token.refreshToken)) return { ok: false, error: { key: "refreshTokenMissing" } };

  let client: Record<string, unknown> | null = null;
  if (clientJson && !social) {
    client = parseObject(clientJson);
    if (!client) return { ok: false, error: { key: "clientInvalid" } };
  }

  const microsoft =
    provider === "Microsoft" ||
    isLocalMicrosoftToken(token) ||
    (client !== null && !textField(client.clientSecret) && isLocalMicrosoftToken(client));
  if (microsoft) return microsoftPayload(token, client);

  if (!social) {
    if (!client) {
      const hash = textField(token.clientIdHash).trim();
      return {
        ok: false,
        error: hash
          ? { key: "clientMissingNamed", params: { file: hash }, hint: "microsoftChoiceHint" }
          : { key: "clientMissing", hint: "microsoftChoiceHint" },
      };
    }
    if (!textField(client.clientId) || !textField(client.clientSecret)) {
      return { ok: false, error: { key: "clientSecretMissing" } };
    }
  }

  return {
    ok: true,
    payload: {
      refreshToken: textField(token.refreshToken),
      accessToken: textField(token.accessToken),
      clientId: textField(client?.clientId),
      clientSecret: textField(client?.clientSecret),
      region: textField(token.region),
      authMethod: client ? "idc" : "social",
      provider,
    },
  };
}
