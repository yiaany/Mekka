import { TelemetryEvent, TelemetryGroups } from 'common/telemetry-constants'
import { useCallback } from 'react'

type EventMap = {
  [E in TelemetryEvent as E['action']]: E
}

type PropertiesForAction<A extends keyof EventMap> = EventMap[A] extends { properties: infer P }
  ? P
  : never

type HasProperties<A extends keyof EventMap> = EventMap[A] extends { properties: any }
  ? true
  : false

/**
 * Hook for type-safe telemetry event tracking with automatic project/org context injection.
 *
 * @example
 * const track = useTrack()
 * track('table_created', { method: 'sql_editor', schema_name: 'public' })
 * track('help_button_clicked')
 */
export const useTrack = () => {
  const track = useCallback(
    <A extends keyof EventMap>(
      _action: A,
      ...args: HasProperties<A> extends true
        ? [properties: PropertiesForAction<A>, groupOverrides?: Partial<TelemetryGroups>]
        : [properties?: undefined, groupOverrides?: Partial<TelemetryGroups>]
    ) => {
      void args
    },
    []
  )

  return track
}
