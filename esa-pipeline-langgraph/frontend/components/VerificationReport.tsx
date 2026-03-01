'use client';

import { useState } from 'react';

interface SectionDetail {
  section_id: string;
  section_name: string;
  status: string;
  found: boolean;
  required: boolean;
  confidence: number;
  summary: string;
  issues: string[];
}

interface VerificationReportData {
  overall_status: string;
  overall_confidence: number;
  auto_approved: boolean;
  sections_found: number;
  sections_missing: number;
  total_sections: number;
  executive_summary: string;
  recommendations: string[];
  flags: string[];
  section_details: SectionDetail[];
  markdown_report?: string;
}

interface VerificationReportProps {
  report: VerificationReportData | Record<string, unknown> | null;
  onApprove?: () => void;
  onRequestReview?: (sectionIds: string[]) => void;
}

export default function VerificationReport({ report, onApprove, onRequestReview }: VerificationReportProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showMarkdown, setShowMarkdown] = useState(false);

  if (!report) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-6">
        <p className="text-gray-500 text-center">No verification report available yet.</p>
      </div>
    );
  }

  // Safely access report properties with defaults
  const data = report as VerificationReportData;
  const overall_status = data.overall_status || 'needs_review';
  const overall_confidence = data.overall_confidence ?? 0;
  const auto_approved = data.auto_approved ?? false;
  const sections_found = data.sections_found ?? 0;
  const sections_missing = data.sections_missing ?? 0;
  const total_sections = data.total_sections ?? 0;
  const executive_summary = data.executive_summary || '';
  const recommendations = data.recommendations || [];
  const flags = data.flags || [];
  const section_details = data.section_details || [];
  const markdown_report = data.markdown_report;

  const statusColors: Record<string, string> = {
    complete: 'bg-green-100 text-green-800 border-green-200',
    partial: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    missing: 'bg-red-100 text-red-800 border-red-200',
    needs_review: 'bg-blue-100 text-blue-800 border-blue-200',
  };

  const statusIcons: Record<string, string> = {
    complete: '✅',
    partial: '⚠️',
    missing: '❌',
    needs_review: '👀',
  };

  const toggleSection = (id: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedSections(newExpanded);
  };

  const mainSections = section_details.filter(s => !s.section_id.startsWith('appendix'));
  const appendices = section_details.filter(s => s.section_id.startsWith('appendix'));

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className={`p-6 ${statusColors[overall_status] || 'bg-gray-100'}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              {statusIcons[overall_status]} AI Verification Report
            </h2>
            <p className="mt-1 text-sm opacity-80">
              {auto_approved ? 'Auto-approved - Ready for QC' : 'Human review recommended'}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold">{Math.round(overall_confidence * 100)}%</div>
            <div className="text-sm">Confidence</div>
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-3 divide-x border-b">
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{sections_found}</div>
          <div className="text-sm text-gray-500">Sections Found</div>
        </div>
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{sections_missing}</div>
          <div className="text-sm text-gray-500">Missing</div>
        </div>
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-gray-600">{total_sections}</div>
          <div className="text-sm text-gray-500">Total Required</div>
        </div>
      </div>

      {/* Executive Summary */}
      <div className="p-6 border-b">
        <h3 className="text-lg font-semibold mb-3">Executive Summary</h3>
        <p className="text-gray-700 leading-relaxed">{executive_summary}</p>
      </div>

      {/* Flags */}
      {flags.length > 0 && (
        <div className="p-6 border-b bg-red-50">
          <h3 className="text-lg font-semibold mb-3 text-red-800">⚠️ Flags Requiring Attention</h3>
          <ul className="space-y-2">
            {flags.map((flag, i) => (
              <li key={i} className="flex items-start gap-2 text-red-700">
                <span className="text-red-500">•</span>
                {flag}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Section Details */}
      <div className="p-6 border-b">
        <h3 className="text-lg font-semibold mb-4">Section Checklist</h3>

        {/* Main Sections */}
        <div className="mb-6">
          <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Main Report Sections</h4>
          <div className="space-y-2">
            {mainSections.map((section) => (
              <div key={section.section_id} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleSection(section.section_id)}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{statusIcons[section.status]}</span>
                    <span className="font-medium">{section.section_name}</span>
                    {section.required && (
                      <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">Required</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-24 bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${section.confidence >= 0.95 ? 'bg-green-500' : section.confidence >= 0.7 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${section.confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-sm text-gray-500 w-12 text-right">
                      {Math.round(section.confidence * 100)}%
                    </span>
                    <svg
                      className={`w-5 h-5 transition-transform ${expandedSections.has(section.section_id) ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </button>
                {expandedSections.has(section.section_id) && (
                  <div className="p-4 bg-gray-50 border-t">
                    {section.summary && (
                      <p className="text-gray-700 mb-3">{section.summary}</p>
                    )}
                    {section.issues && section.issues.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-medium text-red-600 mb-1">Issues:</p>
                        <ul className="text-sm text-red-600 list-disc list-inside">
                          {section.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Appendices */}
        <div>
          <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Appendices</h4>
          <div className="space-y-2">
            {appendices.map((section) => (
              <div key={section.section_id} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleSection(section.section_id)}
                  className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{statusIcons[section.status]}</span>
                    <span className="font-medium">{section.section_name}</span>
                    {section.required && (
                      <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">Required</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-24 bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${section.confidence >= 0.95 ? 'bg-green-500' : section.confidence >= 0.7 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${section.confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-sm text-gray-500 w-12 text-right">
                      {Math.round(section.confidence * 100)}%
                    </span>
                    <svg
                      className={`w-5 h-5 transition-transform ${expandedSections.has(section.section_id) ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </button>
                {expandedSections.has(section.section_id) && (
                  <div className="p-4 bg-gray-50 border-t">
                    {section.summary && (
                      <p className="text-gray-700 mb-3">{section.summary}</p>
                    )}
                    {section.issues && section.issues.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-medium text-red-600 mb-1">Issues:</p>
                        <ul className="text-sm text-red-600 list-disc list-inside">
                          {section.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recommendations */}
      <div className="p-6 border-b">
        <h3 className="text-lg font-semibold mb-3">Recommendations</h3>
        <ul className="space-y-2">
          {recommendations.map((rec, i) => (
            <li key={i} className="flex items-start gap-2 text-gray-700">
              <span className="text-blue-500">→</span>
              {rec}
            </li>
          ))}
        </ul>
      </div>

      {/* Actions */}
      <div className="p-6 bg-gray-50 flex items-center justify-between">
        <button
          onClick={() => setShowMarkdown(!showMarkdown)}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          {showMarkdown ? 'Hide' : 'Show'} Raw Report
        </button>
        <div className="flex gap-3">
          {!auto_approved && onRequestReview && (
            <button
              onClick={() => onRequestReview(flags.map(f => f.split(':')[0]))}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
            >
              Request Changes
            </button>
          )}
          {onApprove && (
            <button
              onClick={onApprove}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              {auto_approved ? 'Continue to QC' : 'Approve Anyway'}
            </button>
          )}
        </div>
      </div>

      {/* Markdown Report (hidden by default) */}
      {showMarkdown && markdown_report && (
        <div className="p-6 border-t bg-gray-900 text-gray-100">
          <pre className="text-sm whitespace-pre-wrap font-mono">{markdown_report}</pre>
        </div>
      )}
    </div>
  );
}
