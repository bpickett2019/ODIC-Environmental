'use client'

import { useState, useCallback } from 'react'
import { uploadFiles } from '@/lib/api'

interface FileUploadProps {
  projectId: string
  onComplete: () => void
}

export default function FileUpload({ projectId, onComplete }: FileUploadProps) {
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const droppedFiles = Array.from(e.dataTransfer.files)
    setFiles(prev => [...prev, ...droppedFiles])
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files)
      setFiles(prev => [...prev, ...selectedFiles])
    }
  }

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (files.length === 0) return
    setUploading(true)
    setUploadProgress(0)

    try {
      const batchSize = 5
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize)
        await uploadFiles(projectId, batch)
        setUploadProgress(Math.round(((i + batch.length) / files.length) * 100))
      }
      onComplete()
    } catch (error) {
      console.error('Upload failed:', error)
      alert('Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-white">Upload Documents</h2>
      <p className="text-gray-400">
        Drag and drop your ESA documents here. Supports PDF, Word, and image files.
      </p>

      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={'border-2 border-dashed rounded-lg p-12 text-center transition-colors ' +
          (isDragging ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 hover:border-gray-600')}
      >
        <input
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.tif"
          onChange={handleFileSelect}
          className="hidden"
          id="file-input"
        />
        <label htmlFor="file-input" className="cursor-pointer">
          <div className="text-4xl mb-4">📄</div>
          <p className="text-gray-300 mb-2">
            Drop files here or <span className="text-blue-400 underline">browse</span>
          </p>
          <p className="text-sm text-gray-500">PDF, DOCX, JPG, PNG, TIFF</p>
        </label>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-300">{files.length} file(s) selected</h3>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {files.map((file, index) => (
              <div key={index} className="flex items-center justify-between px-4 py-2 bg-gray-800 rounded-lg">
                <div className="flex items-center space-x-3">
                  <span className="text-2xl">
                    {file.type.includes('pdf') ? '📕' :
                     file.type.includes('word') || file.name.endsWith('.docx') ? '📘' :
                     file.type.includes('image') ? '🖼️' : '📄'}
                  </span>
                  <div>
                    <p className="text-sm text-white truncate max-w-md">{file.name}</p>
                    <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                  </div>
                </div>
                <button onClick={() => removeFile(index)} className="text-gray-500 hover:text-red-400">
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {uploading && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Uploading...</span>
            <span className="text-white">{uploadProgress}%</span>
          </div>
          <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: uploadProgress + '%' }} />
          </div>
        </div>
      )}

      <div className="flex justify-end space-x-4">
        <button
          onClick={handleUpload}
          disabled={files.length === 0 || uploading}
          className={'px-6 py-2 rounded-lg font-medium transition-colors ' +
            (files.length === 0 || uploading
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700')}
        >
          {uploading ? 'Uploading...' : 'Upload & Start Pipeline'}
        </button>
      </div>
    </div>
  )
}
