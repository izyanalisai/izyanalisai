'use client'

import Link from 'next/link'

export default function DukunganPage() {
  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto pb-16">
      <h1 className="text-xl font-bold mb-1">Dukungan</h1>
      <p className="text-slate-400 text-sm mb-6">
        Ada kendala pemakaian, pembayaran, atau pertanyaan lain? Tim kami siap bantu.
      </p>

      <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5 overflow-hidden mb-6">
        <a
          href="https://wa.me/6285178268451"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200"
        >
          <span>Chat via WhatsApp</span>
          <span className="text-slate-600 text-xs">›</span>
        </a>
        <a
          href="https://t.me/komunitassahamizy"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200"
        >
          <span>Gabung Komunitas Telegram</span>
          <span className="text-slate-600 text-xs">›</span>
        </a>
        <Link
          href="/laporkan-bug"
          className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200"
        >
          <span>Laporkan Bug</span>
          <span className="text-slate-600 text-xs">›</span>
        </Link>
        <Link
          href="/ajukan-fitur"
          className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200"
        >
          <span>Ajukan Fitur</span>
          <span className="text-slate-600 text-xs">›</span>
        </Link>
      </div>

      <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-4">
        <p className="text-sm font-semibold mb-2">Pertanyaan Umum</p>
        <div className="space-y-3 text-xs text-slate-300">
          <div>
            <p className="font-medium text-slate-200">Kenapa Kartu Sinyal saya terkunci?</p>
            <p>Buka pakai 1 token, atau tonton iklan (maks 3 kali/hari), atau upgrade Premium.</p>
          </div>
          <div>
            <p className="font-medium text-slate-200">Token kapan reset?</p>
            <p>Token direset otomatis setiap pergantian hari, mengikuti waktu WIB.</p>
          </div>
          <div>
            <p className="font-medium text-slate-200">Bagaimana cara hapus akun?</p>
            <p>
              Lewat menu Profil →{' '}
              <Link href="/hapus-akun" className="text-[#3B82F6] underline">
                Hapus Akun
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
