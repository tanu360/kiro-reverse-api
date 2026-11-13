import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { PoolProxy, ProxyPoolView } from "@/lib/api/proxy-pool";
import { type TParams, translate } from "@/lib/i18n";
import {
  assignedProxy,
  editorErrors,
  editorModel,
  editorRequest,
  hasErrors,
  intervalOptions,
  poolErrorMessage,
  proxyName,
  routesThroughPool,
  statusLook,
} from "./pool-model";

const t = (key: string, params?: TParams) => translate("en", "proxy-pool", key, params);

function poolProxy(overrides: Partial<PoolProxy> = {}): PoolProxy {
  return {
    id: "px_1",
    url: "socks5h://10.0.0.1:1080",
    hasPassword: false,
    accounts: 0,
    health: { status: "unknown" },
    ...overrides,
  };
}

function poolView(overrides: Partial<ProxyPoolView> = {}): ProxyPoolView {
  return {
    mode: "on",
    directFallback: false,
    checkIntervalMin: 10,
    proxies: [poolProxy()],
    assignments: {},
    ...overrides,
  };
}

describe("intervalOptions", () => {
  it("offers the presets, with a saved value outside them added in order", () => {
    expect(intervalOptions(10)).toEqual([0, 1, 5, 10, 30, 60]);
    expect(intervalOptions(15)).toEqual([0, 1, 5, 10, 15, 30, 60]);
    expect(intervalOptions(-1)).toEqual([0, 1, 5, 10, 30, 60]);
  });
});

describe("statusLook and proxyName", () => {
  it("maps each status to a tone and a label", () => {
    expect(statusLook("ok")).toEqual({ tone: "success", key: "proxy-pool:status.ok" });
    expect(statusLook("failed").tone).toBe("destructive");
    expect(statusLook("unknown").tone).toBe("neutral");
  });

  it("names a proxy by its label, else by its address", () => {
    expect(proxyName({ label: "Frankfurt", url: "http://a:1" })).toBe("Frankfurt");
    expect(proxyName({ label: "  ", url: "http://a:1" })).toBe("http://a:1");
    expect(proxyName({ url: "http://a:1" })).toBe("http://a:1");
  });
});

describe("assignment", () => {
  it("finds the proxy an account is on", () => {
    const view = poolView({ assignments: { acc1: "px_1", acc2: "px_gone" } });
    expect(assignedProxy(view, "acc1")?.id).toBe("px_1");
    expect(assignedProxy(view, "acc2")).toBeUndefined();
    expect(assignedProxy(view, "acc3")).toBeUndefined();
  });

  it("routes through the pool only while it is on and has proxies", () => {
    expect(routesThroughPool(poolView())).toBe(true);
    expect(routesThroughPool(poolView({ mode: "off" }))).toBe(false);
    expect(routesThroughPool(poolView({ proxies: [] }))).toBe(false);
    expect(routesThroughPool(undefined)).toBe(false);
  });
});

describe("editor", () => {
  it("starts an edit from the saved address and username, never a password", () => {
    const model = editorModel(
      poolProxy({ label: "VPS", url: "socks5h://[::1]:1080", username: "bob", hasPassword: true }),
    );
    expect(model.label).toBe("VPS");
    expect(model.proxy).toMatchObject({
      type: "socks5",
      scheme: "socks5h",
      host: "::1",
      port: "1080",
      username: "bob",
      password: "",
    });
  });

  it("flags a missing host, a bad port and a long label", () => {
    const model = editorModel();
    expect(editorErrors(model)).toEqual({ host: true, hostPort: false, port: true, label: false });
    model.proxy = { ...model.proxy, host: "h", port: "70000" };
    expect(editorErrors(model).port).toBe(true);
    model.proxy = { ...model.proxy, port: "8080" };
    model.label = "x".repeat(65);
    expect(editorErrors(model)).toEqual({ host: false, hostPort: false, port: false, label: true });
    model.label = "x".repeat(64);
    expect(hasErrors(editorErrors(model))).toBe(false);
  });

  it("flags a port typed after the host, not an IPv6 host", () => {
    const model = editorModel();
    model.proxy = { ...model.proxy, host: "127.0.0.1:19403", port: "1080" };
    expect(editorErrors(model).hostPort).toBe(true);
    expect(hasErrors(editorErrors(model))).toBe(true);
    model.proxy = { ...model.proxy, host: "::1" };
    expect(editorErrors(model).hostPort).toBe(false);
    model.proxy = { ...model.proxy, host: "proxy.example.com" };
    expect(hasErrors(editorErrors(model))).toBe(false);
  });

  it("sends the address without sign-in and the credentials as their own fields", () => {
    const model = editorModel();
    model.label = " Home ";
    model.proxy = {
      ...model.proxy,
      host: "proxy.local",
      port: "1080",
      username: "u",
      password: "p@ss",
    };
    expect(editorRequest(model, false)).toEqual({
      label: "Home",
      url: "socks5://proxy.local:1080",
      username: "u",
      password: "p@ss",
    });
  });

  it("keeps the saved password on an edit unless a new one is typed or Clear is ticked", () => {
    const model = editorModel(poolProxy({ username: "u", hasPassword: true }));
    expect(editorRequest(model, true)).not.toHaveProperty("password");
    expect(editorRequest({ ...model, clearPassword: true }, true).password).toBe("");
    const typed = { ...model, proxy: { ...model.proxy, password: "new" } };
    expect(editorRequest(typed, true).password).toBe("new");
  });

  it("drops the password when the username is cleared", () => {
    const model = editorModel(poolProxy({ username: "u", hasPassword: true }));
    model.proxy = { ...model.proxy, username: "", password: "left" };
    expect(editorRequest(model, true)).toMatchObject({ username: "", password: "" });
  });
});

describe("poolErrorMessage", () => {
  it("names a pool error and adds the server's detail", () => {
    const error = new ApiError({
      status: 400,
      serverMessage: "invalid proxy: url needs a port",
      body: { code: "proxy_pool_invalid", detail: "url needs a port" },
    });
    expect(poolErrorMessage(error, t)).toBe(
      "The server rejected this proxy. (Details: url needs a port)",
    );
  });

  it("uses the code's own text when there is no detail", () => {
    const error = new ApiError({
      status: 409,
      serverMessage: "this proxy is already in the pool",
      body: { code: "proxy_pool_duplicate" },
    });
    expect(poolErrorMessage(error, t)).toBe("This proxy is already in the pool.");
  });
});
