'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('App Error:', error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-[#0F172A]">
      <div className="max-w-sm w-full">
        <h2 className="text-xl font-bold text-red-400 mb-2">
          Terjadi Kesalahan
        </h2>
        <p className="text-sm text-slate-400 mb-6">
          {error.message || 'Maaf, ada masalah teknis. Coba muat ulang halaman.'}
        </p>
        <button
          onClick={reset}
          className="w-full rounded-xl bg-[#3B82F6] px-4 py-3 text-sm font-semibold text-white hover:bg-blue-600 transition-colors"
        >
          Coba Lagi
        </button>
      </div>
    </div>
  )
}
