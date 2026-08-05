import {
  CommandHeader,
  CommandMenu,
  CommandMenuInput,
  CommandMenuList,
} from 'ui-patterns/CommandMenu'
import { useThemeSwitcherCommands } from 'ui-patterns/CommandMenu/prepackaged/ThemeSwitcher'

import { useContextSearchCommands } from './ContextSearchCommands'
import {
  useQueryTableCommands,
  useSnippetCommands,
} from '@/components/layouts/SQLEditorLayout/SqlEditor.Commands'
import { useProjectLevelTableEditorCommands } from '@/components/layouts/TableEditorLayout/TableEditor.Commands'
import { useLayoutNavCommands } from '@/components/layouts/useLayoutNavCommands'

export function CommandMenuInnerContent() {
  return (
    <>
      <CommandHeader>
        <CommandMenuInput />
      </CommandHeader>
      <CommandMenuList />
    </>
  )
}

export default function StudioCommandMenu() {
  useProjectLevelTableEditorCommands()
  useQueryTableCommands()
  useSnippetCommands()
  useLayoutNavCommands()
  useThemeSwitcherCommands()
  useContextSearchCommands()

  return (
    <CommandMenu>
      <CommandMenuInnerContent />
    </CommandMenu>
  )
}
