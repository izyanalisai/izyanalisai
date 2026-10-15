/** Read-only scan of historical Supabase SQL before deploying to a new project. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

export function auditBaseline(sql) {
  const anonAll = [...sql.matchAll(/\bGRANT\s+ALL\s+ON\s+public\.([a-z_0-9]+)\s+TO\s+anon\s*;/gi)]
    .map(match => match[1]);
  const anonDefaults = [...sql.matchAll(/ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bGRANT\b[^;]*\bTO\s+anon\b/gi)];
  const definerFunctions = [...sql.matchAll(/\bSECURITY\s+DEFINER\b/gi)].length;
  const rlsTables = [...sql.matchAll(/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi)].length;
  return {
    status: anonAll.length || anonDefaults.length ? 'BLOCKED_PRIVILEGE_REVIEW' : 'NO_BROAD_ANON_GRANTS_DETECTED',
    anonymousFullPrivilegeObjects: anonAll.length,
    anonymousDefaultPrivilegeStatements: anonDefaults.length,
    securityDefinerOccurrencesToReview: definerFunctions,
    rlsEnableStatements: rlsTables,
    sensitiveExamples: anonAll.filter(x => /payments?|tokens?|audit|user|notification|ai_|watchlist/i.test(x)).slice(0, 12),
    scope: 'Static grant inventory only; does not prove RLS safety, successful migrations or live data security',
  };
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(here, '../supabase/migrations/20260825031731_remote_schema.sql');
  const result = auditBaseline(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'NO_BROAD_ANON_GRANTS_DETECTED') {
    console.error('::warning::Supabase historical baseline requires anonymous-grant review before deployment');
    if (process.argv.includes('--enforce')) process.exitCode = 1;
  }
}
