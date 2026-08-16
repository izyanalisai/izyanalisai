import { createClient } from 'jsr:@supabase/supabase-js@2'

// ============================================
// 1. KONFIGURASI
// ============================================

// Sumber berita lokal (Berita Indo API - GRATIS & TANPA BATAS)
const LOCAL_SOURCES = [
  { name: 'CNN', url: 'https://berita-indo-api.vercel.app/v1/cnn-news' },
  { name: 'CNBC', url: 'https://berita-indo-api.vercel.app/v1/cnbc-news' },
  { name: 'Tempo', url: 'https://berita-indo-api.vercel.app/v1/tempo-news' },
  { name: 'Antara', url: 'https://berita-indo-api.vercel.app/v1/antara-news' },
]

// Sumber berita global (GNews - 100 request/hari gratis)
const GLOBAL_SOURCE = {
  name: 'GNews',
  url: (apiKey: string) => 
    `https://gnews.io/api/v4/top-headlines?country=us&category=business&lang=en&max=10&token=${apiKey}`
}

// Daftar ticker saham IDX (hardcode sementara, nanti bisa diambil dari DB)
const STATIC_TICKERS = [
  'AALI','ABBA','ADAR','ADHI','ADMF','ADRO','AGRO','AIMS','AMAR','AMRT',
  'ANTM','APII','ARCI','ARGO','ARII','ARNA','ASII','ASRI','AUTO','BABA',
  'BACA','BAJA','BALI','BANK','BAPA','BBCA','BBHI','BBKP','BBMD','BBNI',
  'BBRI','BBTN','BCAP','BEBS','BEEF','BEKS','BEST','BFIN','BIKA','BINA',
  'BIPP','BJBR','BJTM','BKDP','BKSL','BLTA','BLTZ','BMAS','BMRI','BMTR',
  'BNBR','BNGA','BNII','BNLI','BOLT','BORN','BOSS','BPFI','BPII','BRAM',
  'BREN','BRIS','BRMS','BRNA','BRPT','BSDE','BSIM','BSRE','BTEL','BTON',
  'BTPN','BUKA','BULL','BUVA','BVIC','BYAN','CAMP','CARF','CBMF','CCSI',
  'CELL','CENT','CFIN','CINT','CITA','CITY','CLAS','CLPI','CMNP','CMRY',
  'CNMA','COAL','COCO','COCP','COMM','CORA','CPIN','CPRO','CSAP','CSIS',
  'CSMI','CTBN','CTRA','CTRP','CTTH','DADA','DART','DARY','DEAL','DEFI',
  'DEWA','DGNS','DILD','DIVA','DKFT','DMAS','DMMX','DOID','DPNS','DPUM',
  'DRMA','DSNG','DSON','DTRO','DUTI','DVLA','DWGL','DYAN','EAST','ECII',
  'EDGE','EKAD','ELSA','EMDE','EMTK','ENAK','ENRG','EPAC','ERAA','ESSA',
  'ESTI','ETWA','EUSO','EXCL','FAPA','FASW','FAST','FATR','FCSM','FGTR',
  'FILM','FIMP','FISH','FITA','FMII','FOOD','FORU','FPNI','FREN','FRIS',
  'FUJI','GAMA','GARP','GASM','GGRM','GIAA','GGRP','GJTL','GLVA','GMFI',
  'GMTD','GMVA','GOLD','GPRA','GREN','GRPM','GRTM','GSMF','GTBO','GTSI',
  'GULA','GYMG','HADE','HATM','HDFA','HEAL','HERA','HERO','HIND','HITS',
  'HKMU','HMSP','HOKI','HOME','HOTL','HRUM','HRTA','HSFG','ICBP','ICON',
  'IDEA','IDPR','IDRM','IDSA','IDX','IFII','IGAR','IIKP','IKAI','IKAN',
  'IKBI','IKPM','IMAS','IMPC','INAF','INAI','INCI','INCO','INDF','INDO',
  'INDS','INDX','INKP','INOV','INPC','INPP','INPS','INRU','INTA','INTD',
  'INTG','INTK','INTP','IPAC','IPCC','IPCM','IPOL','IPPE','IRRA','ISAT',
  'ISSP','ITIC','ITMG','JAST','JATI','JECC','JETF','JGLE','JIHD','JKON',
  'JMAS','JMTS','JPDL','JPFA','JPRS','JPTI','JRPT','JSKY','JSMR','JSPT',
  'JSUP','JTPE','JWEL','KARW','KBLI','KBLM','KBLV','KBRI','KBSS','KCKL',
  'KEEN','KELT','KFAF','KGAL','KGHA','KGKG','KIAS','KICK','KINO','KJEN',
  'KKGI','KLBF','KLIN','KMDS','KMK','KOBX','KOCS','KOKA','KONI','KOPI',
  'KOTA','KPIG','KRAH','KRAS','KREN','KSAT','KSNI','KTBK','KTCI','KTIS',
  'KUAS','LABA','LAPD','LASF','LBAF','LBF','LCGP','LCKM','LCMS','LDII',
  'LEAD','LIFE','LINK','LION','LIVE','LMAS','LMPI','LMSH','LNGK','LPGI',
  'LPIN','LPKR','LPLI','LPPF','LPPS','LSIP','LSSX','LTLS','LUCK','LUNO',
  'MAHA','MAIN','MAJU','MAKO','MALA','MAMI','MAND','MANU','MAPB','MAPA',
  'MAPI','MASA','MAYA','MBAP','MBMA','MBSS','MCAS','MCOL','MDIA','MDKA',
  'MDLN','MDLZ','MEDC','MEGA','MELI','MERK','MFIN','MGAC','MGII','MGNA',
  'MGRO','MICE','MIDI','MIFA','MIRA','MIXI','MIZA','MKNT','MKPI','MMIX',
  'MNCN','MOLI','MORA','MORE','MOTV','MPMX','MPPA','MPXL','MRAT','MRCA',
  'MRIA','MRNA','MRSY','MSTI','MSTO','MTEL','MTFN','MTLA','MTMH','MTPS',
  'MTSM','MTSS','MTWI','MUAI','MYOR','MYRX','MYTX','MYOH','NAGA','NAMA',
  'NATO','NBLI','NBMI','NDFC','NELY','NEO','NETV','NGEB','NGKA','NGRA',
  'NIAS','NICK','NIKL','NIO','NIPS','NISM','NISO','NISP','NIXI','NKLU',
  'NPKS','NTEK','NTMI','NTO','NUAN','NUSA','OASA','OCAP','OENG','OMED',
  'OMRE','OPMS','ORNA','OTRX','PACS','PADI','PALM','PAMG','PANS','PBRX',
  'PBYY','PCAR','PCEP','PCIK','PDES','PDIS','PEHA','PELM','PENG','PEPO',
  'PERD','PERS','PERT','PETS','PEXS','PFDK','PGAS','PGJO','PGNN','PICO',
  'PIER','PILE','PINV','PIRA','PJAA','PJAN','PKP','PKPK','PKWY','PLAN',
  'PLAS','PLAY','PLIN','PLNT','PNBS','PNIN','PNLF','PNLN','PNSE','PNTS',
  'PNVN','POLL','POLU','POOL','POWR','PPAT','PPRO','PPROP','PRAS','PRDA',
  'PRIM','PRIO','PRKK','PROD','PSAB','PSDN','PSGO','PSKY','PSMN','PSSI',
  'PTBA','PTPP','PTRO','PTSP','PURE','PUTI','PZZA','RAJA','RALS','RANC',
  'RAPR','RATU','RBMS','RBTV','RCCC','RCI','RDTX','REAL','REKS','RELI',
  'REMI','RGFP','RICY','RIGS','RIK','RIMB','RINA','RING','RIPT','RISE',
  'RKDA','RKIM','RKMS','RKNB','RMBA','RMKE','RMKO','RMOL','RMS','RNA',
  'ROCK','RODA','ROHI','ROTI','RUIS','SAGE','SAIP','SALF','SAME','SAND',
  'SANI','SAPX','SARI','SATM','SBCA','SBMF','SBMA','SBMR','SCCO','SCMA',
  'SDMU','SDPC','SDSG','SEAA','SEAT','SECA','SEDO','SEGA','SEMA','SERE',
  'SFAN','SFIL','SFIN','SGRO','SHID','SHIP','SIAP','SICO','SIDO','SIHA',
  'SIIA','SIMM','SIMP','SINA','SINAR','SINK','SINP','SIPD','SIRA','SKBM',
  'SKBR','SKLT','SKRN','SKTB','SKYB','SMDM','SMGR','SMKM','SMMT','SMPT',
  'SMRU','SMSM','SMTX','SOHO','SOPA','SOSS','SOTO','SPMA','SPTO','SQBI',
  'SRGA','SRIL','SRSN','SRTG','SSIA','SSMS','SSRS','STAR','STBF','STTP',
  'SUCO','SUGI','SULI','SULP','SUMM','SUNI','SURE','SURI','SUSI','SWAT',
  'SYST','TAAF','TALF','TAMA','TAMI','TARA','TASI','TAXI','TBIG','TBMS',
  'TBNG','TBS','TCID','TCSA','TDFX','TDPL','TEAM','TECH','TELE','TELK',
  'Tempo','TEPCO','TETA','TEXT','TIFA','TIGA','TIKI','TINC','TINS','TIRA',
  'TITI','TKIM','TKMU','TLDN','TLEE','TLKM','TMAS','TMII','TMPO','TMPP',
  'TMRS','TOBA','TOMI','TOTL','TOWR','TPIA','TPMA','TPRE','TPST','TRAM',
  'TRAY','TRAZ','TREX','TRIA','TRIB','TRIO','TRIS','TRJA','TRN','TROPS',
  'TRUB','TRUE','TRUK','TRUS','TSAI','TSCO','TSEL','TSLA','TSMB','TSPC',
  'TSTR','TTBK','TTGJ','TTI','TUKO','TURM','TVID','TXV','UANG','UBPN',
  'UCLA','UDNG','UGTR','UGRO','UJAN','UKTR','ULBI','ULTJ','UMCW','UMMI',
  'UNIC','UNIQ','UNTR','UNVR','URBN','USAG','USED','USMI','UTAMA','UTAR',
  'UTBI','UTMR','VALU','VICO','VINS','VIVA','VKTR','VOKS','VOX','WALI',
  'WANA','WAPO','WARU','WEGE','WIKA','WINR','WINS','WIR','WISE','WOOD',
  'WSBP','WSKT','WSNP','XCID','XCPL','XICY','XLXL','XOXO','YELO','YELL',
  'YES','YGAS','YIHA','YUASA','YUCH','YULE','ZBRA','ZINC','ZOOM'
]
const TICKER_SET = new Set(STATIC_TICKERS)

