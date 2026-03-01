"""Project state manager using JSON files."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import PROJECTS_DIR


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def create_project(name: str, project_number: str = "", address: str = "") -> Dict:
    """Create a new project with a unique ID."""
    project_id = uuid.uuid4().hex[:12]
    project = {
        "id": project_id,
        "name": name,
        "project_number": project_number,
        "address": address,
        "created_at": _now(),
        "updated_at": _now(),
        "status": "created",
        "documents": [],
        "classifications": {},
        "assembly": None,
        "export": None,
        "ai_reasoning": [],
    }
    project_dir = PROJECTS_DIR / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "files").mkdir(exist_ok=True)
    (project_dir / "converted").mkdir(exist_ok=True)
    (project_dir / "export").mkdir(exist_ok=True)
    save_project(project)
    return project


def save_project(project: dict) -> None:
    """Save project state to JSON."""
    project["updated_at"] = _now()
    path = PROJECTS_DIR / project["id"] / "state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(project, indent=2, default=str))


def load_project(project_id: str) -> Optional[Dict]:
    """Load project state from JSON."""
    path = PROJECTS_DIR / project_id / "state.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def list_projects() -> List[Dict]:
    """List all projects (summary only)."""
    projects = []
    if not PROJECTS_DIR.exists():
        return projects
    for d in sorted(PROJECTS_DIR.iterdir()):
        state_file = d / "state.json"
        if state_file.exists():
            p = json.loads(state_file.read_text())
            projects.append({
                "id": p["id"],
                "name": p["name"],
                "project_number": p.get("project_number", ""),
                "address": p.get("address", ""),
                "status": p["status"],
                "document_count": len(p.get("documents", [])),
                "created_at": p["created_at"],
                "updated_at": p["updated_at"],
            })
    return projects


def add_document(project: dict, doc: dict) -> dict:
    """Add a document to the project state."""
    doc.setdefault("id", uuid.uuid4().hex[:10])
    doc.setdefault("added_at", _now())
    doc.setdefault("status", "uploaded")
    project["documents"].append(doc)
    save_project(project)
    return doc


def update_document(project: dict, doc_id: str, updates: dict) -> Optional[Dict]:
    """Update a document in the project state."""
    for doc in project["documents"]:
        if doc["id"] == doc_id:
            doc.update(updates)
            save_project(project)
            return doc
    return None


def add_reasoning(project: dict, event_type: str, details: dict) -> None:
    """Add an AI reasoning event to the project."""
    project["ai_reasoning"].append({
        "id": uuid.uuid4().hex[:8],
        "timestamp": _now(),
        "type": event_type,
        **details,
    })
    save_project(project)
