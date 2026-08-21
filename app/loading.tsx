export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0F172A]">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-[#3B82F6]" />
        <p className="text-xs text-slate-500">Memuat...</p>
      </div>
    </div>
  )
}