// Model AI gratis dari OpenRouter
const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT =
  'Kamu adalah analis keuangan. Klasifikasikan berita saham ini. Tentukan:\n' +
  '1. Ticker saham utama yang disebut (format kode saham seperti BBCA, TPIA). Jika tidak ada, null.\n' +
  '2. Sentimen terhadap harga saham tersebut: positive, negative, atau neutral.\n' +
  '3. Satu kalimat alasan singkat.\n' +
  'Balas HANYA JSON valid tanpa markdown, schema: {"ticker": "...", "sentiment": "...", "reason": "..."}'

// ============================================
// 2. HELPER FUNCTIONS
// ============================================

// Normalisasi judul buat hashing
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Bikin hash SHA256 dari judul
async function generateHash(title: string): Promise<string> {
  const clean = normalizeTitle(title)
  const encoder = new TextEncoder()
  const data = encoder.encode(clean)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Cari kode saham di teks (case insensitive)
function findTickers(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  const upper = text.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
  const words = upper.split(/\s+/)
  for (const word of words) {
    if (TICKER_SET.has(word) && !found.includes(word)) {
      found.push(word)
    }
  }
  return found
}

// Klasifikasi sentimen pake AI (OpenRouter)
async function classifyNews(
  title: string,
  description: string,
  apiKey: string
): Promise<{ ticker: string | null; sentiment: string; reason: string }> {
  const content = `Title: ${title}\nDescription: ${description || ''}`

  for (const model of FREE_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI News Classifier',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Berita:\n${content}` },
          ],
          temperature: 0.1,
          max_tokens: 200,
        }),
      })

      if (res.status === 429 || res.status === 402 || !res.ok) continue
      const data = await res.json()
      const raw = data?.choices?.[0]?.message?.content ?? ''
      const cleaned = raw.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(cleaned)

      const sentiment = ['positive', 'neutral', 'negative'].includes(parsed.sentiment)
        ? parsed.sentiment
        : 'neutral'

      return {
        ticker: parsed.ticker || null,
        sentiment,
        reason: parsed.reason || 'Klasifikasi AI berhasil',
      }
    } catch {
      continue
    }
  }

  return { ticker: null, sentiment: 'neutral', reason: 'AI gagal, fallback neutral' }
}

