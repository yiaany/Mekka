import { PermissionAction } from '@supabase/shared-types/out/constants'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { ComponentPropsWithoutRef, forwardRef, useMemo, useState } from 'react'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from 'ui'

import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSchemasFilteredForHighAvailability } from '@/hooks/misc/useHighAvailability'

type SchemaSelectorProps = Omit<ComponentPropsWithoutRef<'div'>, 'onSelect'> & {
  disabled?: boolean
  size?: 'tiny' | 'small'
  showError?: boolean
  selectedSchemaName?: string
  placeholderLabel?: string
  supportSelectAll?: boolean
  excludedSchemas?: string[]
  stopScrollPropagation?: boolean
  onSelectSchema: (name: string) => void
  onSelectCreateSchema?: () => void
  align?: 'start' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const DEFAULT_EXCLUDED_SCHEMAS: string[] = []
const LOCAL_SQLITE_SCHEMA = { id: 0, name: 'main', owner: 'local', comment: null }

export const SchemaSelector = forwardRef<HTMLDivElement, SchemaSelectorProps>(
  (
    {
      className,
      disabled = false,
      size = 'tiny',
      showError = true,
      selectedSchemaName,
      placeholderLabel = 'Choose a schema...',
      supportSelectAll = false,
      excludedSchemas = DEFAULT_EXCLUDED_SCHEMAS,
      stopScrollPropagation = false,
      onSelectSchema,
      onSelectCreateSchema,
      align = 'start',
      open: openProp,
      onOpenChange,
      ...rest
    },
    ref
  ) => {
    const [internalOpen, setInternalOpen] = useState(false)
    const isControlled = openProp !== undefined
    const open = isControlled ? openProp : internalOpen
    const setOpen = (next: boolean) => {
      if (!isControlled) setInternalOpen(next)
      onOpenChange?.(next)
    }
    const { can: canCreateSchemas } = useAsyncCheckPermissions(
      PermissionAction.TENANT_SQL_ADMIN_WRITE,
      'schemas'
    )

    const visibleSchemas = useSchemasFilteredForHighAvailability([LOCAL_SQLITE_SCHEMA])

    const schemas = useMemo(
      () =>
        visibleSchemas
          .filter((schema) => !excludedSchemas.includes(schema.name))
          .sort((a, b) => a.name.localeCompare(b.name)),
      [visibleSchemas, excludedSchemas]
    )

    return (
      <div ref={ref} className={className} {...rest}>
        <Popover open={open} onOpenChange={setOpen} modal={false}>
            <PopoverTrigger asChild>
              <Button
                size={size}
                disabled={disabled}
                variant="default"
                data-testid="schema-selector"
                className={`w-full [&>span]:w-full pr-1! space-x-1`}
                iconRight={
                  <ChevronsUpDown className="text-foreground-muted" strokeWidth={2} size={14} />
                }
              >
                {selectedSchemaName ? (
                  <div className="w-full flex gap-1">
                    <p className="text-foreground-lighter">schema</p>
                    <p className="text-foreground">
                      {selectedSchemaName === '*' ? 'All schemas' : selectedSchemaName}
                    </p>
                  </div>
                ) : (
                  <div className="w-full flex gap-1">
                    <p className="text-foreground-lighter">{placeholderLabel}</p>
                  </div>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="p-0 min-w-[200px] pointer-events-auto"
              side="bottom"
              align={align}
              sameWidthAsTrigger
            >
              <Command>
                <CommandInput className="text-xs" placeholder="Find schema..." />
                <CommandList
                  onWheel={stopScrollPropagation ? (event) => event.stopPropagation() : undefined}
                >
                  <CommandEmpty>No schemas found</CommandEmpty>
                  <CommandGroup>
                    <ScrollArea className={(schemas || []).length > 7 ? 'h-[210px]' : ''}>
                      {supportSelectAll && (
                        <CommandItem
                          key="select-all"
                          className="cursor-pointer flex items-center justify-between space-x-2 w-full"
                          onSelect={() => {
                            onSelectSchema('*')
                            setOpen(false)
                          }}
                          onClick={() => {
                            onSelectSchema('*')
                            setOpen(false)
                          }}
                        >
                          <span>All schemas</span>
                          {selectedSchemaName === '*' && (
                            <Check className="text-brand" strokeWidth={2} size={16} />
                          )}
                        </CommandItem>
                      )}
                      {schemas.map((schema) => (
                        <CommandItem
                          key={schema.id}
                          className="cursor-pointer flex items-center justify-between space-x-2 w-full"
                          onSelect={() => {
                            onSelectSchema(schema.name)
                            setOpen(false)
                          }}
                          onClick={() => {
                            onSelectSchema(schema.name)
                            setOpen(false)
                          }}
                        >
                          <span>{schema.name}</span>
                          {selectedSchemaName === schema.name && (
                            <Check className="text-brand" strokeWidth={2} size={16} />
                          )}
                        </CommandItem>
                      ))}
                    </ScrollArea>
                  </CommandGroup>
                  {onSelectCreateSchema !== undefined && canCreateSchemas && (
                    <>
                      <CommandSeparator />
                      <CommandGroup>
                        <CommandItem
                          className="cursor-pointer flex items-center gap-x-2 w-full"
                          onSelect={() => {
                            onSelectCreateSchema()
                            setOpen(false)
                          }}
                          onClick={() => {
                            onSelectCreateSchema()
                            setOpen(false)
                          }}
                        >
                          <Plus size={12} />
                          Create a new schema
                        </CommandItem>
                      </CommandGroup>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
        </Popover>
      </div>
    )
  }
)

SchemaSelector.displayName = 'SchemaSelector'
