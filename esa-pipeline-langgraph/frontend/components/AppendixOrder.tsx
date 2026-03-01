'use client'

import { useState } from 'react'
import { submitAppendixOrder } from '@/lib/api'

interface AppendixItem {
  file_id: string
  filename: string
  appendix_letter: string
  section: string
  page_count: number
}

interface AppendixOrderProps {
  threadId: string
  appendices: AppendixItem[]
  onComplete: () => void
}

export default function AppendixOrder({ threadId, appendices, onComplete }: AppendixOrderProps) {
  const [items, setItems] = useState(appendices)
  const [submitting, setSubmitting] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  const handleDragStart = (index: number) => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index) return

    const newItems = [...items]
    const draggedItem = newItems[draggedIndex]
    newItems.splice(draggedIndex, 1)
    newItems.splice(index, 0, draggedItem)
    setItems(newItems)
    setDraggedIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
  }

  const moveItem = (fromIndex: number, direction: 'up' | 'down') => {
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1
    if (toIndex < 0 || toIndex >= items.length) return

    const newItems = [...items]
    const temp = newItems[fromIndex]
    newItems[fromIndex] = newItems[toIndex]
    newItems[toIndex] = temp
    setItems(newItems)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const newOrder = items.map(item => item.file_id)
      await submitAppendixOrder(threadId, newOrder)
      onComplete()
    } catch (error) {
      console.error('Submit failed:', error)
      alert('Failed to submit order')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Reorder Appendices</h2>
        <p className="text-gray-400 mt-1">
          Drag and drop to reorder appendices, or use the arrow buttons.
        </p>
      </div>

      <div className="space-y-2">
        {items.map((item, index) => (
          <div
            key={item.file_id}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            className={'flex items-center space-x-4 p-4 bg-gray-800 rounded-lg cursor-move transition-colors ' +
              (draggedIndex === index ? 'bg-blue-900/50 border border-blue-500' : 'hover:bg-gray-750')}
          >
            <div className="text-gray-500 cursor-grab">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
              </svg>
            </div>

            <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold">
              {item.appendix_letter || String.fromCharCode(65 + index)}
            </div>

            <div className="flex-1">
              <p className="font-medium text-white">{item.filename}</p>
              <p className="text-sm text-gray-400">
                {item.section.replace(/_/g, ' ')} • {item.page_count} pages
              </p>
            </div>

            <div className="flex flex-col space-y-1">
              <button
                onClick={() => moveItem(index, 'up')}
                disabled={index === 0}
                className="p-1 text-gray-400 hover:text-white disabled:opacity-30"
              >
                ▲
              </button>
              <button
                onClick={() => moveItem(index, 'down')}
                disabled={index === items.length - 1}
                className="p-1 text-gray-400 hover:text-white disabled:opacity-30"
              >
                ▼
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end space-x-4">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting...' : 'Confirm Order'}
        </button>
      </div>
    </div>
  )
}
