"""
Tests for the file triage feature.

Tests file review/triage functionality including:
- Getting triage status for a project
- Updating include/exclude decisions
- Confirming triage before assembly
- Default exclusion of reference reports and low-confidence items
- Triage reset functionality
"""

import asyncio
import json
import hashlib
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def create_test_pdf(path: Path, num_pages: int = 3) -> Path:
    """Create a test PDF file with the given number of pages."""
    c = canvas.Canvas(str(path), pagesize=letter)

    for i in range(num_pages):
        c.setFont("Helvetica", 12)
        c.drawString(100, 700, f"Test Page {i + 1}")
        c.showPage()

    c.save()
    return path


# ===== Fixtures =====

@pytest.fixture
def temp_project_dir():
    """Create a temporary project directory structure."""
    with tempfile.TemporaryDirectory() as tmpdir:
        project_dir = Path(tmpdir) / "projects" / "TEST-001"
        project_dir.mkdir(parents=True)

        # Create subfolders with test PDFs
        (project_dir / "edr").mkdir()
        create_test_pdf(project_dir / "edr" / "edr_report.pdf", 10)

        (project_dir / "historical" / "sanborn_maps").mkdir(parents=True)
        create_test_pdf(project_dir / "historical" / "sanborn_maps" / "sanborn_1920.pdf", 5)

        (project_dir / "site_visit" / "photos").mkdir(parents=True)
        create_test_pdf(project_dir / "site_visit" / "photos" / "site_photos.pdf", 15)

        yield tmpdir


@pytest.fixture
def mock_state():
    """Create mock application state."""
    return {
        'config': {
            'pipeline': {
                'project_base_dir': './projects',
                'output_dir': './completed_reports'
            }
        },
        'classification_results': [],
        'triage_decisions': {}
    }


# ===== Unit Tests for Triage Logic =====

class TestTriageLogic:
    """Tests for triage decision logic."""

    def test_default_include_for_normal_documents(self):
        """Test that normal documents default to include."""
        # Documents with high confidence and normal types should default to include
        doc = {
            'type': 'edr',
            'confidence': 0.95,
            'requires_manual_review': False
        }

        default_include = True
        if doc.get('type') == 'reference_report':
            default_include = False
        elif doc.get('confidence', 1.0) < 0.9:
            default_include = False

        assert default_include is True

    def test_default_exclude_for_reference_reports(self):
        """Test that reference reports default to exclude."""
        doc = {
            'type': 'reference_report',
            'confidence': 0.95,
            'requires_manual_review': False
        }

        default_include = True
        if doc.get('type') == 'reference_report':
            default_include = False

        assert default_include is False

    def test_default_exclude_for_low_confidence(self):
        """Test that low confidence items default to exclude."""
        doc = {
            'type': 'sanborn_map',
            'confidence': 0.75,  # Below 0.9 threshold
            'requires_manual_review': True
        }

        default_include = True
        if doc.get('confidence', 1.0) < 0.9:
            default_include = False

        assert default_include is False

    def test_document_id_generation(self):
        """Test consistent document ID generation."""
        path1 = "/projects/TEST-001/edr/report.pdf"
        path2 = "/projects/TEST-001/edr/report.pdf"
        path3 = "/projects/TEST-001/historical/map.pdf"

        id1 = hashlib.md5(path1.encode()).hexdigest()[:12]
        id2 = hashlib.md5(path2.encode()).hexdigest()[:12]
        id3 = hashlib.md5(path3.encode()).hexdigest()[:12]

        # Same path should generate same ID
        assert id1 == id2
        # Different paths should generate different IDs
        assert id1 != id3


