/** Static source-to-caller contract verification. Not a hosted end-to-end proof. */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
const root = resolve(import.meta.dirname, '..')
const read = p => readFileSync(resolve(root,p), 'utf8')
const protectedWorkers = [
  'backtest-simulate-structural-v2', 'compute-indicators',
  'detect-unusual-activity', 'fetch-candles', 'fetch-index',
  'fetch-news', 'fetch-sectors', 'generate-signals-mtf', 'probe-idx-eod',
]
for (const name of protectedWorkers) {
  const source = read(`supabase/functions/${name}/index.ts`)
  if (!source.includes("import { rejectUnauthorizedWorker }") ||
      !source.includes("if (workerDenied) return workerDenied;")) {
    throw new Error(`PRIVILEGED_WORKER_UNPROTECTED: ${name}`)
  }
  const gate = source.indexOf('if (workerDenied) return workerDenied;')
  const nextPrivilegedAction = source.search(/\.from\(['"](?!internal_secrets)/)
  if (nextPrivilegedAction >= 0 && nextPrivilegedAction < gate) {
    throw new Error(`PRIVILEGED_ACTION_BEFORE_AUTH: ${name}`)
  }
}
const sql = read('supabase/migrations/20260825031731_remote_schema.sql')
const triggers = [
  ['trigger_fetch_index','fetch-index'],
  ['trigger_fetch_news','fetch-news'],
  ['trigger_detect_unusual_activity','detect-unusual-activity'],
]
for (const [name,endpoint] of triggers) {
  const start = sql.indexOf('CREATE FUNCTION public.' + name)
  if (start < 0) throw new Error(`TRIGGER_MISSING: ${name}`)
  const end = sql.indexOf('$function$;', start)
  if (end < start) throw new Error(`TRIGGER_BODY_MISSING: ${name}`)
  const body = sql.slice(start, end)
  if (!body.includes('/functions/v1/' + endpoint) ||
      !body.includes("'x-worker-secret'") ||
      !body.includes("key = 'worker_shared_secret'")) {
    throw new Error(`TRIGGER_WORKER_SECRET_NOT_FORWARDED: ${name}`)
  }
}
const baseline = read('supabase/functions/run-golden-tests/index.ts')
if (!baseline.includes("body.mode === 'seed' ? 'seed' : 'verify'") ||
    !baseline.includes('hasValidWorkerSecret')) throw new Error('GOLDEN_BASELINE_NOT_PROTECTED')
const telegram = read('supabase/functions/telegram-webhook/index.ts')
if (!telegram.includes('hasValidSecretHeader') ||
    !telegram.includes('WEBHOOK_NOT_CONFIGURED')) throw new Error('TELEGRAM_WEBHOOK_NOT_PROTECTED')
console.log(JSON.stringify({workerEndpointsChecked:protectedWorkers.length,postgresTriggerContracts:triggers.length,telegram:'guarded',goldenTest:'verify_default',scope:'static source contract only'}))
