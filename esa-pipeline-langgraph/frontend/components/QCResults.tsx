'use client'

import { useState } from 'react'
import { submitQCResolution } from '@/lib/api'

interface QCIssue {
  agent: string
  severity: string
  description: string
  location: string
  auto_fixable?: boolean
  suggested_fix?: string
}

interface QCResultsProps {
  threadId: string
  qcData: {
    blocking_issues: QCIssue[]
    warnings: QCIssue[]
  }
  onComplete: () => void
}

export default function QCResults({ threadId, qcData, onComplete }: QCResultsProps) {
  const [selectedFixes, setSelectedFixes] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const blockingIssues = qcData?.blocking_issues || []
  const warnings = qcData?.warnings || []

  const toggleFix = (description: string) => {
    setSelectedFixes(prev => {
      const next = new Set(prev)
      if (next.has(description)) {
        next.delete(description)
      } else {
        next.add(description)
      }
      return next
    })
  }

  const handleAutoFix = async () => {
    setSubmitting(true)
    try {
      await submitQCResolution(threadId, {
        auto_fix: true,
        fixes_to_apply: Array.from(selectedFixes)
      })
      onComplete()
    } catch (error) {
      console.error('Auto-fix failed:', error)
      alert('Failed to apply fixes')
    } finally {
      setSubmitting(false)
    }
  }

  const handleApproveWithIssues = async () => {
    if (!confirm('Are you sure you want to approve the report with unresolved issues?')) return

    setSubmitting(true)
    try {
      await submitQCResolution(threadId, { approve_with_issues: true })
      onComplete()
    } catch (error) {
      console.error('Approval failed:', error)
      alert('Failed to approve')
    } finally {
      setSubmitting(false)
    }
  }

  const getSeverityStyle = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-900/50 border-red-700 text-red-300'
      case 'warning': return 'bg-yellow-900/50 border-yellow-700 text-yellow-300'
      default: return 'bg-blue-900/50 border-blue-700 text-blue-300'
    }
  }

  const getAgentIcon = (agent: string) => {
    switch (agent) {
      case 'completeness': return '📋'
      case 'cross_contamination': return '⚠️'
      case 'structure': return '🏗️'
      case 'content_integrity': return '📝'
      case 'format': return '🎨'
      default: return '🔍'
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Quality Control Results</h2>
        <p className="text-gray-400 mt-1">
          Review QC findings and decide how to proceed.
        </p>
      </div>

      {blockingIssues.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-lg font-medium text-red-400">
            Blocking Issues ({blockingIssues.length})
          </h3>
          {blockingIssues.map((issue, index) => (
            <div
              key={index}
              className={'p-4 rounded-lg border ' + getSeverityStyle(issue.severity)}
            >
              <div className="flex items-start space-x-3">
                <span className="text-2xl">{getAgentIcon(issue.agent)}</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{issue.description}</p>
                    {issue.auto_fixable && (
                      <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedFixes.has(issue.description)}
                          onChange={() => toggleFix(issue.description)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-sm">Auto-fix</span>
                      </label>
                    )}
                  </div>
                  <p className="text-sm opacity-75 mt-1">
                    {issue.agent.replace(/_/g, ' ')} • {issue.location}
                  </p>
                  {issue.suggested_fix && (
                    <p className="text-sm mt-2 opacity-75">
                      💡 {issue.suggested_fix}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-lg font-medium text-yellow-400">
            Warnings ({warnings.length})
          </h3>
          {warnings.map((issue, index) => (
            <div
              key={index}
              className={'p-4 rounded-lg border ' + getSeverityStyle(issue.severity)}
            >
              <div className="flex items-start space-x-3">
                <span className="text-2xl">{getAgentIcon(issue.agent)}</span>
                <div className="flex-1">
                  <p className="font-medium">{issue.description}</p>
                  <p className="text-sm opacity-75 mt-1">
                    {issue.agent.replace(/_/g, ' ')} • {issue.location}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {blockingIssues.length === 0 && warnings.length === 0 && (
        <div className="text-center py-8">
          <div className="text-4xl mb-4">✅</div>
          <p className="text-green-400 font-medium">All QC checks passed!</p>
        </div>
      )}

      <div className="flex justify-end space-x-4 pt-4 border-t border-gray-700">
        {selectedFixes.size > 0 && (
          <button
            onClick={handleAutoFix}
            disabled={submitting}
            className="px-6 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? 'Applying...' : `Apply ${selectedFixes.size} Fix(es)`}
          </button>
        )}
        <button
          onClick={handleApproveWithIssues}
          disabled={submitting}
          className="px-6 py-2 bg-yellow-600 text-white rounded-lg font-medium hover:bg-yellow-700 disabled:opacity-50"
        >
          {submitting ? 'Processing...' : 'Approve with Issues'}
        </button>
      </div>
    </div>
  )
}
