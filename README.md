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

## Select OpenAI / xAI Grok for AI features

Set **server-side Supabase Edge Function secrets**, not frontend `NEXT_PUBLIC_*` variables:

| Provider | Required secrets/configuration |
| --- | --- |
| OpenAI | `AI_PROVIDER=openai`, `AI_MODEL=<available-model-id>`, `OPENAI_API_KEY=<server-secret>` |
| xAI/Grok | `AI_PROVIDER=xai`, `AI_MODEL=<available-model-id>`, `XAI_API_KEY=<server-secret>` |
| Compatible gateway | `AI_PROVIDER=compatible`, `AI_MODEL=<model-id>`, `AI_API_KEY=<server-secret>`, `AI_PROVIDER_BASE_URL=<https-api-base>` |

Set `AI_VISION_MODEL` separately to an image-capable model for chart analysis and chat with images. A text-model setting alone does not enable vision. Choose model IDs available to your provider account; no paid model is auto-selected.

The shared adapter is connected to `chat-asisten-ai`, `analyze-chart`, `generate-signal-reasoning`, `generate-trending-reason`, and `fetch-news`. If `AI_PROVIDER` is unset or `legacy`, the existing Cloudflare/9Router/OpenRouter chain is retained. Selecting a cloud provider sends one request to that provider without silently retrying or falling back to another paid provider. Errors continue through each feature's existing error/refund handling.

Optional controls: `AI_MAX_TOKENS` (default 2048, maximum 16384), `AI_TIMEOUT_MS` (default 30000), and `AI_TOKEN_PARAMETER` (`max_tokens` or `max_completion_tokens`). Temperature is omitted. OpenAI uses the official OpenAI API origin; xAI uses `https://api.x.ai/v1`. Use `compatible` for custom HTTPS gateways. The API base is normalized without duplicating `/v1`.

Provider tests validate endpoint/key selection, model configuration, payloads, usage parsing, bounded single requests, and rejection of refused/truncated outputs using mocked HTTP. Live model quality, chart accuracy, and Supabase deployment still need actual credentials and integration tests. The existing deterministic signal-engine rules remain authoritative for price levels; model-generated text does not replace them.

References: [OpenAI API](https://developers.openai.com/api/docs/guides/structured-outputs), [xAI API](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).
