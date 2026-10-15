/** Read-only static security inventory of historical SQL; intentionally fail closed. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

export function auditBaseline(sql) {
  // Parse individual GRANT statements rather than spanning statement boundaries.
  // This is a conservative screen, not a PostgreSQL grammar parser or an RLS proof.
  const grants = [...sql.matchAll(/\bGRANT\s+[^;]*;/gi)].map(match => match[0]);
  const anonAll = grants.flatMap(statement => {
    const target = statement.match(/\bALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?(?:\"?public\"?\.)\"?([a-z_][a-z_0-9]*)\"?\s+TO\s+\"?anon\"?\s*;/i);
    return target ? [target[1]] : [];
  });
  const anonDefaults = [...sql.matchAll(/ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bGRANT\b[^;]*\bTO\s+(?:\"?anon\"?|PUBLIC)\b/gi)];
  const broadSchemaGrants = grants.filter(statement =>
    /\bON\s+ALL\s+(?:TABLES|SEQUENCES|FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+\"?public\"?\b/i.test(statement) &&
    /\bTO\s+(?:\"?anon\"?|PUBLIC)\b/i.test(statement)
  );
  const publicObjectGrants = grants.filter(statement =>
    /\bON\s+(?:TABLE\s+|SEQUENCE\s+|FUNCTION\s+|ROUTINE\s+)?\"?public\"?\./i.test(statement) &&
    /\bTO\s+PUBLIC\s*;/i.test(statement)
  );
  const definerFunctions = [...sql.matchAll(/\bSECURITY\s+DEFINER\b/gi)].length;
  const rlsTables = [...sql.matchAll(/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi)].length;
  const blocked = anonAll.length || anonDefaults.length || broadSchemaGrants.length || publicObjectGrants.length;
  return {
    status: blocked ? 'BLOCKED_PRIVILEGE_REVIEW' : 'NO_BROAD_ANON_GRANTS_DETECTED',
    anonymousFullPrivilegeObjects: anonAll.length,
    anonymousDefaultPrivilegeStatements: anonDefaults.length,
    broadSchemaGrants: broadSchemaGrants.length,
    publicObjectGrants: publicObjectGrants.length,
    securityDefinerOccurrencesToReview: definerFunctions,
    rlsEnableStatements: rlsTables,
    sensitiveExamples: anonAll.filter(x => /payments?|tokens?|audit|user|notification|ai_|watchlist/i.test(x)).slice(0, 12),
    scope: 'Static grant inventory only; does not prove RLS safety, successful migrations or live data security',
  };
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(here, '../supabase/migrations/20261015225043_izy_hosted_legacy_schema_least_privilege_bootstrap.sql');
  const result = auditBaseline(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'NO_BROAD_ANON_GRANTS_DETECTED') {
    console.error('::warning::Supabase historical baseline requires anonymous-grant review before deployment');
    if (process.argv.includes('--enforce')) process.exitCode = 1;
  }
}