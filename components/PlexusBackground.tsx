'use client'

import { useEffect, useRef } from 'react'

type Density = 'subtle' | 'normal'

const PALETTE = ['#3B82F6', '#8B5CF6', '#EC4899', '#F43F5E']

type Node = { x: number; y: number; vx: number; vy: number; r: number; color: string }

const CONFIG: Record<Density, { count: number; maxDist: number; nodeOpacity: number; lineOpacity: number; speed: number }> = {
  subtle: { count: 26, maxDist: 130, nodeOpacity: 0.35, lineOpacity: 0.12, speed: 0.12 },
  normal: { count: 42, maxDist: 150, nodeOpacity: 0.55, lineOpacity: 0.22, speed: 0.18 },
}

function hexToRgb(hex: string) {
  const v = parseInt(hex.slice(1), 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

export default function PlexusBackground({ density = 'normal' }: { density?: Density }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cfg = CONFIG[density]
    const parent = canvas.parentElement
    let width = 0
    let height = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let nodes: Node[] = []
    let rafId = 0
    let running = true

    const rgbCache = PALETTE.map(hexToRgb)

    function resize() {
      if (!parent || !canvas || !ctx) return
      width = parent.clientWidth
      height = parent.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function makeNodes() {
      const area = Math.max(width * height, 1)
      const count = Math.max(10, Math.min(cfg.count, Math.round((area / (480 * 800)) * cfg.count)))
      nodes = Array.from({ length: count }, () => {
        const color = rgbCache[Math.floor(Math.random() * rgbCache.length)]
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * cfg.speed,
          vy: (Math.random() - 0.5) * cfg.speed,
          r: 1 + Math.random() * 1.6,
          color: `${color.r},${color.g},${color.b}`,
        }
      })
    }

    function drawFrame() {
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < cfg.maxDist) {
            const alpha = (1 - dist / cfg.maxDist) * cfg.lineOpacity
            ctx.strokeStyle = `rgba(${a.color},${alpha})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      for (const n of nodes) {
        ctx.beginPath()
        ctx.fillStyle = `rgba(${n.color},${cfg.nodeOpacity})`
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    function step() {
      if (!running) return
      for (const n of nodes) {
        n.x += n.vx
        n.y += n.vy
        if (n.x <= 0 || n.x >= width) n.vx *= -1
        if (n.y <= 0 || n.y >= height) n.vy *= -1
      }
      drawFrame()
      rafId = requestAnimationFrame(step)
    }

    resize()
    makeNodes()
    drawFrame()

    if (!reduceMotion) {
      rafId = requestAnimationFrame(step)
    }

    const handleResize = () => {
      resize()
      makeNodes()
      drawFrame()
    }
    window.addEventListener('resize', handleResize)

    const handleVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(rafId)
      } else if (!reduceMotion) {
        running = true
        rafId = requestAnimationFrame(step)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      running = false
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [density])

  return <canvas ref={canvasRef} className="absolute inset-0 -z-10 pointer-events-none" aria-hidden="true" />
}
