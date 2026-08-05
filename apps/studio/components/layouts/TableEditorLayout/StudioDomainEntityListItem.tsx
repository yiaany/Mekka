import { Database } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn, TreeViewItemVariant } from 'ui'
import Link from 'next/link'
import { useParams } from 'common'

import type { Entity } from '@/data/entity-types/entity-types-infinite-query'

export function StudioDomainEntityListItem({
  item,
  style,
}: {
  item: Entity
  style?: CSSProperties
}) {
  const { ref: projectRef, id } = useParams()
  const isActive = id === item.domainId
  return (
    <Link
      href={`/project/${projectRef}/editor/${encodeURIComponent(item.domainId ?? item.name)}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`View ${item.name}`}
      className={cn(
        TreeViewItemVariant({ isSelected: isActive, isPreview: false }),
        'pl-4 pr-2'
      )}
    >
      <Database size={16} strokeWidth={1.5} className="text-foreground-muted min-w-4" />
      <span className="truncate text-sm text-foreground-light">{item.name}</span>
    </Link>
  )
}
