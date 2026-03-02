import { useState } from 'react';
import { Download, Minimize2, Loader2, FileDown, Scissors, Clock } from 'lucide-react';
import { useReportStore } from '../stores/reportStore';
import { getReportDownloadUrl, splitReport, getSplitPartUrl } from '../api/client';
import type { SplitPart } from '../types';

interface Props {
  reportId: number;
}

export function ActionBar({ reportId }: Props) {
  const { currentReport, assembleResult, compressResult, compressReport, loading } = useReportStore();
  const [quality, setQuality] = useState('standard');
  const [targetMb, setTargetMb] = useState('');
  const [compressing, setCompressing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [splitParts, setSplitParts] = useState<SplitPart[] | null>(null);

  const { documents } = useReportStore();

  if (!currentReport) return null;

  // Prefer assembleResult, fall back to computing from documents
  const includedDocs = documents.filter(d => d.is_included);
  const totalPages = assembleResult?.total_pages ?? includedDocs.reduce((s, d) => s + (d.page_count || 0), 0);
  const totalDocs = assembleResult?.total_documents ?? includedDocs.length;

  const assembledMb = currentReport.assembled_size
    ? (currentReport.assembled_size / 1024 / 1024).toFixed(1)
    : null;
  const compressedMb = currentReport.compressed_size
    ? (currentReport.compressed_size / 1024 / 1024).toFixed(1)
    : null;

  const handleCompress = async () => {
    setCompressing(true);
    try {
      await compressReport(reportId, quality, targetMb ? parseFloat(targetMb) : undefined);
    } finally {
      setCompressing(false);
    }
  };

  const handleSplit = async () => {
    setSplitting(true);
    try {
      const result = await splitReport(reportId, 20);
      setSplitParts(result.parts);
    } catch (e) {
      console.error('Split failed:', e);
    } finally {
      setSplitting(false);
    }
  };

  return (
    <div className="bg-white border-t border-gray-200 px-4 py-2 flex items-center justify-between text-sm shrink-0">
      {/* Left: stats */}
      <div className="flex items-center gap-3 text-gray-600">
        {totalPages > 0 && <span className="font-medium">{totalPages.toLocaleString()} pages</span>}
        {totalDocs > 0 && <span className="text-gray-400">{totalDocs} docs</span>}
        {assembledMb && <span>{assembledMb} MB</span>}
        {compressedMb && (
          <span className="text-green-600">
            compressed: {compressedMb} MB
            {compressResult && ` (-${compressResult.reduction_pct}%)`}
          </span>
        )}
        {currentReport.pipeline_duration != null && currentReport.pipeline_duration > 0 && (
          <span className="flex items-center gap-1 text-gray-400 text-xs">
            <Clock size={11} />
            Assembled in {currentReport.pipeline_duration >= 60
              ? `${Math.floor(currentReport.pipeline_duration / 60)}m ${currentReport.pipeline_duration % 60}s`
              : `${currentReport.pipeline_duration}s`
            }
          </span>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        {currentReport.assembled_filename && (
          <>
            <select
              value={quality}
              onChange={e => setQuality(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
            >
              <option value="email">Email (&lt;10 MB)</option>
              <option value="standard">Standard</option>
              <option value="high">High Quality</option>
            </select>

            <input
              type="number"
              value={targetMb}
              onChange={e => setTargetMb(e.target.value)}
              placeholder="MB"
              className="w-16 border border-gray-300 rounded px-2 py-1 text-xs"
            />

            <button
              onClick={handleCompress}
              disabled={compressing || loading}
              className="flex items-center gap-1 bg-orange-500 text-white px-2.5 py-1 rounded text-xs hover:bg-orange-600 disabled:opacity-50 transition"
            >
              {compressing ? <Loader2 size={12} className="animate-spin" /> : <Minimize2 size={12} />}
              Compress
            </button>

            <a
              href={getReportDownloadUrl(reportId, false)}
              className="flex items-center gap-1 bg-blue-600 text-white px-2.5 py-1 rounded text-xs hover:bg-blue-700 transition"
            >
              <Download size={12} /> Download
            </a>

            {compressedMb && (
              <a
                href={getReportDownloadUrl(reportId, true)}
                className="flex items-center gap-1 bg-green-600 text-white px-2.5 py-1 rounded text-xs hover:bg-green-700 transition"
              >
                <FileDown size={12} /> {compressedMb} MB
              </a>
            )}

            <button
              onClick={handleSplit}
              disabled={splitting || loading}
              className="flex items-center gap-1 bg-purple-500 text-white px-2.5 py-1 rounded text-xs hover:bg-purple-600 disabled:opacity-50 transition"
            >
              {splitting ? <Loader2 size={12} className="animate-spin" /> : <Scissors size={12} />}
              Split for Email
            </button>
          </>
        )}
      </div>

      {/* Split parts panel */}
      {splitParts && splitParts.length > 1 && (
        <div className="border-t border-gray-100 px-4 py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-600">{splitParts.length} parts</span>
            <button onClick={() => setSplitParts(null)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {splitParts.map(part => (
              <a
                key={part.part_number}
                href={getSplitPartUrl(reportId, part.part_number)}
                className="text-xs bg-purple-50 text-purple-700 px-2 py-1 rounded hover:bg-purple-100 transition"
              >
                Part {part.part_number} ({part.page_count}p, {(part.file_size / 1024 / 1024).toFixed(1)}MB)
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
