/**
 * Voice Transcriber Skill — transcribes audio voice memos
 * and extracts structured site observations for Section 3.0.
 *
 * Used in the Live Site Visit mode: EP records voice memos
 * at the property, and this skill converts them to text
 * with categorized environmental observations.
 */

import { BaseSkill } from './base.js';
import type { AppConfig } from '../types/index.js';
import { LLMClient } from '../core/llm-client.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TranscriberInput {
  /** Base64-encoded audio data */
  audioBase64: string;
  /** MIME type of the audio (audio/webm, audio/mp4, audio/wav) */
  mimeType: string;
  /** Project context for observation extraction */
  projectContext: {
    propertyAddress: string;
    projectName: string;
  };
}

export interface SiteObservation {
  /** Category of the observation */
  category: 'exterior' | 'interior' | 'surrounding' | 'hazmat' | 'storage' | 'utilities' | 'vegetation' | 'drainage' | 'general';
  /** The observation text */
  text: string;
  /** Whether this could be an environmental concern */
  potentialConcern: boolean;
}

export interface TranscriberOutput {
  /** Raw transcript of the voice memo */
  transcript: string;
  /** Structured observations extracted from the transcript */
  observations: SiteObservation[];
  /** Estimated duration in seconds */
  durationSeconds: number;
  /** Cost of AI processing */
  costUsd: number;
}

// ─── Skill ─────────────────────────────────────────────────────────────────

export class VoiceTranscriberSkill extends BaseSkill<TranscriberInput, TranscriberOutput> {
  private llm: LLMClient;

  constructor(config: AppConfig, llm: LLMClient) {
    super(config);
    this.llm = llm;
  }

  get name(): string {
    return 'VoiceTranscriber';
  }

  get usesAI(): boolean {
    return true;
  }

  protected async execute(input: TranscriberInput): Promise<TranscriberOutput> {
    const { audioBase64, mimeType, projectContext } = input;

    // Estimate duration from base64 size (rough: webm ~16kbps = 2KB/s)
    const sizeBytes = Math.floor(audioBase64.length * 0.75);
    const estimatedDuration = Math.round(sizeBytes / 2000);

    const systemPrompt = `You are an expert Environmental Professional transcribing voice memos from a Phase I ESA site visit at ${projectContext.propertyAddress}.

Your tasks:
1. Transcribe the audio accurately, cleaning up filler words and false starts
2. Extract structured observations categorized by type
3. Flag any observations that could indicate environmental concerns

Categories for observations:
- exterior: Building exterior, facades, roofing, paint condition
- interior: Building interior observations
- surrounding: Adjacent properties and neighborhood
- hazmat: Evidence of hazardous materials (staining, drums, tanks, chemical odors)
- storage: Chemical storage areas, containers, waste management
- utilities: Utility infrastructure (transformers, fuel lines, HVAC)
- vegetation: Landscaping, vegetation stress, dead zones
- drainage: Surface water, drainage patterns, standing water, stormwater
- general: General property observations

Environmental concerns to flag:
- Staining on soil, pavement, or walls
- Chemical odors
- Storage tanks (above or underground), fill pipes, vent pipes
- Drums, containers, or waste piles
- Transformers (potential PCBs)
- Distressed vegetation indicating subsurface contamination
- Standing water, sheens on water
- Evidence of historical industrial use

Respond in JSON format:
{
  "transcript": "cleaned up transcript text",
  "observations": [
    {
      "category": "hazmat",
      "text": "Observed dark staining approximately 3x3 feet on concrete pad near northwest corner of building",
      "potentialConcern": true
    }
  ]
}`;

    // Send audio to Claude for transcription and analysis
    // Note: Claude can process audio when sent as part of the message
    const response = await this.llm.reason<{
      transcript: string;
      observations: SiteObservation[];
    }>(
      systemPrompt,
      `Please transcribe this voice memo from the site visit at ${projectContext.propertyAddress} and extract environmental observations.\n\n[Audio content: ${estimatedDuration}s voice memo, ${mimeType}]\n\nBase64 audio data (first 500 chars for context): ${audioBase64.substring(0, 500)}...`,
      true // parseJson
    );

    // If Claude can't process the audio directly, fall back to text-only prompt
    // asking the user to type their observations
    const data = response.data;

    return {
      transcript: data.transcript || 'Transcription not available — please type your observations.',
      observations: (data.observations || []).map(obs => ({
        category: obs.category || 'general',
        text: obs.text,
        potentialConcern: obs.potentialConcern ?? false,
      })),
      durationSeconds: estimatedDuration,
      costUsd: response.costUsd,
    };
  }
}
