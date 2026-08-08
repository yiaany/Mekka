import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button, copyToClipboard } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'

const publicOrigin = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_MEKKA_GATEWAY_URL ??
  'http://127.0.0.1:8082'
).replace(/\/$/, '')

function MekkaMcpContent() {
  const [copied, setCopied] = useState(false)
  const mcpUrl = `${publicOrigin}/mcp`
  const config = JSON.stringify(
    {
      mcpServers: {
        mekka: {
          type: 'http',
          url: mcpUrl,
          headers: {
            Authorization: 'Bearer <temporary-agent-access-token>',
          },
        },
      },
    },
    null,
    2
  )

  const handleCopy = () => {
    copyToClipboard(config)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <div className="space-y-6">
      <Admonition
        type="default"
        title="Two deliberate steps"
        description="Sign in on the Register / Sign in page and copy the five-minute Agent Access token. Then replace the placeholder below and add the configuration to your MCP client. Mekka will offer true one-click authorization only after a complete OAuth consent flow exists."
      />

      <div className="overflow-hidden rounded-lg border bg-surface-100">
        <div className="flex items-center justify-between border-b bg-surface-200 px-4 py-3">
          <div>
            <p className="text-sm font-medium">MCP client configuration</p>
            <p className="text-xs text-foreground-muted">
              Cursor, VS Code, Claude Code, Codex, OpenCode and other HTTP clients
            </p>
          </div>
          <Button
            type="button"
            size="tiny"
            variant="default"
            icon={copied ? <Check /> : <Copy />}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto p-4 text-xs">{config}</pre>
      </div>

      <div className="grid gap-3 border-t pt-5 text-sm sm:grid-cols-3">
        <EndpointFact label="Transport" value="Streamable HTTP" />
        <EndpointFact label="Access" value="Tenant-bound, read-only" />
        <EndpointFact label="Token lifetime" value="Up to five minutes" />
      </div>
    </div>
  )
}

function EndpointFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-foreground-muted">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  )
}

export default MekkaMcpContent
