// @ts-nocheck
'use client'

import { useState, useEffect } from 'react'

interface Props {
  targetDate: string
  primaryColor: string
}

function calcTimeLeft(target: string) {
  const diff = new Date(target).getTime() - Date.now()
  if (diff <= 0) return null
  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  }
}

export default function CountdownTimer({ targetDate, primaryColor }: Props) {
  const [timeLeft, setTimeLeft] = useState(calcTimeLeft(targetDate))
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    setTimeLeft(calcTimeLeft(targetDate))

    const interval = setInterval(() => {
      const remaining = calcTimeLeft(targetDate)
      setTimeLeft(remaining)
      if (!remaining) clearInterval(interval)
    }, 1000)

    return () => clearInterval(interval)
  }, [targetDate])

  if (!mounted) {
    return <div className="flex justify-center gap-4 py-8"><div className="h-24 w-20" /></div>
  }

  if (!timeLeft) {
    return (
      <div className="text-center py-8">
        <p className="text-2xl font-bold text-gray-900 animate-pulse">Starting soon...</p>
      </div>
    )
  }

  const units = [
    { value: timeLeft.days, label: 'days' },
    { value: timeLeft.hours, label: 'hrs' },
    { value: timeLeft.minutes, label: 'min' },
    { value: timeLeft.seconds, label: 'sec' },
  ]

  return (
    <div className="flex justify-center gap-3 sm:gap-4">
      {units.map(({ value, label }) => (
        <div
          key={label}
          className="flex flex-col items-center justify-center w-20 h-24 sm:w-24 sm:h-28 rounded-xl border-2 border-gray-200 bg-white"
          style={{ borderTopColor: primaryColor }}
        >
          <span className="text-3xl sm:text-4xl font-bold text-gray-900 tabular-nums">
            {String(value).padStart(2, '0')}
          </span>
          <span className="text-xs sm:text-sm text-gray-500 uppercase tracking-wide mt-1">
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}
