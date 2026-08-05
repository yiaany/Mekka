/* eslint-disable no-restricted-exports */

import type { NextConfig } from 'next'
import path from 'node:path'

import {
  getMaintenanceRedirects,
  PLATFORM_REDIRECTS,
  SELF_HOSTED_REDIRECTS,
  SHARED_REDIRECTS,
} from './redirects.shared'

const marketplaceApiUrl = process.env.NEXT_PUBLIC_MARKETPLACE_API_URL
  ? new URL(process.env.NEXT_PUBLIC_MARKETPLACE_API_URL)
  : null

const marketplaceApiProtocol: 'http' | 'https' | null =
  marketplaceApiUrl?.protocol === 'https:'
    ? 'https'
    : marketplaceApiUrl?.protocol === 'http:'
      ? 'http'
      : null

// Use `satisfies` instead of `: NextConfig` so TypeScript preserves narrow
// inferred types (e.g. async headers → Promise). This avoids TS2345 when
// wrapper functions (bundle-analyzer, sentry) resolve their `next` peer
// types to a different major version than studio's own next dependency.
const nextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH,
  assetPrefix: undefined,
  output: 'standalone',
  experimental: {
    clientRouterFilter: false,
  },
  async redirects() {
    // Rules live in `redirects.shared.ts` (shared with `vercel.ts`). Next
    // auto-prepends `basePath` to source and destination on its own,
    // except for the special `/` → basePath bounce below which opts out
    // via `basePath: false`.
    const isPlatform = false
    const maintenance = process.env.MAINTENANCE_MODE === 'true'
    return [
      ...(isPlatform ? PLATFORM_REDIRECTS : SELF_HOSTED_REDIRECTS),
      ...SHARED_REDIRECTS,
      ...(process.env.NEXT_PUBLIC_BASE_PATH?.length
        ? [
            {
              source: '/',
              destination: process.env.NEXT_PUBLIC_BASE_PATH,
              basePath: false as const,
              permanent: false,
            },
          ]
        : []),
      ...getMaintenanceRedirects(maintenance),
    ]
  },
  async headers() {
    return [
      {
        source: '/(.*?)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Strict-Transport-Security',
            value:
              '',
          },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none';",
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
      {
        source: '/.well-known/vercel/flags',
        headers: [
          {
            key: 'content-type',
            value: 'application/json',
          },
        ],
      },
      {
        source: '/img/:slug*',
        headers: [{ key: 'cache-control', value: 'public, max-age=2592000' }],
      },
      {
        source: '/favicon/:slug*',
        headers: [{ key: 'cache-control', value: 'public, max-age=86400' }],
      },
      {
        source: '/(.*).ts',
        headers: [{ key: 'content-type', value: 'text/typescript' }],
      },
    ]
  },
  images: {
    dangerouslyAllowSVG: false,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'github.com',
        port: '',
        pathname: '**',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        port: '',
        pathname: '/u/*',
      },
      {
        protocol: 'https',
        hostname: 'api-frameworks.vercel.sh',
        port: '',
        pathname: '**',
      },
      {
        protocol: 'https',
        hostname: 'vercel.com',
        port: '',
        pathname: '**',
      },
      ...(marketplaceApiUrl
        ? [
            {
              ...(marketplaceApiProtocol ? { protocol: marketplaceApiProtocol } : {}),
              hostname: marketplaceApiUrl.hostname,
              port: marketplaceApiUrl.port,
              pathname: '**',
            },
          ]
        : []),
    ],
  },
  transpilePackages: ['ui', 'ui-patterns', 'common', 'shared-data', 'api-types', 'icons'],
  serverExternalPackages: ['libpg-query'],
  turbopack: {
    root: path.resolve(process.cwd(), '../..'),
    rules: {
      '*.md': {
        loaders: ['raw-loader'],
        as: '*.js',
      },
      // special case for Deno libs to be loaded as a raw text. They're passed as raw text to the Monaco editor.
      'edge-runtime.d.ts': {
        loaders: ['raw-loader'],
        as: '*.js',
      },
      'lib.deno.d.ts': {
        loaders: ['raw-loader'],
        as: '*.js',
      },
    },
  },
  onDemandEntries: {
    maxInactiveAge: 24 * 60 * 60 * 1000,
    pagesBufferLength: 100,
  },
  typescript: {
    // Typechecking is run via GitHub Action only for efficiency
    // For production, we run typechecks separate from the build command (pnpm typecheck && pnpm build)
    ignoreBuildErrors: true,
  },
} satisfies NextConfig

export default nextConfig
