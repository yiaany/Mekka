import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { useConnectState } from "../useConnectState";

describe("useConnectState", () => {
  test("initializes with the only supported Mekka MCP mode", () => {
    const { result } = renderHook(() => useConnectState());

    expect(result.current.state.mode).toBe("mcp");
    expect(result.current.schema.modes).toEqual([
      {
        id: "mcp",
        label: "Mekka MCP",
        description: "Tenant-bound agent access",
        fields: [],
      },
    ]);
  });

  test("does not restore unsupported legacy modes from persisted state", () => {
    const { result } = renderHook(() => useConnectState({ mode: "direct" }));

    expect(result.current.state.mode).toBe("mcp");
  });

  test("keeps mode restricted to MCP", () => {
    const { result } = renderHook(() => useConnectState());

    act(() => result.current.setMode("framework"));

    expect(result.current.state.mode).toBe("mcp");
  });

  test("exposes no PostgreSQL connection fields or options", () => {
    const { result } = renderHook(() => useConnectState());

    expect(result.current.activeFields).toEqual([]);
    expect(result.current.getFieldOptions("connectionMethod")).toEqual([]);
    expect(result.current.getFieldOptions("orm")).toEqual([]);
  });

  test("ignores updates for removed legacy fields", () => {
    const { result } = renderHook(() => useConnectState());

    act(() => result.current.updateField("connectionMethod", "direct"));

    expect(result.current.state).not.toHaveProperty("connectionMethod");
  });

  test("resolves the Mekka MCP setup step", () => {
    const { result } = renderHook(() => useConnectState());

    expect(result.current.resolvedSteps).toEqual([
      expect.objectContaining({ id: "mcp-status", content: "mekka/mcp" }),
    ]);
  });
});
