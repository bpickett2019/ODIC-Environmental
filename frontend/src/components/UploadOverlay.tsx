import { useCallback, useState, useRef, useEffect } from 'react';
import { Upload, FileText, Trash2, Loader2, FolderInput } from 'lucide-react';
import type { Report } from '../types';

interface Props {
  reports: Report[];
  onCreateAndUpload: (files: FileList | File[]) => void;
  onFolderUpload: (path: string) => void;
  onSelectReport: (id: number) => void;
  onDeleteReport: (id: number) => void;
  isCreating: boolean;
}

export function UploadOverlay({
  reports,
  onCreateAndUpload,
  onFolderUpload,
  onSelectReport,
  onDeleteReport,
  isCreating,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      onCreateAndUpload(e.dataTransfer.files);
    }
  }, [onCreateAndUpload]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onCreateAndUpload(e.target.files);
    }
  };

  const handleFolderSubmit = () => {
    if (folderPath.trim()) {
      onFolderUpload(folderPath.trim());
      setFolderPath('');
      setShowFolderInput(false);
    }
  };

  // Prevent default drag behavior on window
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Title */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Ode</h1>
            <p className="text-gray-500 mt-1">Phase I ESA Report Assembly</p>
          </div>

          {/* Drop zone */}
          <div
            className={`border-2 border-dashed rounded-xl p-16 text-center transition cursor-pointer mb-8 ${
              isDragOver
                ? 'border-blue-500 bg-blue-50 scale-[1.01]'
                : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
            }`}
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !isCreating && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              accept=".pdf,.docx,.doc,.heic,.heif,.jpg,.jpeg,.png,.tiff,.tif,.vsd,.vsdx,.txt,.zip"
            />
            {isCreating ? (
              <div>
                <Loader2 size={48} className="mx-auto mb-4 text-blue-500 animate-spin" />
                <p className="text-lg font-medium text-blue-700">Starting pipeline...</p>
                <p className="text-sm text-gray-400 mt-1">Converting, classifying, and assembling your report</p>
              </div>
            ) : (
              <div>
                <Upload size={48} className="mx-auto mb-4 text-gray-400" />
                <p className="text-xl font-medium text-gray-700">Drop report files to start</p>
                <p className="text-sm text-gray-400 mt-2">
                  PDF, DOCX, HEIC, JPG, PNG, VSD, TXT, ZIP
                </p>
                <p className="text-xs text-gray-300 mt-4">
                  Files are automatically converted, classified, and assembled into a report
                </p>
              </div>
            )}
          </div>

          {/* Folder path input */}
          <div className="text-center mb-8">
            {!showFolderInput ? (
              <button
                onClick={() => setShowFolderInput(true)}
                disabled={isCreating}
                className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50 transition"
              >
                <FolderInput size={16} /> Or upload from a local folder path
              </button>
            ) : (
              <div className="flex gap-2 max-w-lg mx-auto">
                <input
                  type="text"
                  value={folderPath}
                  onChange={e => setFolderPath(e.target.value)}
                  placeholder="/path/to/report/folder"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  onKeyDown={e => e.key === 'Enter' && handleFolderSubmit()}
                  autoFocus
                />
                <button
                  onClick={handleFolderSubmit}
                  disabled={!folderPath.trim() || isCreating}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
                >
                  Import
                </button>
                <button
                  onClick={() => { setShowFolderInput(false); setFolderPath(''); }}
                  className="text-gray-500 px-3 py-2 text-sm hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Recent reports */}
          {reports.length > 0 && (
            <div>
              <h2 className="text-xs font-medium text-gray-400 mb-3 uppercase tracking-wide">
                Recent Reports
              </h2>
              <div className="space-y-2">
                {reports.map(report => (
                  <div
                    key={report.id}
                    className="bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-blue-300 hover:shadow-sm transition cursor-pointer flex items-center justify-between"
                    onClick={() => onSelectReport(report.id)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText size={18} className="text-blue-500 shrink-0" />
                      <div className="min-w-0">
                        <h3 className="font-medium text-gray-900 text-sm truncate">{report.name}</h3>
                        <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                          {report.project_number && <span>#{report.project_number}</span>}
                          <span>{report.document_count} docs</span>
                          <span>{new Date(report.created_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {report.assembled_size && (
                        <span className="text-xs text-gray-500">
                          {(report.assembled_size / 1024 / 1024).toFixed(1)} MB
                        </span>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); onDeleteReport(report.id); }}
                        className="p-1 text-gray-400 hover:text-red-500 transition"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
