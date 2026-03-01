/**
 * SQLite-backed state management for the pipeline.
 *
 * Uses sql.js (pure WebAssembly SQLite) for zero-native-dependency operation.
 *
 * Tracks:
 * - Project status through the pipeline
 * - Document classifications
 * - QA results
 * - API usage / cost tracking
 * - Dashboard notifications
 *
 * The database is persisted to disk on every write operation.
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import type {
  ProjectStatus,
  Priority,
  ProjectSummary,
  PipelineStep,
  APIUsageRecord,
  DashboardNotification,
} from '../types/pipeline.js';
import type {
  ClassificationResult,
  DocumentType,
  ReportSection,
  QAResult,
} from '../types/documents.js';
import type { EvidencePack } from './evidence-extractor.js';

const logger = pino({ name: 'StateManager', level: process.env.LOG_LEVEL || 'info' });

export class StateManager {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private initialized: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Must be called before using any other methods */
  async init(): Promise<void> {
    const SQL = await initSqlJs();

    // Load existing database if it exists
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      // Ensure directory exists
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new SQL.Database();
    }

    this.initializeSchema();
    this.initialized = true;
    logger.info({ dbPath: this.dbPath }, 'StateManager initialized');
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('StateManager not initialized — call init() first');
    }
  }

  private persist(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        client_name TEXT NOT NULL DEFAULT '',
        property_address TEXT NOT NULL DEFAULT '',
        report_type TEXT NOT NULL DEFAULT 'ESAI',
        is_sba_loan INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new',
        priority TEXT NOT NULL DEFAULT 'normal',
        ftp_path TEXT NOT NULL DEFAULT '',
        local_path TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0,
        output_pdf_path TEXT,
        output_docx_path TEXT,
        estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        local_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        document_type TEXT,
        confidence REAL,
        reasoning TEXT,
        date_detected TEXT,
        project_id_detected TEXT,
        page_count INTEGER NOT NULL DEFAULT 0,
        suggested_section TEXT,
        suggested_appendix TEXT,
        needs_manual_review INTEGER NOT NULL DEFAULT 0,
        classification_metadata TEXT DEFAULT '{}',
        manual_override_type TEXT,
        manual_override_section TEXT,
        manual_override_by TEXT,
        manual_override_at TEXT,
        included INTEGER NOT NULL DEFAULT 1,
        section_assignment TEXT,
        order_index INTEGER,
        assignment_rationale TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS qa_results (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0.0,
        critical_issues TEXT NOT NULL DEFAULT '[]',
        warnings TEXT NOT NULL DEFAULT '[]',
        suggestions TEXT NOT NULL DEFAULT '[]',
        cross_contamination TEXT NOT NULL DEFAULT '[]',
        missing_sections TEXT NOT NULL DEFAULT '[]',
        input_pages INTEGER NOT NULL DEFAULT 0,
        output_pages INTEGER NOT NULL DEFAULT 0,
        generated_pages INTEGER NOT NULL DEFAULT 0,
        page_match INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        step TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        read INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS evidence_cache (
        sha256 TEXT PRIMARY KEY,
        sample_texts TEXT NOT NULL,
        pdf_title TEXT,
        pdf_author TEXT,
        total_chars INTEGER NOT NULL,
        pages_read INTEGER NOT NULL,
        is_likely_scanned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS classification_cache (
        sha256 TEXT PRIMARY KEY,
        document_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        reasoning TEXT NOT NULL,
        suggested_section TEXT NOT NULL,
        needs_manual_review INTEGER NOT NULL DEFAULT 0,
        is_sba_specific INTEGER NOT NULL DEFAULT 0,
        classified_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Create indexes
    this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_qa_results_project ON qa_results(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_project ON api_usage(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_notifications_project ON notifications(project_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)');

    this.persist();
  }

  /** Helper to run a query and get rows as objects */
  private query(sql: string, params: any[] = []): any[] {
    this.ensureInit();
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row);
    }
    stmt.free();
    return rows;
  }

  /** Helper to run a query that returns a single row */
  private queryOne(sql: string, params: any[] = []): any | null {
    const rows = this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /** Helper to execute a statement (INSERT, UPDATE, DELETE) */
  private execute(sql: string, params: any[] = []): void {
    this.ensureInit();
    this.db.run(sql, params);
    this.persist();
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  createProject(data: {
    id: string;
    name?: string;
    clientName?: string;
    propertyAddress?: string;
    ftpPath: string;
    localPath: string;
    priority?: Priority;
  }): void {
    this.execute(
      `INSERT INTO projects (id, name, client_name, property_address, ftp_path, local_path, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.name ?? data.id,
        data.clientName ?? '',
        data.propertyAddress ?? '',
        data.ftpPath,
        data.localPath,
        data.priority ?? 'normal',
      ]
    );
    logger.info({ projectId: data.id }, 'Project created');
  }

  getProject(id: string): ProjectRow | null {
    return this.queryOne('SELECT * FROM projects WHERE id = ?', [id]) as ProjectRow | null;
  }

  updateProjectStatus(id: string, status: ProjectStatus, errorMessage?: string): void {
    if (errorMessage !== undefined) {
      if (status === 'complete') {
        this.execute(
          `UPDATE projects SET status = ?, error_message = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?`,
          [status, errorMessage, id]
        );
      } else {
        this.execute(
          `UPDATE projects SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?`,
          [status, errorMessage, id]
        );
      }
    } else {
      if (status === 'complete') {
        this.execute(
          `UPDATE projects SET status = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?`,
          [status, id]
        );
      } else {
        this.execute(
          `UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?`,
          [status, id]
        );
      }
    }
    logger.info({ projectId: id, status }, 'Project status updated');
  }

  updateProjectField(id: string, field: string, value: any): void {
    const allowed = [
      'name', 'client_name', 'property_address', 'file_count',
      'output_pdf_path', 'output_docx_path', 'estimated_cost_usd', 'priority'
    ];
    if (!allowed.includes(field)) {
      throw new Error(`Cannot update field: ${field}`);
    }
    this.execute(
      `UPDATE projects SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`,
      [value, id]
    );
  }

  listProjects(status?: ProjectStatus): ProjectRow[] {
    if (status) {
      return this.query('SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC', [status]);
    }
    return this.query('SELECT * FROM projects ORDER BY created_at DESC');
  }

  getProjectSummaries(): ProjectSummary[] {
    const rows = this.query(`
      SELECT
        p.id, p.name, p.client_name, p.status, p.priority, p.file_count,
        p.estimated_cost_usd, p.created_at, p.updated_at
      FROM projects p
      ORDER BY
        CASE p.priority WHEN 'rush' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        p.created_at DESC
    `);

    return rows.map((r: any) => {
      // Get document counts
      const docCountRow = this.queryOne(
        'SELECT COUNT(*) as cnt FROM documents WHERE project_id = ?',
        [r.id]
      );
      const reviewCountRow = this.queryOne(
        'SELECT COUNT(*) as cnt FROM documents WHERE project_id = ? AND needs_manual_review = 1',
        [r.id]
      );
      const qaRow = this.queryOne(
        'SELECT score, passed FROM qa_results WHERE project_id = ? ORDER BY checked_at DESC LIMIT 1',
        [r.id]
      );

      return {
        id: r.id,
        name: r.name,
        clientName: r.client_name,
        status: r.status as ProjectStatus,
        priority: r.priority as Priority,
        fileCount: r.file_count,
        classifiedCount: docCountRow?.cnt ?? 0,
        needsReviewCount: reviewCountRow?.cnt ?? 0,
        qaScore: qaRow?.score ?? null,
        qaPassed: qaRow ? Boolean(qaRow.passed) : null,
        estimatedCostUsd: r.estimated_cost_usd,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
      };
    });
  }

  // ── Documents ────────────────────────────────────────────────────────────

  addDocument(data: {
    projectId: string;
    filename: string;
    localPath: string;
    sizeBytes: number;
    sha256: string;
    pageCount?: number;
  }): string {
    const id = uuidv4();
    this.execute(
      `INSERT INTO documents (id, project_id, filename, local_path, size_bytes, sha256, page_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, data.projectId, data.filename, data.localPath, data.sizeBytes, data.sha256, data.pageCount ?? 0]
    );
    return id;
  }

  updateDocumentClassification(docId: string, result: ClassificationResult): void {
    this.execute(
      `UPDATE documents SET
        document_type = ?, confidence = ?, reasoning = ?,
        date_detected = ?, project_id_detected = ?, page_count = ?,
        suggested_section = ?,
        needs_manual_review = ?, classification_metadata = ?
       WHERE id = ?`,
      [
        result.documentType, result.confidence, result.reasoning,
        result.dateDetected, result.projectIdDetected, result.pageCount,
        result.suggestedSection,
        result.needsManualReview ? 1 : 0, JSON.stringify(result.metadata),
        docId,
      ]
    );
  }

  updateDocumentOverride(docId: string, type: DocumentType, section: ReportSection, by: string): void {
    this.execute(
      `UPDATE documents SET
        manual_override_type = ?, manual_override_section = ?,
        manual_override_by = ?, manual_override_at = datetime('now')
       WHERE id = ?`,
      [type, section, by, docId]
    );
  }

  updateDocumentIncluded(docId: string, included: boolean): void {
    this.execute('UPDATE documents SET included = ? WHERE id = ?', [included ? 1 : 0, docId]);
  }

  updateDocumentAssignment(docId: string, section: ReportSection, orderIndex: number, rationale: string): void {
    this.execute(
      `UPDATE documents SET section_assignment = ?, order_index = ?, assignment_rationale = ?
       WHERE id = ?`,
      [section, orderIndex, rationale, docId]
    );
  }

  getDocuments(projectId: string): DocumentRow[] {
    return this.query(
      'SELECT * FROM documents WHERE project_id = ? ORDER BY order_index ASC, filename ASC',
      [projectId]
    );
  }

  getDocumentsNeedingReview(projectId: string): DocumentRow[] {
    return this.query(
      'SELECT * FROM documents WHERE project_id = ? AND needs_manual_review = 1 ORDER BY filename',
      [projectId]
    );
  }

  // ── QA Results ───────────────────────────────────────────────────────────

  saveQAResult(projectId: string, result: QAResult): void {
    const id = uuidv4();
    this.execute(
      `INSERT INTO qa_results (
        id, project_id, passed, score,
        critical_issues, warnings, suggestions,
        cross_contamination, missing_sections,
        input_pages, output_pages, generated_pages, page_match
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, projectId,
        result.passed ? 1 : 0, result.score,
        JSON.stringify(result.criticalIssues),
        JSON.stringify(result.warnings),
        JSON.stringify(result.suggestions),
        JSON.stringify(result.crossContamination),
        JSON.stringify(result.missingSections),
        result.pageCountVerification.inputPages,
        result.pageCountVerification.outputPages,
        result.pageCountVerification.generatedPages,
        result.pageCountVerification.match ? 1 : 0,
      ]
    );
  }

  getLatestQAResult(projectId: string): QAResult | null {
    const row = this.queryOne(
      'SELECT * FROM qa_results WHERE project_id = ? ORDER BY checked_at DESC LIMIT 1',
      [projectId]
    );

    if (!row) return null;

    return {
      passed: Boolean(row.passed),
      score: row.score,
      criticalIssues: JSON.parse(row.critical_issues),
      warnings: JSON.parse(row.warnings),
      suggestions: JSON.parse(row.suggestions),
      crossContamination: JSON.parse(row.cross_contamination),
      missingSections: JSON.parse(row.missing_sections),
      pageCountVerification: {
        inputPages: row.input_pages,
        outputPages: row.output_pages,
        generatedPages: row.generated_pages,
        match: Boolean(row.page_match),
      },
      checkedAt: new Date(row.checked_at),
    };
  }

  // ── API Usage ────────────────────────────────────────────────────────────

  recordAPIUsage(record: APIUsageRecord): void {
    const id = uuidv4();
    this.execute(
      `INSERT INTO api_usage (id, project_id, step, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, record.projectId, record.step, record.model, record.inputTokens, record.outputTokens, record.costUsd]
    );

    // Update project estimated cost
    const costRow = this.queryOne(
      'SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE project_id = ?',
      [record.projectId]
    );
    this.execute(
      'UPDATE projects SET estimated_cost_usd = ? WHERE id = ?',
      [costRow?.total ?? 0, record.projectId]
    );
  }

  getProjectCost(projectId: string): number {
    const row = this.queryOne(
      'SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE project_id = ?',
      [projectId]
    );
    return row?.total ?? 0;
  }

  // ── Notifications ────────────────────────────────────────────────────────

  addNotification(projectId: string, type: 'info' | 'warning' | 'error' | 'success', message: string): string {
    const id = uuidv4();
    this.execute(
      `INSERT INTO notifications (id, project_id, type, message)
       VALUES (?, ?, ?, ?)`,
      [id, projectId, type, message]
    );
    return id;
  }

  getNotifications(limit = 50): DashboardNotification[] {
    const rows = this.query(
      'SELECT * FROM notifications ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );

    return rows.map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      type: r.type,
      message: r.message,
      timestamp: new Date(r.timestamp),
      read: Boolean(r.read),
    }));
  }

  markNotificationRead(id: string): void {
    this.execute('UPDATE notifications SET read = 1 WHERE id = ?', [id]);
  }

  // ── Classification Cache ──────────────────────────────────────────────────

  /**
   * Look up a previous classification result by file SHA-256.
   * Returns null if not found or if sha256 is empty.
   */
  getCachedClassification(sha256: string): ClassificationResult | null {
    if (!sha256) return null;
    const row = this.queryOne(
      'SELECT * FROM classification_cache WHERE sha256 = ?',
      [sha256]
    );
    if (!row) return null;

    return {
      documentType: row.document_type as ClassificationResult['documentType'],
      confidence: row.confidence,
      reasoning: row.reasoning,
      dateDetected: null,
      projectIdDetected: null,
      pageCount: 0, // file-specific — caller must override if needed
      pageRange: { start: 1, end: 0 },
      suggestedSection: row.suggested_section as ClassificationResult['suggestedSection'],
      needsManualReview: Boolean(row.needs_manual_review),
      isSbaSpecific: Boolean(row.is_sba_specific),
      metadata: { classifiedBy: row.classified_by, fromCache: 'true' },
    };
  }

  /**
   * Store a classification result in the SHA-256 cache for future reuse.
   * Silently skips if sha256 is empty.
   */
  setCachedClassification(
    sha256: string,
    result: ClassificationResult,
    classifiedBy: string
  ): void {
    if (!sha256) return;
    this.execute(
      `INSERT OR REPLACE INTO classification_cache
        (sha256, document_type, confidence, reasoning, suggested_section,
         needs_manual_review, is_sba_specific, classified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sha256,
        result.documentType,
        result.confidence,
        result.reasoning,
        result.suggestedSection,
        result.needsManualReview ? 1 : 0,
        result.isSbaSpecific ? 1 : 0,
        classifiedBy,
      ]
    );
  }

  // ── Evidence Cache ────────────────────────────────────────────────────────

  /**
   * Look up cached evidence pack data by SHA-256.
   * Returns null if not found or sha256 is empty.
   * Caller must merge with pageCount/fileSizeBytes from the document row.
   */
  getEvidenceCache(
    sha256: string
  ): Pick<EvidencePack, 'sampleTexts' | 'pdfTitle' | 'pdfAuthor' | 'totalChars' | 'pagesRead' | 'isLikelyScanned'> | null {
    if (!sha256) return null;
    const row = this.queryOne('SELECT * FROM evidence_cache WHERE sha256 = ?', [sha256]);
    if (!row) return null;
    return {
      sampleTexts: JSON.parse(row.sample_texts),
      pdfTitle: row.pdf_title ?? undefined,
      pdfAuthor: row.pdf_author ?? undefined,
      totalChars: row.total_chars,
      pagesRead: row.pages_read,
      isLikelyScanned: Boolean(row.is_likely_scanned),
    };
  }

  /**
   * Store evidence pack data in the cache for future reuse (avoids re-reading PDF).
   * Silently skips if sha256 is empty.
   */
  setEvidenceCache(sha256: string, pack: EvidencePack): void {
    if (!sha256) return;
    this.execute(
      `INSERT OR REPLACE INTO evidence_cache
        (sha256, sample_texts, pdf_title, pdf_author, total_chars, pages_read, is_likely_scanned)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sha256,
        JSON.stringify(pack.sampleTexts),
        pack.pdfTitle ?? null,
        pack.pdfAuthor ?? null,
        pack.totalChars,
        pack.pagesRead,
        pack.isLikelyScanned ? 1 : 0,
      ]
    );
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  close(): void {
    if (this.db) {
      this.persist();
      this.db.close();
    }
    logger.info('StateManager closed');
  }
}

// ── Row types (raw DB rows before transformation) ─────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  client_name: string;
  property_address: string;
  report_type: string;
  is_sba_loan: number;
  status: string;
  priority: string;
  ftp_path: string;
  local_path: string;
  file_count: number;
  output_pdf_path: string | null;
  output_docx_path: string | null;
  estimated_cost_usd: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DocumentRow {
  id: string;
  project_id: string;
  filename: string;
  local_path: string;
  size_bytes: number;
  sha256: string;
  document_type: string | null;
  confidence: number | null;
  reasoning: string | null;
  date_detected: string | null;
  project_id_detected: string | null;
  page_count: number;
  suggested_section: string | null;
  suggested_appendix: string | null;
  needs_manual_review: number;
  classification_metadata: string;
  manual_override_type: string | null;
  manual_override_section: string | null;
  manual_override_by: string | null;
  manual_override_at: string | null;
  included: number;
  section_assignment: string | null;
  order_index: number | null;
  assignment_rationale: string | null;
  created_at: string;
}
