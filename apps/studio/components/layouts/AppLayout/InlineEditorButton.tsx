import { SqlEditor } from 'icons'
import { useParams } from 'common'
import { useRouter } from 'next/router'
import { cn, KeyboardShortcut } from 'ui'

import { SIDEBAR_KEYS } from '@/components/layouts/ProjectLayout/LayoutSidebar/LayoutSidebarProvider'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { IS_PLATFORM } from '@/lib/constants'
import { useTrack } from '@/lib/telemetry/track'
import { SHORTCUT_IDS } from '@/state/shortcuts/registry'
import { useIsShortcutEnabled } from '@/state/shortcuts/useIsShortcutEnabled'
import { useSidebarManagerSnapshot } from '@/state/sidebar-manager-state'

const InlineEditorKeyboardTooltip = () => {
  const hotkeyEnabled = useIsShortcutEnabled(SHORTCUT_IDS.INLINE_EDITOR_TOGGLE)

  return hotkeyEnabled ? <KeyboardShortcut keys={['Meta', 'E']} /> : null
}

export const InlineEditorButton = () => {
  const { ref } = useParams()
  const router = useRouter()
  const { activeSidebar, toggleSidebar } = useSidebarManagerSnapshot()
  const isOpen = activeSidebar?.id === SIDEBAR_KEYS.EDITOR_PANEL
  const track = useTrack()

  const handleClick = () => {
    track('header_inline_editor_button_clicked')
    const destination = getInlineEditorDestination(ref)
    if (destination !== null) {
      void router.push(destination)
      return
    }
    toggleSidebar(SIDEBAR_KEYS.EDITOR_PANEL)
  }

  return (
    <ButtonTooltip
      variant="outline"
      size="tiny"
      id="editor-trigger"
      className={cn(
        'rounded-full w-[32px] h-[32px] flex items-center justify-center p-0 text-foreground-light hover:text-foreground',
        isOpen && 'bg-foreground text-background hover:text-background'
      )}
      onClick={handleClick}
      tooltip={{
        content: {
          className: 'p-1 pl-2.5',
          text: (
            <div className="flex items-center gap-2.5">
              <span>SQL Editor</span>
              <InlineEditorKeyboardTooltip />
            </div>
          ),
        },
      }}
    >
      <SqlEditor size={16} strokeWidth={1.5} />
      <span className="sr-only">SQL Editor</span>
    </ButtonTooltip>
  )
}

export function getInlineEditorDestination(ref: string | undefined): string | null {
  return !IS_PLATFORM && ref !== undefined ? `/project/${ref}/sql/new` : null
}
