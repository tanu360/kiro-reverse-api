import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertsConfig } from "@/lib/api/alerts";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AlertsCard } from "./alerts-card";

// The dialog tests type whole forms, so a busy run needs more than the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

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
  dailySummary: false,
  dailySummaryMinute: 540,
  dailySummaryLastSent: 0,
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

/** A line read out by the app's live region (announce()), not a visible notice. */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
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

  it("shows when the daily summary was last sent as a live time", async () => {
    const sent = Math.floor(Date.now() / 1000) - 3600;
    mockServer.use(
      http.get(apiUrl("/alerts"), () =>
        HttpResponse.json({ ...SAVED, dailySummary: true, dailySummaryLastSent: sent }),
      ),
    );
    const { container } = await renderCard();
    const selector = `time[datetime="${new Date(sent * 1000).toISOString()}"]`;
    await waitFor(() =>
      expect(container.querySelector(selector)?.parentElement).toHaveTextContent(/Last sent/),
    );
  });

  it("keeps each channel's test spinner while tests overlap", async () => {
    const second = { ...SAVED.channels[0], id: "ch_two", name: "Second hook" };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      http.get(apiUrl("/alerts"), () =>
        HttpResponse.json({ ...SAVED, channels: [...SAVED.channels, second] }),
      ),
      http.post(apiUrl("/alerts/test"), async () => {
        await held;
        return HttpResponse.json({ ts: 1, ok: true, status: 200, attempts: 1, event: "test" });
      }),
    );
    const { user } = await renderCard();
    const first = await screen.findByRole("button", { name: "Send test to Ops hook" });
    await user.click(first);
    await user.click(screen.getByRole("button", { name: "Send test to Second hook" }));
    expect(screen.getByRole("button", { name: "Send test to Second hook" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(first).toHaveAttribute("aria-busy", "true");
    release();
    await waitFor(() => expect(first).not.toHaveAttribute("aria-busy", "true"));
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

    await expectAnnounced("Channel saved.");
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
    expect(secret).toHaveAttribute("placeholder", "Saved. Leave empty to keep it.");
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
    await expectAnnounced("Test alert sent to Receiver.");
    const writesSent = await writes();
    expect(writesSent).toHaveLength(1);
    expect(writesSent[0]?.path).toBe("/alerts/test");
    expect(writesSent[0]?.body).toEqual({ channelId: expect.stringMatching(/^ch_/) });
    expect(await screen.findByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Test")).toBeInTheDocument();
  });

  it("keeps letters out of a thresholds field", async () => {
    const { user } = await renderCard();
    const thresholds = screen.getByLabelText("Account thresholds (%)");
    await user.clear(thresholds);
    await user.type(thresholds, "5a0, 7x5%; 10o0");
    expect(thresholds).toHaveValue("50, 75%; 100");
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
    await expectAnnounced("Your settings were saved.");
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
          dailySummary: false,
          dailySummaryMinute: 540,
        },
      },
    ]);
    await waitFor(() => expect(thresholds).toHaveValue("50, 75, 100"));
  });
});

