import { useCallback, useMemo, useState } from "react";

import {
  getActiveFields,
  getDefaultState,
  resetDependentFields,
  resolveSteps,
} from "./connect.resolver";
import { connectSchema } from "./connect.schema";
import type {
  ConnectMode,
  ConnectSchema,
  ConnectState,
  FieldOption,
  ResolvedField,
  ResolvedStep,
} from "./Connect.types";

export interface UseConnectStateReturn {
  state: ConnectState;
  updateField: (fieldId: string, value: string | boolean | string[]) => void;
  setMode: (mode: ConnectMode) => void;
  activeFields: ResolvedField[];
  resolvedSteps: ResolvedStep[];
  getFieldOptions: (fieldId: string) => FieldOption[];
  schema: ConnectSchema;
}

export function useConnectState(
  initialState?: Partial<ConnectState>,
): UseConnectStateReturn {
  const [state, setState] = useState<ConnectState>(
    () =>
      ({
        ...getDefaultState({ schema: connectSchema }),
        ...initialState,
        mode: "mcp",
      }) as ConnectState,
  );

  const updateField = useCallback(
    (fieldId: string, value: string | boolean | string[]) => {
      if (!(fieldId in connectSchema.fields)) return;
      setState((previous) =>
        resetDependentFields(
          { ...previous, [fieldId]: value },
          fieldId,
          connectSchema,
        ),
      );
    },
    [],
  );

  const setMode = useCallback((_mode: ConnectMode) => {
    setState((previous) => ({ ...previous, mode: "mcp" }));
  }, []);

  const activeFields = useMemo(
    () => getActiveFields(connectSchema, state),
    [state],
  );
  const resolvedSteps = useMemo(
    () => resolveSteps(connectSchema, state),
    [state],
  );
  const getFieldOptions = useCallback(
    (_fieldId: string): FieldOption[] => [],
    [],
  );

  return {
    state,
    updateField,
    setMode,
    activeFields,
    resolvedSteps,
    getFieldOptions,
    schema: connectSchema,
  };
}
