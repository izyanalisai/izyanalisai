#!/bin/bash
set -e

# --- Rename unused vars ke underscore-prefixed ---
sed -i '52s/totalBars/_totalBars/' supabase/functions/backtest-simulate-structural-v2/index.ts
sed -i '1s/\breq\b/_req/' supabase/functions/diag-ai-base/index.ts
sed -i '191s/\breq\b/_req/' supabase/functions/diagnose-indicators/index.ts
sed -i '12s/\breq\b/_req/' supabase/functions/probe-idx-eod/index.ts

# --- Update eslint config: abaikan var/arg berawalan underscore ---
echo "CEK MANUAL: pastikan eslint.config.mjs punya rule ini di 'rules':"
echo '  "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]'

echo "SELESAI - jalankan npm run lint untuk verifikasi"
