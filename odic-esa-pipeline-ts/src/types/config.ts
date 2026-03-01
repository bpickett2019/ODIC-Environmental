/**
 * Configuration schema types for the ODIC ESA Pipeline.
 * These mirror the structure in config.yaml.
 */

/** Configuration for the local SFTP server (dev/testing) */
export interface SFTPServerConfig {
  /** Whether the local SFTP server is enabled */
  enabled: boolean;
  /** Port to listen on (default 2222) */
  port: number;
  /** Username for SFTP authentication */
  username: string;
  /** Password for SFTP authentication */
  password: string;
  /** Path to the SSH host key file (generated on first run) */
  host_key_path: string;
}

/** Event emitted when a file is received via SFTP or folder watch */
export interface FileReceivedEvent {
  /** Project ID extracted from the directory name (e.g. "6384578-ESAI-SiteName") */
  projectId: string;
  /** Original filename of the uploaded file */
  filename: string;
  /** Full local path to the received file */
  localPath: string;
  /** Timestamp of when the file was received */
  receivedAt: Date;
}

export interface FTPConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Directory on FTP server to watch for new projects */
  watch_directory: string;
  /** How often to check for new files (seconds) */
  poll_interval_seconds: number;
  /** Local directory to download files into */
  download_directory: string;
  /** Protocol: sftp or ftp */
  protocol: 'sftp' | 'ftp';
  /** Local SFTP server configuration (dev/testing) */
  server?: SFTPServerConfig;
  /** Watch mode: "sftp" runs the local SFTP server, "folder" just watches a local directory */
  watch_mode?: 'sftp' | 'folder';
}

export interface LLMConfig {
  /** Environment variable name containing the Anthropic API key */
  api_key_env: string;
  /** Model ID for fast/cheap classification tasks */
  classifier_model: string;
  /** Model ID for reasoning/generation tasks */
  reasoning_model: string;
  /** Max retries on API failure */
  max_retries: number;
  /** Timeout per API call in seconds */
  timeout_seconds: number;
  /** Max pages of text to extract for classification */
  max_pages_for_classification: number;
  /** Max page images to send for visual classification */
  max_images_for_classification: number;
}

export interface PipelineConfig {
  /** Base directory for project working files */
  project_base_dir: string;
  /** Directory for completed report output */
  output_dir: string;
  /** Max projects to process simultaneously */
  max_concurrent_projects: number;
  /** If false, pause after triage for Rose's approval */
  auto_assemble_when_complete: boolean;
  /** Halt pipeline if input pages ≠ output pages */
  page_integrity_check: boolean;
  /** Number of parallel classification calls (default: 8) */
  classification_concurrency: number;
  /** Max LLM calls for classification per project run (default: 2) */
  max_llm_calls_per_project: number;
  /** Max LLM calls for classification across all projects in a session (default: 10) */
  max_llm_calls_per_run: number;
}

export interface QAConfig {
  /** Minimum number of report sections required to pass */
  minimum_sections_required: number;
  /** Require site photographs */
  require_site_photos: boolean;
  /** Require EDR report */
  require_edr: boolean;
  /** Require topographic maps */
  require_topo: boolean;
  /** Score threshold for passing QA (0-1) */
  minimum_passing_score: number;
}

export interface CompressionConfig {
  enabled: boolean;
  /** Max output file size in MB */
  max_file_size_mb: number;
  /** Target DPI for image downsampling */
  target_dpi: number;
}

export interface NotificationConfig {
  type: 'email' | 'slack' | 'none';
  recipients: string[];
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_pass_env?: string;
  slack_webhook_env?: string;
}

export interface DashboardConfig {
  host: string;
  port: number;
}

export interface ResearchConfig {
  /** Geocoding provider: 'nominatim' (free) or 'google' (requires key) */
  geocoding_provider: 'nominatim' | 'google';
  /** Env var name for Google Maps API key (optional) */
  google_maps_api_key_env: string;
  /** Search radius in miles for EPA database queries */
  epa_search_radius_miles: number;
  /** Max images per document for vision analysis */
  max_vision_images_per_doc: number;
  /** Max pixel width for images sent to vision AI */
  vision_image_max_width: number;
  /** Whether to fetch satellite imagery (requires Google Maps key) */
  enable_satellite_imagery: boolean;
  /** Whether to query CA-specific databases (EnviroStor, GeoTracker) */
  enable_california_databases: boolean;
}

export interface EmailDeliveryConfig {
  /** Whether email delivery is enabled */
  enabled: boolean;
  /** Email provider */
  provider: 'smtp' | 'gmail' | 'sendgrid';
  /** Sender display name */
  from_name: string;
  /** Sender email address */
  from_email: string;
  /** Reply-to address */
  reply_to?: string;
  /** CC list for internal team */
  cc_list: string[];
  /** BCC list */
  bcc_list: string[];
  /** Auto-send when pipeline completes */
  auto_deliver: boolean;
  /** SMTP configuration */
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass_env: string;
  };
  /** Gmail OAuth2 configuration */
  gmail?: {
    user: string;
    client_id_env: string;
    client_secret_env: string;
    refresh_token_env: string;
  };
  /** SendGrid configuration */
  sendgrid?: {
    api_key_env: string;
  };
  /** Rate limiting */
  rate_limit: {
    max_per_hour: number;
    max_per_day: number;
  };
}

export interface AppConfig {
  ftp: FTPConfig;
  llm: LLMConfig;
  pipeline: PipelineConfig;
  qa: QAConfig;
  compression: CompressionConfig;
  notifications: NotificationConfig;
  dashboard: DashboardConfig;
  research: ResearchConfig;
  email_delivery: EmailDeliveryConfig;
}
