'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import AIThinkingPanel, { useThinkingLines } from '@/components/AIThinkingPanel'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Stage = 'setup' | 'upload' | 'ingest' | 'classify' | 'qc' | 'complete'

interface Classification {
  section: string
  confidence: number
  observations: string[]
  entities_found: Record<string, string>
  flags: string[]
  page_start: number
  page_end: number
}

interface PDFManifest {
  filename: string
  total_pages: number
  file_size_bytes: number
  total_words: number
  processing_time_ms: number
}

interface PageReconciliation {
  source_pdf_pages: number
  classified_pages: number
  unclassified_pages: number
  coverage_percent: number
}

export default function DemoPage() {
  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('ESA-2024-001')
  const [projectAddress, setProjectAddress] = useState('123 Industrial Way, Springfield, IL 62701')
  const [company, setCompany] = useState('ODIC Environmental')

  // Processing state
  const [currentStage, setCurrentStage] = useState<Stage>('setup')
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Results state
  const [pdfManifest, setPdfManifest] = useState<PDFManifest | null>(null)
  const [classifications, setClassifications] = useState<Classification[]>([])
  const [contaminationResult, setContaminationResult] = useState<Record<string, unknown> | null>(null)
  const [qcSummary, setQcSummary] = useState<Record<string, unknown> | null>(null)
  const [reconciliation, setReconciliation] = useState<PageReconciliation | null>(null)

  // AI Thinking panel state
  const { lines, addThinkingToken, addEvent, clear: clearLines } = useThinkingLines()

  // File input ref
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null)

  // Create session
  const createSession = async () => {
    try {
      const res = await fetch(`${API_BASE}/demo/session/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          project_address: projectAddress,
          company
        })
      })
      const data = await res.json()
      setSessionId(data.session_id)
      setCurrentStage('upload')
      return data.session_id
    } catch (e) {
      setError(`Failed to create session: ${e}`)
      return null
    }
  }

  // Upload file
  const uploadFile = async (file: File, sid: string) => {
    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch(`${API_BASE}/demo/session/${sid}/upload`, {
        method: 'POST',
        body: formData
      })
      const data = await res.json()
      return data
    } catch (e) {
      setError(`Failed to upload file: ${e}`)
      return null
    }
  }

  // Connect WebSocket and start processing
  const startProcessing = async () => {
    if (!selectedFile) {
      setError('Please select a PDF file')
      return
    }

    setIsProcessing(true)
    setError(null)
    clearLines()
    setClassifications([])
    setContaminationResult(null)
    setQcSummary(null)

    // Create session
    const sid = await createSession()
    if (!sid) return

    // Upload file
    addEvent('thinking', 'ingest', 'Uploading PDF file...\n')
    const uploadResult = await uploadFile(selectedFile, sid)
    if (!uploadResult) return

    addEvent('thinking', 'ingest', `Uploaded: ${uploadResult.filename} (${Math.round(uploadResult.size_bytes / 1024)}KB)\n\n`)

    // Connect WebSocket
    const wsUrl = API_BASE.replace('http', 'ws')
    const ws = new WebSocket(`${wsUrl}/demo/ws/${sid}`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected')
      // Start processing
      ws.send(JSON.stringify({ command: 'start_processing' }))
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      handleWebSocketMessage(data)
    }

    ws.onerror = (e) => {
      console.error('WebSocket error:', e)
      setError('WebSocket connection error')
      setIsProcessing(false)
    }

    ws.onclose = () => {
      console.log('WebSocket closed')
      setIsProcessing(false)
    }
  }

  // Handle WebSocket messages
  const handleWebSocketMessage = (data: Record<string, unknown>) => {
    const type = data.type as string

    switch (type) {
      case 'connected':
        console.log('Connected to session:', data.session_id)
        break

      case 'stage_start':
        setCurrentStage(data.stage as Stage)
        addEvent('thinking', data.stage as string, `\n--- ${(data.message as string).toUpperCase()} ---\n\n`)
        break

      case 'stage_complete':
        addEvent('complete', data.stage as string, `\n${data.message}\n`)
        break

      case 'pdf_progress':
        if (data.type === 'page') {
          // Show occasional page updates, not every single one
          const pageNum = data.page_number as number
          const totalPages = data.total_pages as number
          if (pageNum === 1 || pageNum === totalPages || pageNum % 10 === 0) {
            addEvent('thinking', 'ingest', `Extracting page ${pageNum}/${totalPages}...\n`)
          }
        } else if ((data as Record<string, unknown>).type === 'complete') {
          const manifestData = (data as Record<string, unknown>).data as Record<string, unknown>
          setPdfManifest({
            filename: selectedFile?.name || 'document.pdf',
            total_pages: manifestData.total_pages as number,
            file_size_bytes: selectedFile?.size || 0,
            total_words: manifestData.total_words as number,
            processing_time_ms: manifestData.processing_time_ms as number
          })
        }
        break

      case 'ai_thinking':
        // Stream AI thinking tokens
        const content = data.content as string
        const stage = data.stage as string
        if (content) {
          addThinkingToken(stage, content)
        }
        if (data.type === 'alert') {
          // Alert was embedded in the stream, no extra action needed
        }
        break

      case 'classification_result':
        const classification = data.data as Classification
        setClassifications(prev => [...prev, classification])
        break

      case 'contamination_result':
        setContaminationResult(data.data as Record<string, unknown>)
        break

      case 'qc_summary':
        setQcSummary(data.data as Record<string, unknown>)
        break

      case 'pipeline_complete':
        setCurrentStage('complete')
        setIsProcessing(false)
        addEvent('complete', 'complete', '\n\n=== PROCESSING COMPLETE ===\n')

        // Fetch reconciliation
        if (sessionId) {
          fetch(`${API_BASE}/demo/session/${sessionId}/reconciliation`)
            .then(res => res.json())
            .then(data => setReconciliation(data))
            .catch(console.error)
        }
        break

      case 'error':
        addEvent('error', data.stage as string || 'error', `\nERROR: ${data.message}\n`)
        setError(data.message as string)
        setIsProcessing(false)
        break
    }
  }

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && file.type === 'application/pdf') {
      setSelectedFile(file)
      setError(null)
    } else {
      setError('Please select a PDF file')
    }
  }

  const stages = [
    { id: 'setup', label: 'Setup', icon: '1' },
    { id: 'upload', label: 'Upload', icon: '2' },
    { id: 'ingest', label: 'Extract', icon: '3' },
    { id: 'classify', label: 'Classify', icon: '4' },
    { id: 'qc', label: 'QC', icon: '5' },
    { id: 'complete', label: 'Done', icon: '6' }
  ]

  const getStageIndex = (stage: Stage) => stages.findIndex(s => s.id === stage)
  const currentIndex = getStageIndex(currentStage)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-xl font-bold">ESA Document Intelligence Demo</h1>
        <p className="text-sm text-gray-400">Real-time AI document analysis with visible thinking</p>
      </header>

      <div className="flex h-[calc(100vh-120px)]">
        {/* LEFT: Pipeline Stages */}
        <div className="w-48 border-r border-gray-800 p-4">
          <div className="space-y-2">
            {stages.map((stage, index) => (
              <div
                key={stage.id}
                className={`flex items-center gap-3 p-2 rounded ${
                  index < currentIndex
                    ? 'text-green-400'
                    : index === currentIndex
                    ? 'text-cyan-400 bg-gray-900'
                    : 'text-gray-600'
                }`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    index < currentIndex
                      ? 'bg-green-600 text-white'
                      : index === currentIndex
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {index < currentIndex ? '✓' : stage.icon}
                </div>
                <span className="text-sm font-medium">{stage.label}</span>
                {index === currentIndex && isProcessing && (
                  <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
                )}
              </div>
            ))}
          </div>

          {/* Project info */}
          {sessionId && (
            <div className="mt-8 pt-4 border-t border-gray-800">
              <div className="text-xs text-gray-500 space-y-1">
                <div>Project: <span className="text-gray-400">{projectId}</span></div>
                <div>Session: <span className="text-gray-400">{sessionId}</span></div>
              </div>
            </div>
          )}
        </div>

        {/* CENTER: AI Thinking Panel (prominent) */}
        <div className="flex-1 p-4">
          {currentStage === 'setup' ? (
            <div className="h-full flex items-center justify-center">
              <div className="max-w-md w-full space-y-6 p-6 bg-gray-900 rounded-lg">
                <h2 className="text-lg font-semibold text-center">Configure Demo</h2>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Project ID</label>
                    <input
                      type="text"
                      value={projectId}
                      onChange={e => setProjectId(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Site Address</label>
                    <input
                      type="text"
                      value={projectAddress}
                      onChange={e => setProjectAddress(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Company Name</label>
                    <input
                      type="text"
                      value={company}
                      onChange={e => setCompany(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-1">ESA Report PDF</label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf"
                      onChange={handleFileSelect}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:bg-cyan-600 file:text-white file:cursor-pointer"
                    />
                    {selectedFile && (
                      <p className="mt-1 text-xs text-gray-500">
                        Selected: {selectedFile.name} ({Math.round(selectedFile.size / 1024)}KB)
                      </p>
                    )}
                  </div>
                </div>

                {error && (
                  <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
                    {error}
                  </div>
                )}

                <button
                  onClick={startProcessing}
                  disabled={!selectedFile || isProcessing}
                  className="w-full py-3 bg-cyan-600 text-white rounded font-medium hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isProcessing ? 'Processing...' : 'Start AI Analysis'}
                </button>
              </div>
            </div>
          ) : (
            <AIThinkingPanel
              lines={lines}
              currentStage={currentStage}
              isProcessing={isProcessing}
            />
          )}
        </div>

        {/* RIGHT: Results Panel */}
        <div className="w-80 border-l border-gray-800 p-4 overflow-y-auto">
          <h3 className="text-sm font-semibold text-gray-400 mb-4">Results</h3>

          {/* Page Reconciliation */}
          {pdfManifest && (
            <div className="mb-4 p-3 bg-gray-900 rounded">
              <div className="text-xs font-semibold text-gray-400 mb-2">PAGE RECONCILIATION</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <div className="text-gray-500">Source PDF</div>
                  <div className="text-white font-mono">{pdfManifest.total_pages} pages</div>
                </div>
                <div>
                  <div className="text-gray-500">Classified</div>
                  <div className="text-white font-mono">{classifications.length} sections</div>
                </div>
                <div>
                  <div className="text-gray-500">Total Words</div>
                  <div className="text-white font-mono">{pdfManifest.total_words.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-gray-500">Time</div>
                  <div className="text-white font-mono">{pdfManifest.processing_time_ms}ms</div>
                </div>
              </div>
            </div>
          )}

          {/* Classifications */}
          {classifications.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-semibold text-gray-400 mb-2">CLASSIFICATIONS</div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {classifications.map((c, i) => (
                  <div key={i} className="p-2 bg-gray-900 rounded text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-white font-medium">{c.section}</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        c.confidence >= 80
                          ? 'bg-green-900 text-green-300'
                          : c.confidence >= 60
                          ? 'bg-yellow-900 text-yellow-300'
                          : 'bg-red-900 text-red-300'
                      }`}>
                        {c.confidence}%
                      </span>
                    </div>
                    <div className="text-gray-500 mt-1">
                      Pages {c.page_start}-{c.page_end}
                    </div>
                    {c.flags && c.flags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {c.flags.map((flag, j) => (
                          <span key={j} className="px-1 py-0.5 bg-red-900/50 text-red-400 rounded text-xs">
                            {flag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cross-Contamination */}
          {contaminationResult && (
            <div className="mb-4 p-3 bg-gray-900 rounded">
              <div className="text-xs font-semibold text-gray-400 mb-2">CROSS-CONTAMINATION</div>
              <div className={`text-sm font-medium ${
                contaminationResult.contamination_found
                  ? 'text-red-400'
                  : 'text-green-400'
              }`}>
                {contaminationResult.contamination_found
                  ? `${(contaminationResult.issues as unknown[])?.length || 0} Issues Found`
                  : 'No Issues Detected'
                }
              </div>
              {contaminationResult.contamination_found && (
                <div className="mt-2 space-y-1">
                  {((contaminationResult.issues as Array<{ description: string; severity: string }>) || []).map((issue, i) => (
                    <div key={i} className="text-xs text-red-300 p-1 bg-red-900/30 rounded">
                      {issue.description}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* QC Summary */}
          {qcSummary && (
            <div className="mb-4 p-3 bg-gray-900 rounded">
              <div className="text-xs font-semibold text-gray-400 mb-2">QC SUMMARY</div>
              <div className={`text-sm font-medium ${
                qcSummary.overall_status === 'ready'
                  ? 'text-green-400'
                  : 'text-yellow-400'
              }`}>
                {qcSummary.overall_status === 'ready' ? 'Ready for Assembly' : 'Issues Found'}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Confidence: {qcSummary.confidence}%
              </div>
              {(qcSummary.missing_sections as string[])?.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs text-yellow-400">Missing Sections:</div>
                  <ul className="text-xs text-gray-400 list-disc list-inside">
                    {(qcSummary.missing_sections as string[]).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Reset button */}
          {currentStage === 'complete' && (
            <button
              onClick={() => {
                setCurrentStage('setup')
                setSessionId(null)
                setSelectedFile(null)
                setPdfManifest(null)
                setClassifications([])
                setContaminationResult(null)
                setQcSummary(null)
                setReconciliation(null)
                clearLines()
                if (fileInputRef.current) {
                  fileInputRef.current.value = ''
                }
              }}
              className="w-full py-2 bg-gray-800 text-gray-300 rounded hover:bg-gray-700"
            >
              Process Another Document
            </button>
          )}
        </div>
      </div>

      {/* BOTTOM: File Info Bar */}
      <footer className="border-t border-gray-800 px-6 py-2 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-4">
          {selectedFile && (
            <>
              <span>File: <span className="text-gray-400">{selectedFile.name}</span></span>
              <span>Size: <span className="text-gray-400">{Math.round(selectedFile.size / 1024)}KB</span></span>
            </>
          )}
          {pdfManifest && (
            <>
              <span>Pages: <span className="text-gray-400">{pdfManifest.total_pages}</span></span>
              <span>Words: <span className="text-gray-400">{pdfManifest.total_words.toLocaleString()}</span></span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span>Model: <span className="text-cyan-400">gpt-4o</span></span>
          {isProcessing && <span className="text-cyan-400 animate-pulse">Processing...</span>}
        </div>
      </footer>
    </div>
  )
}
