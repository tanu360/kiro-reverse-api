import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { RequestDetailSheet } from "./request-detail-sheet";

/**
 * An admin row with everything a key holder must never see: the account, key, upstream message,
 * the attempts chain with its accounts, the conversation and a kept body. The holder's view must
 * drop all of it even when the row carries it.
 */
const FAILED: RequestRecord = {
  ts: 1_762_000_000,
  accountId: "acc-secret",
  apiKeyId: "key-secret",
  apiKeyMasked: "sk-abc1****wxyz",
  email: "owner@example.com",
  model: "claude-sonnet-4.5",
  inTokens: 1200,
  outTokens: 0,
  totalTokens: 1200,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
  credits: 0,
  success: false,
  status: 429,
  message: "upstream said: quota for owner@example.com exhausted",
  endpoint: "claude",
  client: "claude-code",
  durationMs: 2350,
  errorType: "rate_limit",
  requestId: "req_0123456789abcdef01234567",
  conversationId: "conv-secret",
  hasBody: true,
  attempts: [
    {
      accountId: "acc-other",
      email: "other@example.com",
      endpoint: "Kiro IDE",
      startMs: 0,
      durationMs: 800,
      success: false,
      status: 429,
      errorType: "rate_limit",
      message: "HTTP 429 for other@example.com",
      failover: true,
    },
    {
      accountId: "acc-secret",
      email: "owner@example.com",
      endpoint: "Kiro IDE",
      startMs: 820,
      durationMs: 1500,
      success: false,
      status: 429,
      errorType: "rate_limit",
    },
  ],
};

const SUCCEEDED: RequestRecord = {
  ts: 1_762_000_000,
  accountId: "",
  model: "claude-haiku-4.5",
  inTokens: 1000,
  outTokens: 600,
  totalTokens: 1600,
  cacheReadTokens: 250,
  cacheWriteTokens: 40,
  credits: 0.012345,
  success: true,
  status: 200,
  endpoint: "openai",
  durationMs: 4000,
  requestId: "req_fedcba9876543210fedcba98",
  tries: 1,
};

/** Every /admin/api request: a key holder's sheet must send none. */
let adminCalls: string[] = [];

beforeEach(() => {
  adminCalls = [];
  mockServer.events.on("request:start", ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/admin/api")) adminCalls.push(`${request.method} ${pathname}`);
  });
});

afterEach(() => {
  mockServer.events.removeAllListeners();
});

function renderHolderSheet(record: RequestRecord) {
  return renderWithProviders(
    <RequestDetailSheet
      accounts={false}
      actions={false}
      count={1}
      details
      messages={false}
      onOpenChange={() => {}}
      open
      position={1}
      record={record}
    />,
  );
}

function labels(dialog: HTMLElement, label: string): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>("dt")].filter(
    (term) => term.textContent?.trim() === label,
  );
}

/** The value under a fact's label in the sheet's grids (a legend dot may lead the label). */
function fact(dialog: HTMLElement, label: string): HTMLElement {
  const [term, ...more] = labels(dialog, label);
  const value = term?.nextElementSibling;
  if (more.length > 0 || !(value instanceof HTMLElement)) throw new Error(`no one ${label}`);
  return value;
}

