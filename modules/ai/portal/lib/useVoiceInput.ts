// @ts-nocheck — portal deps resolve at build time.
//
// useVoiceInput — the reference mic-button hook
// (spec-ai-voice-transcription.md §3.4).
//
// Tap → record (MediaRecorder, speech bitrate) → tap → POST to
// /api/modules/ai/transcriptions → transcript handed to the caller to append into
// the draft. Cross-repo consumers vendor this file verbatim (the portal
// build cannot import across repos); the HTTP endpoint is the contract, so
// keep this boring: bearer token, multipart POST, JSON out.

import { useCallback, useEffect, useRef, useState } from 'react'

export function useVoiceInput({ useCase, token, apiUrl, onTranscript, maxSeconds = 120 }) {
  const [state, setState] = useState('idle') // idle | recording | uploading
  const [error, setError] = useState(null)
  const [seconds, setSeconds] = useState(0)
  const recRef = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)
  const abortRef = useRef(null)
  const tickRef = useRef(null)

  const supported = typeof window !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof window.MediaRecorder !== 'undefined'

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recRef.current = null
    chunksRef.current = []
    setSeconds(0)
  }, [])

  // Unmount safety: abort any in-flight upload, release the mic.
  useEffect(() => () => { abortRef.current?.abort(); cleanup() }, [cleanup])

  const stop = useCallback(() => {
    if (recRef.current?.state === 'recording') recRef.current.stop()
  }, [])

  const cancel = useCallback(() => {
    if (recRef.current) recRef.current.onstop = null
    try { recRef.current?.stop() } catch { /* already stopped */ }
    abortRef.current?.abort()
    cleanup()
    setState('idle')
  }, [cleanup])

  const start = useCallback(async () => {
    if (!supported || state !== 'idle') return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
      const rec = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 24_000,
      })
      recRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        cleanup()
        if (!blob.size) { setState('idle'); return }
        setState('uploading')
        const controller = new AbortController()
        abortRef.current = controller
        // The client end of the spec's 30 s abort chain.
        const uploadDeadline = setTimeout(() => controller.abort(), 30_000)
        try {
          const form = new FormData()
          form.append('audio', blob, 'audio')
          form.append('use_case', useCase)
          const lang = (navigator.language || '').slice(0, 2).toLowerCase()
          if (/^[a-z]{2}$/.test(lang)) form.append('language', lang)
          const res = await fetch(`${apiUrl ?? ''}/api/modules/ai/transcriptions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
            signal: controller.signal,
          })
          const body = await res.json().catch(() => null)
          if (!res.ok) throw new Error(body?.error?.message ?? 'Could not transcribe that.')
          const text = body?.data?.text?.trim()
          if (text) onTranscript(text)
        } catch (err) {
          if (err?.name !== 'AbortError') setError(err instanceof Error ? err.message : 'Could not transcribe that.')
        } finally {
          clearTimeout(uploadDeadline)
          setState('idle')
        }
      }
      rec.start()
      setState('recording')
      const startedAt = Date.now()
      tickRef.current = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000)
        setSeconds(s)
        if (s >= maxSeconds) stop()
      }, 500)
    } catch {
      setError('Microphone unavailable.')
      cleanup()
      setState('idle')
    }
  }, [supported, state, useCase, token, apiUrl, onTranscript, maxSeconds, cleanup, stop])

  return { state, seconds, error, supported, start, stop, cancel }
}
