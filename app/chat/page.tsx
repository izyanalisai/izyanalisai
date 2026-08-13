'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string | null
  image_url: string | null
}

export default function ChatPage() {
  const supabase = createClient()
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [tokenBalance, setTokenBalance] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadWallet = useCallback(async () => {
    const { data } = await supabase.rpc('get_my_wallet')
    setTokenBalance(data?.balance ?? null)
  }, [supabase])

  useEffect(() => {
    loadWallet()
  }, [loadWallet])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handlePickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setError('Ukuran gambar maksimal 5 MB.')
      return
    }
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  const handleSend = async () => {
    if (!input.trim() && !imageFile) return
    if (tokenBalance !== null && tokenBalance <= 0) {
      setError('Token habis. Upgrade Premium atau tunggu reset besok.')
      return
    }
    setError(null)
    setSending(true)

    let imageUrl: string | null = null
    if (imageFile) {
      const { data: userRes } = await supabase.auth.getUser()
      const path = `${userRes.user?.id}/${Date.now()}-${imageFile.name}`
      const { error: uploadErr } = await supabase.storage
        .from('chart-images')
        .upload(path, imageFile)
      if (uploadErr) {
        setError('Gagal upload gambar: ' + uploadErr.message)
        setSending(false)
        return
      }
      const { data: publicUrl } = supabase.storage.from('chart-images').getPublicUrl(path)
      imageUrl = publicUrl.publicUrl
    }

    const userMsg: ChatMessage = {
      id: 'local-' + Date.now(),
      role: 'user',
      content: input || null,
      image_url: imageUrl,
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setImageFile(null)
    setImagePreview(null)

    const { data, error: fnError } = await supabase.functions.invoke('chat-asisten-ai', {
      body: { thread_id: threadId, message: userMsg.content ?? 'Tolong analisa gambar ini', image_url: imageUrl },
    })

    setSending(false)

    if (fnError || data?.error) {
      const msg = data?.error ?? fnError?.message ?? 'Gagal mengirim pesan.'
      if (msg === 'INSUFFICIENT_TOKENS') {
        setError('Token habis. Upgrade Premium atau tunggu reset besok.')
      } else {
        setError(msg)
      }
      return
    }

    setThreadId(data.thread_id)
    setMessages((prev) => [
      ...prev,
      { id: 'local-' + Date.now() + '-r', role: 'assistant', content: data.reply, image_url: null },
    ])
    if (typeof data.token_balance === 'number') setTokenBalance(data.token_balance)
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white flex flex-col max-w-[480px] mx-auto lg:max-w-2xl">
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 sticky top-0 bg-[#0F172A]/95 backdrop-blur z-10">
        <Link href="/" className="text-sm text-slate-400">
          ‹ Kembali
        </Link>
        <p className="text-sm font-semibold">Asisten AI</p>
        <span className="text-xs text-slate-400">
          {tokenBalance !== null ? `${tokenBalance} token` : ''}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-28">
        {messages.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-10">
            Tanya apa saja soal saham atau pasar atau kirim chart.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
              m.role === 'user'
                ? 'ml-auto bg-[#3B82F6] text-white'
                : 'mr-auto bg-white/5 border border-white/10 text-slate-100'
            }`}
          >
            {m.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.image_url} alt="chart" className="rounded-lg mb-2 max-h-48" />
            )}
            {m.content && <p className="whitespace-pre-wrap">{m.content}</p>}
          </div>
        ))}
        {sending && <p className="text-slate-500 text-xs">Asisten AI sedang mengetik...</p>}
        <div ref={bottomRef} />
      </div>

      <div className="fixed bottom-0 left-0 right-0 max-w-[480px] lg:max-w-2xl mx-auto bg-[#0F172A] border-t border-white/10 px-4 py-3 pb-[env(safe-area-inset-bottom)]">
        {error && <p className="text-[#EF4444] text-xs mb-2">{error}</p>}
        {imagePreview && (
          <div className="mb-2 relative w-16 h-16">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imagePreview} alt="preview" className="rounded-lg w-16 h-16 object-cover" />
            <button
              onClick={() => {
                setImageFile(null)
                setImagePreview(null)
              }}
              className="absolute -top-1 -right-1 bg-[#EF4444] rounded-full w-5 h-5 text-xs"
            >
              ×
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-white/5 border border-white/10 cursor-pointer">
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handlePickImage} className="hidden" />
            📎
          </label>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Tanya soal saham atau pasar..."
            className="flex-1 rounded-full bg-white/5 border border-white/10 px-4 py-2.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          />
          <button
            onClick={handleSend}
            disabled={sending}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full disabled:opacity-50"
            style={{
              backgroundImage:
                'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
            }}
          >
            ➤
          </button>
        </div>
      </div>
    </main>
  )
}
