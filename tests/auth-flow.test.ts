import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPostLoginPath } from '../lib/auth-flow'

type RecordResponse = { data: Record<string, unknown> | null; error: Error | null }

function makeQuery(response: RecordResponse) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => response,
  }
  return chain
}

function clientWithResponses(records: Record<string, RecordResponse>) {
  const signOut = vi.fn(async (): Promise<{ error: Error | null }> => ({ error: null }))
  const from = vi.fn((table: string) => {
    const record = records[table]
    if (!record) throw new Error('unexpected table: ' + table)
    return makeQuery(record)
  })
  return { client: { from, auth: { signOut } } as unknown as SupabaseClient, from, signOut }
}

const clean = (data: Record<string, unknown> | null) => ({ data, error: null })
const failed = () => ({ data: null, error: new Error('test-only Postgres outage') })

describe('post-login onboarding authorization', () => {
  it.each([
    ['profiles', { profiles: failed() }],
    ['agreements', { profiles: clean({ risk_profile: 'moderate' }), agreements: failed() }],
    ['agreement_acceptances', {
      profiles: clean({ risk_profile: 'moderate' }),
      agreements: clean({ id: 'active-agreement' }),
      agreement_acceptances: failed(),
    }],
  ])('rejects failed %s query rather than treating it as missing data', async (_name, records) => {
    const { client } = clientWithResponses(records)
    await expect(getPostLoginPath(client, 'user-1')).rejects.toThrow(/POST_LOGIN_.*_UNAVAILABLE/)
  })

  it('does not require acceptance if there is no active agreement', async () => {
    const { client, from } = clientWithResponses({
      profiles: clean({ risk_profile: 'moderate' }), agreements: clean(null),
    })
    await expect(getPostLoginPath(client, 'user-1')).resolves.toBe('/')
    expect(from).not.toHaveBeenCalledWith('agreement_acceptances')
  })

  it('routes a non-accepted active agreement to the agreement page', async () => {
    const { client } = clientWithResponses({
      profiles: clean({ risk_profile: 'moderate' }),
      agreements: clean({ id: 'active-agreement' }),
      agreement_acceptances: clean(null),
    })
    await expect(getPostLoginPath(client, 'user-1')).resolves.toBe('/agreement')
  })

  it('signs out a deleted account before allowing onboarding', async () => {
    const { client, signOut, from } = clientWithResponses({
      profiles: clean({ deleted_at: '2026-10-01T00:00:00Z', risk_profile: 'moderate' }),
    })
    await expect(getPostLoginPath(client, 'user-1')).resolves.toBe('/login?accountDeleted=1')
    expect(signOut).toHaveBeenCalledOnce()
    expect(from).not.toHaveBeenCalledWith('agreements')
  })
})


describe('deleted-account sign-out failures', () => {
  it('rejects a failed sign-out instead of treating account deletion as cleared', async () => {
    const { client, signOut } = clientWithResponses({
      profiles: clean({ deleted_at: '2026-10-01T00:00:00Z', risk_profile: 'moderate' }),
    })
    signOut.mockResolvedValueOnce({ error: new Error('sign-out temporarily unavailable') })
    await expect(getPostLoginPath(client, 'user-1')).rejects.toThrow(
      'POST_LOGIN_DELETED_ACCOUNT_SIGNOUT_FAILED'
    )
  })
})
