'use client'

import { useState } from 'react'
import { submitClassificationReview } from '@/lib/api'

interface Document {
  file_id: string
  filename: string
  classification: {
    category: string
    section: string
    confidence: number
    reasoning: string
  }
}

interface ClassificationReviewProps {
  threadId: string
  documents: { documents: Document[] }
  onComplete: () => void
}

const CATEGORIES = [
  { value: 'main_body', label: 'Main Report Body' },
  { value: 'appendix', label: 'Appendix' },
  { value: 'supporting_record', label: 'Supporting Record' },
  { value: 'excluded', label: 'Excluded' },
]

const SECTIONS = {
  main_body: [
    'executive_summary', 'introduction', 'site_description', 'environmental_setting',
    'historical_use', 'regulatory_database_review', 'findings_conclusions_recommendations', 'qualifications'
  ],
  appendix: [
    'appendix_a_site_plans_maps', 'appendix_b_site_photographs', 'appendix_c_historical_sources',
    'appendix_d_regulatory_records', 'appendix_e_edr_report', 'appendix_f_qualifications', 'appendix_other'
  ],
  supporting_record: [
    'previous_phase1_other_firm', 'previous_phase2_other_firm', 'historical_report', 'third_party_assessment'
  ],
  excluded: ['duplicate', 'draft', 'internal_notes', 'irrelevant', 'unknown']
}

export default function ClassificationReview({ threadId, documents, onComplete }: ClassificationReviewProps) {
  const [decisions, setDecisions] = useState<Record<string, { category: string; section: string }>>({})
  const [submitting, setSubmitting] = useState(false)

  const docs = documents?.documents || []

  const updateDecision = (fileId: string, field: 'category' | 'section', value: string) => {
    setDecisions(prev => ({
      ...prev,
      [fileId]: {
        ...prev[fileId],
        [field]: value,
        ...(field === 'category' ? { section: SECTIONS[value as keyof typeof SECTIONS]?.[0] || '' } : {})
      }
    }))
  }

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 0.85) return { color: 'bg-green-600', label: 'High' }
    if (confidence >= 0.6) return { color: 'bg-yellow-600', label: 'Medium' }
    return { color: 'bg-red-600', label: 'Low' }
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const reviewDecisions = docs.map(doc => ({
        file_id: doc.file_id,
        category: decisions[doc.file_id]?.category || doc.classification.category,
        section: decisions[doc.file_id]?.section || doc.classification.section,
        reason: 'Human reviewed'
      }))
      await submitClassificationReview(threadId, reviewDecisions)
      onComplete()
    } catch (error) {
      console.error('Submit failed:', error)
      alert('Failed to submit review')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Review Classifications</h2>
        <p className="text-gray-400 mt-1">
          Review and correct AI-suggested classifications. Documents with low confidence are highlighted.
        </p>
      </div>

      <div className="space-y-4">
        {docs.map(doc => {
          const badge = getConfidenceBadge(doc.classification.confidence)
          const currentCategory = decisions[doc.file_id]?.category || doc.classification.category
          const currentSection = decisions[doc.file_id]?.section || doc.classification.section

          return (
            <div key={doc.file_id} className="bg-gray-800 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-white">{doc.filename}</p>
                  <p className="text-sm text-gray-400 mt-1">{doc.classification.reasoning}</p>
                </div>
                <span className={'px-2 py-1 rounded text-xs font-medium ' + badge.color}>
                  {badge.label} ({Math.round(doc.classification.confidence * 100)}%)
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Category</label>
                  <select
                    value={currentCategory}
                    onChange={e => updateDecision(doc.file_id, 'category', e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                  >
                    {CATEGORIES.map(cat => (
                      <option key={cat.value} value={cat.value}>{cat.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Section</label>
                  <select
                    value={currentSection}
                    onChange={e => updateDecision(doc.file_id, 'section', e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                  >
                    {(SECTIONS[currentCategory as keyof typeof SECTIONS] || []).map(sec => (
                      <option key={sec} value={sec}>{sec.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end space-x-4">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting...' : 'Confirm Classifications'}
        </button>
      </div>
    </div>
  )
}
