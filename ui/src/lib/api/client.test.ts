import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSession,
  getToken,
  type SessionChangeReason,
  setSession,
  subscribeSession,
} from "@/lib/auth/session";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { apiBlob, apiRequest } from "./client";
import { ApiError } from "./errors";

function signIn(token: string): void {
  setSession({ token, expiresAt: Date.now() + 3_600_000, remember: false }, "signin");
}

/** Captures the headers of the next request to `path`. */
function captureHeaders(path: string, response: () => Response = () => HttpResponse.json({})) {
  const seen: Headers[] = [];
  mockServer.use(
    http.all(apiUrl(path), ({ request }) => {
      seen.push(request.headers);
      return response();
    }),
  );
  return seen;
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

const unsubscribers: Array<() => void> = [];

function recordReasons(): SessionChangeReason[] {
  const reasons: SessionChangeReason[] = [];
  unsubscribers.push(subscribeSession((_session, reason) => reasons.push(reason)));
  return reasons;
}

// Authenticated requests need a session; tests that need another token sign in again.
beforeEach(() => {
  signIn("token-default");
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

describe("apiRequest headers", () => {
  it("sends X-Admin-Token when a session exists and never X-Admin-Password", async () => {
    signIn("token-a");
    const seen = captureHeaders("/probe");
    await apiRequest("/probe");
    expect(seen[0].get("X-Admin-Token")).toBe("token-a");
    expect(seen[0].has("X-Admin-Password")).toBe(false);
  });

  it("sends no token with auth: false", async () => {
    signIn("token-a");
    const seen = captureHeaders("/probe");
    await apiRequest("/probe", { auth: false });
    expect(seen[0].has("X-Admin-Token")).toBe(false);
    expect(seen[0].has("X-Admin-Password")).toBe(false);
  });

  it("sends nothing and fails with 401 when signed out", async () => {
    clearSession("signout");
    const seen = captureHeaders("/probe");
    const reasons = recordReasons();
    const error = await rejection(apiRequest("/probe"));
    expect(error.status).toBe(401);
    expect(reasons).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("sends JSON bodies as application/json", async () => {
    let body: unknown;
    let contentType: string | null = null;
    mockServer.use(
      http.post(apiUrl("/probe"), async ({ request }) => {
        contentType = request.headers.get("Content-Type");
        body = await request.json();
        return HttpResponse.json({ success: true });
      }),
    );
    await apiRequest("/probe", { method: "POST", body: { a: 1 } });
    expect(contentType).toBe("application/json");
    expect(body).toEqual({ a: 1 });
  });

  it("leaves the Content-Type of FormData to the browser", async () => {
    const seen = captureHeaders("/probe", () => HttpResponse.json({ success: true }));
    const form = new FormData();
    form.append("file", new Blob(["{}"], { type: "application/json" }), "backup.json");
    await apiRequest("/probe", { method: "POST", body: form });
    expect(seen[0].get("Content-Type") ?? "").not.toContain("application/json");
  });

  it("skips undefined, null and empty query values", async () => {
    let url = "";
    mockServer.use(
      http.get(apiUrl("/probe"), ({ request }) => {
        url = request.url;
        return HttpResponse.json({});
      }),
    );
    await apiRequest("/probe", { query: { a: 1, b: undefined, c: null, d: "", e: false } });
    expect(new URL(url).search).toBe("?a=1&e=false");
  });
});

describe("apiRequest errors", () => {
  it("throws ApiError with the server message for a 400", async () => {
    mockServer.use(
      http.post(apiUrl("/probe"), () =>
        HttpResponse.json({ error: "Invalid JSON" }, { status: 400 }),
      ),
    );
    const error = await rejection(apiRequest("/probe", { method: "POST", body: {} }));
    expect(error.status).toBe(400);
    expect(error.serverMessage).toBe("Invalid JSON");
    expect(error.body).toEqual({ error: "Invalid JSON" });
  });

  it("uses a plain-text body as the message (413)", async () => {
    mockServer.use(
      http.post(
        apiUrl("/probe"),
        () => new HttpResponse("http: request body too large", { status: 413 }),
      ),
    );
    const error = await rejection(apiRequest("/probe", { method: "POST", body: {} }));
    expect(error.status).toBe(413);
    expect(error.serverMessage).toBe("http: request body too large");
  });

  it("reads Retry-After on a 429", async () => {
    mockServer.use(
      http.get(apiUrl("/probe"), () =>
        HttpResponse.json(
          { error: "Too many admin password attempts; try again later" },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
      ),
    );
    const error = await rejection(apiRequest("/probe"));
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(30);
  });

  it("reads index from a model-mapping 400", async () => {
    mockServer.use(
      http.post(apiUrl("/probe"), () =>
        HttpResponse.json({ error: "mapping points to itself", index: 2 }, { status: 400 }),
      ),
    );
    const error = await rejection(apiRequest("/probe", { method: "POST", body: {} }));
    expect(error.index).toBe(2);
    expect(error.retryAfter).toBeNull();
  });

  it("throws on a 2xx body with success: false", async () => {
    mockServer.use(
      http.post(apiUrl("/probe"), () => HttpResponse.json({ success: false, error: "x" })),
    );
    const error = await rejection(apiRequest("/probe", { method: "POST", body: {} }));
    expect(error.status).toBe(200);
    expect(error.serverMessage).toBe("x");
  });

  it("maps a network failure to status 0", async () => {
    mockServer.use(http.get(apiUrl("/probe"), () => HttpResponse.error()));
    const error = await rejection(apiRequest("/probe"));
    expect(error.status).toBe(0);
    expect(error.serverMessage).toBe("network");
  });
});

describe("401 handling", () => {
  it("clears the session once for two parallel 401s", async () => {
    signIn("token-a");
    const reasons = recordReasons();
    mockServer.use(
      http.get(apiUrl("/probe"), () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );
    const results = await Promise.allSettled([apiRequest("/probe"), apiRequest("/probe")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(reasons.filter((r) => r === "expired")).toHaveLength(1);
    expect(getToken()).toBeNull();
  });

  it("does not clear the session for a 401 with auth: false", async () => {
    signIn("token-a");
    const reasons = recordReasons();
    mockServer.use(
      http.post(apiUrl("/session"), () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );
    await rejection(apiRequest("/session", { method: "POST", body: {}, auth: false }));
    expect(reasons).toEqual([]);
    expect(getToken()).toBe("token-a");
  });

  it("ignores a late 401 for a token that was already replaced", async () => {
    signIn("token-old");
    const reasons = recordReasons();
    let answer: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    let arrived: () => void = () => {};
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    mockServer.use(
      http.get(apiUrl("/slow"), () => {
        arrived();
        return pending;
      }),
    );
    const request = apiRequest("/slow");
    await requestArrived;
    setSession({ token: "token-new", expiresAt: Date.now() + 3_600_000, remember: false });
    answer(HttpResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const error = await rejection(request);
    expect(error.status).toBe(401);
    expect(getToken()).toBe("token-new");
    expect(reasons).not.toContain("expired");
  });
});

describe("apiBlob", () => {
  it("returns the blob and the Content-Disposition filename", async () => {
    signIn("token-a");
    mockServer.use(
      http.get(
        apiUrl("/backups/:id/download"),
        () =>
          new HttpResponse('{"format":"kiro-proxy-backup"}', {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": 'attachment; filename="kiro-backup-abc.json"',
            },
          }),
      ),
    );
    const { blob, filename } = await apiBlob("/backups/abc/download");
    expect(filename).toBe("kiro-backup-abc.json");
    expect(await blob.text()).toBe('{"format":"kiro-proxy-backup"}');
  });

  it("throws ApiError for a JSON error body", async () => {
    mockServer.use(
      http.get(apiUrl("/probe"), () =>
        HttpResponse.json({ error: "backup not found: x" }, { status: 404 }),
      ),
    );
    const error = await rejection(apiBlob("/probe"));
    expect(error.status).toBe(404);
    expect(error.serverMessage).toBe("backup not found: x");
  });
});
