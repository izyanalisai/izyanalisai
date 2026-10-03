import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '../middleware'
import { GET } from '../app/auth/callback/route'

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn(), postLogin: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }))
vi.mock('@/lib/auth-flow', () => ({ getPostLoginPath: mocks.postLogin }))

beforeEach(() => { vi.resetAllMocks() })

describe('session redirect cookies', () => {
  it('preserves cleared cookies and drops old query parameters on anonymous redirects', async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => ({
      auth: { getUser: async () => {
        options.cookies.setAll([{ name: 'session', value: '', options: { maxAge: 0, path: '/' } }])
        return { data: { user: null } }
      } },
    }))
    const response = await middleware(new NextRequest('https://example.com/profil?private=1'))
    expect(response.headers.get('location')).toBe('https://example.com/landing')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('preserves refreshed cookies when a non-admin is redirected', async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => ({
      auth: { getUser: async () => {
        options.cookies.setAll([{ name: 'session', value: 'fresh', options: { httpOnly: true, path: '/' } }])
        return { data: { user: { id: 'u1' } } }
      } },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_admin: false } }) }) }) }),
    }))
    const response = await middleware(new NextRequest('https://example.com/admin'))
    expect(response.headers.get('location')).toBe('https://example.com/')
    expect(response.cookies.get('session')?.value).toBe('fresh')
  })

  it('keeps public and worker routes accessible without calling session auth', async () => {
    for (const path of ['/login', '/auth/callback', '/api/cron/fetch-quotes']) {
      const response = await middleware(new NextRequest(`https://example.com${path}`))
      expect(response.status).toBe(200)
    }
    expect(mocks.createServerClient).not.toHaveBeenCalled()
  })

  it('reads callback cookies without depending on whitespace after semicolons', async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => {
      expect(options.cookies.getAll()).toEqual([{ name: 'first', value: '1' }, { name: 'second', value: 'a=b' }])
      return { auth: { exchangeCodeForSession: async () => {
        options.cookies.setAll([{ name: 'session', value: 'new', options: { path: '/' } }])
        return { data: { user: { id: 'u1' } }, error: null }
      } } }
    })
    mocks.postLogin.mockResolvedValue('/profil-risiko')
    const response = await GET(new NextRequest('https://example.com/auth/callback?code=one', {
      headers: { cookie: 'first=1;second=a=b' },
    }))
    expect(response.headers.get('location')).toBe('https://example.com/profil-risiko')
    expect(response.cookies.get('session')?.value).toBe('new')
  })

  it('preserves cleared cookies on failed callback exchange', async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => ({
      auth: { exchangeCodeForSession: async () => {
        options.cookies.setAll([{ name: 'session', value: '', options: { path: '/', maxAge: 0 } }])
        return { data: { user: null }, error: new Error('expired') }
      } },
    }))
    const response = await GET(new NextRequest('https://example.com/auth/callback?code=expired'))
    expect(response.headers.get('location')).toBe('https://example.com/login?error=auth_callback_failed')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('redirects a callback without a code without starting a session exchange', async () => {
    const response = await GET(new NextRequest('https://example.com/auth/callback'))
    expect(response.headers.get('location')).toContain('auth_callback_failed')
    expect(mocks.createServerClient).not.toHaveBeenCalled()
  })
})
