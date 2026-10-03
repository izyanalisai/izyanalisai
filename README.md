# IzyAnalisAi

A web application for AI-assisted technical analysis of Indonesian stocks, built with Next.js 16, React 19, Tailwind CSS, Supabase, and Cloudflare/OpenNext.

## Implemented application areas

The repository includes authentication/onboarding, risk profiles, stock detail pages, watchlists, technical signals and signal history, trading plans, AI chat/chart analysis, news/calendar screens, subscriptions, and an admin interface. Supabase functions implement background market-data processing, signal evaluation, and payment-webhook handling. Code presence alone does not prove live service availability or trading accuracy.

## Local setup

Use Node.js 24 LTS, matching CI and the Cloudflare build environment. The installed Supabase and Cloudflare tooling requires Node.js 22 or newer.

```bash
npm ci
cp .env.example .env.local
# Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
npm run dev
```

Configure Supabase authentication redirect URLs for `/auth/callback` on your local and deployed origins. OAuth sign-in also requires the relevant provider configuration in Supabase. Public configuration belongs in `NEXT_PUBLIC_*`; never put a service-role key or provider secret there.

The frontend requires the matching Supabase schema and configured edge functions. Archived migrations are historical records and should not be blindly replayed against a live database. Server credentials belong in the appropriate Supabase or deployment secret store.

## Verification

```bash
npm test
npm run typecheck
npm run lint -- --max-warnings=0
npm run build
```

Auth regression tests verify cookie preservation on redirects, callback cookie parsing, failed exchanges, and the public/worker-route bypass. These tests mock Supabase; they do not replace live OAuth testing or database authorization checks. `Web Checks` runs tests, TypeScript, lint, and a build using placeholder public configuration. Cloudflare deployment runs the web checks before building/deploying.

Edge-function tests are configured in `.github/workflows/test-edge-functions.yml`. Payment tests and signal lifecycle tests are separate from the frontend suite. Live Supabase, market data, AI providers, billing, notification delivery, and Cloudflare deployments require their actual configuration and additional integration verification.

## Deployment and access controls

The existing workflows use Cloudflare and Supabase secrets. Do not commit `.env.local` or secret values. Cookie-based middleware routes anonymous users to the landing page and checks admin profiles, while preserving session refresh/clear cookies on redirects. Supabase RLS and individual edge-function authentication must enforce data access; frontend routing alone is not an authorization boundary.

This project is suitable for describing implemented AI application integration in a portfolio. No claim of audited trading accuracy, investment returns, or production readiness is made here.
