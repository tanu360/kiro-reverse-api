import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { DataTable, type DataTableColumn, type DataTableSort } from "./data-table";
import { DataTableCard } from "./data-table-card";

interface Row {
  id: string;
  name: string;
  count: number;
}

const ROWS: Row[] = [
  { id: "a", name: "Alpha", count: 3 },
  { id: "b", name: "Bravo", count: 1 },
  { id: "c", name: "Charlie", count: 2 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name, sortable: true },
  { id: "count", header: "Count", cell: (row) => row.count, sortable: true, align: "end" },
  {
    id: "actions",
    header: "Actions",
    cell: (row) => (
      <button onClick={() => {}} type="button">
        Open {row.name}
      </button>
    ),
  },
];

function SelectableTable({
  data,
  initial,
  onChange,
}: {
  data: Row[];
  initial: string[];
  onChange: (next: Set<string>) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial));
  return (
    <DataTable
      columns={COLUMNS}
      data={data}
      getRowId={(row) => row.id}
      selection={{
        selected,
        onChange: (next) => {
          onChange(next);
          setSelected(next);
        },
        rowLabel: (row) => row.name,
      }}
    />
  );
}

function SortedTable({ onSortChange }: { onSortChange: (sort: DataTableSort) => void }) {
  const [sort, setSort] = useState<DataTableSort | null>(null);
  return (
    <DataTable
      columns={COLUMNS}
      data={ROWS}
      getRowId={(row) => row.id}
      onSortChange={(next) => {
        onSortChange(next);
        setSort(next);
      }}
      sort={sort}
    />
  );
}

/** The select-all checkbox is the first one; its label depends on the loaded catalog. */
function headerCheckbox(): HTMLElement {
  const [first] = screen.getAllByRole("checkbox");
  if (!first) throw new Error("no checkbox rendered");
  return first;
}

