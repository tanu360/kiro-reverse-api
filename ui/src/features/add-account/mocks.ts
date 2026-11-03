import { type HttpHandler, HttpResponse, http } from "msw";
import type {
  Account,
  AddedAccountRef,
  AuthMethod,
  CredentialsImportRequest,
  KiroProfile,
} from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { makeAccount, makeAccountFull } from "@/lib/mocks/fixtures";
import { apiUrl, jsonError, mockDelay, requireAuth } from "@/lib/mocks/http";

// Add-account auth flows. Every success appends an account to mockDb, like the Go handlers.
// Scenario switches live in the inputs, so mock mode can walk every branch by hand:
// - Builder ID: region eu-west-9 expires on the first poll.
// - Microsoft: a callback with `dup` is a duplicate; on the second leg `profiles=2` offers two
//   Kiro profiles, `noprofile` completes with a warning.
// - SSO token: a line `bad` fails; only bad lines fail the whole request.
// - Credentials: a Kiro API key already added is a 409.

const REGION_RE = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;
const API_KEY_REGIONS = ["us-east-1", "eu-central-1"];
const BUILDER_ID_EXPIRED_REGION = "eu-west-9";
const BUILDER_ID_PENDING_POLLS = 2;

interface BuilderIdSession {
  polls: number;
  region: string;
}

interface MicrosoftSession {
  kind: "session";
  leg: "kiro" | "microsoft";
}

interface MicrosoftSelection {
  kind: "selection";
  profiles: KiroProfile[];
}

let sequence = 0;

function newId(): string {
  return crypto.randomUUID();
}

/** Region rules of config/region.go: trimmed, lowercased, empty means us-east-1. */
function normalizeRegion(raw: unknown): string | null {
  const region = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!region) return "us-east-1";
  return REGION_RE.test(region) ? region : null;
}

function addAccount(
  overrides: Partial<Account>,
  secrets: Record<string, string> = {},
): AddedAccountRef {
  sequence += 1;
  const account = makeAccount({
    region: "us-east-1",
    activeRegion: overrides.region ?? "us-east-1",
    lastRefresh: Math.floor(Date.now() / 1000),
    ...overrides,
  });
  mockDb.accounts.push(account);
  mockDb.secrets[account.id] = { ...makeAccountFull(account), ...secrets };
  return { id: account.id, email: account.email };
}

