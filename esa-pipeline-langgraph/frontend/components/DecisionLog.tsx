'use client';

import { useState } from 'react';

interface Decision {
  timestamp: string;
  stage: string;
  action: string;
  tier: 'auto_approved' | 'audit_trail' | 'human_review';
  confidence?: number;
  details?: Record<string, unknown>;
}

interface DecisionLogProps {
  decisions: Decision[];
  expandable?: boolean;
}

export default function DecisionLog({ decisions, expandable = true }: DecisionLogProps) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  const tierConfig = {
    auto_approved: {
      label: 'Auto-Approved',
      color: 'bg-green-100 text-green-800 border-green-200',
      icon: '✅',
      description: 'Tier 1 - Deterministic or high-confidence decision'
    },
    audit_trail: {
      label: 'Audit Trail',
      color: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      icon: '📋',
      description: 'Tier 2 - Auto-approved with logged reasoning'
    },
    human_review: {
      label: 'Human Review',
      color: 'bg-red-100 text-red-800 border-red-200',
      icon: '👁️',
      description: 'Tier 3 - Required human verification'
    }
  };

  const filteredDecisions = filter
    ? decisions.filter(d => d.tier === filter)
    : decisions;

  const tierCounts = {
    auto_approved: decisions.filter(d => d.tier === 'auto_approved').length,
    audit_trail: decisions.filter(d => d.tier === 'audit_trail').length,
    human_review: decisions.filter(d => d.tier === 'human_review').length
  };

  const displayDecisions = expanded ? filteredDecisions : filteredDecisions.slice(0, 5);

  return (
    <div className="bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="p-4 bg-gray-50 border-b">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">AI Decision Log</h3>
          <span className="text-sm text-gray-500">{decisions.length} decisions</span>
        </div>

        {/* Tier summary */}
        <div className="flex gap-3 mt-3">
          {Object.entries(tierConfig).map(([tier, config]) => (
            <button
              key={tier}
              onClick={() => setFilter(filter === tier ? null : tier)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-all ${
                filter === tier ? config.color + ' ring-2 ring-offset-1' : 'bg-gray-100 text-gray-600 border-gray-200'
              }`}
            >
              <span>{config.icon}</span>
              <span>{config.label}</span>
              <span className="font-medium">{tierCounts[tier as keyof typeof tierCounts]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Decision list */}
      <div className="divide-y max-h-96 overflow-y-auto">
        {displayDecisions.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No decisions recorded yet
          </div>
        ) : (
          displayDecisions.map((decision, index) => (
            <DecisionItem key={index} decision={decision} tierConfig={tierConfig} />
          ))
        )}
      </div>

      {/* Show more/less button */}
      {expandable && filteredDecisions.length > 5 && (
        <div className="p-3 bg-gray-50 border-t">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full text-center text-sm text-blue-600 hover:text-blue-800"
          >
            {expanded ? 'Show Less' : `Show ${filteredDecisions.length - 5} More`}
          </button>
        </div>
      )}
    </div>
  );
}

function DecisionItem({
  decision,
  tierConfig
}: {
  decision: Decision;
  tierConfig: Record<string, { label: string; color: string; icon: string; description: string }>;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const config = tierConfig[decision.tier];

  const formatTimestamp = (ts: string) => {
    try {
      const date = new Date(ts);
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  };

  return (
    <div className="p-4 hover:bg-gray-50 transition-colors">
      <div className="flex items-start gap-3">
        {/* Tier indicator */}
        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-lg ${config.color}`}>
          {config.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900">{decision.action}</span>
            <span className={`px-2 py-0.5 rounded text-xs ${config.color}`}>
              {config.label}
            </span>
            {decision.confidence !== undefined && (
              <span className="text-sm text-gray-500">
                {Math.round(decision.confidence * 100)}% confidence
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
            <span className="uppercase tracking-wide">{decision.stage}</span>
            <span>•</span>
            <span>{formatTimestamp(decision.timestamp)}</span>
          </div>

          {/* Details expandable */}
          {decision.details && Object.keys(decision.details).length > 0 && (
            <>
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="mt-2 text-sm text-blue-600 hover:text-blue-800"
              >
                {showDetails ? 'Hide Details' : 'Show Details'}
              </button>

              {showDetails && (
                <div className="mt-2 p-3 bg-gray-100 rounded text-sm">
                  <pre className="whitespace-pre-wrap text-xs text-gray-700 font-mono">
                    {JSON.stringify(decision.details, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