describe("AlertsCard daily summary", () => {
  it("switches the summary on at a local hour stored in UTC and saves both", async () => {
    const { user } = await renderCard();
    const toggle = screen.getByRole("switch", { name: "Daily usage summary" });
    expect(toggle).not.toBeChecked();
    // The default 09:00 UTC, labelled with the viewer's own time and the UTC time.
    const time = screen.getByRole("combobox", { name: "Send at" });
    expect(time).toHaveTextContent("(09:00 UTC)");
    // The local time in the language's own clock: "9:00 AM" in English, not "09:00 AM".
    const nine = new Date();
    nine.setUTCHours(9, 0, 0, 0);
    const local = new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(nine);
    expect(local).not.toMatch(/^0/);
    expect(time).toHaveTextContent(`${local} (09:00 UTC)`);
    expect(screen.getByText(/The server keeps 09:00 UTC/)).toBeInTheDocument();

    await user.click(toggle);
    await user.click(time);
    const options = await screen.findAllByRole("option");
    // One option per local hour.
    expect(options).toHaveLength(24);
    const target = options.find((option) => option.textContent?.includes("(06:00 UTC)"));
    if (!target) throw new Error("no 06:00 UTC option");
    await user.click(target);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () =>
      expect((await writes()).at(-1)?.body).toMatchObject({
        dailySummary: true,
        dailySummaryMinute: 360,
      }),
    );
  });

  it("sends a test summary to the channels that are on and reports the result", async () => {
    mockServer.use(http.get(apiUrl("/alerts"), () => HttpResponse.json(SAVED)));
    mockServer.use(
      http.post(apiUrl("/alerts/daily-summary/test"), () =>
        HttpResponse.json({
          results: [
            {
              channelId: "ch_ops",
              ts: Math.floor(Date.now() / 1000),
              ok: true,
              status: 200,
              attempts: 1,
              event: "daily_summary",
            },
          ],
          title: "Daily usage summary",
          text: "Last 24 hours",
        }),
      ),
    );
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Send test" }));
    // Said under the button until the next test, and read out.
    await waitFor(() => expect(screen.getAllByText("Summary sent to 1 channel.")).toHaveLength(2));
    const lines = screen.getAllByText("Summary sent to 1 channel.");
    expect(lines.filter((line) => line.closest('[data-slot="live-announcer"]'))).toHaveLength(1);
    expect(
      lines
        .find((line) => !line.closest('[data-slot="live-announcer"]'))
        ?.closest('[data-slot="settings-row"]'),
    ).toHaveTextContent("Test the summary");
    const row = screen.getByText("Ops hook").closest("li") as HTMLElement;
    expect(await within(row).findByText("Daily summary")).toBeInTheDocument();
  });

  it("shows a failed channel save in the dialog, and Try again saves it", async () => {
    let fail = true;
    mockServer.use(
      http.get(apiUrl("/alerts"), () => HttpResponse.json(SAVED)),
      http.post(apiUrl("/alerts"), () =>
        fail
          ? HttpResponse.json({ error: "store busy" }, { status: 500 })
          : HttpResponse.json(SAVED),
      ),
    );
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit channel" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const notice = await within(dialog).findByRole("alert");
    expect(notice).toHaveTextContent(/^store busy$/);
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));

    await expectAnnounced("Channel saved.");
    expect(within(dialog).getByRole("button", { name: "Saved" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps a save on its way busy when the dialog is closed and opened again", async () => {
    let land: () => void = () => {};
    mockServer.use(
      http.get(apiUrl("/alerts"), () => HttpResponse.json(SAVED)),
      http.post(apiUrl("/alerts"), async () => {
        await new Promise<void>((resolve) => {
          land = resolve;
        });
        return HttpResponse.json(SAVED);
      }),
    );
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit channel" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("button", { name: /Saving/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Not a fresh, idle form that the first save then flips to Saved and closes.
    await user.click(screen.getByRole("button", { name: "Edit Ops hook" }));
    dialog = await screen.findByRole("dialog", { name: "Edit channel" });
    expect(within(dialog).getByRole("button", { name: /Saving/ })).toBeInTheDocument();
    land();
    await expectAnnounced("Channel saved.");
  });

  it("removes a channel after confirmation, with focus on Add channel", async () => {
    mockServer.use(
      http.get(apiUrl("/alerts"), () => HttpResponse.json(SAVED)),
      http.post(apiUrl("/alerts"), () => HttpResponse.json({ ...SAVED, channels: [] })),
    );
    const { user } = await renderCard();
    await user.click(await screen.findByRole("button", { name: "Remove Ops hook" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    await expectAnnounced("Channel removed.");
    expect(screen.queryByText("Ops hook")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add channel" })).toHaveFocus());
  });

  it("shows a failed test under its row, and Try again sends it again", async () => {
    let fail = true;
    mockServer.use(
      http.get(apiUrl("/alerts"), () => HttpResponse.json(SAVED)),
      http.post(apiUrl("/alerts/test"), () =>
        fail
          ? HttpResponse.json({ error: "store busy" }, { status: 500 })
          : HttpResponse.json({
              ts: Math.floor(Date.now() / 1000),
              ok: true,
              status: 200,
              attempts: 1,
              event: "test",
            }),
      ),
    );
    const { user } = await renderCard();
    const row = (await screen.findByText("Ops hook")).closest("li") as HTMLElement;
    const send = within(row).getByRole("button", { name: "Send test to Ops hook" });

    await user.click(send);
    const notice = await within(row).findByRole("alert");
    expect(notice).toHaveTextContent(/^store busy$/);
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));

    await expectAnnounced("Test alert sent to Ops hook.");
    expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
    expect(send).toHaveFocus();
    expect(await within(row).findByText("Delivered")).toBeInTheDocument();
  });

  it("disables the test while no channel is on", async () => {
    await renderCard();
    expect(screen.getByRole("button", { name: "Send test" })).toBeDisabled();
    expect(screen.getByText("Add or switch on a channel first.")).toBeInTheDocument();
  });
});