function newEmail(prefix: string): string {
  return `${prefix}.${sequence + 1}@northwind-labs.dev`;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function microsoftState(id: string): MicrosoftSession | MicrosoftSelection | undefined {
  return mockDb.pending.microsoft[id] as MicrosoftSession | MicrosoftSelection | undefined;
}

function builderIdState(id: string): BuilderIdSession | undefined {
  return mockDb.pending.builderId[id] as BuilderIdSession | undefined;
}

function addMicrosoftAccount(profileArn = ""): AddedAccountRef {
  return addAccount({
    email: newEmail("entra.user"),
    authMethod: "external_idp",
    provider: "AzureAD",
    profileArn,
  });
}

function importApiKey(body: CredentialsImportRequest): Response {
  const raw = (body.kiroApiKey || body.accessToken || "").trim();
  if (!raw) return jsonError(400, "kiroApiKey is empty");
  const parts = raw.split("|");
  if (parts.length > 2) return jsonError(400, "kiroApiKey has more than one '|' separator");
  const [key, suffix = ""] = parts.map((part) => part.trim());
  if (!/^[\w.-]+$/.test(key)) return jsonError(400, "kiroApiKey contains invalid characters");
  const region = normalizeRegion(body.region || suffix);
  if (!region) return jsonError(400, "invalid Kiro API key region");
  if (!API_KEY_REGIONS.includes(region)) {
    return jsonError(400, "unsupported Kiro API key region: use us-east-1 or eu-central-1");
  }
  if (Object.values(mockDb.secrets).some((secret) => secret.kiroApiKey === key)) {
    return jsonError(409, "this Kiro API key is already added");
  }
  const account = addAccount(
    {
      authMethod: "api_key",
      provider: "APIKey",
      region,
      activeRegion: region,
      expiresAt: 0,
    },
    { kiroApiKey: key, accessToken: key, refreshToken: "" },
  );
  return HttpResponse.json({ success: true, account });
}

function importRefreshToken(body: CredentialsImportRequest): Response {
  const refreshToken = (body.refreshToken ?? "").trim();
  if (!refreshToken) return jsonError(400, "refreshToken or kiroApiKey is required");
  const region = normalizeRegion(body.region);
  if (!region) return jsonError(400, "invalid region");
  const hint = (body.authMethod ?? "").toLowerCase();
  const microsoft = hint === "external_idp" || Boolean(body.tokenEndpoint || body.issuerUrl);
  const authMethod: AuthMethod = microsoft
    ? "external_idp"
    : hint === "idc" || (body.clientId && body.clientSecret)
      ? "idc"
      : "social";
  const account = addAccount(
    {
      email: newEmail(authMethod === "social" ? "social.user" : "idc.user"),
      authMethod,
      provider: body.provider || (authMethod === "social" ? "Google" : "BuilderId"),
      region,
      activeRegion: region,
      userId: body.userId ?? "",
      profileArn: body.profileArn ?? "",
    },
    { refreshToken, accessToken: body.accessToken ?? "" },
  );
  return HttpResponse.json({ success: true, account });
}

export const handlers: HttpHandler[] = [
  // IAM Identity Center
  http.post(apiUrl("/auth/iam-sso/start"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const startUrl = text(body.startUrl).trim();
    if (!startUrl) return jsonError(400, "startUrl is required");
    const region = normalizeRegion(body.region);
    if (!region) return jsonError(400, "invalid region");
    const sessionId = newId();
    mockDb.pending.iam[sessionId] = { startUrl, region };
    return HttpResponse.json({
      sessionId,
      authorizeUrl: `https://oidc.${region}.amazonaws.com/authorize?response_type=code&client_id=mock-${sessionId.slice(0, 8)}&redirect_uri=http%3A%2F%2F127.0.0.1%2Foauth%2Fcallback&state=${sessionId}&code_challenge_method=S256`,
      expiresIn: 600,
    });
  }),

  http.post(apiUrl("/auth/iam-sso/complete"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const session = mockDb.pending.iam[text(body.sessionId)] as { region: string } | undefined;
    if (!session) return jsonError(400, "会话不存在或已过期");
    const callbackUrl = text(body.callbackUrl);
    if (!callbackUrl.includes("code=") || !callbackUrl.includes("state=")) {
      return jsonError(400, "无效的回调 URL");
    }
    delete mockDb.pending.iam[text(body.sessionId)];
    const account = addAccount({
      email: newEmail("enterprise.user"),
      authMethod: "idc",
      provider: "Enterprise",
      region: session.region,
      activeRegion: session.region,
    });
    return HttpResponse.json({ success: true, account });
  }),

  // Microsoft SSO
  http.post(apiUrl("/auth/microsoft-sso/start"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const sessionId = newId();
    const session: MicrosoftSession = { kind: "session", leg: "kiro" };
    mockDb.pending.microsoft[sessionId] = session;
    return HttpResponse.json({
      sessionId,
      authorizeUrl: `https://app.kiro.dev/signin?redirect_uri=http%3A%2F%2Flocalhost%3A3128&state=${sessionId}&login_option=external_idp`,
      expiresIn: 600,
      stage: "kiro",
    });
  }),

  http.post(apiUrl("/auth/microsoft-sso/complete"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const sessionId = text(body.sessionId).trim();
    const callbackUrl = text(body.callbackUrl).trim();
    if (!sessionId || !callbackUrl) return jsonError(400, "sessionId and callbackUrl are required");
    const session = microsoftState(sessionId);
    if (session?.kind !== "session") {
      return jsonError(400, "Microsoft SSO session not found or expired");
    }
    if (callbackUrl.includes("dup"))
      return jsonError(409, "this Microsoft account is already added");
    if (session.leg === "kiro") {
      session.leg = "microsoft";
      return HttpResponse.json({
        success: true,
        stage: "microsoft",
        authorizeUrl: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=mock&redirect_uri=http%3A%2F%2Flocalhost%3A3128%2Foauth%2Fcallback&state=${sessionId}`,
      });
    }
    delete mockDb.pending.microsoft[sessionId];
    if (callbackUrl.includes("profiles=2")) {
      const selectionId = newId();
      const selection: MicrosoftSelection = {
        kind: "selection",
        profiles: [
          {
            arn: "arn:aws:codewhisperer:eu-central-1:381492027763:profile/QK7M2XRZ9PLA",
            name: "Northwind Engineering",
            region: "eu-central-1",
          },
          {
            arn: "arn:aws:codewhisperer:us-east-1:381492027763:profile/HV4N8TQW2JDE",
            region: "us-east-1",
          },
        ],
      };
      mockDb.pending.microsoft[selectionId] = selection;
      return HttpResponse.json({
        success: true,
        stage: "profile",
        selectionId,
        profiles: selection.profiles,
      });
    }
    const account = addMicrosoftAccount();
    return HttpResponse.json({
      success: true,
      stage: "complete",
      account,
      ...(callbackUrl.includes("noprofile")
        ? {
            warning:
              "The account was added, but its Kiro profile could not be resolved yet: no Kiro profile found",
          }
        : {}),
    });
  }),

  http.post(apiUrl("/auth/microsoft-sso/select-profile"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const selectionId = text(body.selectionId);
    const selection = microsoftState(selectionId);
    if (selection?.kind !== "selection") {
      return jsonError(400, "Microsoft profile selection not found or expired");
    }
    const profileArn = text(body.profileArn);
    if (!selection.profiles.some((profile) => profile.arn === profileArn)) {
      return jsonError(400, "Selected Kiro profile was not offered for this login");
    }
    delete mockDb.pending.microsoft[selectionId];
    return HttpResponse.json({
      success: true,
      stage: "complete",
      account: addMicrosoftAccount(profileArn),
    });
  }),

  http.post(apiUrl("/auth/microsoft-sso/cancel"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = (await readJson(request)) ?? {};
    for (const id of [text(body.sessionId), text(body.selectionId)]) {
      if (id) delete mockDb.pending.microsoft[id];
    }
    return HttpResponse.json({ success: true });
  }),

  // AWS Builder ID device code
  http.post(apiUrl("/auth/builderid/start"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = (await readJson(request)) ?? {};
    const region = normalizeRegion(body.region);
    if (!region) return jsonError(400, "invalid region");
    const sessionId = newId();
    const session: BuilderIdSession = { polls: 0, region };
    mockDb.pending.builderId[sessionId] = session;
    return HttpResponse.json({
      sessionId,
      userCode: "ABCD-EFGH",
      verificationUri: "https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH",
      interval: 1,
    });
  }),

  http.post(apiUrl("/auth/builderid/poll"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const sessionId = text(body.sessionId);
    const session = builderIdState(sessionId);
    if (!session) {
      return HttpResponse.json(
        { success: false, error: "session not found or expired" },
        { status: 400 },
      );
    }
    if (session.region === BUILDER_ID_EXPIRED_REGION) {
      delete mockDb.pending.builderId[sessionId];
      return HttpResponse.json({ success: false, error: "authorization expired" }, { status: 400 });
    }
    session.polls += 1;
    if (session.polls <= BUILDER_ID_PENDING_POLLS) {
      return HttpResponse.json({ success: true, completed: false, status: "pending", interval: 1 });
    }
    delete mockDb.pending.builderId[sessionId];
    const account = addAccount({
      email: newEmail("builder.dev"),
      authMethod: "idc",
      provider: "BuilderId",
      region: session.region,
      activeRegion: session.region,
    });
    return HttpResponse.json({ success: true, completed: true, account });
  }),

  // SSO token (bulk)
  http.post(apiUrl("/auth/sso-token"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = await readJson(request);
    if (!body) return jsonError(400, "Invalid JSON");
    const bearerToken = text(body.bearerToken);
    if (!bearerToken.trim()) return jsonError(400, "bearerToken is required");
    const region = normalizeRegion(body.region);
    if (!region) return jsonError(400, "invalid region");
    const lines = bearerToken
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const accounts: AddedAccountRef[] = [];
    const errors: string[] = [];
    lines.forEach((line, index) => {
      if (line === "bad") {
        errors.push(`token ${index + 1}: token 验证失败: 401 Unauthorized`);
        return;
      }
      accounts.push(
        addAccount({ email: "", authMethod: "idc", provider: "", region, activeRegion: region }),
      );
    });
    if (accounts.length === 0 && errors.length > 0) {
      return HttpResponse.json({ success: false, error: errors.join("; ") }, { status: 500 });
    }
    return HttpResponse.json({
      success: true,
      accounts: accounts.length ? accounts : null,
      errors: errors.length ? errors : null,
    });
  }),

  // Credentials (local cache, credentials JSON, web cookie, Kiro API keys)
  http.post(apiUrl("/auth/credentials"), async ({ request }) => {
    const denied = requireAuth(request);
    if (denied) return denied;
    await mockDelay();
    const body = (await readJson(request)) as CredentialsImportRequest | null;
    if (!body) return jsonError(400, "Invalid JSON");
    const method = (body.authMethod ?? "").toLowerCase();
    const apiKeyPath =
      Boolean(body.kiroApiKey) ||
      (!body.refreshToken &&
        (method === "api_key" ||
          method === "apikey" ||
          (body.accessToken ?? "").startsWith("ksk_")));
    return apiKeyPath ? importApiKey(body) : importRefreshToken(body);
  }),
];
