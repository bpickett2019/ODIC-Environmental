const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export interface Project {
  project_id: string
  project_address: string
  report_type: 'phase_1' | 'phase_2'
  client_name: string
}

export interface PipelineStatus {
  thread_id: string
  project_id: string
  status: string
  started_at: string
  state?: {
    current_stage: string
    awaiting_human_input: boolean
    human_input_type: string | null
    human_input_data: Record<string, unknown>
  }
}

export interface ClassificationDocument {
  file_id: string
  filename: string
  classification: {
    category: string
    section: string
    confidence: number
    reasoning: string
  }
}

export interface QCIssue {
  agent: string
  severity: string
  description: string
  location: string
  auto_fixable: boolean
  suggested_fix: string
}

export interface ExportFile {
  filename: string
  size_mb: number
  pages: number
  path: string
}

// Project APIs
export async function createProject(project: Project) {
  const res = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  })
  return res.json()
}

export async function getProject(projectId: string) {
  const res = await fetch(`${API_BASE}/projects/${projectId}`)
  return res.json()
}

// File upload
export async function uploadFiles(projectId: string, files: File[]) {
  const formData = new FormData()
  files.forEach(file => formData.append('files', file))

  const res = await fetch(`${API_BASE}/projects/${projectId}/upload-multiple`, {
    method: 'POST',
    body: formData,
  })
  return res.json()
}

// Pipeline control
export async function startPipeline(project: Project) {
  const res = await fetch(`${API_BASE}/pipeline/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  })
  return res.json()
}

export async function getPipelineStatus(threadId: string): Promise<PipelineStatus> {
  const res = await fetch(`${API_BASE}/pipeline/${threadId}/status`)
  return res.json()
}

// Human input submissions
export async function submitClassificationReview(
  threadId: string,
  decisions: Array<{
    file_id: string
    category: string
    section: string
    appendix_letter?: string
    reason?: string
  }>
) {
  const res = await fetch(`${API_BASE}/pipeline/${threadId}/classification-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decisions),
  })
  return res.json()
}

export async function submitAppendixOrder(threadId: string, newOrder: string[]) {
  const res = await fetch(`${API_BASE}/pipeline/${threadId}/appendix-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_order: newOrder }),
  })
  return res.json()
}

export async function submitQCResolution(
  threadId: string,
  resolution: {
    approve_with_issues?: boolean
    auto_fix?: boolean
    fixes_to_apply?: string[]
  }
) {
  const res = await fetch(`${API_BASE}/pipeline/${threadId}/qc-resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resolution),
  })
  return res.json()
}

export async function submitFinalSignoff(
  threadId: string,
  approved: boolean,
  notes: string = ''
) {
  const res = await fetch(`${API_BASE}/pipeline/${threadId}/final-signoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved, notes }),
  })
  return res.json()
}

// Exports
export async function listExports(projectId: string) {
  const res = await fetch(`${API_BASE}/projects/${projectId}/exports`)
  return res.json()
}

export function getExportUrl(projectId: string, filename: string) {
  return `${API_BASE}/projects/${projectId}/exports/${filename}`
}

// WebSocket connection
export function createWebSocket(threadId: string): WebSocket {
  const wsUrl = API_BASE.replace('http', 'ws')
  return new WebSocket(`${wsUrl}/ws/${threadId}`)
}

// ===== Demo API =====

export interface DemoProject {
  project_id: string
  project_address: string
  company: string
}

export async function createDemoSession(project: DemoProject) {
  const res = await fetch(`${API_BASE}/demo/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  })
  return res.json()
}

export async function getDemoSessionStatus(sessionId: string) {
  const res = await fetch(`${API_BASE}/demo/session/${sessionId}`)
  return res.json()
}

export async function uploadDemoPdf(sessionId: string, file: File) {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${API_BASE}/demo/session/${sessionId}/upload`, {
    method: 'POST',
    body: formData,
  })
  return res.json()
}

export async function getDemoReconciliation(sessionId: string) {
  const res = await fetch(`${API_BASE}/demo/session/${sessionId}/reconciliation`)
  return res.json()
}

export function createDemoWebSocket(sessionId: string): WebSocket {
  const wsUrl = API_BASE.replace('http', 'ws')
  return new WebSocket(`${wsUrl}/demo/ws/${sessionId}`)
}
