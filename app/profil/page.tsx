cat > /tmp/upload-chart-ai.patch << 'PATCHEOF'
diff --git a/app/chat/page.tsx b/app/chat/page.tsx
index ff18d9b..1acb23c 100644
--- a/app/chat/page.tsx
+++ b/app/chat/page.tsx
@@ -3,6 +3,7 @@
 import { createClient } from '@/lib/supabase/client'
 import { useCallback, useEffect, useRef, useState } from 'react'
 import Link from 'next/link'
+import ChartUploadModal from '@/components/ChartUploadModal'
 
 type ChatMessage = {
   id: string
@@ -21,6 +22,7 @@ export default function ChatPage() {
   const [sending, setSending] = useState(false)
   const [tokenBalance, setTokenBalance] = useState<number | null>(null)
   const [error, setError] = useState<string | null>(null)
+  const [showChartUpload, setShowChartUpload] = useState(false)
   const bottomRef = useRef<HTMLDivElement>(null)
 
   const loadWallet = useCallback(async () => {
@@ -119,6 +121,17 @@ export default function ChatPage() {
         </span>
       </header>
 
+      <div className="px-4 pt-3">
+        <button
+          onClick={() => setShowChartUpload(true)}
+          className="w-full rounded-xl bg-white/5 border border-white/10 py-2.5 text-xs font-medium text-slate-300"
+        >
+          Upload Chart untuk Analisis AI
+        </button>
+      </div>
+
+      <ChartUploadModal open={showChartUpload} onClose={() => setShowChartUpload(false)} />
+
       <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-28">
         {messages.length === 0 && (
           <p className="text-slate-500 text-sm text-center py-10">
diff --git a/components/ChartUploadModal.tsx b/components/ChartUploadModal.tsx
new file mode 100644
index 0000000..2b887b9
--- /dev/null
+++ b/components/ChartUploadModal.tsx
@@ -0,0 +1,210 @@
+'use client'
+
+import { createClient } from '@/lib/supabase/client'
+import { useState } from 'react'
+
+type ChartResult = {
+  id: string
+  image_url: string
+  ticker: string | null
+  ai_description: string
+  pattern_detected: string
+  support_level: number | null
+  resistance_level: number | null
+  engine_entry: number | null
+  engine_sl: number | null
+  engine_tp: number | null
+  engine_note: string
+  is_premium: boolean
+}
+
+function formatHarga(n: number | null | undefined) {
+  if (n === null || n === undefined) return '-'
+  return new Intl.NumberFormat('id-ID').format(n)
+}
+
+export default function ChartUploadModal({
+  open,
+  onClose,
+  defaultTicker,
+}: {
+  open: boolean
+  onClose: () => void
+  defaultTicker?: string
+}) {
+  const supabase = createClient()
+  const [file, setFile] = useState<File | null>(null)
+  const [preview, setPreview] = useState<string | null>(null)
+  const [ticker, setTicker] = useState(defaultTicker ?? '')
+  const [loading, setLoading] = useState(false)
+  const [error, setError] = useState<string | null>(null)
+  const [result, setResult] = useState<ChartResult | null>(null)
+
+  if (!open) return null
+
+  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
+    const f = e.target.files?.[0]
+    if (!f) return
+    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
+      setError('Format tidak didukung. Gunakan JPG, PNG, atau WEBP.')
+      return
+    }
+    if (f.size > 5 * 1024 * 1024) {
+      setError('Ukuran file maksimal 5 MB.')
+      return
+    }
+    setError(null)
+    setFile(f)
+    setPreview(URL.createObjectURL(f))
+  }
+
+  const reset = () => {
+    setFile(null)
+    setPreview(null)
+    setResult(null)
+    setError(null)
+  }
+
+  const handleClose = () => {
+    reset()
+    onClose()
+  }
+
+  const handleSubmit = async () => {
+    if (!file) {
+      setError('Pilih gambar chart dulu.')
+      return
+    }
+    setLoading(true)
+    setError(null)
+    const form = new FormData()
+    form.append('image', file)
+    if (ticker.trim()) form.append('ticker', ticker.trim().toUpperCase())
+
+    const { data, error: fnError } = await supabase.functions.invoke('analyze-chart', {
+      body: form,
+    })
+
+    setLoading(false)
+
+    if (fnError) {
+      const ctx = (fnError as { context?: Response }).context
+      if (ctx?.status === 429) {
+        setError('Jatah analisa chart gratis hari ini sudah habis (1x/hari). Upgrade Premium untuk unlimited.')
+      } else if (ctx?.status === 401) {
+        setError('Sesi login habis, silakan login ulang.')
+      } else {
+        setError('Gagal menganalisa chart. Coba lagi.')
+      }
+      return
+    }
+    if (data?.error) {
+      setError(data.error)
+      return
+    }
+    setResult(data as ChartResult)
+  }
+
+  return (
+    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center">
+      <div className="w-full sm:max-w-[420px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-[#0F172A] border border-white/10 px-4 py-5">
+        <div className="flex items-center justify-between mb-4">
+          <h2 className="font-semibold text-base">Upload Chart untuk Analisis AI</h2>
+          <button onClick={handleClose} className="text-slate-400 text-sm">
+            Tutup
+          </button>
+        </div>
+
+        {!result && (
+          <div className="space-y-3">
+            <p className="text-slate-500 text-xs">
+              AI akan membaca pola visual chart (trend, support/resistance, candlestick). Angka Entry, SL, TP
+              tetap dihitung sistem berdasarkan harga terkini, bukan dari AI.
+            </p>
+
+            <label className="block">
+              <span className="text-xs text-slate-400">Kode Saham (opsional)</span>
+              <input
+                type="text"
+                value={ticker}
+                onChange={(e) => setTicker(e.target.value.toUpperCase())}
+                placeholder="Contoh: BBRI"
+                className="w-full mt-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none"
+              />
+            </label>
+
+            <label className="block">
+              <span className="text-xs text-slate-400">Gambar Chart (JPG/PNG/WEBP, maks 5MB)</span>
+              <input
+                type="file"
+                accept="image/jpeg,image/png,image/webp"
+                onChange={handlePick}
+                className="w-full mt-1 text-xs text-slate-400"
+              />
+            </label>
+
+            {preview && (
+              // eslint-disable-next-line @next/next/no-img-element
+              <img src={preview} alt="preview" className="w-full rounded-lg border border-white/10" />
+            )}
+
+            {error && <p className="text-[#EF4444] text-xs">{error}</p>}
+
+            <button
+              onClick={handleSubmit}
+              disabled={loading || !file}
+              className="w-full rounded-xl bg-gradient-to-r from-[#3B82F6] via-[#8B5CF6] to-[#EC4899] py-3 text-sm font-semibold disabled:opacity-40"
+            >
+              {loading ? 'Menganalisa...' : 'Analisa Chart'}
+            </button>
+          </div>
+        )}
+
+        {result && (
+          <div className="space-y-3">
+            {/* eslint-disable-next-line @next/next/no-img-element */}
+            <img src={result.image_url} alt="chart" className="w-full rounded-lg border border-white/10" />
+
+            <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-3">
+              <p className="text-xs text-slate-500 mb-1">Pola Terdeteksi</p>
+              <p className="text-sm font-medium">{result.pattern_detected}</p>
+            </div>
+
+            <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-3">
+              <p className="text-xs text-slate-500 mb-1">Narasi AI</p>
+              <p className="text-sm">{result.ai_description}</p>
+            </div>
+
+            {result.engine_entry != null ? (
+              <div className="grid grid-cols-3 gap-2 text-sm">
+                <div className="rounded-lg bg-white/5 px-3 py-2">
+                  <p className="text-slate-500 text-xs">Entry</p>
+                  <p className="font-medium">{formatHarga(result.engine_entry)}</p>
+                </div>
+                <div className="rounded-lg bg-white/5 px-3 py-2">
+                  <p className="text-slate-500 text-xs">SL</p>
+                  <p className="font-medium text-[#EF4444]">{formatHarga(result.engine_sl)}</p>
+                </div>
+                <div className="rounded-lg bg-white/5 px-3 py-2">
+                  <p className="text-slate-500 text-xs">TP1</p>
+                  <p className="font-medium text-[#22C55E]">{formatHarga(result.engine_tp)}</p>
+                </div>
+              </div>
+            ) : (
+              <p className="text-slate-500 text-xs">{result.engine_note}</p>
+            )}
+
+            <p className="text-slate-600 text-[11px]">DYOR — sinyal AI bukan jaminan profit.</p>
+
+            <button
+              onClick={reset}
+              className="w-full rounded-xl bg-white/5 border border-white/10 py-3 text-sm font-medium"
+            >
+              Analisa Chart Lain
+            </button>
+          </div>
+        )}
+      </div>
+    </div>
+  )
+}
diff --git a/components/StockDetail.tsx b/components/StockDetail.tsx
index edbe882..9faa297 100644
--- a/components/StockDetail.tsx
+++ b/components/StockDetail.tsx
@@ -4,6 +4,7 @@ import { createClient } from '@/lib/supabase/client'
 import { useEffect, useState, useCallback } from 'react'
 import { useRouter } from 'next/navigation'
 import type { User } from '@supabase/supabase-js'
+import ChartUploadModal from '@/components/ChartUploadModal'
 
 type Stock = {
   id: string
@@ -93,6 +94,7 @@ export default function StockDetail({ ticker }: { ticker: string }) {
 
   const [unlockLoading, setUnlockLoading] = useState(false)
   const [unlockMsg, setUnlockMsg] = useState<string | null>(null)
+  const [showChartUpload, setShowChartUpload] = useState(false)
 
   const loadSignal = useCallback(async (stockId: string) => {
     const { data, error } = await supabase.rpc('get_signal_for_stock', { p_stock_id: stockId })
@@ -368,6 +370,13 @@ export default function StockDetail({ ticker }: { ticker: string }) {
           </div>
         )}
 
+        <button
+          onClick={() => setShowChartUpload(true)}
+          className="w-full rounded-xl bg-white/5 border border-white/10 py-3 text-sm font-medium flex items-center justify-center gap-2"
+        >
+          Upload Chart untuk Analisis AI
+        </button>
+
         <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-4">
           <div className="flex items-center justify-between mb-3">
             <h2 className="font-semibold text-sm">Sinyal AI</h2>
@@ -526,6 +535,12 @@ export default function StockDetail({ ticker }: { ticker: string }) {
           </button>
         </div>
       </div>
+
+      <ChartUploadModal
+        open={showChartUpload}
+        onClose={() => setShowChartUpload(false)}
+        defaultTicker={stock.ticker}
+      />
     </main>
   )
 }
PATCHEOF
git apply /tmp/upload-chart-ai.patch