// Fetch dari Berita Indo API (Lokal)
async function fetchLocalSource(url: string, name: string) {
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (!res.ok) return []
    const json = await res.json()
    const articles = json.data || json.articles || []
    if (!Array.isArray(articles)) return []
    return articles.map((item: any) => ({
      title: item.title || item.judul || '',
      description: item.description || item.deskripsi || '',
      link: item.link || item.url || '',
      pubDate: item.pubDate || item.publishedAt || item.published_at || new Date().toISOString(),
      source: name,
      category: 'domestic' as const,
    }))
  } catch {
    return []
  }
}

// Fetch dari GNews (Global)
async function fetchGlobalSource(apiKey: string) {
  try {
    const url = GLOBAL_SOURCE.url(apiKey)
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (!res.ok) return []
    const json = await res.json()
    const articles = json.articles || []
    if (!Array.isArray(articles)) return []
    return articles.map((item: any) => ({
      title: item.title || '',
      description: item.description || '',
      link: item.url || '',
      pubDate: item.publishedAt || new Date().toISOString(),
      source: 'GNews',
      category: 'global' as const,
    }))
  } catch {
    return []
  }
}

// ============================================
// 3. MAIN HANDLER
// ============================================

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'OPENROUTER_API_KEY belum di-set di Supabase Secrets' }),
      { status: 500 }
    )
  }

  let totalFetched = 0
  let totalInserted = 0
  let totalUpdated = 0
  let totalSkipped = 0
  let totalFailed = 0

  // ---- AMBIL SEMUA ARTIKEL ----
  const allArticles: any[] = []

  // 1. Lokal (4 sumber)
  for (const source of LOCAL_SOURCES) {
    console.log(`Fetching local: ${source.name}...`)
    const articles = await fetchLocalSource(source.url, source.name)
    allArticles.push(...articles)
    totalFetched += articles.length
  }

  // 2. Global (GNews)
  const gnewsKey = Deno.env.get('GNEWS_API_KEY')
  if (gnewsKey) {
    console.log('Fetching global: GNews...')
    const articles = await fetchGlobalSource(gnewsKey)
    allArticles.push(...articles)
    totalFetched += articles.length
  }

  console.log(`Total articles fetched: ${totalFetched}`)

  // ---- PROSES SATU PER SATU ----
  for (const item of allArticles) {
    const { title, description, link, pubDate, source, category } = item

    if (!title || !link) {
      totalSkipped++
      continue
    }

    try {
      // 1. Hash buat cegah duplikat
      const hash = await generateHash(title)

      // 2. Cek apakah udah ada di DB
      const { data: existing } = await supabase
        .from('news')
        .select('id, sources')
        .eq('hash', hash)
        .maybeSingle()

      // 3. Cari ticker dari judul & deskripsi
      const combinedText = `${title} ${description || ''}`
      const mappedTickers = findTickers(combinedText)

      // 4. Klasifikasi sentimen (pake AI)
      let sentiment = 'neutral'
      let sentimentReason = 'Belum diklasifikasi'
      let primaryTicker: string | null = null

      if (mappedTickers.length > 0) {
        const result = await classifyNews(title, description || '', apiKey)
        sentiment = result.sentiment
        sentimentReason = result.reason || 'Klasifikasi AI'
        primaryTicker = result.ticker || mappedTickers[0]
      } else {
        sentiment = 'neutral'
        sentimentReason = 'Tidak ada ticker saham yang terdeteksi'
      }

      const isCatalyst = sentiment === 'positive' && mappedTickers.length > 0

      // 5. Simpan atau Update
      if (existing) {
        // UPDATE: tambahin sumber baru
        const currentSources = existing.sources || []
        const newSources = [...new Set([...currentSources, source])]

        const { error: updateErr } = await supabase
          .from('news')
          .update({
            sources: newSources,
            mapped_tickers: mappedTickers,
            sentiment: sentiment,
            sentiment_reason: sentimentReason,
            is_catalyst: isCatalyst,
          })
          .eq('id', existing.id)

        if (updateErr) {
          console.error(`Update error: ${updateErr.message}`)
          totalFailed++
        } else {
          totalUpdated++
        }
      } else {
        // INSERT baru
        const { error: insertErr } = await supabase
          .from('news')
          .insert({
            title: title,
            hash: hash,
            sources: [source],
            source_urls: [link],
            published_at: pubDate,
            content_snippet: (description || '').substring(0, 500),
            category: category,
            mapped_tickers: mappedTickers,
            sentiment: sentiment,
            sentiment_reason: sentimentReason,
            is_catalyst: isCatalyst,
          })

        if (insertErr) {
          console.error(`Insert error: ${insertErr.message}`)
          totalFailed++
        } else {
          totalInserted++
        }
      }
    } catch (err) {
      console.error(`Error processing article: ${err.message}`)
      totalFailed++
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      skipped: totalSkipped,
      failed: totalFailed,
      timestamp: new Date().toISOString(),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
