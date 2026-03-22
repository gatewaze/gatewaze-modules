// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'

interface FormField {
  id: string
  type: string
  label: string
  placeholder?: string
  required?: boolean
  options?: string[]
}

interface FormData {
  id: string
  slug: string
  name: string
  description: string | null
  fields: FormField[]
  thank_you_message: string
  settings: Record<string, any>
}

export default function FormPage({ params, apiUrl }: { params: { slug: string }; apiUrl?: string }) {
  const [form, setForm] = useState<FormData | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [responses, setResponses] = useState<Record<string, any>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    async function loadForm() {
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
        const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
        if (!url || !key) return

        const { createClient } = await import('@supabase/supabase-js')
        const supabase = createClient(url, key)

        const { data, error } = await supabase
          .from('forms')
          .select('id, slug, name, description, fields, thank_you_message, settings')
          .eq('slug', params.slug)
          .eq('is_active', true)
          .single()

        if (!error && data) setForm(data)
      } catch (err) {
        console.error('[forms-portal] Failed to load form:', err)
      } finally {
        setLoading(false)
      }
    }

    loadForm()
  }, [params.slug])

  const validate = (): boolean => {
    if (!form) return false
    const newErrors: Record<string, string> = {}
    for (const field of form.fields) {
      if (field.required) {
        const value = responses[field.id]
        if (!value || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && !value.trim())) {
          newErrors[field.id] = `${field.label} is required`
        }
      }
      if (field.type === 'email' && responses[field.id]) {
        const emailVal = responses[field.id]
        if (typeof emailVal === 'string' && !emailVal.includes('@')) {
          newErrors[field.id] = 'Please enter a valid email address'
        }
      }
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form || !validate()) return

    try {
      setSubmitting(true)

      const baseApiUrl = apiUrl || process.env.NEXT_PUBLIC_API_URL || ''

      const res = await fetch(`${baseApiUrl}/api/modules/forms/${form.slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses, source: 'portal' }),
      })

      const result = await res.json()
      if (result.success) {
        setSubmitted(true)
      } else {
        alert(result.error || 'Submission failed. Please try again.')
      }
    } catch {
      alert('Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const updateResponse = (fieldId: string, value: any) => {
    setResponses(prev => ({ ...prev, [fieldId]: value }))
    if (errors[fieldId]) setErrors(prev => { const n = { ...prev }; delete n[fieldId]; return n })
  }

  const handleCheckboxChange = (fieldId: string, option: string, checked: boolean) => {
    const current = (responses[fieldId] as string[]) || []
    const next = checked ? [...current, option] : current.filter(v => v !== option)
    updateResponse(fieldId, next)
  }

  if (loading) {
    return (
      <main className="relative z-10">
        <div className="max-w-2xl mx-auto px-6 py-12">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-white/10 rounded w-1/3" />
            <div className="h-4 bg-white/10 rounded w-2/3" />
            <div className="space-y-3 mt-8">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-white/5 rounded" />)}
            </div>
          </div>
        </div>
      </main>
    )
  }

  if (!form) {
    return (
      <main className="relative z-10">
        <div className="max-w-2xl mx-auto px-6 py-12 text-center">
          <h1 className="text-2xl font-bold text-white">Form not found</h1>
          <p className="text-white/60 mt-2">This form may have been removed or is no longer active.</p>
        </div>
      </main>
    )
  }

  if (submitted) {
    return (
      <main className="relative z-10">
        <div className="max-w-2xl mx-auto px-6 py-12 text-center">
          <div className="bg-white/5 rounded-xl border border-white/10 p-8">
            <div className="text-4xl mb-4">&#10003;</div>
            <p className="text-lg text-white">{form.thank_you_message}</p>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="relative z-10">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="bg-white/5 rounded-xl border border-white/10 p-6 sm:p-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">{form.name}</h1>
          {form.description && (
            <p className="text-white/60 mb-6">{form.description}</p>
          )}

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {form.fields.map((field) => (
              <div key={field.id}>
                <label className="block text-sm font-medium text-white/80 mb-1.5">
                  {field.label}
                  {field.required && <span className="text-red-400 ml-1">*</span>}
                </label>

                {field.type === 'textarea' ? (
                  <textarea
                    value={responses[field.id] || ''}
                    onChange={(e) => updateResponse(field.id, e.target.value)}
                    placeholder={field.placeholder}
                    required={field.required}
                    rows={4}
                    className="w-full rounded-lg bg-white/10 border border-white/20 px-4 py-2.5 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 resize-y"
                  />
                ) : field.type === 'select' && field.options ? (
                  <select
                    value={responses[field.id] || ''}
                    onChange={(e) => updateResponse(field.id, e.target.value)}
                    required={field.required}
                    className="w-full rounded-lg bg-white/10 border border-white/20 px-4 py-2.5 text-white focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20"
                  >
                    <option value="">{field.placeholder || 'Select...'}</option>
                    {field.options.map((opt) => (
                      <option key={opt} value={opt} className="bg-gray-800">{opt}</option>
                    ))}
                  </select>
                ) : field.type === 'radio' && field.options ? (
                  <div className="space-y-2">
                    {field.options.map((opt) => (
                      <label key={opt} className="flex items-center gap-3 text-white/80 cursor-pointer">
                        <input
                          type="radio"
                          name={field.id}
                          value={opt}
                          checked={responses[field.id] === opt}
                          onChange={(e) => updateResponse(field.id, e.target.value)}
                          className="accent-white"
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                ) : field.type === 'checkbox' && field.options ? (
                  <div className="space-y-2">
                    {field.options.map((opt) => (
                      <label key={opt} className="flex items-center gap-3 text-white/80 cursor-pointer">
                        <input
                          type="checkbox"
                          value={opt}
                          checked={(responses[field.id] || []).includes(opt)}
                          onChange={(e) => handleCheckboxChange(field.id, opt, e.target.checked)}
                          className="accent-white"
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                ) : (
                  <input
                    type={field.type === 'phone' ? 'tel' : (['text', 'email', 'number', 'date', 'tel', 'url'].includes(field.type) ? field.type : 'text')}
                    value={responses[field.id] || ''}
                    onChange={(e) => updateResponse(field.id, e.target.value)}
                    placeholder={field.placeholder}
                    required={field.required}
                    className="w-full rounded-lg bg-white/10 border border-white/20 px-4 py-2.5 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20"
                  />
                )}

                {errors[field.id] && (
                  <p className="text-red-400 text-sm mt-1">{errors[field.id]}</p>
                )}
              </div>
            ))}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-6 rounded-lg bg-white text-black font-medium hover:bg-white/90 disabled:bg-white/50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Submitting...' : (form.settings?.submitButtonText || 'Submit')}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
