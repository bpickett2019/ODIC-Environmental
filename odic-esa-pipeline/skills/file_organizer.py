"""
ODIC ESA Pipeline - File Organizer Skill

Takes classifier output, renames files following a standard naming convention,
and sorts them into the correct project subfolder based on document type
and ESA template section mapping.
"""

import shutil
import re
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, Optional, List

import yaml

from .base import BaseSkill, SkillResult
from core.state import StateManager, DocumentStatus, ProjectStatus


class FileOrganizer(BaseSkill):
    """
    Organizes classified documents into project folders.

    - Renames files using a standard naming convention
    - Creates project folder structure if needed
    - Places documents in appropriate subfolders based on type
    - Tracks organization state for idempotency
    """

    # Document type to subfolder mapping
    SUBFOLDER_MAP = {
        "sanborn_map": "historical/sanborn_maps",
        "topographic_map": "historical/topo_maps",
        "aerial_photograph": "historical/aerials",
        "city_directory": "historical/city_directories",
        "fire_insurance_map": "historical/fire_insurance_maps",
        "edr": "regulatory/edr",
        "title_record": "records/title",
        "tax_record": "records/tax",
        "building_permit": "records/permits",
        "site_photograph": "site_visit/photos",
        "regulatory_correspondence": "regulatory/correspondence",
        "prior_environmental_report": "prior_reports",
        "client_correspondence": "client",
        "lab_results": "lab_results",
        "other": "other",
    }

    def __init__(
        self,
        config: dict,
        state_manager: Optional[StateManager] = None
    ):
        """
        Initialize the file organizer.

        Args:
            config: Configuration dictionary
            state_manager: Optional StateManager instance
        """
        super().__init__(config)

        # Get base directories from config
        pipeline_config = config.get("pipeline", {})
        self.project_base_dir = Path(
            pipeline_config.get("project_base_dir", "./projects")
        )
        self.failed_dir = Path(
            pipeline_config.get("failed_dir", "./failed")
        )

        # Ensure directories exist
        self.project_base_dir.mkdir(parents=True, exist_ok=True)
        self.failed_dir.mkdir(parents=True, exist_ok=True)

        # State manager
        self.state_manager = state_manager

        # Load ESA template for section mapping
        self.esa_template = self._load_esa_template()

        # Required document types from config
        qa_config = config.get("qa", {})
        self.required_types = self._get_required_types(qa_config)

    def _load_esa_template(self) -> Dict[str, Any]:
        """Load ESA template configuration."""
        template_path = Path(__file__).parent.parent / "config" / "esa_template.yaml"

        if template_path.exists():
            with open(template_path, "r") as f:
                return yaml.safe_load(f)
        else:
            self.logger.warning(f"ESA template not found at {template_path}")
            return {}

    def _get_required_types(self, qa_config: dict) -> List[str]:
        """Determine required document types from config."""
        required = []

        if qa_config.get("require_edr", True):
            required.append("edr")
        if qa_config.get("require_topo", True):
            required.append("topographic_map")
        if qa_config.get("require_site_photos", True):
            required.append("site_photograph")

        # Also check ESA template for required sections with doc_types
        template = self.esa_template.get("phase1_esa", {})
        required_docs = template.get("required_documents", {})

        for doc_type in required_docs.get("minimum", []):
            if doc_type not in required:
                required.append(doc_type)

        return required

    def _generate_filename(
        self,
        project_id: str,
        document_type: str,
        original_filename: str,
        metadata: Dict[str, Any]
    ) -> str:
        """
        Generate a standardized filename.

        Format: {project_id}_{doc_type}_{date}_{sequence}.pdf

        Args:
            project_id: Project identifier
            document_type: Document type ID
            original_filename: Original filename
            metadata: Classification metadata

        Returns:
            Standardized filename
        """
        # Get date from metadata or use current date
        doc_date = metadata.get("date")
        if doc_date:
            # Try to parse and format date
            try:
                # Handle various date formats
                for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%Y"]:
                    try:
                        parsed = datetime.strptime(doc_date, fmt)
                        doc_date = parsed.strftime("%Y%m%d")
                        break
                    except ValueError:
                        continue
                else:
                    doc_date = datetime.now().strftime("%Y%m%d")
            except (ValueError, TypeError):
                doc_date = datetime.now().strftime("%Y%m%d")
        else:
            doc_date = datetime.now().strftime("%Y%m%d")

        # Clean up document type for filename
        doc_type_clean = document_type.replace("_", "-")

        # Get file extension from original
        original_path = Path(original_filename)
        extension = original_path.suffix.lower() or ".pdf"

        # Generate base filename
        base_name = f"{project_id}_{doc_type_clean}_{doc_date}"

        return f"{base_name}{extension}"

    def _get_project_folder(self, project_id: str) -> Path:
        """Get or create project folder."""
        project_path = self.project_base_dir / project_id

        # Create standard project folder structure
        subfolders = [
            "historical/sanborn_maps",
            "historical/topo_maps",
            "historical/aerials",
            "historical/city_directories",
            "historical/fire_insurance_maps",
            "regulatory/edr",
            "regulatory/correspondence",
            "records/title",
            "records/tax",
            "records/permits",
            "site_visit/photos",
            "prior_reports",
            "client",
            "lab_results",
            "other",
            "report",
        ]

        for subfolder in subfolders:
            (project_path / subfolder).mkdir(parents=True, exist_ok=True)

        return project_path

    def _get_destination_folder(
        self,
        project_path: Path,
        document_type: str
    ) -> Path:
        """Get destination subfolder for document type."""
        subfolder = self.SUBFOLDER_MAP.get(document_type, "other")
        return project_path / subfolder

    def _ensure_unique_filename(self, dest_path: Path, filename: str) -> str:
        """
        Ensure filename is unique by adding sequence number if needed.

        Args:
            dest_path: Destination directory
            filename: Proposed filename

        Returns:
            Unique filename
        """
        path = Path(filename)
        base = path.stem
        ext = path.suffix

        candidate = filename
        sequence = 1

        while (dest_path / candidate).exists():
            candidate = f"{base}_{sequence:02d}{ext}"
            sequence += 1

            if sequence > 99:
                # Fallback to timestamp
                ts = datetime.now().strftime("%H%M%S")
                candidate = f"{base}_{ts}{ext}"
                break

        return candidate

    def validate_input(self, input_data: Any) -> bool:
        """
        Validate input data from classifier.

        Expected input format:
        {
            "file": "/path/to/file.pdf",
            "type": "document_type",
            "confidence": 0.95,
            "project_id": "ODIC-2024-001",
            "requires_manual_review": false,
            "extracted_metadata": {...}
        }
        """
        if not isinstance(input_data, dict):
            self.logger.error("Input must be a dictionary")
            return False

        required_fields = ["file", "type"]
        for field in required_fields:
            if field not in input_data:
                self.logger.error(f"Missing required field: {field}")
                return False

        # Check file exists
        file_path = Path(input_data["file"])
        if not file_path.exists():
            self.logger.error(f"File does not exist: {file_path}")
            return False

        return True

    async def process(self, input_data: Any) -> SkillResult:
        """
        Organize a classified document.

        Args:
            input_data: Classification result from DocumentClassifier

        Returns:
            SkillResult with organization details
        """
        file_path = Path(input_data["file"])
        document_type = input_data["type"]
        project_id = input_data.get("project_id")
        confidence = input_data.get("confidence", 0.0)
        requires_manual_review = input_data.get("requires_manual_review", False)
        metadata = input_data.get("extracted_metadata", {})

        self.logger.info(
            f"Organizing document: {file_path.name} -> "
            f"type={document_type}, project={project_id}"
        )

        # Handle documents that need manual review
        if requires_manual_review:
            return await self._handle_manual_review(
                file_path, document_type, project_id, metadata
            )

        # Handle documents without a project ID
        if not project_id:
            return await self._handle_no_project(
                file_path, document_type, metadata
            )

        try:
            # Get or create project folder
            project_path = self._get_project_folder(project_id)

            # Get destination subfolder
            dest_folder = self._get_destination_folder(project_path, document_type)

            # Generate standardized filename
            new_filename = self._generate_filename(
                project_id, document_type, file_path.name, metadata
            )

            # Ensure unique filename
            new_filename = self._ensure_unique_filename(dest_folder, new_filename)

            # Full destination path
            dest_path = dest_folder / new_filename

            # Copy file (preserve original for safety)
            shutil.copy2(str(file_path), str(dest_path))

            self.logger.info(f"Organized: {file_path.name} -> {dest_path}")

            # Update state if state manager is available
            if self.state_manager:
                # Ensure document is tracked (idempotent)
                self.state_manager.add_document(str(file_path))

                # Update classification info
                self.state_manager.update_document_classification(
                    str(file_path),
                    document_type,
                    confidence,
                    project_id,
                    requires_manual_review,
                    metadata
                )

                # Mark as organized
                self.state_manager.update_document_organized(
                    str(file_path), str(dest_path), project_id
                )

                # Update project document tracking
                self.state_manager.update_project_documents(project_id)

            # Check project completeness
            completeness = self._check_project_completeness(project_id)

            return SkillResult.ok(
                data={
                    "original_file": str(file_path),
                    "organized_path": str(dest_path),
                    "project_id": project_id,
                    "project_path": str(project_path),
                    "document_type": document_type,
                    "new_filename": new_filename,
                    "project_complete": completeness["complete"],
                    "present_documents": completeness["present"],
                    "missing_documents": completeness["missing"],
                },
                subfolder=str(dest_folder.relative_to(project_path)),
            )

        except Exception as e:
            self.logger.exception(f"Failed to organize document: {e}")

            # Move to failed folder
            failed_path = self._move_to_failed(
                file_path, f"Organization failed: {str(e)}"
            )

            if self.state_manager:
                self.state_manager.mark_document_failed(
                    str(file_path), str(e)
                )

            return SkillResult.fail(
                error=f"Organization failed: {str(e)}",
                data={
                    "original_file": str(file_path),
                    "failed_path": str(failed_path) if failed_path else None,
                    "document_type": document_type,
                    "project_id": project_id,
                },
            )

    async def _handle_manual_review(
        self,
        file_path: Path,
        document_type: str,
        project_id: Optional[str],
        metadata: Dict[str, Any]
    ) -> SkillResult:
        """Handle documents flagged for manual review."""
        # Create manual review folder
        review_folder = self.project_base_dir / "_manual_review"
        review_folder.mkdir(parents=True, exist_ok=True)

        # Preserve original name with prefix
        review_filename = f"REVIEW_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file_path.name}"
        review_path = review_folder / review_filename

        # Copy to review folder
        shutil.copy2(str(file_path), str(review_path))

        # Write metadata file for reviewer
        meta_path = review_path.with_suffix(".meta.json")
        import json
        with open(meta_path, "w") as f:
            json.dump({
                "original_file": str(file_path),
                "suggested_type": document_type,
                "suggested_project": project_id,
                "metadata": metadata,
                "flagged_at": datetime.utcnow().isoformat(),
            }, f, indent=2)

        self.logger.info(f"Document flagged for manual review: {review_path}")

        return SkillResult.ok(
            data={
                "original_file": str(file_path),
                "review_path": str(review_path),
                "meta_path": str(meta_path),
                "document_type": document_type,
                "project_id": project_id,
                "requires_manual_review": True,
            },
            action="manual_review",
        )

    async def _handle_no_project(
        self,
        file_path: Path,
        document_type: str,
        metadata: Dict[str, Any]
    ) -> SkillResult:
        """Handle documents with no identifiable project ID."""
        # Create unassigned folder
        unassigned_folder = self.project_base_dir / "_unassigned"
        unassigned_folder.mkdir(parents=True, exist_ok=True)

        # Preserve original name with timestamp
        unassigned_filename = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file_path.name}"
        unassigned_path = unassigned_folder / unassigned_filename

        shutil.copy2(str(file_path), str(unassigned_path))

        self.logger.warning(f"Document has no project ID: {unassigned_path}")

        return SkillResult.ok(
            data={
                "original_file": str(file_path),
                "unassigned_path": str(unassigned_path),
                "document_type": document_type,
                "project_id": None,
                "requires_project_assignment": True,
            },
            action="unassigned",
        )

    def _move_to_failed(
        self,
        file_path: Path,
        reason: str
    ) -> Optional[Path]:
        """Move a file to the failed folder."""
        try:
            failed_filename = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{file_path.name}"
            failed_path = self.failed_dir / failed_filename

            shutil.copy2(str(file_path), str(failed_path))

            # Write error info
            error_path = failed_path.with_suffix(".error.txt")
            with open(error_path, "w") as f:
                f.write(f"Original: {file_path}\n")
                f.write(f"Failed at: {datetime.utcnow().isoformat()}\n")
                f.write(f"Reason: {reason}\n")

            return failed_path
        except Exception as e:
            self.logger.error(f"Failed to move file to failed folder: {e}")
            return None

    def _check_project_completeness(self, project_id: str) -> Dict[str, Any]:
        """Check if project has all required documents."""
        if self.state_manager:
            return self.state_manager.check_project_completeness(
                project_id, self.required_types
            )

        # Fallback: scan project folder
        project_path = self.project_base_dir / project_id
        present = []

        for doc_type, subfolder in self.SUBFOLDER_MAP.items():
            subfolder_path = project_path / subfolder
            if subfolder_path.exists() and any(subfolder_path.iterdir()):
                present.append(doc_type)

        missing = [t for t in self.required_types if t not in present]

        return {
            "complete": len(missing) == 0,
            "present": present,
            "missing": missing,
            "required": self.required_types,
        }

    def get_project_status(self, project_id: str) -> Dict[str, Any]:
        """Get detailed status of a project."""
        project_path = self.project_base_dir / project_id

        if not project_path.exists():
            return {
                "exists": False,
                "project_id": project_id,
            }

        completeness = self._check_project_completeness(project_id)

        # Count documents by type
        documents_by_type = {}
        for doc_type, subfolder in self.SUBFOLDER_MAP.items():
            subfolder_path = project_path / subfolder
            if subfolder_path.exists():
                files = list(subfolder_path.glob("*.pdf"))
                if files:
                    documents_by_type[doc_type] = len(files)

        return {
            "exists": True,
            "project_id": project_id,
            "project_path": str(project_path),
            "complete": completeness["complete"],
            "present_types": completeness["present"],
            "missing_types": completeness["missing"],
            "documents_by_type": documents_by_type,
            "total_documents": sum(documents_by_type.values()),
        }
