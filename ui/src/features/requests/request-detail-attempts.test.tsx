import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestRecord } from "@/lib/api/types";
import { copyText } from "@/lib/clipboard";
import { maskEmail } from "@/lib/privacy";
import { renderWithProviders } from "@/test/render";
import { RequestDetailSheet } from "./request-detail-sheet";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

const copyTextMock = vi.mocked(copyText);

const EMAIL = "chain.owner@example.com";

const RECORD: RequestRecord = {
  id: 42,
  ts: 1_762_000_000,
  accountId: "acc-2",
  email: "second@example.com",
  model: "claude-sonnet-4.5",
  inTokens: 10,
  outTokens: 5,
  totalTokens: 15,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  credits: 0.01,
  success: true,
  status: 200,
  endpoint: "claude",
  durationMs: 2900,
  attempts: [
    {
      accountId: "acc-1",
      email: EMAIL,
      endpoint: "Kiro IDE",
      startMs: 0,
      durationMs: 800,
      success: false,
      status: 500,
      errorType: "upstream",
      message: `HTTP 500 for ${EMAIL}`,
      failover: true,
    },
    {
      accountId: "acc-2",
      email: "second@example.com",
      endpoint: "Kiro IDE",
      startMs: 820,
      durationMs: 2050,
      success: true,
    },
  ],
};

function renderSheet(record: RequestRecord, privacy: boolean) {
  return renderWithProviders(
    <RequestDetailSheet count={1} onOpenChange={() => {}} open position={1} record={record} />,
    { privacy },
  );
}

beforeEach(() => {
  copyTextMock.mockReset();
  copyTextMock.mockResolvedValue(true);
});

describe("RequestDetailSheet attempts", () => {
  it("shows the attempt chain in the sheet", async () => {
    renderSheet(RECORD, false);
    const dialog = await screen.findByRole("dialog");
    const card = within(dialog).getByRole("region", { name: "Attempts" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
    expect(card).toHaveTextContent("Moved to another account");
  });

  it("leaves the card out for a row logged before the chain existed", async () => {
    renderSheet({ ...RECORD, attempts: undefined }, false);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("region", { name: "Attempts" })).toBeNull();
  });

  it("masks attempt emails in Copy as JSON under privacy mode", async () => {
    const { user } = renderSheet(RECORD, true);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveTextContent(EMAIL);
    await user.click(within(dialog).getByRole("button", { name: "Copy as JSON" }));
    const copied = JSON.parse(String(await copyTextMock.mock.calls[0]?.[0])) as RequestRecord;
    expect(copied.attempts?.[0].email).toBe(maskEmail(EMAIL));
    expect(copied.attempts?.[0].message).toBe(`HTTP 500 for ${maskEmail(EMAIL)}`);
    expect(copied.attempts?.[1].durationMs).toBe(2050);
  });
});
