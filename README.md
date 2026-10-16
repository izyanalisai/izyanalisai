# IzyAnalisAi

> **Research Indonesian stocks using technical signals, market context, and AI-assisted analysis in one workspace.**

IzyAnalisAi is a web application for researching listed Indonesian equities. It brings together stock data, technical signal workflows, watchlists, trading plans, market news, and AI-assisted explanations. It is built with Next.js 16, React 19, Tailwind CSS, Supabase, and Cloudflare/OpenNext.

## What users can do

| Product area | User action | Result in the application |
| --- | --- | --- |
| Stock research | Open stock detail and market views | A consolidated research view for the selected equity |
| Watchlist | Track stocks of interest | A personal list for returning to relevant symbols |
| Technical signals | Inspect calculated signals and history | Signal records and context for review |
| Risk profile & trading plan | Set risk preferences and examine a plan | A structured plan and related risk context |
| AI assistant | Ask questions or request chart analysis | AI-generated explanations or chart interpretation when a provider is configured |
| Market context | Review news, trending reasons, and calendar screens | Additional inputs to evaluate alongside technical signals |
| Account & subscriptions | Use onboarding, subscriptions, and billing flows | Account, entitlement, and payment-related application states |
| Administration | Access authorized admin routes | Management tools governed by application roles |

## Example research workflow

1. Open a stock detail page and inspect the market context.
2. Review technical signals, their recorded history, and applicable risk parameters.
3. Add relevant symbols to a watchlist and prepare a trading plan.
4. Use the AI assistant to summarize a chart or related news.
5. Make the final decision independently. AI text and signals are research aids, not a promise of returns.

## Application architecture

- **Frontend:** Next.js App Router, React, and Tailwind CSS.
- **Data and accounts:** Supabase authentication, database tables, and authorization policies.
- **Business logic:** Supabase Edge Functions for market-data processing, signal evaluation, AI features, and billing webhooks.
- **AI:** a configurable server-side provider adapter supporting OpenAI, xAI/Grok, compatible gateways, and the existing legacy provider path.
- **Delivery:** Cloudflare/OpenNext build and deployment workflows.

The AI adapter is used by `chat-asisten-ai`, `analyze-chart`, `generate-signal-reasoning`, `generate-trending-reason`, and `fetch-news`. Deterministic signal-engine rules remain responsible for numeric price levels; language-model output does not replace that logic.

## Run locally

Use **Node.js 24 LTS** and install dependencies from the repository root.

```bash
npm ci
cp .env.example .env.local
# Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev
```

Configure Supabase authentication callback URLs for `/auth/callback`. OAuth providers need their own Supabase configuration. The application requires the corresponding database schema and Edge Functions for data-backed features.

## Configure an AI provider

Place credentials in **Supabase Edge Function secrets**, never in a `NEXT_PUBLIC_*` environment variable.

| Provider | Server-side configuration |
| --- | --- |
| OpenAI | `AI_PROVIDER=openai`, `AI_MODEL`, `OPENAI_API_KEY` |
| xAI/Grok | `AI_PROVIDER=xai`, `AI_MODEL`, `XAI_API_KEY` |
| Compatible HTTPS gateway | `AI_PROVIDER=compatible`, `AI_MODEL`, `AI_API_KEY`, `AI_PROVIDER_BASE_URL` |
| Existing configured path | `AI_PROVIDER=legacy` or unset |

Set `AI_VISION_MODEL` separately to a supported image-capable model for chart-image analysis. Optional controls include `AI_MAX_TOKENS`, `AI_TIMEOUT_MS`, and `AI_TOKEN_PARAMETER`. Select a model available in your provider account. Provider requests are bounded and do not silently retry via another paid provider.

## Checks

```bash
npm test
npm run typecheck
npm run lint -- --max-warnings=0
npm run build
```

Frontend and Edge Function test workflows cover defined contracts and application logic. Local mock-based results do not establish live market-data accuracy, payment settlement, external AI model quality, or production uptime.

## Security and usage boundaries

Protect Supabase credentials and payment/provider secrets server-side. Cookie-based route handling is not a substitute for Supabase RLS or Edge Function authorization. The software presents research and application workflows; it does not guarantee an investment outcome or represent verified financial advice. Real-world service behavior depends on properly configured and independently tested providers and infrastructure.
