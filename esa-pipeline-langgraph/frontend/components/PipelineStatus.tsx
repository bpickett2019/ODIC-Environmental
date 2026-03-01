'use client'

import DecisionLog from './DecisionLog'

interface Decision {
  timestamp: string
  stage: string
  action: string
  tier: 'auto_approved' | 'audit_trail' | 'human_review'
  confidence?: number
  details?: Record<string, unknown>
}

interface PipelineStatusProps {
  threadId: string
  state: Record<string, unknown> | null
}

export default function PipelineStatus({ threadId, state }: PipelineStatusProps) {
  const currentStage = state?.stage as string || state?.current_stage as string || 'Starting...'
  const errors = state?.errors as string[] || []
  const decisions = (state?.decisions as Decision[]) || []

  const verificationReport = state?.verification_report as { auto_approved?: boolean; overall_confidence?: number; sections_found?: number; sections_missing?: number } | null

  const stages = [
    { id: 'ingest', label: 'Ingesting Files', icon: '📥' },
    { id: 'classify', label: 'Classifying Documents', icon: '🏷️' },
    { id: 'structure', label: 'Building Structure', icon: '🏗️' },
    { id: 'assemble', label: 'Assembling Report', icon: '📋' },
    { id: 'verify', label: 'AI Verification', icon: '🤖' },
    { id: 'qc', label: 'Quality Control', icon: '✅' },
    { id: 'export', label: 'Exporting', icon: '📤' },
  ]

  const currentIndex = stages.findIndex(s => s.id === currentStage)

  return (
    <div className="space-y-8">
      <div className="text-center">
        <div className="inline-block animate-spin text-4xl mb-4">⚙️</div>
        <h2 className="text-xl font-semibold text-white">Processing Your Report</h2>
        <p className="text-gray-400 mt-2">Thread ID: {threadId}</p>
      </div>

      <div className="space-y-4">
        {stages.map((stage, index) => {
          const isComplete = index < currentIndex
          const isCurrent = index === currentIndex
          const isPending = index > currentIndex

          return (
            <div
              key={stage.id}
              className={'flex items-center space-x-4 p-4 rounded-lg ' +
                (isComplete ? 'bg-green-900/30' :
                 isCurrent ? 'bg-blue-900/30' : 'bg-gray-800/50')}
            >
              <div className={'w-10 h-10 rounded-full flex items-center justify-center ' +
                (isComplete ? 'bg-green-600' :
                 isCurrent ? 'bg-blue-600 animate-pulse' : 'bg-gray-700')}>
                {isComplete ? '✓' : stage.icon}
              </div>
              <div className="flex-1">
                <p className={'font-medium ' +
                  (isComplete ? 'text-green-400' :
                   isCurrent ? 'text-blue-400' : 'text-gray-500')}>
                  {stage.label}
                </p>
                {isCurrent && (
                  <p className="text-sm text-gray-400">In progress...</p>
                )}
              </div>
              {isComplete && (
                <span className="text-green-400">Complete</span>
              )}
              {isCurrent && (
                <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          )
        })}
      </div>

      {/* Verification Summary */}
      {verificationReport && (
        <div className={`rounded-lg p-4 ${verificationReport.auto_approved ? 'bg-green-900/30 border border-green-700' : 'bg-yellow-900/30 border border-yellow-700'}`}>
          <h3 className={`font-medium mb-2 ${verificationReport.auto_approved ? 'text-green-400' : 'text-yellow-400'}`}>
            {verificationReport.auto_approved ? '✅ AI Auto-Approved' : '⚠️ Review Recommended'}
          </h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-gray-400">Confidence:</span>
              <span className="ml-2 text-white font-medium">
                {verificationReport.overall_confidence ? Math.round(verificationReport.overall_confidence * 100) : 0}%
              </span>
            </div>
            <div>
              <span className="text-gray-400">Sections Found:</span>
              <span className="ml-2 text-green-400 font-medium">{verificationReport.sections_found || 0}</span>
            </div>
            <div>
              <span className="text-gray-400">Missing:</span>
              <span className="ml-2 text-red-400 font-medium">{verificationReport.sections_missing || 0}</span>
            </div>
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4">
          <h3 className="text-red-400 font-medium mb-2">Errors</h3>
          <ul className="space-y-1">
            {errors.map((error, i) => (
              <li key={i} className="text-sm text-red-300">• {error}</li>
            ))}
          </ul>
        </div>
      )}

      {/* AI Decision Log */}
      {decisions.length > 0 && (
        <div className="mt-6">
          <DecisionLog decisions={decisions} expandable={true} />
        </div>
      )}
    </div>
  )
}
