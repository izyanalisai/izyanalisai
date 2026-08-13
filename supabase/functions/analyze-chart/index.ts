import { createClient } from 'jsr:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
// Worker 6 - Chart Analysis (spec 5.3, 5.6, 14.2).
// AI Vision cuma boleh kasih narasi pola/trend. Entry, SL, TP, support,
// resistance WAJIB dari ENGINE (baseline sama persis dengan generate-signals,
// arah BUY-only karena SELL memang sedang dimatikan di engine utama juga).
// Insert ke chart_analyses cuma boleh lewat service role di sini -- client
// cuma punya SELECT (lihat migration restrict_chart_analyses_to_server_write).
const FREE_VISION_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free'
];
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const ATR_PERIOD = 14;
const SUPPORT_RESISTANCE_LOOKBACK = 20;
function computeATR(candles, period = ATR_PERIOD) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for(let i = 1; i < candles.length; i++){
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const lastN = trs.slice(-period);
  return lastN.reduce((a, b)=>a + b, 0) / lastN.length;
}
function wibDateString(d) {
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const SYSTEM_PROMPT = 'Kamu adalah asisten analisa chart saham IDX untuk IzyAnalisAI. Tugasmu HANYA membaca chart secara visual: ' + 'arah tren (uptrend/downtrend/sideways), pola candlestick atau pola chart yang terlihat (mis. bullish engulfing, ' + 'double bottom, head and shoulders), dan kondisi umum momentum. ' + 'JANGAN PERNAH menyebut angka Entry, Buy Area, Stop Loss, Take Profit, Risk/Reward, Support, Resistance, atau ' + 'rekomendasi BUY/SELL/HOLD -- semua angka itu dihitung sistem lain, bukan tugasmu. ' + 'Balas HANYA dalam format JSON valid, tanpa markdown, dengan schema persis: ' + '{"narasi": "penjelasan 2-4 kalimat dalam Bahasa Indonesia", "pola": "nama pola singkat atau Tidak ada pola jelas"}';
async function callVision(imageBase64, mime, apiKey) {
  let lastError = null;
  for (const model of FREE_VISION_MODELS){
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI Chart Analysis'
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Analisa chart saham berikut.'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mime};base64,${imageBase64}`
                  }
                }
              ]
            }
          ],
          max_tokens: 500
        })
      });
      if (res.status === 429 || res.status === 402) {
        lastError = await res.text();
        continue;
      }
      if (!res.ok) {
        lastError = await res.text();
        continue;
      }
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content ?? '';
      if (!raw) {
        lastError = 'response kosong';
        continue;
      }
      const cleaned = raw.replace(/```json|```/g, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch  {
        parsed = {
          narasi: cleaned,
          pola: undefined
        };
      }
      return {
        narasi: parsed.narasi || 'AI tidak memberikan narasi.',
        pola: parsed.pola || 'Tidak ada pola jelas',
        modelUsed: model
      };
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw new Error(`Semua model vision gratis gagal: ${JSON.stringify(lastError)}`);
}
Deno.serve(async (req)=>{
  try {
    const apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: 'OPENROUTER_API_KEY belum di-set di Supabase Secrets'
      }), {
        status: 500
      });
    }
    const authHeader = req.headers.get('Authorization');
    const anon = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: authHeader ?? ''
        }
      }
    });
    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({
        error: 'unauthorized'
      }), {
        status: 401
      });
    }
    const user = userData.user;
    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const form = await req.formData();
    const file = form.get('image');
    const tickerRaw = form.get('ticker');
    const ticker = typeof tickerRaw === 'string' && tickerRaw.trim() ? tickerRaw.trim().toUpperCase() : null;
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({
        error: "field 'image' wajib diisi (file)"
      }), {
        status: 400
      });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return new Response(JSON.stringify({
        error: 'Format tidak didukung. Gunakan JPG, PNG, atau WEBP.'
      }), {
        status: 400
      });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({
        error: 'Ukuran file maksimal 5 MB.'
      }), {
        status: 400
      });
    }
    // Cek profile + kuota harian (spec 5.3: free 1x/hari, terpisah dari token AI Chat; premium unlimited).
    const { data: profile } = await admin.from('profiles').select('is_premium').eq('id', user.id).maybeSingle();
    const isPremium = !!profile?.is_premium;
    if (!isPremium) {
      const today = wibDateString(new Date());
      const { count } = await admin.from('chart_analyses').select('id', {
        count: 'exact',
        head: true
      }).eq('user_id', user.id).gte('created_at', `${today}T00:00:00+07:00`).lt('created_at', `${today}T23:59:59.999+07:00`);
      if ((count ?? 0) >= 1) {
        return new Response(JSON.stringify({
          error: 'CHART_QUOTA_EXHAUSTED',
          message: 'Jatah analisa chart gratis hari ini sudah habis (1x/hari). Upgrade Premium untuk unlimited.'
        }), {
          status: 429
        });
      }
    }
    // Resize ke maksimal 1024x1024 (contain, jaga aspect ratio) sebelum disimpan.
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    let outBytes;
    let outMime = 'image/jpeg';
    try {
      const img = await Image.decode(inputBytes);
      const scale = Math.min(1, 1024 / img.width, 1024 / img.height);
      if (scale < 1) img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
      outBytes = await img.encodeJPEG(85);
    } catch  {
      // Kalau decode gagal (format aneh), upload apa adanya daripada gagal total.
      outBytes = inputBytes;
      outMime = file.type;
    }
    const path = `${user.id}/${crypto.randomUUID()}.${outMime === 'image/jpeg' ? 'jpg' : 'bin'}`;
    const { error: uploadErr } = await admin.storage.from('chart-images').upload(path, outBytes, {
      contentType: outMime,
      upsert: false
    });
    if (uploadErr) {
      return new Response(JSON.stringify({
        error: `Gagal upload gambar: ${uploadErr.message}`
      }), {
        status: 500
      });
    }
    const { data: publicUrlData } = admin.storage.from('chart-images').getPublicUrl(path);
    const imageUrl = publicUrlData.publicUrl;
    // Resolve saham (opsional -- kalau kosong, kartu cuma berisi narasi AI tanpa angka engine).
    let stockId = null;
    let engineEntry = null;
    let engineSl = null;
    let engineTp = null;
    let supportLevel = null;
    let resistanceLevel = null;
    let engineNote = 'Saham tidak disebutkan -- hanya narasi visual, tanpa Entry/SL/TP.';
    if (ticker) {
      const { data: stock } = await admin.from('stocks').select('id').eq('ticker', ticker).maybeSingle();
      if (!stock) {
        return new Response(JSON.stringify({
          error: `Saham ${ticker} tidak ditemukan.`
        }), {
          status: 404
        });
      }
      stockId = stock.id;
      const { data: candles } = await admin.from('candles').select('ts, open, high, low, close, volume').eq('stock_id', stockId).eq('timeframe', 'D1').order('ts', {
        ascending: true
      }).limit(120);
      const { data: indicator } = await admin.from('indicators').select('ema50').eq('stock_id', stockId).eq('timeframe', 'D1').order('ts', {
        ascending: false
      }).limit(1).maybeSingle();
      if (candles && candles.length >= ATR_PERIOD + 1) {
        const lastCandle = candles[candles.length - 1];
        const atr = computeATR(candles);
        const uptrend = indicator?.ema50 == null || lastCandle.close >= indicator.ema50;
        if (atr != null && uptrend) {
          const recent = candles.slice(-SUPPORT_RESISTANCE_LOOKBACK);
          supportLevel = Math.min(...recent.map((c)=>c.low));
          resistanceLevel = Math.max(...recent.map((c)=>c.high));
          const entry = lastCandle.close;
          const stopLoss = entry - 2 * atr;
          const risk = entry - stopLoss;
          engineEntry = entry;
          engineSl = stopLoss;
          engineTp = entry + 2 * risk // TP1, konsisten dgn baseline_v6 signal engine
          ;
          engineNote = 'Entry/SL/TP dari engine (basis D1, arah BUY), bukan dari AI.';
        } else {
          engineNote = 'Data belum cukup / tren belum mendukung untuk hitung Entry/SL/TP saat ini.';
        }
      } else {
        engineNote = 'Histori candle D1 belum cukup untuk hitung Entry/SL/TP.';
      }
    }
    const b64 = btoa(String.fromCharCode(...outBytes));
    const vision = await callVision(b64, outMime, apiKey);
    const { data: inserted, error: insertErr } = await admin.from('chart_analyses').insert({
      user_id: user.id,
      stock_id: stockId,
      image_url: imageUrl,
      ai_description: vision.narasi,
      pattern_detected: vision.pola,
      support_level: supportLevel,
      resistance_level: resistanceLevel,
      engine_entry: engineEntry,
      engine_sl: engineSl,
      engine_tp: engineTp
    }).select('id, created_at').single();
    if (insertErr || !inserted) {
      return new Response(JSON.stringify({
        error: `Gagal simpan hasil analisa: ${insertErr?.message}`
      }), {
        status: 500
      });
    }
    await admin.from('ai_usage').insert({
      user_id: user.id,
      worker: 'analyze-chart',
      model: vision.modelUsed
    });
    return new Response(JSON.stringify({
      id: inserted.id,
      created_at: inserted.created_at,
      image_url: imageUrl,
      ticker,
      ai_description: vision.narasi,
      pattern_detected: vision.pola,
      support_level: supportLevel,
      resistance_level: resistanceLevel,
      engine_entry: engineEntry,
      engine_sl: engineSl,
      engine_tp: engineTp,
      engine_note: engineNote,
      is_premium: isPremium
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500
    });
  }
});
