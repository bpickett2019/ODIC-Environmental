'use client';

import { useState } from 'react';

interface SectionInfo {
  section_id: string;
  section_name: string;
  status: 'found' | 'missing' | 'partial';
  required: boolean;
  confidence: number;
  tier: 'auto_approved' | 'audit_trail' | 'human_review';
  source_file?: string;
  pages?: string;
  ai_summary?: string;
  ai_note?: string;
}

interface CompletenessReportProps {
  reportType: string;
  sections: SectionInfo[];
  totalRequired: number;
  totalFound: number;
  totalMissing: number;
  overallCompleteness: number;
  blockingIssues: number;
  autoApprovedSections: number;
  humanReviewRequired: number;
}

export default function CompletenessReport({
  reportType,
  sections,
  totalRequired,
  totalFound,
  totalMissing,
  overallCompleteness,
  blockingIssues,
  autoApprovedSections,
  humanReviewRequired
}: CompletenessReportProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showOnlyIssues, setShowOnlyIssues] = useState(false);

  const toggleSection = (id: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedSections(newExpanded);
  };

  const statusConfig = {
    found: { icon: '✅', color: 'text-green-600', bg: 'bg-green-50 border-green-200' },
    missing: { icon: '❌', color: 'text-red-600', bg: 'bg-red-50 border-red-200' },
    partial: { icon: '⚠️', color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200' }
  };

  const tierColors = {
    auto_approved: 'bg-green-100 text-green-800',
    audit_trail: 'bg-yellow-100 text-yellow-800',
    human_review: 'bg-red-100 text-red-800'
  };

  const displaySections = showOnlyIssues
    ? sections.filter(s => s.status !== 'found' || s.tier === 'human_review')
    : sections;

  // Separate main sections from appendices
  const mainSections = displaySections.filter(s => !s.section_id.startsWith('appendix'));
  const appendices = displaySections.filter(s => s.section_id.startsWith('appendix'));

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="p-6 bg-gradient-to-r from-blue-600 to-blue-700 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">Completeness Report</h2>
            <p className="text-blue-100 mt-1">{reportType} - ASTM E1527-21</p>
          </div>
          <div className="text-right">
            <div className="text-4xl font-bold">{Math.round(overallCompleteness)}%</div>
            <div className="text-blue-100 text-sm">Complete</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-4 h-3 bg-blue-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              overallCompleteness >= 95 ? 'bg-green-400' :
              overallCompleteness >= 80 ? 'bg-yellow-400' : 'bg-red-400'
            }`}
            style={{ width: `${overallCompleteness}%` }}
          />
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-5 divide-x border-b">
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-gray-900">{totalRequired}</div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Required</div>
        </div>
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{totalFound}</div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Found</div>
        </div>
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{totalMissing}</div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Missing</div>
        </div>
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{autoApprovedSections}</div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Auto-Approved</div>
        </div>
        <div className="p-4 text-center">
          <div className="text-2xl font-bold text-orange-600">{humanReviewRequired}</div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Needs Review</div>
        </div>
      </div>

      {/* Blocking issues alert */}
      {blockingIssues > 0 && (
        <div className="m-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center gap-2 text-red-800">
            <span className="text-xl">🚫</span>
            <span className="font-semibold">{blockingIssues} Blocking Issue{blockingIssues > 1 ? 's' : ''}</span>
            <span className="text-red-600 text-sm ml-2">Must resolve before export</span>
          </div>
        </div>
      )}

      {/* Filter toggle */}
      <div className="px-6 py-3 border-b bg-gray-50">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showOnlyIssues}
            onChange={e => setShowOnlyIssues(e.target.checked)}
            className="w-4 h-4 rounded text-blue-600"
          />
          <span className="text-sm text-gray-600">Show only issues requiring attention</span>
        </label>
      </div>

      {/* Main Sections */}
      <div className="p-4">
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
          Main Report Sections
        </h3>
        <div className="space-y-2">
          {mainSections.map(section => (
            <SectionItem
              key={section.section_id}
              section={section}
              statusConfig={statusConfig}
              tierColors={tierColors}
              expanded={expandedSections.has(section.section_id)}
              onToggle={() => toggleSection(section.section_id)}
            />
          ))}
        </div>
      </div>

      {/* Appendices */}
      {appendices.length > 0 && (
        <div className="p-4 border-t">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
            Appendices
          </h3>
          <div className="space-y-2">
            {appendices.map(section => (
              <SectionItem
                key={section.section_id}
                section={section}
                statusConfig={statusConfig}
                tierColors={tierColors}
                expanded={expandedSections.has(section.section_id)}
                onToggle={() => toggleSection(section.section_id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionItem({
  section,
  statusConfig,
  tierColors,
  expanded,
  onToggle
}: {
  section: SectionInfo;
  statusConfig: Record<string, { icon: string; color: string; bg: string }>;
  tierColors: Record<string, string>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = statusConfig[section.status];

  return (
    <div className={`border rounded-lg overflow-hidden ${status.bg}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-white/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">{status.icon}</span>
          <div className="text-left">
            <span className="font-medium text-gray-900">{section.section_name}</span>
            {section.required && (
              <span className="ml-2 text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">Required</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Tier badge */}
          <span className={`px-2 py-1 rounded text-xs font-medium ${tierColors[section.tier]}`}>
            {section.tier === 'auto_approved' ? 'Tier 1' :
             section.tier === 'audit_trail' ? 'Tier 2' : 'Tier 3'}
          </span>

          {/* Confidence bar */}
          <div className="w-20">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    section.confidence >= 0.95 ? 'bg-green-500' :
                    section.confidence >= 0.90 ? 'bg-yellow-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${section.confidence * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 w-8 text-right">
                {Math.round(section.confidence * 100)}%
              </span>
            </div>
          </div>

          {/* Expand icon */}
          <svg
            className={`w-5 h-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t bg-white/80">
          {/* Source file info */}
          {section.source_file && (
            <div className="flex items-center gap-2 text-sm text-gray-600 mb-2">
              <span className="font-medium">Source:</span>
              <span>{section.source_file}</span>
              {section.pages && <span className="text-gray-400">• Pages {section.pages}</span>}
            </div>
          )}

          {/* AI Summary */}
          {section.ai_summary && (
            <div className="mt-2">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                AI Summary
              </div>
              <p className="text-sm text-gray-700 bg-blue-50 p-3 rounded border border-blue-100">
                {section.ai_summary}
              </p>
            </div>
          )}

          {/* AI Note (for issues) */}
          {section.ai_note && (
            <div className="mt-2">
              <div className="text-xs font-medium text-red-600 uppercase tracking-wide mb-1">
                Issue Details
              </div>
              <p className="text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200">
                {section.ai_note}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
