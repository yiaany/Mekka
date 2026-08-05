import { useParams } from 'common'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { Menu } from 'ui'

import { ShortcutTooltip } from '@/components/ui/ShortcutTooltip'
import { SHORTCUT_IDS } from '@/state/shortcuts/registry'
import { useShortcut } from '@/state/shortcuts/useShortcut'

import { useStorageV2Page } from './Storage.utils'

export const StorageMenuV2 = () => {
  const router = useRouter()
  const { ref } = useParams()
  const page = useStorageV2Page()
  useShortcut(SHORTCUT_IDS.NAV_STORAGE_FILES, () => router.push(`/project/${ref}/storage/files`))

  return (
    <Menu type="pills" className="my-2 flex grow flex-col md:my-4">
      <div className="md:mx-3">
        <Menu.Group title={<span className="font-mono uppercase">Manage</span>} />
        <ShortcutTooltip
          shortcutId={SHORTCUT_IDS.NAV_STORAGE_FILES}
          side="right"
          delayDuration={1000}
        >
          <Link href={`/project/${ref}/storage/files`}>
            <Menu.Item rounded active={page === 'files'}>
              <p className="truncate">Files</p>
            </Menu.Item>
          </Link>
        </ShortcutTooltip>
      </div>
    </Menu>
  )
}
