'use client'

import { useState } from 'react'
import Link from 'next/link'

type SectionKey =
  | 'terms'
  | 'privacy'
  | 'dyor'
  | 'sumber-data'
  | 'cara-kerja-ai'
  | 'regulasi'
  | 'hak-data'

const SECTIONS: { key: SectionKey; title: string }[] = [
  { key: 'terms', title: 'Terms of Use' },
  { key: 'privacy', title: 'Privacy Policy' },
  { key: 'dyor', title: 'DYOR & Disclaimer Risiko' },
  { key: 'sumber-data', title: 'Sumber Data' },
  { key: 'cara-kerja-ai', title: 'Cara Kerja AI dan Sinyal' },
  { key: 'regulasi', title: 'Informasi Regulasi' },
  { key: 'hak-data', title: 'Hak Atas Data Kamu' },
]

function SectionBody({ section }: { section: SectionKey }) {
  switch (section) {
    case 'terms':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            Dengan menggunakan IzyAnalisAi, kamu setuju memakai aplikasi ini untuk tujuan
            analisa dan edukasi pasar saham, bukan sebagai nasihat investasi resmi.
          </p>
          <p>
            Kamu bertanggung jawab penuh atas keputusan trading yang kamu ambil. IzyAnalisAi
            tidak menjamin profit dan tidak bertanggung jawab atas kerugian finansial akibat
            penggunaan sinyal, analisa AI, atau data di aplikasi ini.
          </p>
          <p>
            Akun bersifat personal, tidak boleh dipindahtangankan. Penyalahgunaan sistem token,
            iklan, atau pembayaran dapat menyebabkan akun ditangguhkan.
          </p>
        </div>
      )
    case 'privacy':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            Kami menyimpan data akun (nama, email), preferensi (profil risiko, watchlist),
            riwayat interaksi AI, dan data transaksi (token, langganan) untuk menjalankan
            fitur aplikasi. Dasar pemrosesan data ini adalah persetujuan kamu saat mendaftar
            dan kebutuhan pelaksanaan layanan, sesuai UU No. 27 Tahun 2022 tentang
            Pelindungan Data Pribadi (UU PDP).
          </p>
          <p>
            Data tidak dijual ke pihak ketiga. Data dibagikan hanya ke penyedia layanan yang
            memang dibutuhkan untuk operasional: penyedia AI (OpenRouter), payment gateway
            (Midtrans), dan layanan iklan (Google AdMob).
          </p>
          <p>Data disimpan selama akun aktif, dan dihapus mengikuti kebijakan Hapus Akun.</p>
          <p>
            Sesuai UU PDP, kamu berhak: mengakses dan mendapat salinan data pribadimu,
            meminta koreksi data yang tidak akurat, meminta penghapusan atau pemusnahan data,
            menarik persetujuan pemrosesan data, dan mengajukan keberatan atas pemrosesan
            tertentu. Untuk menggunakan hak-hak ini, hubungi kami lewat menu Dukungan di
            Profil.
          </p>
        </div>
      )
    case 'dyor':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            <strong>DYOR — Do Your Own Research.</strong> Sinyal AI (BUY/SELL/HOLD), Entry,
            Target, dan Stop Loss dihasilkan dari perhitungan sistem berbasis data historis.
            Ini <strong>bukan jaminan profit</strong> dan bukan rekomendasi investasi resmi.
          </p>
          <p>
            Perdagangan saham memiliki risiko kerugian. Win Rate dan performa masa lalu tidak
            menjamin hasil yang sama di masa depan. Selalu lakukan riset mandiri dan
            pertimbangkan profil risiko kamu sendiri sebelum mengambil keputusan.
          </p>
        </div>
      )
    case 'sumber-data':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            Data harga dan volume saham bersumber dari penyedia data pasar pihak ketiga
            (dengan cache dan mekanisme fallback), bukan real-time 24 jam — mengikuti jadwal
            sesi perdagangan Bursa Efek Indonesia.
          </p>
          <p>
            Data fundamental, kalender laba, dan kalender IPO diperbarui secara berkala dari
            sumber publik. Berita diringkas otomatis dari sumber media yang tersedia.
          </p>
        </div>
      )
    case 'cara-kerja-ai':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            Angka pada Kartu Sinyal (Buy Area, TP1, TP2, Stop Loss, Risk-Reward, Win Rate,
            Confidence) <strong>selalu dihitung oleh sistem/engine</strong> berdasarkan
            indikator teknikal dan data historis — bukan dikarang oleh AI.
          </p>
          <p>
            AI hanya bertugas menjelaskan alasan (reasoning) di balik angka yang sudah
            dihitung sistem, dan membantu membaca chart yang kamu upload. AI tidak pernah
            mengubah atau menentukan sendiri angka trading.
          </p>
        </div>
      )
    case 'regulasi':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            IzyAnalisAi adalah platform analisa dan edukasi, <strong>bukan</strong> perusahaan
            sekuritas, manajer investasi, penasihat investasi, atau pihak lain yang memiliki
            izin dari Otoritas Jasa Keuangan (OJK) untuk memberikan nasihat atau rekomendasi
            investasi.
          </p>
          <p>
            Sinyal BUY/SELL/HOLD, Entry, Target, dan Stop Loss yang ditampilkan adalah hasil
            perhitungan sistem berbasis data historis untuk tujuan analisa dan edukasi, dan{' '}
            <strong>bukan ajakan, penawaran, atau rekomendasi resmi</strong> untuk membeli
            atau menjual efek tertentu.
          </p>
          <p>
            Aplikasi ini tidak mengeksekusi transaksi jual-beli saham. Eksekusi transaksi
            tetap dilakukan lewat aplikasi sekuritas resmi berizin OJK milik kamu sendiri.
          </p>
        </div>
      )
    case 'hak-data':
      return (
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>Kamu berhak untuk:</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>Melihat data akun kamu lewat halaman Profil.</li>
            <li>Meminta salinan (unduhan) data kamu dengan menghubungi Dukungan.</li>
            <li>
              Menghapus akun beserta datanya lewat{' '}
              <Link href="/hapus-akun" className="text-[#3B82F6] underline">
                halaman Hapus Akun
              </Link>
              .
            </li>
          </ul>
        </div>
      )
  }
}

export default function LegalPage() {
  const [open, setOpen] = useState<SectionKey>('dyor')

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto pb-16">
      <h1 className="text-xl font-bold mb-1">Legal</h1>
      <p className="text-slate-400 text-sm mb-6">
        Ketentuan penggunaan, privasi, dan penjelasan cara kerja IzyAnalisAi.
      </p>

      <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5 overflow-hidden">
        {SECTIONS.map((s) => (
          <div key={s.key}>
            <button
              onClick={() => setOpen(open === s.key ? ('' as SectionKey) : s.key)}
              className="w-full flex items-center justify-between px-4 py-3.5 text-sm font-medium text-slate-200"
            >
              <span>{s.title}</span>
              <span className="text-slate-600 text-xs">{open === s.key ? '−' : '+'}</span>
            </button>
            {open === s.key && (
              <div className="px-4 pb-4">
                <SectionBody section={s.key} />
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  )
}
