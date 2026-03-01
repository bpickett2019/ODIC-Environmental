/**
 * Config loader — reads YAML configuration files and validates them.
 *
 * Supports:
 * - Loading the main app config (config.yaml)
 * - Loading the report templates (esa-template.yaml) — multi-report-type
 * - Loading document type definitions (document-types.yaml)
 * - Environment variable interpolation for secrets
 * - Sensible defaults for missing optional values
 */

import yaml from 'js-yaml';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import type { AppConfig, ReportType } from '../types/index.js';

const logger = pino({ name: 'ConfigLoader', level: process.env.LOG_LEVEL || 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Directory containing config YAML files */
const CONFIG_DIR = path.resolve(__dirname, '..', 'config');

/**
 * Load and validate the main application config.
 * Merges defaults with the YAML file.
 *
 * @param overridePath Optional custom path to config.yaml
 */
export async function loadAppConfig(overridePath?: string): Promise<AppConfig> {
  const configPath = overridePath ?? path.join(CONFIG_DIR, 'config.yaml');

  logger.info({ configPath }, 'Loading application config');

  let rawConfig: Record<string, any>;

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    rawConfig = yaml.load(content) as Record<string, any>;
  } catch (err) {
    logger.warn({ configPath }, 'Config file not found or invalid, using defaults');
    rawConfig = {};
  }

  const config: AppConfig = {
    ftp: {
      host: rawConfig?.ftp?.host ?? '',
      port: rawConfig?.ftp?.port ?? 22,
      username: rawConfig?.ftp?.username ?? '',
      password: rawConfig?.ftp?.password ?? '',
      protocol: rawConfig?.ftp?.protocol ?? 'sftp',
      watch_directory: rawConfig?.ftp?.watch_directory ?? '/incoming',
      poll_interval_seconds: rawConfig?.ftp?.poll_interval_seconds ?? 30,
      download_directory: rawConfig?.ftp?.download_directory ?? './downloads',
    },
    llm: {
      api_key_env: rawConfig?.llm?.api_key_env ?? 'ANTHROPIC_API_KEY',
      classifier_model: rawConfig?.llm?.classifier_model ?? 'claude-haiku-4-5-20251001',
      reasoning_model: rawConfig?.llm?.reasoning_model ?? 'claude-sonnet-4-5-20250929',
      max_retries: rawConfig?.llm?.max_retries ?? 3,
      timeout_seconds: rawConfig?.llm?.timeout_seconds ?? 120,
      max_pages_for_classification: rawConfig?.llm?.max_pages_for_classification ?? 10,
      max_images_for_classification: rawConfig?.llm?.max_images_for_classification ?? 3,
    },
    pipeline: {
      project_base_dir: rawConfig?.pipeline?.project_base_dir ?? './projects',
      output_dir: rawConfig?.pipeline?.output_dir ?? './completed_reports',
      max_concurrent_projects: rawConfig?.pipeline?.max_concurrent_projects ?? 5,
      auto_assemble_when_complete: rawConfig?.pipeline?.auto_assemble_when_complete ?? false,
      page_integrity_check: rawConfig?.pipeline?.page_integrity_check ?? true,
      classification_concurrency: rawConfig?.pipeline?.classification_concurrency ?? 8,
      max_llm_calls_per_project: rawConfig?.pipeline?.max_llm_calls_per_project ?? 2,
      max_llm_calls_per_run: rawConfig?.pipeline?.max_llm_calls_per_run ?? 10,
    },
    qa: {
      minimum_sections_required: rawConfig?.qa?.minimum_sections_required ?? 8,
      require_site_photos: rawConfig?.qa?.require_site_photos ?? true,
      require_edr: rawConfig?.qa?.require_edr ?? true,
      require_topo: rawConfig?.qa?.require_topo ?? true,
      minimum_passing_score: rawConfig?.qa?.minimum_passing_score ?? 0.80,
    },
    compression: {
      enabled: rawConfig?.compression?.enabled ?? true,
      max_file_size_mb: rawConfig?.compression?.max_file_size_mb ?? 50,
      target_dpi: rawConfig?.compression?.target_dpi ?? 150,
    },
    notifications: {
      type: rawConfig?.notifications?.type ?? 'none',
      recipients: rawConfig?.notifications?.recipients ?? [],
      smtp_host: rawConfig?.notifications?.smtp_host,
      smtp_port: rawConfig?.notifications?.smtp_port,
      smtp_user: rawConfig?.notifications?.smtp_user,
      smtp_pass_env: rawConfig?.notifications?.smtp_pass_env,
      slack_webhook_env: rawConfig?.notifications?.slack_webhook_env,
    },
    dashboard: {
      host: rawConfig?.dashboard?.host ?? '0.0.0.0',
      port: rawConfig?.dashboard?.port ?? 8080,
    },
    research: {
      geocoding_provider: rawConfig?.research?.geocoding_provider ?? 'nominatim',
      google_maps_api_key_env: rawConfig?.research?.google_maps_api_key_env ?? 'GOOGLE_MAPS_API_KEY',
      epa_search_radius_miles: rawConfig?.research?.epa_search_radius_miles ?? 1.0,
      max_vision_images_per_doc: rawConfig?.research?.max_vision_images_per_doc ?? 4,
      vision_image_max_width: rawConfig?.research?.vision_image_max_width ?? 1024,
      enable_satellite_imagery: rawConfig?.research?.enable_satellite_imagery ?? true,
      enable_california_databases: rawConfig?.research?.enable_california_databases ?? true,
    },
    email_delivery: {
      enabled: rawConfig?.email_delivery?.enabled ?? false,
      provider: rawConfig?.email_delivery?.provider ?? 'smtp',
      from_name: rawConfig?.email_delivery?.from_name ?? 'ODIC Environmental',
      from_email: rawConfig?.email_delivery?.from_email ?? '',
      reply_to: rawConfig?.email_delivery?.reply_to,
      cc_list: rawConfig?.email_delivery?.cc_list ?? [],
      bcc_list: rawConfig?.email_delivery?.bcc_list ?? [],
      auto_deliver: rawConfig?.email_delivery?.auto_deliver ?? false,
      smtp: rawConfig?.email_delivery?.smtp,
      gmail: rawConfig?.email_delivery?.gmail,
      sendgrid: rawConfig?.email_delivery?.sendgrid,
      rate_limit: {
        max_per_hour: rawConfig?.email_delivery?.rate_limit?.max_per_hour ?? 10,
        max_per_day: rawConfig?.email_delivery?.rate_limit?.max_per_day ?? 50,
      },
    },
  };

  logger.info(
    {
      classifierModel: config.llm.classifier_model,
      reasoningModel: config.llm.reasoning_model,
      dashboardPort: config.dashboard.port,
    },
    'Config loaded'
  );

  return config;
}

// ─── Report Template Types ──────────────────────────────────────────────────

export interface TemplateSubsection {
  number: string;
  title: string;
}

export interface TemplateFrontMatterItem {
  id: string;
  title: string;
  type: 'generated' | 'uploaded';
  required: boolean;
  condition?: string;
  description?: string;
  document_types?: string[];
}

export interface TemplateTOC {
  id: string;
  title: string;
  type: string;
  description?: string;
}

export interface TemplateSection {
  id: string;
  number: string;
  title: string;
  type: string;
  required: boolean;
  description?: string;
  condition?: string;
  subsections?: TemplateSubsection[];
}

export interface TemplateAppendix {
  id: string;
  letter: string;
  title: string;
  required: boolean;
  document_types?: string[];
  ordering?: string;
  description?: string;
}

export interface ReportTypeTemplate {
  id: string;
  title: string;
  standard?: string;
  front_matter: TemplateFrontMatterItem[];
  toc: TemplateTOC;
  sections: TemplateSection[];
  appendices: TemplateAppendix[];
}

export interface FormattingConfig {
  page_header: string;
  project_number_line: string;
  page_number_format: string;
  footer: string;
  section_headers: {
    major: { bold: boolean; size: number };
    subsection: { bold: boolean; size: number; small_caps?: boolean };
  };
  tables: {
    header_background: string;
    border: boolean;
  };
  appendix_dividers: {
    header: string;
    appendix_label: string;
    subtitle_style: string;
  };
  photo_grid: {
    columns: number;
    rows: number;
    caption_below: boolean;
    header: string;
  };
}

export interface ESATemplate {
  company: string;
  company_address: string;
  company_phone: string;
  standard: string;
  report_types: ReportTypeTemplate[];
  formatting: FormattingConfig;
}

// ─── Legacy compatibility ───────────────────────────────────────────────────

/** For backward compatibility, these aliases point to individual template pieces */
export type ESATemplateSection = TemplateSection;
export type ESATemplateAppendix = TemplateAppendix;

/**
 * Load the report template configuration.
 * Contains assembly instructions for all report types.
 */
export async function loadESATemplate(overridePath?: string): Promise<ESATemplate> {
  const templatePath = overridePath ?? path.join(CONFIG_DIR, 'esa-template.yaml');

  logger.info({ templatePath }, 'Loading report templates');

  const content = await fs.readFile(templatePath, 'utf-8');
  const template = yaml.load(content) as ESATemplate;

  logger.info(
    {
      reportTypes: template.report_types.map(rt => rt.id),
      reportTypeCount: template.report_types.length,
    },
    'Report templates loaded'
  );

  return template;
}

/**
 * Get the template for a specific report type.
 */
export function getReportTypeTemplate(
  template: ESATemplate,
  reportType: ReportType
): ReportTypeTemplate | undefined {
  // Handle PHASE2 → ESAII alias
  const typeId = reportType === 'PHASE2' ? 'ESAII' : reportType;
  return template.report_types.find(rt => rt.id === typeId);
}

// ─── Document Type Definitions ──────────────────────────────────────────────

/** Parsed document type definition */
export interface DocumentTypeDefinition {
  id: string;
  label: string;
  description: string;
  visual_hints?: string[];
  text_hints?: string[];
  typical_date_range?: string;
  default_section: string;
}

export interface DocumentTypesConfig {
  document_types: DocumentTypeDefinition[];
  thresholds: {
    auto_classify: number;
    needs_review: number;
    reject: number;
  };
}

/**
 * Load document type definitions.
 */
export async function loadDocumentTypes(overridePath?: string): Promise<DocumentTypesConfig> {
  const typesPath = overridePath ?? path.join(CONFIG_DIR, 'document-types.yaml');

  logger.info({ typesPath }, 'Loading document type definitions');

  const content = await fs.readFile(typesPath, 'utf-8');
  const config = yaml.load(content) as DocumentTypesConfig;

  logger.info(
    { typeCount: config.document_types.length },
    'Document types loaded'
  );

  return config;
}