describe("RequestDetailSheet for a key holder", () => {
  it("drops the account, key, message, attempts chain, conversation and replay", async () => {
    renderHolderSheet(FAILED);
    const dialog = await screen.findByRole("dialog");
    const text = dialog.textContent ?? "";
    for (const secret of ["owner@example.com", "other@example.com", "acc-secret", "sk-abc1"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("upstream said");
    expect(text).not.toContain("conv-secret");
    for (const label of ["Account", "API key", "Account ID", "API key ID", "Conversation ID"]) {
      expect(labels(dialog, label)).toEqual([]);
    }
    for (const action of ["Open account", "Conversation", "Replay", "Copy as JSON"]) {
      expect(within(dialog).queryByRole("button", { name: action })).not.toBeInTheDocument();
    }
    expect(within(dialog).queryByRole("region", { name: "Attempts" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
    expect(dialog.querySelector("[data-testid=request-message]")).toBeNull();
    // Only the number of tries the chain took.
    expect(fact(dialog, "Attempts")).toHaveTextContent(/^2$/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adminCalls).toEqual([]);
  });

  it("shows a failure's status, category, caller, endpoint and request ID", async () => {
    renderHolderSheet(FAILED);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "claude-sonnet-4.5" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Failed 429")).toBeInTheDocument();
    // The table's pill, without the code: the status code has its own fact.
    expect(fact(dialog, "Error")).toHaveTextContent(/^Rate limited$/);
    expect(fact(dialog, "Status code")).toHaveTextContent("429");
    expect(fact(dialog, "Endpoint")).toHaveTextContent("Claude");
    expect(fact(dialog, "Client")).toHaveTextContent("Claude Code");
    expect(fact(dialog, "Request ID")).toHaveTextContent("req_0123456789abcdef01234567");
    expect(within(dialog).getByRole("button", { name: "Copy Request ID" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Trace ID")).not.toBeInTheDocument();
    // Nothing billed, the input still counted with its cache share.
    expect(fact(dialog, "Credits")).toHaveTextContent("—");
    expect(fact(dialog, "Duration")).toHaveTextContent("2.35s2,350 ms");
    expect(within(dialog).getByText("25% of input")).toBeInTheDocument();
    // No output: no speed.
    expect(dialog.querySelector("[data-output-speed]")).toBeNull();
  });

  it("shows a success's exact credits and duration, the speed and the API that was called", async () => {
    renderHolderSheet(SUCCEEDED);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Succeeded")).toBeInTheDocument();
    expect(fact(dialog, "Status code")).toHaveTextContent("200");
    expect(labels(dialog, "Error")).toEqual([]);
    expect(fact(dialog, "Credits")).toHaveTextContent(/^0\.012345$/);
    expect(fact(dialog, "Duration")).toHaveTextContent("4.00s4,000 ms");
    expect(fact(dialog, "Tokens")).toHaveTextContent("1,600");
    expect(fact(dialog, "Input")).toHaveTextContent("1,000");
    // 600 output tokens in 4 s, beside the output count.
    expect(fact(dialog, "Output")).toHaveTextContent("600150 tok/s");
    expect(fact(dialog, "Cache read")).toHaveTextContent("25025% of input");
    expect(fact(dialog, "Cache write")).toHaveTextContent("40");
    expect(fact(dialog, "Client")).toHaveTextContent("OpenAI API");
    expect(fact(dialog, "Endpoint")).toHaveTextContent("OpenAI");
    expect(fact(dialog, "Attempts")).toHaveTextContent(/^1$/);
  });

  it("leaves the admin's sheet as it was: actions, account facts, message and trace ID", async () => {
    renderWithProviders(
      <RequestDetailSheet
        count={1}
        onOpenChange={() => {}}
        open
        position={1}
        record={{ ...FAILED, id: 7 }}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    for (const action of ["Open account", "Conversation", "Replay", "Copy as JSON"]) {
      expect(within(dialog).getByRole("button", { name: action })).toBeInTheDocument();
    }
    expect(within(dialog).getByTestId("request-message")).toHaveTextContent("upstream said");
    expect(within(dialog).getByRole("region", { name: "Attempts" })).toBeInTheDocument();
    expect(fact(dialog, "Trace ID")).toHaveTextContent("req_0123456789abcdef01234567");
    expect(fact(dialog, "Account ID")).toHaveTextContent("acc-secret");
    expect(fact(dialog, "Duration")).toHaveTextContent(/^2\.35s$/);
    // A failure's badge carries the code; no status code fact, no caller, no tries count.
    for (const label of ["Status code", "Client", "Error", "Request ID"]) {
      expect(labels(dialog, label)).toEqual([]);
    }
  });
});
