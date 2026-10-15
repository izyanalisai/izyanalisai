import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditBaseline } from './audit-supabase-baseline.mjs';

test('rejects explicit anonymous full-table grants', () => {
  const result = auditBaseline('GRANT ALL ON public.payments TO anon;');
  assert.equal(result.status, 'BLOCKED_PRIVILEGE_REVIEW');
  assert.deepEqual(result.sensitiveExamples, ['payments']);
});

test('rejects permissive anonymous default grants', () => {
  const result = auditBaseline('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;');
  assert.equal(result.status, 'BLOCKED_PRIVILEGE_REVIEW');
  assert.equal(result.anonymousDefaultPrivilegeStatements, 1);
});

test('rejects grants across every public table', () => {
  const result = auditBaseline('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;');
  assert.equal(result.status, 'BLOCKED_PRIVILEGE_REVIEW');
  assert.equal(result.broadSchemaGrants, 1);
});

test('rejects PUBLIC grants to individual objects', () => {
  const result = auditBaseline('GRANT EXECUTE ON FUNCTION public.rotate_secret(uuid) TO PUBLIC;');
  assert.equal(result.status, 'BLOCKED_PRIVILEGE_REVIEW');
  assert.equal(result.publicObjectGrants, 1);
});

test('rejects PUBLIC as a recipient of blanket defaults', () => {
  const result = auditBaseline('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;');
  assert.equal(result.status, 'BLOCKED_PRIVILEGE_REVIEW');
});

test('does not accidentally bridge semicolon boundaries', () => {
  const result = auditBaseline('GRANT SELECT ON public.stocks TO anon; GRANT ALL ON public.payments TO authenticated;');
  assert.equal(result.status, 'NO_BROAD_ANON_GRANTS_DETECTED');
});

test('recognizes limited, explicit public SELECT grants without claiming RLS proof', () => {
  const result = auditBaseline('GRANT SELECT ON public.stocks TO anon; ALTER TABLE public.stocks ENABLE ROW LEVEL SECURITY;');
  assert.equal(result.status, 'NO_BROAD_ANON_GRANTS_DETECTED');
  assert.match(result.scope, /does not prove RLS safety/);
});

test('the historical baseline must remain blocked until privileged grants are reviewed', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260825031731_remote_schema.sql', import.meta.url), 'utf8');
  const result = auditBaseline(sql);
  assert.equal(result.status, 'BLOCKED_PRIVILEGE_REVIEW');
  assert.ok(result.anonymousFullPrivilegeObjects >= 50);
  assert.ok(result.securityDefinerOccurrencesToReview >= 90);
});
