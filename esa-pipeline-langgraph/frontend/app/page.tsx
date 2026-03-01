'use client'

import { useState, useEffect, useCallback } from 'react'
import FileUpload from '@/components/FileUpload'
import PipelineStatus from '@/components/PipelineStatus'
import ClassificationReview from '@/components/ClassificationReview'
import AppendixOrder from '@/components/AppendixOrder'
import VerificationReport from '@/components/VerificationReport'
import QCResults from '@/components/QCResults'
import ExportPanel from '@/components/ExportPanel'
import { createProject, startPipeline, getPipelineStatus, createWebSocket } from '@/lib/api'

type Stage = 'setup' | 'upload' | 'running' | 'classification_review' | 'appendix_order' | 'verification_review' | 'qc_resolution' | 'final_signoff' | 'complete'

interface ProjectData {
  project_id: string
  project_address: string
  report_type: 'phase_1' | 'phase_2'
  client_name: string
}

export default function Home() {
  const [stage, setStage] = useState<Stage>('setup')
  const [project, setProject] = useState<ProjectData | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [pipelineState, setPipelineState] = useState<Record<string, unknown> | null>(null)
  const [ws, setWs] = useState<WebSocket | null>(null)

  // WebSocket connection
  useEffect(() => {
    if (!threadId) return

    const socket = createWebSocket(threadId)

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)
      console.log('WebSocket message:', data)

      if (data.type === 'status_update') {
        setPipelineState(prev => ({ ...prev, ...data }))

        // Update stage based on human input type
        if (data.awaiting_human_input) {
          switch (data.human_input_type) {
            case 'classification_review':
              setStage('classification_review')
              break
            case 'appendix_order':
              setStage('appendix_order')
              break
            case 'verification_review':
              setStage('verification_review')
              break
            case 'qc_resolution':
              setStage('qc_resolution')
              break
            case 'final_signoff':
              setStage('final_signoff')
              break
          }
        }
      } else if (data.type === 'pipeline_complete') {
        setStage('complete')
      } else if (data.type === 'pipeline_error') {
        console.error('Pipeline error:', data.error)
      }
    }

    socket.onerror = (error) => {
      console.error('WebSocket error:', error)
    }

    setWs(socket)

    return () => {
      socket.close()
    }
  }, [threadId])

  // Poll for status updates as backup
  useEffect(() => {
    if (!threadId || stage === 'complete') return

    const interval = setInterval(async () => {
      try {
        const status = await getPipelineStatus(threadId)
        if (status.state) {
          setPipelineState(prev => ({ ...prev, ...status.state }))
        }
      } catch (error) {
        console.error('Status poll error:', error)
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [threadId, stage])

  const handleProjectCreate = async (data: ProjectData) => {
    setProject(data)
    await createProject(data)
    setStage('upload')
  }

  const handleFilesUploaded = async () => {
    if (!project) return

    // Start the pipeline
    const result = await startPipeline(project)
    setThreadId(result.thread_id)
    setStage('running')
  }

  const handleHumanInputComplete = () => {
    setStage('running')
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white mb-2">
                ESA Report Assembly & QC
              </h1>
              <p className="text-gray-400">
                AI-powered document assembly and quality control for Environmental Site Assessments
              </p>
            </div>
            <a
              href="/demo"
              className="px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
            >
              Try AI Demo
            </a>
          </div>
        </header>

        {/* Progress indicator */}
        <div className="mb-8">
          <StageIndicator currentStage={stage} />
        </div>

        {/* Main content */}
        <div className="bg-gray-900 rounded-lg p-6 shadow-xl">
          {stage === 'setup' && (
            <ProjectSetup onSubmit={handleProjectCreate} />
          )}

          {stage === 'upload' && project && (
            <FileUpload
              projectId={project.project_id}
              onComplete={handleFilesUploaded}
            />
          )}

          {stage === 'running' && threadId && (
            <PipelineStatus
              threadId={threadId}
              state={pipelineState}
            />
          )}

          {stage === 'classification_review' && threadId && pipelineState && (
            <ClassificationReview
              threadId={threadId}
              documents={(pipelineState as Record<string, unknown>).human_input_data as { documents: Array<{ file_id: string; filename: string; classification: { category: string; section: string; confidence: number; reasoning: string } }> }}
              onComplete={handleHumanInputComplete}
            />
          )}

          {stage === 'appendix_order' && threadId && pipelineState && (
            <AppendixOrder
              threadId={threadId}
              appendices={(pipelineState as Record<string, { appendix_order: Array<{ file_id: string; filename: string; appendix_letter: string; section: string; page_count: number }> }>).human_input_data?.appendix_order || []}
              onComplete={handleHumanInputComplete}
            />
          )}

          {stage === 'verification_review' && threadId && pipelineState && (
            <VerificationReport
              report={(pipelineState as Record<string, unknown>).verification_report as Record<string, unknown> | null}
              onApprove={handleHumanInputComplete}
            />
          )}

          {stage === 'qc_resolution' && threadId && pipelineState && (
            <QCResults
              threadId={threadId}
              qcData={(pipelineState as Record<string, unknown>).human_input_data as { blocking_issues: Array<{ agent: string; severity: string; description: string; location: string; auto_fixable: boolean; suggested_fix: string }>; warnings: Array<{ agent: string; severity: string; description: string; location: string }> }}
              onComplete={handleHumanInputComplete}
            />
          )}

          {stage === 'final_signoff' && threadId && project && pipelineState && (
            <ExportPanel
              threadId={threadId}
              projectId={project.project_id}
              exportData={(pipelineState as Record<string, { export_files: Array<{ filename: string; size_mb: number; pages: number; path: string }> }>).human_input_data?.export_files || []}
              onComplete={handleHumanInputComplete}
            />
          )}

          {stage === 'complete' && project && (
            <div className="text-center py-12">
              <div className="text-green-400 text-6xl mb-4">✓</div>
              <h2 className="text-2xl font-bold text-white mb-2">Report Complete!</h2>
              <p className="text-gray-400 mb-6">
                Your ESA report has been assembled and QC&apos;d successfully.
              </p>
              <a
                href={`/projects/${project.project_id}/exports`}
                className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Download Reports
              </a>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

function StageIndicator({ currentStage }: { currentStage: Stage }) {
  const stages = [
    { id: 'setup', label: 'Setup' },
    { id: 'upload', label: 'Upload' },
    { id: 'running', label: 'Processing' },
    { id: 'verification_review', label: 'AI Verify' },
    { id: 'qc_resolution', label: 'QC' },
    { id: 'final_signoff', label: 'Sign-off' },
    { id: 'complete', label: 'Complete' },
  ]

  const currentIndex = stages.findIndex(s => s.id === currentStage)

  return (
    <div className="flex items-center justify-between">
      {stages.map((stage, index) => (
        <div key={stage.id} className="flex items-center">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              index < currentIndex
                ? 'bg-green-600 text-white'
                : index === currentIndex
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-400'
            }`}
          >
            {index < currentIndex ? '✓' : index + 1}
          </div>
          <span
            className={`ml-2 text-sm ${
              index <= currentIndex ? 'text-white' : 'text-gray-500'
            }`}
          >
            {stage.label}
          </span>
          {index < stages.length - 1 && (
            <div
              className={`w-12 h-0.5 mx-4 ${
                index < currentIndex ? 'bg-green-600' : 'bg-gray-700'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function ProjectSetup({ onSubmit }: { onSubmit: (data: ProjectData) => void }) {
  const [formData, setFormData] = useState<ProjectData>({
    project_id: '',
    project_address: '',
    report_type: 'phase_1',
    client_name: '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (formData.project_id && formData.project_address) {
      onSubmit(formData)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <h2 className="text-xl font-semibold text-white mb-4">Create New Project</h2>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Project ID *
        </label>
        <input
          type="text"
          value={formData.project_id}
          onChange={e => setFormData(prev => ({ ...prev, project_id: e.target.value }))}
          placeholder="e.g., 2024-001-ESA"
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Site Address *
        </label>
        <input
          type="text"
          value={formData.project_address}
          onChange={e => setFormData(prev => ({ ...prev, project_address: e.target.value }))}
          placeholder="e.g., 123 Main Street, City, State 12345"
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Report Type
        </label>
        <select
          value={formData.report_type}
          onChange={e => setFormData(prev => ({ ...prev, report_type: e.target.value as 'phase_1' | 'phase_2' }))}
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="phase_1">Phase I ESA</option>
          <option value="phase_2">Phase II ESA</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Client Name
        </label>
        <input
          type="text"
          value={formData.client_name}
          onChange={e => setFormData(prev => ({ ...prev, client_name: e.target.value }))}
          placeholder="e.g., ABC Corporation"
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      <button
        type="submit"
        className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
      >
        Create Project
      </button>
    </form>
  )
}
