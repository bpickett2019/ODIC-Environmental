'use client'

import { useState } from 'react'
import { submitFinalSignoff, getExportUrl } from '@/lib/api'

interface ExportFile {
  filename: string
  size_mb: number
  pages: number
  path: string
}

interface ExportPanelProps {
  threadId: string
  projectId: string
  exportData: ExportFile[]
  onComplete: () => void
}

export default function ExportPanel({ threadId, projectId, exportData, onComplete }: ExportPanelProps) {
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleApprove = async () => {
    setSubmitting(true)
    try {
      await submitFinalSignoff(threadId, true, notes)
      onComplete()
    } catch (error) {
      console.error('Approval failed:', error)
      alert('Failed to approve')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    if (!notes.trim()) {
      alert('Please provide a reason for rejection')
      return
    }

    setSubmitting(true)
    try {
      await submitFinalSignoff(threadId, false, notes)
      onComplete()
    } catch (error) {
      console.error('Rejection failed:', error)
      alert('Failed to reject')
    } finally {
      setSubmitting(false)
    }
  }

  const totalPages = exportData.reduce((sum, f) => sum + f.pages, 0)
  const totalSize = exportData.reduce((sum, f) => sum + f.size_mb, 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Final Sign-off</h2>
        <p className="text-gray-400 mt-1">
          Review the exported files and approve for delivery.
        </p>
      </div>

      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-medium text-white mb-4">Export Summary</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center p-3 bg-gray-700 rounded-lg">
            <p className="text-2xl font-bold text-blue-400">{exportData.length}</p>
            <p className="text-sm text-gray-400">File(s)</p>
          </div>
          <div className="text-center p-3 bg-gray-700 rounded-lg">
            <p className="text-2xl font-bold text-green-400">{totalPages}</p>
            <p className="text-sm text-gray-400">Total Pages</p>
          </div>
          <div className="text-center p-3 bg-gray-700 rounded-lg">
            <p className="text-2xl font-bold text-purple-400">{totalSize.toFixed(1)} MB</p>
            <p className="text-sm text-gray-400">Total Size</p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-lg font-medium text-white">Exported Files</h3>
        {exportData.map((file, index) => (
          <div
            key={index}
            className="flex items-center justify-between p-4 bg-gray-800 rounded-lg"
          >
            <div className="flex items-center space-x-4">
              <div className="text-3xl">📄</div>
              <div>
                <p className="font-medium text-white">{file.filename}</p>
                <p className="text-sm text-gray-400">
                  {file.pages} pages • {file.size_mb.toFixed(1)} MB
                </p>
              </div>
            </div>
            <a
              href={getExportUrl(projectId, file.filename)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Download
            </a>
          </div>
        ))}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Notes (optional for approval, required for rejection)
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Add any notes or feedback..."
          rows={3}
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white resize-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="flex justify-end space-x-4 pt-4 border-t border-gray-700">
        <button
          onClick={handleReject}
          disabled={submitting}
          className="px-6 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={handleApprove}
          disabled={submitting}
          className="px-6 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
        >
          {submitting ? 'Processing...' : 'Approve & Deliver'}
        </button>
      </div>
    </div>
  )
}
