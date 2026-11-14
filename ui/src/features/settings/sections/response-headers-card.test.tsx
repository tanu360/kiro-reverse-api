import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { ResponseHeadersCard } from "./response-headers-card";
import { SECTION_ID } from "./sections";

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
  const all = await Promise.all(recorded);
  return all.filter((r) => r.method !== "GET");
}

beforeEach(() => {
  recorded = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

function card(): HTMLElement {
  const element = document.getElementById(SECTION_ID.responseHeaders);
  if (!element) throw new Error("card not rendered");
  return element;
}

async function renderCard() {
  const result = renderWithProviders(<ResponseHeadersCard />);
  await screen.findByRole("button", { name: "Add header" });
  return result;
}

describe("ResponseHeadersCard", () => {
  it("adds a header in the editor, inserts variables at the caret and saves the list", async () => {
    const { user } = await renderCard();
    expect(within(card()).getByText("X-Request-Id: {request_id}")).toBeInTheDocument();

    await user.click(within(card()).getByRole("button", { name: "Add header" }));
    const dialog = await screen.findByRole("dialog", { name: "Add header" });
    const apply = within(dialog).getByRole("button", { name: "Add header" });
    expect(apply).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Header name"), "X-Trace");
    const value = within(dialog).getByLabelText("Value") as HTMLInputElement;
    await user.type(value, "id=");
    await user.click(within(dialog).getByRole("button", { name: "{request_id}" }));
    expect(value).toHaveValue("id={request_id}");
    expect(value).toHaveFocus();
    expect(value.selectionStart).toBe("id={request_id}".length);

    // A chip replaces the selection, here the "id=" at the start.
    value.setSelectionRange(0, 3);
    await user.click(within(dialog).getByRole("button", { name: "{model}" }));
    expect(value).toHaveValue("{model}{request_id}");
    expect(value.selectionStart).toBe("{model}".length);

    await user.click(apply);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Applying writes the draft only; Save sends it.
    expect(await writes()).toHaveLength(0);

    const [row] = within(card()).getAllByRole("listitem");
    expect(row).toHaveAccessibleName("Header 1");
    expect(row).toHaveTextContent("X-Trace");
    expect(row).toHaveTextContent("{model}{request_id}");

    const toggle = within(row).getByRole("switch", { name: "Send header X-Trace" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    await user.click(within(card()).getByRole("button", { name: "Save" }));
    await screen.findByText("Your settings were saved.");
    expect(await writes()).toEqual([
      {
        method: "POST",
        path: "/response-headers",
        body: { headers: [{ name: "X-Trace", value: "{model}{request_id}", enabled: false }] },
      },
    ]);
    expect(mockDb.responseHeaders).toEqual([
      { name: "X-Trace", value: "{model}{request_id}", enabled: false },
    ]);
  });

  it("explains a refused name or value in the editor and keeps Apply off", async () => {
    mockDb.responseHeaders = [{ name: "X-Request-Id", value: "{request_id}", enabled: true }];
    const { user } = await renderCard();

    await user.click(within(card()).getByRole("button", { name: "Add header" }));
    const dialog = await screen.findByRole("dialog", { name: "Add header" });
    const apply = within(dialog).getByRole("button", { name: "Add header" });
    const name = within(dialog).getByLabelText("Header name");
    const value = within(dialog).getByLabelText("Value");

    await user.type(name, "Content-Type");
    expect(
      within(dialog).getByText("The proxy manages Content-Type, so it cannot be set here."),
    ).toBeInTheDocument();
    await user.clear(name);
    // A space or a colon never reaches the name.
    await user.type(name, "Bad Name:");
    expect(name).toHaveValue("BadName");
    expect(
      within(dialog).queryByText(
        "A header name can only use letters, digits and symbols such as - _ . ~, with no spaces or colons.",
      ),
    ).not.toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "x-request-id");
    expect(within(dialog).getByText("x-request-id is already in the list.")).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "X-Model");
    await user.type(value, "{{reqid}");
    expect(within(dialog).getByText("{reqid} is not a known variable.")).toBeInTheDocument();
    expect(apply).toBeDisabled();

    await user.clear(value);
    await user.type(value, "{{model}");
    expect(apply).toBeEnabled();
  });

  it("flags the row the server refused, in the reader's language", async () => {
    // A list saved by hand in the config file, which the editor would not take.
    mockDb.responseHeaders = [
      { name: "X-Request-Id", value: "{request_id}", enabled: true },
      { name: "Set-Cookie", value: "a=b", enabled: true },
    ];
    const { user } = await renderCard();
    const rows = within(card()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    await user.click(within(rows[0]).getByRole("switch", { name: "Send header X-Request-Id" }));
    await user.click(within(card()).getByRole("button", { name: "Save" }));

    const message = "The proxy manages Set-Cookie, so it cannot be set here.";
    const alert = await within(rows[1]).findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(rows[1]).toHaveAttribute("data-error", "true");
    expect(rows[0]).not.toHaveAttribute("data-error");
    const [write] = await writes();
    expect(write.path).toBe("/response-headers");
    expect(mockDb.responseHeaders[0].enabled).toBe(true);
  });

  it("deletes a header from its menu and stops adding at the limit", async () => {
    mockDb.responseHeaders = Array.from({ length: 20 }, (_, i) => ({
      name: `X-H${i}`,
      value: "{request_id}",
      enabled: true,
    }));
    const { user } = await renderCard();
    const add = within(card()).getByRole("button", { name: "Add header" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(within(card()).getByText("You can add up to 20 headers.")).toBeInTheDocument();
    await user.click(add);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(within(card()).getByRole("button", { name: "Header actions: X-H0" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete header" }));
    expect(within(card()).getAllByRole("listitem")).toHaveLength(19);
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(within(card()).getByRole("button", { name: "Header actions: X-H1" })).toHaveFocus();
  });
});
