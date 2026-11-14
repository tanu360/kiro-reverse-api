import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import { renderWithProviders } from "@/test/render";
import { RequestDetailSheet } from "./request-detail-sheet";
import { RequestCard } from "./requests-columns";

const RAW = "outbound proxy failed: connection refused or reset";
const PLAIN = "Could not connect through the account's proxy. The proxy refused the connection.";

const PROXY_ERROR: RequestRecord = {
  id: 7,
  ts: 1_762_000_000,
  accountId: "acc-1",
  email: "owner@example.com",
  model: "claude-haiku-4.5",
  inTokens: 0,
  outTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  credits: 0,
  success: false,
  status: 503,
  message: RAW,
  errorType: "proxy",
  endpoint: "claude",
  durationMs: 20,
  attempts: [
    {
      accountId: "acc-1",
      email: "owner@example.com",
      startMs: 0,
      durationMs: 18,
      success: false,
      errorType: "proxy",
      message: RAW,
      proxy: { source: "account", code: "connect" },
    },
  ],
};

describe("a Proxy error request", () => {
  it("leads the details with the plain sentence and keeps the client's error behind Details", async () => {
    const { user } = renderWithProviders(
      <RequestDetailSheet
        count={1}
        onOpenChange={() => {}}
        open
        position={1}
        record={PROXY_ERROR}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    const message = within(dialog).getByTestId("request-message");
    expect(message).toHaveTextContent(PLAIN);
    expect(message).not.toHaveTextContent(RAW);
    await user.click(within(message).getByRole("button", { name: "Details" }));
    expect(await screen.findByText(RAW)).toBeVisible();
  });

  it("shows the plain sentence on the phone card", () => {
    renderWithProviders(<RequestCard onOpen={() => {}} record={PROXY_ERROR} />);
    expect(screen.getByText(PLAIN)).toBeInTheDocument();
    expect(screen.queryByText(RAW)).toBeNull();
  });

  it("keeps the client's error for a row logged before the server named the proxy", () => {
    renderWithProviders(
      <RequestCard onOpen={() => {}} record={{ ...PROXY_ERROR, attempts: undefined }} />,
    );
    expect(screen.getByText(RAW)).toBeInTheDocument();
  });

  it("words the sentence in the viewer's language", () => {
    renderWithProviders(<RequestCard onOpen={() => {}} record={PROXY_ERROR} />, { lang: "pt-BR" });
    expect(
      screen.getByText("Não foi possível conectar pelo proxy da conta. O proxy recusou a conexão."),
    ).toBeInTheDocument();
  });
});
