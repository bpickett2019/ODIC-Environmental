import { Loader2, CheckCircle, XCircle, Ban } from 'lucide-react';
import type { OperationProgress, ProgressLogEntry } from '../stores/reportStore';

interface Props {
  progress: OperationProgress | null;
  progressLog: ProgressLogEntry[];
  pipelinePhase: string;
}

export function ProcessingOverlay({ progress, progressLog, pipelinePhase }: Props) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const phaseLabel = pipelinePhase === 'uploading'
    ? 'Uploading files...'
    : pipelinePhase === 'classifying'
      ? `Classifying ${progress ? `${progress.current}/${progress.total}` : ''}...`
      : pipelinePhase === 'converting'
        ? `Converting ${progress ? `${progress.current}/${progress.total}` : ''}...`
        : pipelinePhase === 'processing'
          ? `Processing ${progress ? `${progress.current}/${progress.total}` : ''}...`
          : pipelinePhase === 'validating'
          ? 'Validating assembly order...'
          : pipelinePhase === 'assembling'
            ? 'Assembling report...'
            : 'Processing...';

  return (
    <div className="absolute inset-0 bg-white/95 flex items-center justify-center z-20">
      <div className="w-full max-w-md px-8">
        <div className="text-center mb-6">
          <Loader2 size={40} className="mx-auto mb-4 text-blue-600 animate-spin" />
          <h2 className="text-lg font-semibold text-gray-900">{phaseLabel}</h2>
        </div>

        {/* Progress bar */}
        {progress && progress.total > 0 && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{progress.current} / {progress.total}</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Current file */}
        {progress?.filename && (
          <p className="text-xs text-blue-600 truncate text-center mb-3">
            {progress.filename}
          </p>
        )}

        {/* Log feed */}
        {progressLog.length > 0 && (
          <div className="max-h-[240px] overflow-y-auto text-xs font-mono space-y-1 bg-gray-900 text-gray-300 rounded-lg p-3">
            {progressLog.slice(-8).map((entry, i) => (
              <div key={i}>
                <div className="flex items-center gap-1.5 leading-tight">
                  {entry.status === 'ok' && <CheckCircle size={10} className="text-green-400 shrink-0" />}
                  {entry.status === 'error' && <XCircle size={10} className="text-red-400 shrink-0" />}
                  {entry.status === 'excluded' && <Ban size={10} className="text-yellow-400 shrink-0" />}
                  {entry.status === 'classifying' && <Loader2 size={10} className="text-blue-400 shrink-0 animate-spin" />}
                  <span className="truncate text-gray-400">{entry.filename}</span>
                  <span className={`shrink-0 ${
                    entry.status === 'error' ? 'text-red-400'
                      : entry.status === 'excluded' ? 'text-yellow-400'
                        : 'text-green-400'
                  }`}>
                    {entry.detail}
                  </span>
                </div>
                {entry.reasoning && entry.reasoning !== entry.detail && (
                  <div className="pl-5 text-gray-500 leading-tight truncate">{entry.reasoning}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
