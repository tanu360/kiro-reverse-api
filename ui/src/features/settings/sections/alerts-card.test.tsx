import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertsConfig } from "@/lib/api/alerts";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AlertsCard } from "./alerts-card";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let recorded: Array<Promise<Recorded>> = [];

function onRequestStart({ request }: { request: Request }): void {
  const path = new URL(request.url).pathname.replace(/^\/admin\/api/, "");
  recorded.push(
    request
      .clone()
      .text()
      .then((text) => ({ method: request.method, path, body: text ? JSON.parse(text) : null })),
  );
}

async function writes(): Promise<Recorded[]> {
  return (await Promise.all(recorded)).filter((r) => r.method !== "GET");
}

beforeEach(() => {
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

const SAVED: AlertsConfig = {
  accountUsage: true,
  poolUsage: false,
  accountBanned: true,
  allUnavailable: true,
  accountThresholds: [80, 90, 100],
  poolThresholds: [95],
  poolCooldownMinutes: 30,
  channels: [
    {
      id: "ch_ops",
      type: "webhook",
      name: "Ops hook",
      enabled: true,
      targetHint: "https://hooks.example.com/…",
      urlSet: true,
      botTokenSet: false,
      secretSet: true,
      lastResult: {
        ts: Math.floor(Date.now() / 1000) - 120,
        ok: false,
        status: 503,
        attempts: 4,
        event: "pool_usage",
        error: "HTTP 503: upstream down",
      },
    },
  ],
};

async function renderCard() {
  const result = renderWithProviders(<AlertsCard />);
  await screen.findByRole("button", { name: "Add channel" });
  return result;
}

describe("AlertsCard", () => {
  it("shows a channel's target hint and last result, never its secrets", async () => {
    mockServer.use(http.get(apiUrl("/alerts"), () => HttpResponse.json(SAVED)));
    await renderCard();

    const row = (await screen.findByText("Ops hook")).closest("li") as HTMLElement;
    expect(within(row).getByText("https://hooks.example.com/…")).toBeInTheDocument();
    expect(within(row).getByText("Webhook")).toBeInTheDocument();
    expect(within(row).getByText("Failed")).toBeInTheDocument();
    expect(within(row).getByText("Pool usage")).toBeInTheDocument();
    expect(within(row).getByText("4 attempts")).toBeInTheDocument();
    expect(within(row).getByText("HTTP 503: upstream down")).toBeInTheDocument();

    expect(screen.getByLabelText("Pool thresholds (%)")).toHaveValue("95");
    expect(screen.getByText("1 channel on")).toBeInTheDocument();
  });

  it("masks emails in a channel's name and error under privacy", async () => {
    const named: AlertsConfig = {
      ...SAVED,
      channels: [
        {
          ...SAVED.channels[0],
          name: "Pager ops@example.com",
          lastResult: {
            ts: Math.floor(Date.now() / 1000) - 60,
            ok: false,
            status: 403,
            attempts: 1,
            event: "test",
            error: "rejected for ops@example.com",
          },
        },
      ],
    };
    mockServer.use(http.get(apiUrl("/alerts"), () => HttpResponse.json(named)));
    const { container } = renderWithProviders(<AlertsCard />, { privacy: true });

    const row = (await screen.findByText("Pager op***@ex***.com")).closest("li") as HTMLElement;
    expect(within(row).getByText("rejected for op***@ex***.com")).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Send test to Pager op***@ex***.com" }),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("ops@example.com");
  });

  it("adds a channel from the dialog and lists it with a masked target", async () => {
    const { user } = await renderCard();
    expect(
      screen.getByText("No channels yet. Add one to start getting alerts."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Add channel" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Required.")).toBeInTheDocument();
    expect(await writes()).toEqual([]);

    await user.type(within(dialog).getByLabelText("Name"), "Receiver");
    await user.type(
      within(dialog).getByLabelText("Webhook URL"),
      "https://hooks.example.com/secret-path",
    );
    await user.type(within(dialog).getByLabelText("Signing secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await screen.findByText("Channel saved.");
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/alerts",
        body: {
          channels: [
            {
              type: "webhook",
              name: "Receiver",
              enabled: true,
              url: "https://hooks.example.com/secret-path",
              secret: "s3cret",
            },
          ],
        },
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add channel" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("https://hooks.example.com/…")).toBeInTheDocument();
    expect(screen.queryByText(/secret-path/)).not.toBeInTheDocument();
    expect(screen.getByText("No alert sent yet.")).toBeInTheDocument();
  });

  it("removes a saved signing secret from the dialog", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    let dialog = await screen.findByRole("dialog", { name: "Add channel" });
    // A new channel has no saved secret to remove.
    expect(
      within(dialog).queryByRole("checkbox", { name: "Remove the saved secret" }),
    ).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "Receiver");
    await user.type(within(dialog).getByLabelText("Webhook URL"), "https://hooks.example.com/x");
    await user.type(within(dialog).getByLabelText("Signing secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add channel" })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Edit Receiver" }));
    dialog = await screen.findByRole("dialog", { name: "Edit channel" });
    const secret = within(dialog).getByLabelText("Signing secret");
    expect(secret).toHaveAttribute("placeholder", "Saved. Leave blank to keep it.");
    recorded = [];
    await user.click(within(dialog).getByRole("checkbox", { name: "Remove the saved secret" }));
    expect(secret).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit channel" })).not.toBeInTheDocument(),
    );
    const sent = await writes();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      channels: [
        {
          id: expect.stringMatching(/^ch_/),
          type: "webhook",
          name: "Receiver",
          enabled: true,
          clearSecret: true,
        },
      ],
    });

    // Saved without a secret: nothing is left to keep or remove.
    await user.click(screen.getByRole("button", { name: "Edit Receiver" }));
    dialog = await screen.findByRole("dialog", { name: "Edit channel" });
    expect(within(dialog).getByLabelText("Signing secret")).not.toHaveAttribute("placeholder");
    expect(
      within(dialog).queryByRole("checkbox", { name: "Remove the saved secret" }),
    ).not.toBeInTheDocument();
  });

  it("names a field the server rejected by its own rule, not as required", async () => {
    mockServer.use(
      http.post(apiUrl("/alerts"), () =>
        HttpResponse.json(
          {
            error: "chatId must be a chat id",
            code: "alert_channel_invalid",
            field: "chatId",
            index: 0,
          },
          { status: 400 },
        ),
      ),
    );
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Add channel" });
    await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Telegram" }));
    await user.type(within(dialog).getByLabelText("Bot token"), "123456:ABC-DEF");
    await user.type(within(dialog).getByLabelText("Chat ID"), "@ops");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText("Enter a chat ID or @channelname, with no spaces."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Required.")).not.toBeInTheDocument();
  });

  it("sends a test and shows the result on the row", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Add channel" });
    await user.type(within(dialog).getByLabelText("Name"), "Receiver");
    await user.type(within(dialog).getByLabelText("Webhook URL"), "https://hooks.example.com/x");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add channel" })).not.toBeInTheDocument(),
    );

    recorded = [];
    await user.click(screen.getByRole("button", { name: "Send test to Receiver" }));
    expect(await screen.findByText("Test alert sent to Receiver.")).toBeInTheDocument();
    const writesSent = await writes();
    expect(writesSent).toHaveLength(1);
    expect(writesSent[0]?.path).toBe("/alerts/test");
    expect(writesSent[0]?.body).toEqual({ channelId: expect.stringMatching(/^ch_/) });
    expect(await screen.findByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Test")).toBeInTheDocument();
  });

  it("blocks Save on thresholds out of order and saves the rules once fixed", async () => {
    const { user } = await renderCard();
    const thresholds = screen.getByLabelText("Account thresholds (%)");
    await user.clear(thresholds);
    await user.type(thresholds, "90, 80");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Enter 1 to 10 whole percentages from 1 to 100 in ascending order."),
    ).toBeInTheDocument();
    expect(await writes()).toEqual([]);

    await user.clear(thresholds);
    await user.type(thresholds, "50 75 100");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Your settings were saved.");
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/alerts",
        body: {
          accountUsage: true,
          poolUsage: true,
          accountBanned: true,
          allUnavailable: true,
          accountThresholds: [50, 75, 100],
          poolThresholds: [80, 90, 100],
          poolCooldownMinutes: 60,
        },
      },
    ]);
    await waitFor(() => expect(thresholds).toHaveValue("50, 75, 100"));
  });
});