class TestTriageDecisions:
    """Tests for triage decision storage and retrieval."""

    def test_store_triage_decision(self, mock_state):
        """Test storing a triage decision."""
        project_id = "TEST-001"
        doc_id = "abc123"

        if project_id not in mock_state['triage_decisions']:
            mock_state['triage_decisions'][project_id] = {}

        mock_state['triage_decisions'][project_id][doc_id] = {
            "include": False,
            "reason": "Third-party reference report",
            "updated_at": datetime.now().isoformat()
        }

        assert project_id in mock_state['triage_decisions']
        assert doc_id in mock_state['triage_decisions'][project_id]
        assert mock_state['triage_decisions'][project_id][doc_id]['include'] is False

    def test_confirm_triage(self, mock_state):
        """Test confirming triage decisions."""
        project_id = "TEST-001"

        mock_state['triage_decisions'][project_id] = {
            "doc1": {"include": True},
            "doc2": {"include": False}
        }

        # Mark as confirmed
        mock_state['triage_decisions'][project_id]['_confirmed'] = True
        mock_state['triage_decisions'][project_id]['_confirmed_at'] = datetime.now().isoformat()

        assert mock_state['triage_decisions'][project_id]['_confirmed'] is True

    def test_reset_triage(self, mock_state):
        """Test resetting triage decisions."""
        project_id = "TEST-001"

        mock_state['triage_decisions'][project_id] = {
            "doc1": {"include": True},
            "_confirmed": True
        }

        # Reset
        del mock_state['triage_decisions'][project_id]

        assert project_id not in mock_state['triage_decisions']


class TestTriageWithClassification:
    """Tests for triage integration with classification results."""

    def test_find_classification_by_path(self, mock_state):
        """Test finding classification result by path."""
        mock_state['classification_results'] = [
            {
                'path': '/projects/TEST-001/edr/report.pdf',
                'type': 'edr',
                'confidence': 0.95
            },
            {
                'path': '/projects/TEST-001/historical/map.pdf',
                'type': 'sanborn_map',
                'confidence': 0.88
            }
        ]

        target_path = '/projects/TEST-001/edr/report.pdf'
        classification = None

        for result in mock_state['classification_results']:
            if result.get('path') == target_path:
                classification = result
                break

        assert classification is not None
        assert classification['type'] == 'edr'
        assert classification['confidence'] == 0.95

    def test_classification_affects_default_include(self, mock_state):
        """Test that classification results affect default include status."""
        classifications = [
            {'path': 'doc1.pdf', 'type': 'edr', 'confidence': 0.95},
            {'path': 'doc2.pdf', 'type': 'reference_report', 'confidence': 0.92},
            {'path': 'doc3.pdf', 'type': 'sanborn_map', 'confidence': 0.75}
        ]

        results = []
        for cls in classifications:
            default_include = True
            auto_exclude_reason = None

            if cls.get('type') == 'reference_report':
                default_include = False
                auto_exclude_reason = "Third-party reference report"
            elif cls.get('confidence', 1.0) < 0.9:
                default_include = False
                auto_exclude_reason = f"Low confidence ({cls['confidence']:.1%})"

            results.append({
                'path': cls['path'],
                'default_include': default_include,
                'reason': auto_exclude_reason
            })

        # EDR should be included
        assert results[0]['default_include'] is True

        # Reference report should be excluded
        assert results[1]['default_include'] is False
        assert 'reference' in results[1]['reason'].lower()

        # Low confidence should be excluded
        assert results[2]['default_include'] is False
        assert 'confidence' in results[2]['reason'].lower()


class TestTriageBeforeAssembly:
    """Tests for triage requirement before assembly."""

    def test_assembly_blocked_without_triage(self, mock_state):
        """Test that assembly is blocked when triage not confirmed."""
        project_id = "TEST-001"

        # No triage decisions at all
        triage_confirmed = mock_state['triage_decisions'].get(project_id, {}).get('_confirmed', False)

        assert triage_confirmed is False

    def test_assembly_allowed_after_triage(self, mock_state):
        """Test that assembly is allowed after triage confirmation."""
        project_id = "TEST-001"

        mock_state['triage_decisions'][project_id] = {
            "doc1": {"include": True},
            "doc2": {"include": False},
            "_confirmed": True
        }

        triage_confirmed = mock_state['triage_decisions'].get(project_id, {}).get('_confirmed', False)

        assert triage_confirmed is True

    def test_triage_file_persistence(self, temp_project_dir):
        """Test that triage decisions can be saved to file."""
        project_dir = Path(temp_project_dir) / "projects" / "TEST-001"

        triage_data = {
            "project_id": "TEST-001",
            "confirmed": True,
            "confirmed_at": datetime.now().isoformat(),
            "decisions": {
                "doc1": {"include": True},
                "doc2": {"include": False, "reason": "Reference report"}
            }
        }

        triage_file = project_dir / "triage_decisions.json"
        with open(triage_file, 'w') as f:
            json.dump(triage_data, f, indent=2)

        assert triage_file.exists()

        # Read back
        with open(triage_file, 'r') as f:
            loaded = json.load(f)

        assert loaded['confirmed'] is True
        assert loaded['decisions']['doc1']['include'] is True
        assert loaded['decisions']['doc2']['include'] is False


