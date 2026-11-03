import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { DataTable, type DataTableColumn, type DataTableSort } from "./data-table";

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

function mockMatchMedia(matches: (query: string) => boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  );
}

/** The select-all checkbox is the first one; its label depends on the loaded catalog. */
function headerCheckbox(): HTMLElement {
  const [first] = screen.getAllByRole("checkbox");
  if (!first) throw new Error("no checkbox rendered");
  return first;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("renders mobile cards under md", () => {
    mockMatchMedia((query) => query === "(max-width: 767px)");
    renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        renderMobileCard={(row) => <div>Card {row.name}</div>}
      />,
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Card Bravo")).toBeInTheDocument();
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

  it("renders the empty state outside the horizontally scrolling table", () => {
    renderWithProviders(
      <DataTable
        columns={COLUMNS}
        data={[]}
        emptyState={<p>No requests yet</p>}
        getRowId={(row) => row.id}
      />,
    );
    const empty = screen.getByText("No requests yet");
    // Inside the table it would be centred across the full scroll width, off-screen on phones.
    expect(empty.closest("table")).toBeNull();
    expect(empty.closest('[data-slot="table-container"]')).toBeNull();
    // The header row stays, so the columns are still visible.
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

  it("leaves rows unfocusable without onRowClick", () => {
    renderWithProviders(<DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />);
    expect(screen.getByRole("row", { name: /Alpha/ })).not.toHaveAttribute("tabindex");
  });
});
