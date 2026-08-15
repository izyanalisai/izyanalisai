'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import PlexusBackground from '@/components/PlexusBackground'

const SLIDES = [
  { title: 'Sinyal AI Cerdas', desc: 'Entry, target, dan stop loss yang jelas untuk setiap saham IDX.' },
  { title: 'Sector Rotation & Smart Money', desc: 'Pantau ke mana dana bergerak antar sektor secara real-time.' },
  { title: 'Analis Pasar IDX di Genggaman Anda', desc: 'Tanya apa saja soal saham, lengkap dengan analisa chart AI.' },
]

export default function OnboardingPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)

  const finish = () => {
    localStorage.setItem('izy_onboarding_done', '1')
    router.replace('/landing')
  }

  const next = () => {
    if (step === SLIDES.length - 1) finish()
    else setStep((s) => s + 1)
  }

  const slide = SLIDES[step]

  return (
    <main className="min-h-screen relative overflow-hidden text-white px-6 py-10 max-w-[480px] mx-auto flex flex-col">
      <div className="absolute inset-0 -z-10 animate-gradient-flow" />
      <PlexusBackground density="normal" />

      <div className="flex justify-end">
        <button onClick={finish} className="text-slate-400 text-sm">Lewati</button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <h1 className="text-2xl font-bold mb-3">{slide.title}</h1>
        <p className="text-slate-400 text-sm max-w-xs">{slide.desc}</p>
      </div>

      <div className="flex justify-center gap-2 mb-6">
        {SLIDES.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-[#8B5CF6]' : 'w-1.5 bg-white/20'}`}
          />
        ))}
      </div>

      <button
        onClick={next}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white"
        style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
      >
        {step === SLIDES.length - 1 ? 'Mulai' : 'Lanjut'}
      </button>
    </main>
  )
        }                                             }
