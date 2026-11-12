import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { CountTokensCard } from "./count-tokens-card";
import { SECTION_ID } from "./sections";

let posts: Array<Promise<unknown>> = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/count-tokens")) {
    posts.push(request.clone().json());
  }
}

beforeEach(() => {
  posts = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

function card(): HTMLElement {
  const element = document.getElementById(SECTION_ID.countTokens);
  if (!element) throw new Error("count tokens card not rendered");
  return element;
}

describe("CountTokensCard", () => {
  it("shows the local estimate when no API is set", async () => {
    renderWithProviders(<CountTokensCard />);
    expect(await screen.findByText("Estimated by this proxy")).toBeInTheDocument();
    expect(within(card()).getByText("Local estimate")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Set up counting API" })).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Remove counting API" })).toBeNull();
  });

  it("sets up an API with a Bearer key and shows it masked", async () => {
    const { user } = renderWithProviders(<CountTokensCard />);
    await user.click(await screen.findByRole("button", { name: "Set up counting API" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up counting API" });

    // Long values are pasted: typing them key by key takes seconds on a loaded runner.
    await user.click(within(dialog).getByLabelText("API URL"));
    await user.paste("https://count.example/v1/messages/count_tokens");
    await user.click(within(dialog).getByRole("combobox", { name: "Send the key as" }));
    await user.click(await screen.findByRole("option", { name: "Authorization: Bearer" }));
    await user.click(within(dialog).getByLabelText("API key"));
    await user.paste("sk-ant-api03-secret-WXYZ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await screen.findByText("Your settings were saved.");
    expect(await Promise.all(posts)).toEqual([
      {
        countTokensApiUrl: "https://count.example/v1/messages/count_tokens",
        countTokensAuthType: "bearer",
        countTokensApiKey: "sk-ant-api03-secret-WXYZ",
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Set up counting API" })).toBeNull(),
    );
    expect(
      within(card()).getByText("https://count.example/v1/messages/count_tokens"),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText("Sends the key as Authorization: Bearer (••••WXYZ)"),
    ).toBeInTheDocument();
    expect(within(card()).getByText("External API")).toBeInTheDocument();
    expect(mockDb.countTokens.key).toBe("sk-ant-api03-secret-WXYZ");
  });

  it("checks the URL before it saves", async () => {
    const { user } = renderWithProviders(<CountTokensCard />);
    await user.click(await screen.findByRole("button", { name: "Set up counting API" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up counting API" });

    await user.click(within(dialog).getByLabelText("API URL"));
    await user.paste("https://user:pw@count.example");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      within(dialog).getByText(
        "Enter an http:// or https:// URL with a host, without a user name or password.",
      ),
    ).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("never shows the saved key: blank keeps it, the checkbox removes it", async () => {
    mockDb.countTokens = {
      url: "http://127.0.0.1:8787/count",
      authType: "x-api-key",
      key: "sk-saved-key-0123-abcd",
    };
    const { user } = renderWithProviders(<CountTokensCard />);
    expect(await screen.findByText("Sends the key as x-api-key (••••abcd)")).toBeInTheDocument();

    await user.click(within(card()).getByRole("button", { name: "Edit" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit counting API" });
    expect(within(dialog).getByLabelText("API key")).toHaveValue("");
    expect(
      within(dialog).getByText("Leave blank to keep the saved key (••••abcd)"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await screen.findByText("Your settings were saved.");
    expect(mockDb.countTokens.key).toBe("sk-saved-key-0123-abcd");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit counting API" })).toBeNull(),
    );
    await user.click(within(card()).getByRole("button", { name: "Edit" }));
    dialog = await screen.findByRole("dialog", { name: "Edit counting API" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Remove the saved key" }));
    expect(within(dialog).getByLabelText("API key")).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(card()).findByText("No key sent")).toBeInTheDocument();
    expect(await Promise.all(posts)).toEqual([
      { countTokensApiUrl: "http://127.0.0.1:8787/count", countTokensAuthType: "x-api-key" },
      {
        countTokensApiUrl: "http://127.0.0.1:8787/count",
        countTokensAuthType: "x-api-key",
        clearApiKey: true,
      },
    ]);
    expect(mockDb.countTokens.key).toBe("");
  });

  it("drops the saved key when the URL moves to another host", async () => {
    mockDb.countTokens = {
      url: "https://count.example/v1/messages/count_tokens",
      authType: "x-api-key",
      key: "sk-saved-key-0123-abcd",
    };
    const { user } = renderWithProviders(<CountTokensCard />);
    expect(await screen.findByText("Sends the key as x-api-key (••••abcd)")).toBeInTheDocument();
    await user.click(within(card()).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit counting API" });
    const urlInput = within(dialog).getByLabelText("API URL");

    // A new path on the same host keeps the key.
    await user.clear(urlInput);
    await user.paste("https://count.example/v2/count");
    expect(
      within(dialog).getByText("Leave blank to keep the saved key (••••abcd)"),
    ).toBeInTheDocument();

    // Another host: the form says the key goes and stops offering the checkbox.
    await user.clear(urlInput);
    await user.paste("http://counter.example:8787/count");
    expect(
      within(dialog).getByText(
        "The host changed, so the saved key will be removed. Enter the key again to send it.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: "Remove the saved key" })).toBeNull();
    expect(within(dialog).getByLabelText("API key")).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(card()).findByText("No key sent")).toBeInTheDocument();
    expect(await Promise.all(posts)).toEqual([
      { countTokensApiUrl: "http://counter.example:8787/count", countTokensAuthType: "x-api-key" },
    ]);
    expect(mockDb.countTokens).toEqual({
      url: "http://counter.example:8787/count",
      authType: "x-api-key",
      key: "",
    });
  });

  it("removes the API after confirmation", async () => {
    mockDb.countTokens = { url: "http://127.0.0.1:8787/count", authType: "bearer", key: "" };
    const { user } = renderWithProviders(<CountTokensCard />);
    await user.click(await screen.findByRole("button", { name: "Remove counting API" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove counting API" }));

    expect(await within(card()).findByText("Estimated by this proxy")).toBeInTheDocument();
    expect(await Promise.all(posts)).toEqual([{ countTokensApiUrl: "" }]);
    expect(mockDb.countTokens).toEqual({ url: "", authType: "x-api-key", key: "" });
  });
});
