"""
ODIC ESA Pipeline - State Management

SQLite-based state tracking for documents and projects.
Ensures idempotent processing - reprocessing the same file won't create duplicates.
Tracks which documents have been processed, which projects are complete, what's pending.
"""

import sqlite3
import hashlib
import json
import logging
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, asdict
from enum import Enum
from contextlib import contextmanager


logger = logging.getLogger(__name__)


class DocumentStatus(Enum):
    """Status of a document in the pipeline."""
    PENDING = "pending"           # Detected but not yet processed
    PROCESSING = "processing"     # Currently being processed
    CLASSIFIED = "classified"     # Classification complete
    ORGANIZED = "organized"       # Moved to project folder
    FAILED = "failed"             # Processing failed
    MANUAL_REVIEW = "manual_review"  # Flagged for manual review


class ProjectStatus(Enum):
    """Status of a project."""
    INCOMPLETE = "incomplete"     # Missing required documents
    READY = "ready"               # All required docs present, ready for assembly
    ASSEMBLING = "assembling"     # Report being generated
    QA_PENDING = "qa_pending"     # Awaiting QA review
    COMPLETE = "complete"         # Report finalized
    FAILED = "failed"             # Assembly or QA failed


@dataclass
class DocumentRecord:
    """Record of a document in the system."""
    id: Optional[int]
    file_hash: str                # SHA-256 hash for idempotency
    original_filename: str
    original_path: str
    current_path: Optional[str]
    document_type: Optional[str]
    confidence: Optional[float]
    project_id: Optional[str]
    status: str
    requires_manual_review: bool
    classification_metadata: Optional[str]  # JSON string
    error_message: Optional[str]
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "DocumentRecord":
        """Create DocumentRecord from database row."""
        return cls(
            id=row["id"],
            file_hash=row["file_hash"],
            original_filename=row["original_filename"],
            original_path=row["original_path"],
            current_path=row["current_path"],
            document_type=row["document_type"],
            confidence=row["confidence"],
            project_id=row["project_id"],
            status=row["status"],
            requires_manual_review=bool(row["requires_manual_review"]),
            classification_metadata=row["classification_metadata"],
            error_message=row["error_message"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass
class ProjectRecord:
    """Record of a project in the system."""
    id: Optional[int]
    project_id: str               # e.g., "ODIC-2024-001"
    project_path: Optional[str]
    status: str
    document_count: int
    required_documents: Optional[str]  # JSON list of required doc types
    present_documents: Optional[str]   # JSON list of present doc types
    report_path: Optional[str]
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "ProjectRecord":
        """Create ProjectRecord from database row."""
        return cls(
            id=row["id"],
            project_id=row["project_id"],
            project_path=row["project_path"],
            status=row["status"],
            document_count=row["document_count"],
            required_documents=row["required_documents"],
            present_documents=row["present_documents"],
            report_path=row["report_path"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class StateManager:
    """
    Manages pipeline state using SQLite.

    Features:
    - Idempotent document tracking via file hashes
    - Project status tracking
    - Document-to-project association
    - Query methods for pipeline orchestration
    """

    SCHEMA_VERSION = 1

    def __init__(self, db_path: str = "./pipeline_state.db"):
        """
        Initialize the state manager.

        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_database()

    @contextmanager
    def _get_connection(self):
        """Context manager for database connections."""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_database(self):
        """Initialize database schema."""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Documents table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_hash TEXT UNIQUE NOT NULL,
                    original_filename TEXT NOT NULL,
                    original_path TEXT NOT NULL,
                    current_path TEXT,
                    document_type TEXT,
                    confidence REAL,
                    project_id TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    requires_manual_review INTEGER DEFAULT 0,
                    classification_metadata TEXT,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Projects table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT UNIQUE NOT NULL,
                    project_path TEXT,
                    status TEXT NOT NULL DEFAULT 'incomplete',
                    document_count INTEGER DEFAULT 0,
                    required_documents TEXT,
                    present_documents TEXT,
                    report_path TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Processing log for audit trail
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS processing_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_id INTEGER,
                    project_id TEXT,
                    action TEXT NOT NULL,
                    details TEXT,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (document_id) REFERENCES documents(id)
                )
            """)

            # Schema version tracking
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS schema_info (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            """)

            cursor.execute(
                "INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)",
                ("version", str(self.SCHEMA_VERSION))
            )

            # Create indexes
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)"
            )

            logger.info(f"Database initialized at {self.db_path}")

    @staticmethod
    def compute_file_hash(file_path: str) -> str:
        """
        Compute SHA-256 hash of a file for idempotency.

        Args:
            file_path: Path to the file

        Returns:
            Hex string of SHA-256 hash
        """
        sha256 = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()

    def is_document_processed(self, file_path: str) -> bool:
        """
        Check if a document has already been processed (idempotency check).

        Args:
            file_path: Path to the file

        Returns:
            True if file has been processed before
        """
        file_hash = self.compute_file_hash(file_path)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id FROM documents WHERE file_hash = ?",
                (file_hash,)
            )
            return cursor.fetchone() is not None

    def get_document_by_hash(self, file_hash: str) -> Optional[DocumentRecord]:
        """Get document record by file hash."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()
            return DocumentRecord.from_row(row) if row else None

    def get_document_by_path(self, file_path: str) -> Optional[DocumentRecord]:
        """Get document record by computing file hash."""
        file_hash = self.compute_file_hash(file_path)
        return self.get_document_by_hash(file_hash)

    def add_document(
        self,
        file_path: str,
        status: DocumentStatus = DocumentStatus.PENDING
    ) -> Optional[DocumentRecord]:
        """
        Add a new document to tracking (idempotent).

        Args:
            file_path: Path to the file
            status: Initial status

        Returns:
            DocumentRecord if new, None if already exists
        """
        path = Path(file_path)
        file_hash = self.compute_file_hash(file_path)
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Check if already exists (idempotency)
            cursor.execute(
                "SELECT * FROM documents WHERE file_hash = ?",
                (file_hash,)
            )
            existing = cursor.fetchone()
            if existing:
                logger.debug(f"Document already tracked: {path.name}")
                return None

            # Insert new document
            cursor.execute("""
                INSERT INTO documents (
                    file_hash, original_filename, original_path,
                    status, requires_manual_review, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 0, ?, ?)
            """, (
                file_hash, path.name, str(path),
                status.value, now, now
            ))

            doc_id = cursor.lastrowid

            # Log the action
            self._log_action(
                cursor, doc_id, None, "document_added",
                {"path": str(path), "hash": file_hash}
            )

            logger.info(f"Added document to tracking: {path.name}")

            cursor.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
            return DocumentRecord.from_row(cursor.fetchone())

    def update_document_classification(
        self,
        file_path: str,
        document_type: str,
        confidence: float,
        project_id: Optional[str],
        requires_manual_review: bool,
        metadata: Dict[str, Any]
    ) -> bool:
        """
        Update document with classification results.

        Args:
            file_path: Path to the file
            document_type: Classified document type
            confidence: Classification confidence
            project_id: Associated project ID
            requires_manual_review: Whether manual review is needed
            metadata: Additional classification metadata

        Returns:
            True if updated successfully
        """
        file_hash = self.compute_file_hash(file_path)
        now = datetime.utcnow().isoformat()

        status = (
            DocumentStatus.MANUAL_REVIEW if requires_manual_review
            else DocumentStatus.CLASSIFIED
        )

        with self._get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                UPDATE documents SET
                    document_type = ?,
                    confidence = ?,
                    project_id = ?,
                    status = ?,
                    requires_manual_review = ?,
                    classification_metadata = ?,
                    updated_at = ?
                WHERE file_hash = ?
            """, (
                document_type, confidence, project_id,
                status.value, int(requires_manual_review),
                json.dumps(metadata), now, file_hash
            ))

            if cursor.rowcount == 0:
                logger.warning(f"Document not found for classification update: {file_path}")
                return False

            # Get doc ID for logging
            cursor.execute(
                "SELECT id FROM documents WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()
            if row:
                self._log_action(
                    cursor, row["id"], project_id, "classified",
                    {"type": document_type, "confidence": confidence}
                )

            logger.info(
                f"Classification updated: type={document_type}, "
                f"confidence={confidence:.2f}, project={project_id}"
            )
            return True

    def update_document_organized(
        self,
        file_path: str,
        new_path: str,
        project_id: str
    ) -> bool:
        """
        Update document after it's been organized into a project folder.

        Args:
            file_path: Original file path
            new_path: New path after organization
            project_id: Project it was organized into

        Returns:
            True if updated successfully
        """
        file_hash = self.compute_file_hash(file_path)
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                UPDATE documents SET
                    current_path = ?,
                    project_id = ?,
                    status = ?,
                    updated_at = ?
                WHERE file_hash = ?
            """, (
                new_path, project_id,
                DocumentStatus.ORGANIZED.value, now, file_hash
            ))

            if cursor.rowcount == 0:
                return False

            cursor.execute(
                "SELECT id FROM documents WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()
            if row:
                self._log_action(
                    cursor, row["id"], project_id, "organized",
                    {"new_path": new_path}
                )

            return True

    def mark_document_failed(
        self,
        file_path: str,
        error_message: str
    ) -> bool:
        """Mark a document as failed with error message."""
        file_hash = self.compute_file_hash(file_path)
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                UPDATE documents SET
                    status = ?,
                    error_message = ?,
                    updated_at = ?
                WHERE file_hash = ?
            """, (DocumentStatus.FAILED.value, error_message, now, file_hash))

            return cursor.rowcount > 0

    # Project methods

    def get_or_create_project(
        self,
        project_id: str,
        required_documents: Optional[List[str]] = None
    ) -> ProjectRecord:
        """
        Get existing project or create new one.

        Args:
            project_id: Project identifier
            required_documents: List of required document types

        Returns:
            ProjectRecord
        """
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute(
                "SELECT * FROM projects WHERE project_id = ?",
                (project_id,)
            )
            existing = cursor.fetchone()

            if existing:
                return ProjectRecord.from_row(existing)

            # Create new project
            req_docs = json.dumps(required_documents or [])
            cursor.execute("""
                INSERT INTO projects (
                    project_id, status, document_count,
                    required_documents, present_documents,
                    created_at, updated_at
                ) VALUES (?, ?, 0, ?, '[]', ?, ?)
            """, (project_id, ProjectStatus.INCOMPLETE.value, req_docs, now, now))

            self._log_action(
                cursor, None, project_id, "project_created",
                {"required_documents": required_documents}
            )

            cursor.execute(
                "SELECT * FROM projects WHERE project_id = ?",
                (project_id,)
            )
            return ProjectRecord.from_row(cursor.fetchone())

    def update_project_documents(self, project_id: str) -> ProjectRecord:
        """
        Update project's document count and present document types.

        Args:
            project_id: Project identifier

        Returns:
            Updated ProjectRecord
        """
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Ensure project exists first
            cursor.execute(
                "SELECT id FROM projects WHERE project_id = ?",
                (project_id,)
            )
            if cursor.fetchone() is None:
                # Create the project if it doesn't exist
                cursor.execute("""
                    INSERT INTO projects (
                        project_id, status, document_count,
                        required_documents, present_documents,
                        created_at, updated_at
                    ) VALUES (?, ?, 0, '[]', '[]', ?, ?)
                """, (project_id, ProjectStatus.INCOMPLETE.value, now, now))

            # Get document types present in this project
            cursor.execute("""
                SELECT document_type, COUNT(*) as count
                FROM documents
                WHERE project_id = ? AND status = ?
                GROUP BY document_type
            """, (project_id, DocumentStatus.ORGANIZED.value))

            doc_types = {}
            total_count = 0
            for row in cursor.fetchall():
                if row["document_type"]:
                    doc_types[row["document_type"]] = row["count"]
                    total_count += row["count"]

            present_docs = json.dumps(list(doc_types.keys()))

            cursor.execute("""
                UPDATE projects SET
                    document_count = ?,
                    present_documents = ?,
                    updated_at = ?
                WHERE project_id = ?
            """, (total_count, present_docs, now, project_id))

            cursor.execute(
                "SELECT * FROM projects WHERE project_id = ?",
                (project_id,)
            )
            return ProjectRecord.from_row(cursor.fetchone())

    def check_project_completeness(
        self,
        project_id: str,
        required_types: List[str]
    ) -> Dict[str, Any]:
        """
        Check if a project has all required document types.

        Args:
            project_id: Project identifier
            required_types: List of required document type IDs

        Returns:
            Dict with 'complete' bool, 'present', and 'missing' lists
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT DISTINCT document_type
                FROM documents
                WHERE project_id = ? AND status = ?
            """, (project_id, DocumentStatus.ORGANIZED.value))

            present = {row["document_type"] for row in cursor.fetchall()}
            required = set(required_types)
            missing = required - present

            return {
                "complete": len(missing) == 0,
                "present": list(present),
                "missing": list(missing),
                "required": required_types
            }

    def set_project_status(self, project_id: str, status: ProjectStatus) -> bool:
        """Update project status."""
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE projects SET status = ?, updated_at = ?
                WHERE project_id = ?
            """, (status.value, now, project_id))

            if cursor.rowcount > 0:
                self._log_action(
                    cursor, None, project_id, "status_changed",
                    {"new_status": status.value}
                )
                return True
            return False

    def set_project_report_path(self, project_id: str, report_path: str) -> bool:
        """Set the path to the completed report."""
        now = datetime.utcnow().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE projects SET
                    report_path = ?,
                    status = ?,
                    updated_at = ?
                WHERE project_id = ?
            """, (report_path, ProjectStatus.COMPLETE.value, now, project_id))

            return cursor.rowcount > 0

    # Query methods

    def get_pending_documents(self) -> List[DocumentRecord]:
        """Get all documents with pending status."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE status = ?",
                (DocumentStatus.PENDING.value,)
            )
            return [DocumentRecord.from_row(row) for row in cursor.fetchall()]

    def get_documents_for_project(self, project_id: str) -> List[DocumentRecord]:
        """Get all documents associated with a project."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE project_id = ?",
                (project_id,)
            )
            return [DocumentRecord.from_row(row) for row in cursor.fetchall()]

    def get_projects_by_status(self, status: ProjectStatus) -> List[ProjectRecord]:
        """Get all projects with a given status."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM projects WHERE status = ?",
                (status.value,)
            )
            return [ProjectRecord.from_row(row) for row in cursor.fetchall()]

    def get_documents_needing_review(self) -> List[DocumentRecord]:
        """Get all documents flagged for manual review."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE requires_manual_review = 1"
            )
            return [DocumentRecord.from_row(row) for row in cursor.fetchall()]

    def get_failed_documents(self) -> List[DocumentRecord]:
        """Get all failed documents."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE status = ?",
                (DocumentStatus.FAILED.value,)
            )
            return [DocumentRecord.from_row(row) for row in cursor.fetchall()]

    def get_processing_log(
        self,
        document_id: Optional[int] = None,
        project_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Get processing log entries."""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            query = "SELECT * FROM processing_log WHERE 1=1"
            params = []

            if document_id:
                query += " AND document_id = ?"
                params.append(document_id)
            if project_id:
                query += " AND project_id = ?"
                params.append(project_id)

            query += " ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)

            cursor.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    def _log_action(
        self,
        cursor: sqlite3.Cursor,
        document_id: Optional[int],
        project_id: Optional[str],
        action: str,
        details: Dict[str, Any]
    ):
        """Log a processing action for audit trail."""
        cursor.execute("""
            INSERT INTO processing_log (document_id, project_id, action, details, timestamp)
            VALUES (?, ?, ?, ?, ?)
        """, (
            document_id, project_id, action,
            json.dumps(details), datetime.utcnow().isoformat()
        ))

    def get_stats(self) -> Dict[str, Any]:
        """Get overall pipeline statistics."""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Document stats
            cursor.execute("""
                SELECT status, COUNT(*) as count
                FROM documents
                GROUP BY status
            """)
            doc_stats = {row["status"]: row["count"] for row in cursor.fetchall()}

            # Project stats
            cursor.execute("""
                SELECT status, COUNT(*) as count
                FROM projects
                GROUP BY status
            """)
            project_stats = {row["status"]: row["count"] for row in cursor.fetchall()}

            # Total counts
            cursor.execute("SELECT COUNT(*) as count FROM documents")
            total_docs = cursor.fetchone()["count"]

            cursor.execute("SELECT COUNT(*) as count FROM projects")
            total_projects = cursor.fetchone()["count"]

            return {
                "total_documents": total_docs,
                "total_projects": total_projects,
                "documents_by_status": doc_stats,
                "projects_by_status": project_stats,
            }