describe("DataTable", () => {
  it("renders headers and rows", () => {
    renderWithProviders(<DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Count" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("cell", { name: "Charlie" })).toBeInTheDocument();
  });

  it("sorts by header click and flips on the same column", async () => {
    const onSortChange = vi.fn();
    const { user } = renderWithProviders(<SortedTable onSortChange={onSortChange} />);
    const header = screen.getByRole("columnheader", { name: "Name" });
    expect(header).toHaveAttribute("aria-sort", "none");

    await user.click(within(header).getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ id: "name", desc: false });
    expect(header).toHaveAttribute("aria-sort", "ascending");

    await user.click(within(header).getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ id: "name", desc: true });
    expect(header).toHaveAttribute("aria-sort", "descending");
  });

  it("uses defaultSortDesc for a newly sorted column", async () => {
    const onSortChange = vi.fn();
    const { user } = renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        defaultSortDesc={(id) => id === "count"}
        getRowId={(row) => row.id}
        onSortChange={onSortChange}
        sort={{ id: "name", desc: false }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Count" }));
    expect(onSortChange).toHaveBeenCalledWith({ id: "count", desc: true });
  });

  it("select-all adds only the visible rows", async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <SelectableTable data={ROWS.slice(0, 2)} initial={["z"]} onChange={onChange} />,
    );
    await user.click(headerCheckbox());
    expect(onChange).toHaveBeenLastCalledWith(new Set(["z", "a", "b"]));
  });

  it("select-all from the all-selected state clears the whole selection", async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <SelectableTable
        data={ROWS.slice(0, 2)}
        initial={["a", "b", "hidden"]}
        onChange={onChange}
      />,
    );
    const all = headerCheckbox();
    expect(all).toHaveAttribute("aria-checked", "true");
    await user.click(all);
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it("shows the indeterminate header state for a partial selection", () => {
    renderWithProviders(<SelectableTable data={ROWS} initial={["b"]} onChange={() => {}} />);
    expect(headerCheckbox()).toHaveAttribute("aria-checked", "mixed");
  });

  it("switches to cards below a container width, by CSS alone", () => {
    const { container } = renderWithProviders(
      <DataTable
        cardsBelow="4xl"
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        renderCard={(row) => <div>Card {row.name}</div>}
      />,
    );
    // Both views render; the data-table container query shows one of them.
    const root = container.querySelector('[data-slot="data-table"]');
    expect(root).toHaveClass("@container/data-table");
    const cards = container.querySelector('[data-slot="data-table-cards"]');
    expect(cards).toHaveClass("@4xl/data-table:hidden");
    expect(within(cards as HTMLElement).getByText("Card Bravo")).toBeInTheDocument();
    const view = container.querySelector('[data-slot="data-table-view"]');
    expect(view).toHaveClass("hidden", "@4xl/data-table:block");
    expect(within(view as HTMLElement).getByRole("table")).toBeInTheDocument();
  });

  it("keeps renderMobileCard working as cards below the lg container width", () => {
    const { container } = renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        renderMobileCard={(row) => <div>Card {row.name}</div>}
      />,
    );
    expect(container.querySelector('[data-slot="data-table-cards"]')).toHaveClass(
      "@lg/data-table:hidden",
    );
    expect(screen.getByText("Card Alpha")).toBeInTheDocument();
  });

  it("lays cards out in the shared grid and passes the selection to each card", async () => {
    const onChange = vi.fn();
    const { container, user } = renderWithProviders(
      <DataTable
        cardLayout="grid"
        cardsBelow="2xl"
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        renderCard={(row, ctx) => (
          <button onClick={ctx.toggleSelected} type="button">
            {row.name} {ctx.selected ? "on" : "off"}
          </button>
        )}
        selection={{ selected: new Set(["b"]), onChange, rowLabel: (row) => row.name }}
      />,
    );
    const list = container.querySelector('[data-slot="data-table-cards"] ul');
    expect(list).toHaveClass("grid", "@2xl:grid-cols-2");
    expect(screen.getByRole("button", { name: "Bravo on" }).closest("li")).toHaveAttribute(
      "data-state",
      "selected",
    );
    await user.click(screen.getByRole("button", { name: "Alpha off" }));
    expect(onChange).toHaveBeenLastCalledWith(new Set(["b", "a"]));
  });

  it("opens a focused row with Enter and Space, but not from an inner button", async () => {
    const onRowClick = vi.fn();
    const { user } = renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );
    const row = screen.getByRole("row", { name: /Alpha/ });
    expect(row).toHaveAttribute("tabindex", "0");

    row.focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[0]);
    await user.keyboard(" ");
    expect(onRowClick).toHaveBeenCalledTimes(2);

    screen.getByRole("button", { name: "Open Alpha" }).focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("cell", { name: "Bravo" }));
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1]);
  });

  it("shows only the empty state, with no header, when nothing is filtered", () => {
    renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={[]}
        emptyState={<p>No requests yet</p>}
        getRowId={(row) => row.id}
      />,
    );
    expect(screen.getByText("No requests yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
  });

  it("keeps the header over a filtered empty table, with the empty state outside the scroller", () => {
    renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={[]}
        emptyState={<p>No matches</p>}
        filtered
        getRowId={(row) => row.id}
      />,
    );
    const empty = screen.getByText("No matches");
    // Inside the table it would be centred across the full scroll width, off-screen on phones.
    expect(empty.closest("table")).toBeNull();
    expect(empty.closest('[data-slot="table-container"]')).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
  });

  it("makes the whole header height the sort button's target", () => {
    renderWithProviders(<SortedTable onSortChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Name" }).className).toContain("h-10");
  });

  it("pins a sticky end column to the right edge and a sticky column to the left", () => {
    renderWithProviders(
      <DataTable
        columns={[
          { ...COLUMNS[0], sticky: true } as DataTableColumn<Row>,
          COLUMNS[1] as DataTableColumn<Row>,
          { ...COLUMNS[2], sticky: "end" } as DataTableColumn<Row>,
        ]}
        data={ROWS}
        getRowId={(row) => row.id}
      />,
    );
    const actionsHeader = screen.getByRole("columnheader", { name: "Actions" });
    expect(actionsHeader.className).toContain("right-0");
    expect(actionsHeader.className).toContain("sticky");
    const actionsCell = screen.getByRole("button", { name: "Open Alpha" }).closest("td");
    expect(actionsCell?.className).toContain("right-0");
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("left-0");
  });

  it("gives loading rows one cell per column, with each column's classes", () => {
    const columns = [COLUMNS[0], { ...COLUMNS[1], className: "hidden wide:table-cell" }];
    const { container } = renderWithProviders(
      <DataTable
        columns={columns}
        data={[]}
        getRowId={(row) => row.id}
        loading
        selection={{ selected: new Set(), onChange: () => {}, rowLabel: (row) => row.name }}
      />,
    );
    const row = container.querySelector('tbody tr[aria-hidden="true"]') as HTMLElement;
    const cells = row.querySelectorAll("td");
    // The selection cell, then one per column; a column hidden by a breakpoint stays hidden.
    expect(cells).toHaveLength(3);
    expect(cells[0]).toHaveClass("w-px");
    expect(cells[2]).toHaveClass("hidden", "wide:table-cell");
    expect(cells[1]).not.toHaveClass("hidden");
  });

  it("draws two-line skeletons, as many as a page holds up to ten", () => {
    const { container } = renderWithProviders(
      <DataTable columns={COLUMNS} data={[]} getRowId={(row) => row.id} loading pageSize={25} />,
    );
    const placeholders = container.querySelectorAll('tbody tr[aria-hidden="true"]');
    expect(placeholders).toHaveLength(10);
    expect(
      placeholders[0]?.querySelector("td")?.querySelectorAll('[data-slot="skeleton"]'),
    ).toHaveLength(2);
  });

  it("names a clickable row and says it opens a dialog", () => {
    renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        onRowClick={() => {}}
        rowLabel={(row) => `Open details for ${row.name}`}
      />,
    );
    const row = screen.getByRole("row", { name: "Open details for Alpha" });
    expect(row).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("insets the edge cells inside a DataTableCard and with the inset prop", () => {
    const { container } = renderWithProviders(
      <DataTableCard footer={<p>Pager</p>} toolbar={<p>Toolbar</p>}>
        <DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />
      </DataTableCard>,
    );
    expect(container.querySelector("table")?.className).toContain("[&_tr>*:first-child]:ps-4");
    expect(container.querySelector('[data-slot="data-table-card-toolbar"]')).toHaveTextContent(
      "Toolbar",
    );
    expect(container.querySelector('[data-slot="data-table-card-footer"]')).toHaveTextContent(
      "Pager",
    );
  });

  it("pads comfortable rows and leaves compact rows at the default", () => {
    const comfortable = renderWithProviders(
      <DataTable columns={COLUMNS} data={ROWS} density="comfortable" getRowId={(row) => row.id} />,
    );
    expect(comfortable.container.querySelector("table")?.className).toContain("[&_tbody_td]:py-3");
    comfortable.unmount();
    const compact = renderWithProviders(
      <DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />,
    );
    expect(compact.container.querySelector("table")?.className).not.toContain("py-3");
  });

  it("gives a sticky start column an edge once columns scroll under it", () => {
    renderWithProviders(
      <DataTable
        columns={[{ ...COLUMNS[0], sticky: "start" } as DataTableColumn<Row>, COLUMNS[1]]}
        data={ROWS}
        getRowId={(row) => row.id}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain(
      "in-data-overflow-start:shadow-[inset_-1px_0_0_var(--border-subtle)]",
    );
  });

  it("leaves rows unfocusable without onRowClick", () => {
    renderWithProviders(<DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />);
    expect(screen.getByRole("row", { name: /Alpha/ })).not.toHaveAttribute("tabindex");
  });

  it("reports the hovered row and marks rows with their id and index", async () => {
    const onRowHover = vi.fn();
    const { user } = renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        onRowHover={onRowHover}
      />,
    );
    const bravo = screen.getByRole("row", { name: /Bravo/ });
    expect(bravo).toHaveAttribute("data-row-id", "b");
    expect(bravo).toHaveAttribute("data-row-index", "1");
    await user.hover(bravo);
    expect(onRowHover).toHaveBeenLastCalledWith(ROWS[1]);
    await user.unhover(bravo);
    expect(onRowHover).toHaveBeenLastCalledWith(null);
  });

  it("puts a select-all row over the cards, which have no header row", async () => {
    const onChange = vi.fn();
    const { container, user } = renderWithProviders(
      <DataTable
        cardLayout="divided"
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        renderCard={(row) => <div>Card {row.name}</div>}
        selection={{ selected: new Set(["b"]), onChange, rowLabel: (row) => row.name }}
      />,
    );
    const cards = container.querySelector('[data-slot="data-table-cards"]') as HTMLElement;
    const all = within(cards).getByRole("checkbox", { name: "Select all" });
    expect(all).toHaveAttribute("aria-checked", "mixed");
    // The row's label text toggles it too, not only the 16 px box.
    await user.click(within(cards).getByText("Select all"));
    expect(onChange).toHaveBeenLastCalledWith(new Set(["b", "a", "c"]));
  });

  it("shows a page of ListCard-shaped placeholder rows while divided cards load", () => {
    const { container, unmount } = renderWithProviders(
      <DataTable
        cardLayout="divided"
        columns={COLUMNS}
        data={[]}
        getRowId={(row) => row.id}
        loading
        pageSize={25}
        renderCard={(row) => <div>Card {row.name}</div>}
      />,
    );
    const cards = container.querySelector('[data-slot="data-table-cards"]') as HTMLElement;
    expect(cards.querySelectorAll('[data-slot="list-card-skeleton"]')).toHaveLength(10);
    unmount();
    renderWithProviders(
      <DataTable
        cardLayout="divided"
        columns={COLUMNS}
        data={[]}
        getRowId={(row) => row.id}
        loading
        pageSize={4}
        renderCard={(row) => <div>Card {row.name}</div>}
        renderCardSkeleton={() => <div data-testid="own-skeleton" />}
      />,
    );
    expect(screen.getAllByTestId("own-skeleton")).toHaveLength(4);
  });
});
