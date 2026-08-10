import { StudioDomainError } from "@mekka/studio-domain-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { SqliteRowsGrid } from "./SqliteRowsGrid";
import { SqliteTableEditor } from "./SqliteTableEditor";

const clientState = vi.hoisted(() => ({ current: undefined as any }));

vi.mock("@/data/studio-domain/client", () => ({
  createProjectStudioDomainClient: () => clientState.current,
}));

describe("SQLite structured mutation resilience", () => {
  test("releases row Saving state before a hanging refetch completes", async () => {
    let listCalls = 0;
    clientState.current = {
      listRows: vi.fn(() => {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve({ rows: [], totalCount: 0, limit: 50, offset: 0 });
        }
        return new Promise(() => undefined);
      }),
      createRow: vi.fn(() => Promise.resolve({ changes: 1 })),
    };
    renderWithQueryClient(
      <SqliteRowsGrid projectRef="local" table="notes" primaryKey={["id"]} />,
    );

    await screen.findByText("0 of 0");
    fireEvent.change(screen.getByLabelText("New row JSON"), {
      target: { value: '{"id":1,"body":"first"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Insert row" }));

    await waitFor(() => expect(screen.queryByText("Saving...")).not.toBeInTheDocument());
    expect(clientState.current.createRow).toHaveBeenCalledTimes(1);
    expect(clientState.current.listRows).toHaveBeenCalledTimes(2);
  });

  test("reconciles an ambiguous insert and does not retry it", async () => {
    let listCalls = 0;
    clientState.current = {
      listRows: vi.fn(() => {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve({ rows: [], totalCount: 0, limit: 50, offset: 0 });
        }
        return Promise.resolve({
          rows: [
            { id: 10, body: "first" },
            { id: "1", body: "first" },
          ],
          totalCount: 2,
          limit: 200,
          offset: 0,
        });
      }),
      createRow: vi.fn(() => {
        const error = new StudioDomainError(
            "infrastructure",
            504,
            "018e6c28-0000-7000-8000-000000000001" as never,
            "Timed out",
          );
        Object.assign(error, { outcomeAmbiguous: true });
        return Promise.reject(error);
      }),
    };
    renderWithQueryClient(
      <SqliteRowsGrid projectRef="local" table="notes" primaryKey={["id"]} />,
    );

    await screen.findByText("0 of 0");
    fireEvent.change(screen.getByLabelText("New row JSON"), {
      target: { value: '{"id":1,"body":"first"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Insert row" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("appears applied");
    expect(clientState.current.createRow).toHaveBeenCalledTimes(1);
  });

  test("does not accept a substring-filter row with a different primary key", async () => {
    let listCalls = 0;
    clientState.current = {
      listRows: vi.fn(() => {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve({ rows: [], totalCount: 0, limit: 50, offset: 0 });
        }
        return Promise.resolve({
          rows: [{ id: 10, body: "first" }],
          totalCount: 1,
          limit: 200,
          offset: 0,
        });
      }),
      createRow: vi.fn(() =>
        Promise.reject(
          new StudioDomainError(
            "infrastructure",
            503,
            "018e6c28-0000-7000-8000-000000000001" as never,
            "Unavailable",
            true,
          ),
        ),
      ),
    };
    renderWithQueryClient(
      <SqliteRowsGrid projectRef="local" table="notes" primaryKey={["id"]} />,
    );

    await screen.findByText("0 of 0");
    fireEvent.change(screen.getByLabelText("New row JSON"), {
      target: { value: '{"id":1,"body":"first"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Insert row" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("does not appear applied");
  });

  test("releases table Creating state before schema invalidation finishes", async () => {
    let healthCalls = 0;
    clientState.current = {
      getSchemaHealth: vi.fn(() => {
        healthCalls += 1;
        if (healthCalls === 1) {
          return Promise.resolve({
            status: "ok",
            formatVersion: 1,
            schemaVersion: 1,
            schemaHash: "a".repeat(64),
          });
        }
        return new Promise(() => undefined);
      }),
      createTable: vi.fn(() =>
        Promise.resolve({
          resource: {
            name: "notes",
            columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
            primaryKey: ["id"],
          },
          migrationSql: 'CREATE TABLE "notes" ("id" INTEGER NOT NULL)',
          checkpointId: null,
        }),
      ),
    };
    renderWithQueryClient(<SqliteTableEditor />);

    await screen.findByTestId("sqlite-table-editor");
    fireEvent.change(screen.getByLabelText("Table name"), { target: { value: "notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Creating table..." })).not.toBeInTheDocument(),
    );
    expect(clientState.current.createTable).toHaveBeenCalledTimes(1);
    expect(clientState.current.getSchemaHealth).toHaveBeenCalledTimes(2);
  });
});

function renderWithQueryClient(element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}
