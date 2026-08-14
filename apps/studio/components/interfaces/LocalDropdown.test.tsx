import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MouseEventHandler, ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { LocalDropdown } from './LocalDropdown'

const { mockRouter, mockSetTheme } = vi.hoisted(() => ({
  mockRouter: {
    pathname: '/project/[ref]/editor',
    asPath: '/project/local/editor',
  },
  mockSetTheme: vi.fn(),
}))

vi.mock('next/router', () => ({
  useRouter: () => mockRouter,
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
  }: {
    href: string
    children: ReactNode
    onClick?: MouseEventHandler<HTMLAnchorElement>
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: mockSetTheme,
  }),
}))

vi.mock('@/components/ui/ProfileImage', () => ({
  ProfileImage: () => <div>Avatar</div>,
}))

vi.mock('@/lib/telemetry/track', () => ({ useTrack: () => vi.fn() }))

vi.mock('ui', async () => {
  const React = await import('react')

  return {
    Button: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) => (
      <button tabIndex={0} {...props}>
        {children}
      </button>
    ),
    cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children: ReactNode
      onValueChange: (value: string) => void
    }) => (
      <div>
        {React.Children.map(children, (child: ReactNode) =>
          React.isValidElement<{ value: string; onClick?: () => void }>(child)
            ? React.cloneElement(child, {
                onClick: () => onValueChange(child.props.value),
              })
            : (child as ReactElement)
        )}
      </div>
    ),
    DropdownMenuRadioItem: ({
      children,
      onClick,
    }: {
      children: ReactNode
      onClick?: () => void
    }) => (
      <button tabIndex={0} onClick={onClick}>
        {children}
      </button>
    ),
    Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    singleThemes: [
      { value: 'dark', name: 'Dark' },
      { value: 'light', name: 'Light' },
    ],
  }
})

describe('LocalDropdown', () => {
  it('removes the Command menu and keeps theme controls wired', async () => {
    const user = userEvent.setup()

    render(<LocalDropdown />)

    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.queryByText('Command menu')).not.toBeInTheDocument()

    await user.click(screen.getByText('Light'))
    expect(mockSetTheme).toHaveBeenCalledWith('light')
  })
})
