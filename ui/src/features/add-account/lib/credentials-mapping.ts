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

/**
 * An export's top-level `tags` list as id to name. Kiro Account Manager files give each tag a
 * UUID id; this server's exports use the name as the id.
 */
function tagNames(value: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(value)) return names;
  for (const tag of value) {
    if (!isRecord(tag)) continue;
    const id = textField(tag.id);
    const name = textField(tag.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

/** An entry's tag ids as names; an id the top-level list does not know is kept as it is. */
function entryTags(value: unknown, names: ReadonlyMap<string, string>): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (isRecord(tag) ? textField(tag.name) : textField(tag)))
    .map((tag) => names.get(tag) ?? tag)
    .filter((tag) => tag.trim() !== "");
}

/** Text that may be absent: "" for anything but a string. */
function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One Kiro Account Manager export entry: `credentials.x` wins over the entry's own `x`. The
 * nickname, notes and tags come along, with tag ids resolved through `names`.
 */
function fromAccountManager(
  entry: unknown,
  names: ReadonlyMap<string, string> = new Map(),
): CredentialSource {
  const account = isRecord(entry) ? entry : {};
  const credentials = isRecord(account.credentials) ? account.credentials : {};
  const pick = (key: string) => textField(credentials[key]) || textField(account[key]);
  const metadata: CredentialSource = {};
  const nickname = optionalText(account.nickname);
  const notes = optionalText(account.notes);
  const tags = entryTags(account.tags, names);
  if (nickname) metadata.nickname = nickname;
  if (notes) metadata.notes = notes;
  if (tags.length > 0) metadata.tags = tags;
  return {
    ...metadata,
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
  if (isRecord(json) && Array.isArray(json.accounts)) {
    const names = tagNames(json.tags);
    return json.accounts.map((entry) => fromAccountManager(entry, names));
  }
  const items = Array.isArray(json) ? json : [json];
  return items.map((item) => (isRecord(item) ? item : {}));
}

/** The nickname, notes and tags an item carries, for any import request; empty ones are left out. */
function metadataFields(
  item: CredentialSource,
): Pick<CredentialsImportRequest, "nickname" | "notes" | "tags"> {
  const fields: Pick<CredentialsImportRequest, "nickname" | "notes" | "tags"> = {};
  const nickname = optionalText(item.nickname).trim();
  const notes = optionalText(item.notes).trim();
  const tags = Array.isArray(item.tags)
    ? item.tags.map(textField).filter((tag) => tag.trim() !== "")
    : [];
  if (nickname) fields.nickname = nickname;
  if (notes) fields.notes = notes;
  if (tags.length > 0) fields.tags = tags;
  return fields;
}

/**
 * The request for one item, mapped exactly like the old admin panel did, plus the nickname,
 * notes and tags it carries.
 */
export function mapCredential(item: CredentialSource): MappedCredential {
  const metadata = metadataFields(item);
  const refreshToken = textField(item.refreshToken);
  const accessToken = textField(item.accessToken);
  const region = textField(item.region);
  const method = textField(item.authMethod).toLowerCase();

  const looksLikeApiKey =
    method === "api_key" || method === "apikey" || accessToken.startsWith("ksk_");
  const apiKey =
    textField(item.kiroApiKey) || (looksLikeApiKey && !refreshToken ? accessToken : "");
  if (apiKey) {
    return {
      kind: "request",
      payload: { kiroApiKey: apiKey, authMethod: "api_key", region, ...metadata },
    };
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
        ...metadata,
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
      ...metadata,
    },
  };
}
