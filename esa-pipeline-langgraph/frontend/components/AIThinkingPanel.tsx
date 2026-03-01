'use client'

import { useEffect, useRef, useState } from 'react'

interface ThinkingLine {
  id: string
  type: 'thinking' | 'alert' | 'classification' | 'finding' | 'complete' | 'error'
  stage: string
  content: string
  timestamp: Date
}

interface AIThinkingPanelProps {
  lines: ThinkingLine[]
  currentStage: string
  isProcessing: boolean
}

export default function AIThinkingPanel({
  lines,
  currentStage,
  isProcessing
}: AIThinkingPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  // Detect manual scroll
  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
    setAutoScroll(isAtBottom)
  }

  const getLineColor = (type: string) => {
    switch (type) {
      case 'alert':
        return 'text-red-400'
      case 'classification':
        return 'text-green-400'
      case 'finding':
        return 'text-yellow-400'
      case 'complete':
        return 'text-blue-400'
      case 'error':
        return 'text-red-500'
      default:
        return 'text-cyan-400'
    }
  }

  const getStageIcon = (stage: string) => {
    switch (stage) {
      case 'ingest':
        return '[PDF]'
      case 'classify':
        return '[AI]'
      case 'qc':
        return '[QC]'
      case 'verify':
        return '[VERIFY]'
      default:
        return '[SYS]'
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-950 rounded-lg border border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
          <span className="text-sm font-mono text-gray-300">AI Processing Console</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-500">
            Stage: <span className="text-cyan-400">{currentStage || 'idle'}</span>
          </span>
          {!autoScroll && (
            <button
              onClick={() => setAutoScroll(true)}
              className="text-xs px-2 py-1 bg-gray-800 text-gray-400 rounded hover:bg-gray-700"
            >
              Resume scroll
            </button>
          )}
        </div>
      </div>

      {/* Console output */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm leading-relaxed"
        style={{
          background: 'linear-gradient(180deg, #0a0a0a 0%, #111111 100%)'
        }}
      >
        {lines.length === 0 ? (
          <div className="text-gray-600 italic">
            Waiting for processing to begin...
          </div>
        ) : (
          <div className="space-y-0">
            {lines.map((line) => (
              <span
                key={line.id}
                className={`${getLineColor(line.type)} whitespace-pre-wrap`}
              >
                {line.type === 'alert' && (
                  <span className="bg-red-900/50 px-1 rounded">
                    {line.content}
                  </span>
                )}
                {line.type !== 'alert' && line.content}
              </span>
            ))}
            {isProcessing && (
              <span className="inline-block w-2 h-4 bg-cyan-400 animate-pulse ml-0.5" />
            )}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="px-4 py-2 bg-gray-900 border-t border-gray-800 flex items-center justify-between">
        <div className="text-xs font-mono text-gray-500">
          {lines.length > 0 && (
            <span>
              {lines.filter(l => l.type === 'classification').length} classifications
              {' | '}
              {lines.filter(l => l.type === 'alert').length} alerts
            </span>
          )}
        </div>
        <div className="text-xs font-mono text-gray-500">
          {lines.length} events
        </div>
      </div>
    </div>
  )
}

// Separate component for accumulating streaming text
export function useThinkingLines() {
  const [lines, setLines] = useState<ThinkingLine[]>([])
  const currentLineRef = useRef<ThinkingLine | null>(null)
  const lineIdCounter = useRef(0)

  const addThinkingToken = (stage: string, content: string) => {
    setLines(prev => {
      const last = prev[prev.length - 1]

      // If same stage and thinking type, append to last line
      if (last && last.stage === stage && last.type === 'thinking') {
        const updated = [...prev]
        updated[updated.length - 1] = {
          ...last,
          content: last.content + content
        }
        return updated
      }

      // Otherwise create new line
      return [
        ...prev,
        {
          id: `line-${lineIdCounter.current++}`,
          type: 'thinking',
          stage,
          content,
          timestamp: new Date()
        }
      ]
    })
  }

  const addEvent = (type: ThinkingLine['type'], stage: string, content: string) => {
    setLines(prev => [
      ...prev,
      {
        id: `line-${lineIdCounter.current++}`,
        type,
        stage,
        content,
        timestamp: new Date()
      }
    ])
  }

  const clear = () => {
    setLines([])
    lineIdCounter.current = 0
  }

  return { lines, addThinkingToken, addEvent, clear }
}
