import type { CredentialsImportRequest } from "@/lib/api/types";

/** A credentials item as pasted: any JSON value, read field by field. */
export type CredentialSource = Record<string, unknown>;

type MappedCredential =
  | { kind: "request"; payload: CredentialsImportRequest }
  | { kind: "missingRefreshToken" };

const MICROSOFT_ALIASES = [
  "external_idp",
  "external-idp",
  "external",
  "microsoft",
  "m365",
  "office365",
  "azure",
  "azuread",
  "azure-ad",
  "azure_ad",
  "entra",
  "entra-id",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field as text: strings as is, numbers and booleans stringified, anything else empty. */
export function textField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Microsoft Entra credentials: an alias in authMethod or provider, or an Entra endpoint. */
export function isMicrosoftCredential(item: CredentialSource): boolean {
  return (
    MICROSOFT_ALIASES.includes(textField(item.authMethod).toLowerCase()) ||
    MICROSOFT_ALIASES.includes(textField(item.provider).toLowerCase()) ||
    Boolean(textField(item.tokenEndpoint) || textField(item.issuerUrl))
  );
}

/** One Kiro Account Manager export entry: `credentials.x` wins over the entry's own `x`. */
function fromAccountManager(entry: unknown): CredentialSource {
  const account = isRecord(entry) ? entry : {};
  const credentials = isRecord(account.credentials) ? account.credentials : {};
  const pick = (key: string) => textField(credentials[key]) || textField(account[key]);
  return {
    refreshToken: pick("refreshToken"),
    accessToken: pick("accessToken"),
    kiroApiKey: pick("kiroApiKey"),
    clientId: pick("clientId"),
    clientSecret: pick("clientSecret"),
    region: pick("region"),
    authMethod: pick("authMethod"),
    provider: pick("provider") || textField(account.idp),
    userId: textField(account.userId),
    profileArn: textField(account.profileArn),
    tokenEndpoint: textField(credentials.tokenEndpoint),
    issuerUrl: textField(credentials.issuerUrl),
    scopes: textField(credentials.scopes),
  };
}

/**
 * Accepts one object, an array, or a Kiro Account Manager export (`{accounts: [...]}`).
 * Throws when the text is not JSON.
 */
export function parseCredentialsJson(text: string): CredentialSource[] {
  const json: unknown = JSON.parse(text.trim());
  if (isRecord(json) && Array.isArray(json.accounts)) return json.accounts.map(fromAccountManager);
  const items = Array.isArray(json) ? json : [json];
  return items.map((item) => (isRecord(item) ? item : {}));
}

/** The request for one item, mapped exactly like the old admin panel did. */
export function mapCredential(item: CredentialSource): MappedCredential {
  const refreshToken = textField(item.refreshToken);
  const accessToken = textField(item.accessToken);
  const region = textField(item.region);
  const method = textField(item.authMethod).toLowerCase();

  const looksLikeApiKey =
    method === "api_key" || method === "apikey" || accessToken.startsWith("ksk_");
  const apiKey =
    textField(item.kiroApiKey) || (looksLikeApiKey && !refreshToken ? accessToken : "");
  if (apiKey) {
    return { kind: "request", payload: { kiroApiKey: apiKey, authMethod: "api_key", region } };
  }

  if (!refreshToken) return { kind: "missingRefreshToken" };

  // Entra credentials go through untouched: the server owns alias detection and endpoint recovery.
  if (isMicrosoftCredential(item)) {
    return {
      kind: "request",
      payload: {
        refreshToken,
        accessToken,
        clientId: textField(item.clientId),
        authMethod: "external_idp",
        provider: "AzureAD",
        region,
        userId: textField(item.userId),
        profileArn: textField(item.profileArn),
        tokenEndpoint: textField(item.tokenEndpoint),
        issuerUrl: textField(item.issuerUrl),
        scopes: textField(item.scopes),
      },
    };
  }

  const clientId = textField(item.clientId);
  const clientSecret = textField(item.clientSecret);
  const authMethod = clientId && clientSecret ? "idc" : method === "idc" ? "idc" : "social";
  const provider = textField(item.provider) || (authMethod === "idc" ? "BuilderId" : "Google");
  return {
    kind: "request",
    payload: {
      refreshToken,
      accessToken,
      clientId,
      clientSecret,
      authMethod,
      provider,
      region: region || "us-east-1",
    },
  };
}