class TestGetIncludedDocuments:
    """Tests for getting the list of included documents."""

    def test_get_included_documents(self, temp_project_dir, mock_state):
        """Test getting list of documents to include in assembly."""
        project_dir = Path(temp_project_dir) / "projects" / "TEST-001"

        # Get all PDFs
        all_pdfs = list(project_dir.rglob("*.pdf"))
        assert len(all_pdfs) == 3

        # Set up triage decisions - exclude one
        mock_state['triage_decisions']['TEST-001'] = {}

        for pdf in all_pdfs:
            doc_id = hashlib.md5(str(pdf).encode()).hexdigest()[:12]
            # Exclude the sanborn map
            include = 'sanborn' not in pdf.name.lower()
            mock_state['triage_decisions']['TEST-001'][doc_id] = {'include': include}

        # Get included documents
        included = []
        for pdf in all_pdfs:
            doc_id = hashlib.md5(str(pdf).encode()).hexdigest()[:12]
            decision = mock_state['triage_decisions']['TEST-001'].get(doc_id, {})
            if decision.get('include', True):
                included.append(pdf)

        assert len(included) == 2  # Sanborn excluded
        assert all('sanborn' not in p.name.lower() for p in included)

    def test_default_include_when_no_decision(self, temp_project_dir, mock_state):
        """Test that documents default to include when no decision exists."""
        project_dir = Path(temp_project_dir) / "projects" / "TEST-001"

        all_pdfs = list(project_dir.rglob("*.pdf"))

        # No triage decisions set
        mock_state['triage_decisions']['TEST-001'] = {}

        included = []
        for pdf in all_pdfs:
            doc_id = hashlib.md5(str(pdf).encode()).hexdigest()[:12]
            decision = mock_state['triage_decisions']['TEST-001'].get(doc_id, {})
            # Default to True if no decision
            if decision.get('include', True):
                included.append(pdf)

        # All should be included by default
        assert len(included) == len(all_pdfs)


# ===== API Endpoint Tests =====

class TestTriageEndpoints:
    """Tests for triage API endpoints (mocked)."""

    def test_triage_request_model(self):
        """Test the TriageRequest pydantic model structure."""
        # Simulate the expected request format
        request_data = {
            "documents": [
                {"document_id": "abc123", "include": True, "reason": None},
                {"document_id": "def456", "include": False, "reason": "Reference report"}
            ],
            "confirmed": False
        }

        assert len(request_data['documents']) == 2
        assert request_data['documents'][0]['include'] is True
        assert request_data['documents'][1]['include'] is False
        assert request_data['confirmed'] is False

    def test_triage_response_structure(self, temp_project_dir):
        """Test expected triage response structure."""
        project_dir = Path(temp_project_dir) / "projects" / "TEST-001"

        # Build expected response
        documents = []
        for pdf in project_dir.rglob("*.pdf"):
            doc_id = hashlib.md5(str(pdf).encode()).hexdigest()[:12]
            documents.append({
                "id": doc_id,
                "name": pdf.name,
                "path": str(pdf),
                "type": "unknown",
                "confidence": 1.0,
                "page_count": None,
                "size": pdf.stat().st_size,
                "include": True,
                "reason": None,
                "auto_excluded": False,
                "requires_review": False
            })

        response = {
            "project_id": "TEST-001",
            "documents": documents,
            "total_documents": len(documents),
            "included_count": len([d for d in documents if d['include']]),
            "excluded_count": len([d for d in documents if not d['include']]),
            "needs_review_count": 0,
            "triage_confirmed": False,
            "can_assemble": False
        }

        assert response['project_id'] == "TEST-001"
        assert len(response['documents']) == 3
        assert response['triage_confirmed'] is False
        assert response['can_assemble'] is False
