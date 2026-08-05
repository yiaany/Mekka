import { useIsLoggedIn } from 'common'

import { useStorageGotoCommands } from '../interfaces/Storage/Storage.Commands'
import { useAdvisorsGoToCommands } from './AdvisorsLayout/Advisors.Commands'
import { useAuthGotoCommands } from './AuthLayout/Auth.Commands'
import { useBillingGotoCommands } from './BillingLayout/Billing.Commands'
import { useDatabaseGotoCommands } from './DatabaseLayout/Database.Commands'
import { useFunctionsGotoCommands } from './EdgeFunctionsLayout/EdgeFunctions.Commands'
import { useIntegrationsGotoCommands } from './IntegrationsLayout/Integrations.Commands'
import { useLogsGotoCommands } from './LogsLayout/Logs.Commands'
import { useProjectSettingsGotoCommands } from './ProjectSettingsLayout/ProjectSettings.Commands'
import { useReportsGotoCommands } from './ReportsLayout/Reports.Commands'
import { useSqlEditorGotoCommands } from './SQLEditorLayout/SqlEditor.Commands'
import { useTableEditorGotoCommands } from './TableEditorLayout/TableEditor.Commands'
import { useApiDocsGotoCommands } from '@/components/interfaces/ProjectAPIDocs/ProjectAPIDocs.Commands'
import { STUDIO_FEATURES } from '@/lib/fork-config'

export function useLayoutNavCommands() {
  const isLoggedIn = useIsLoggedIn()

  useTableEditorGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.tableEditor })
  useSqlEditorGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.sqlEditor })
  useDatabaseGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.database })
  useAuthGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.auth })
  useAdvisorsGoToCommands({ enabled: isLoggedIn && STUDIO_FEATURES.advisors })
  useStorageGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.storage })
  useFunctionsGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.edgeFunctions })
  useLogsGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.logs })
  useReportsGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.observability })
  useApiDocsGotoCommands({ enabled: false })
  useProjectSettingsGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.settings })
  useIntegrationsGotoCommands({ enabled: isLoggedIn && STUDIO_FEATURES.integrations })
  useBillingGotoCommands({ enabled: false })
}
