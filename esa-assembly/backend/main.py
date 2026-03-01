"""ODIC ESA Report Assembly System — FastAPI Backend."""

import asyncio
import hashlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

import config
import state
from llm_router import LLMRouter
from classifier import classify_document, DOCUMENT_TYPES
from assembler import create_assembly, TEMPLATE_SECTIONS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("esa")

app = FastAPI(title="ODIC ESA Report Assembly", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# SSE clients per project
sse_clients = {}  # type: Dict[str, List[asyncio.Queue]]


async def send_sse(project_id: str, event: str, data: dict):
    """Send an SSE event to all connected clients for a project."""
    if project_id in sse_clients:
        for q in sse_clients[project_id]:
            await q.put({"event": event, "data": data})


# ─── Health ───────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


# ─── Projects ─────────────────────────────────────────────
@app.post("/api/projects")
async def create_project(request: Request):
    body = await request.json()
    name = body.get("name", "Untitled Project")
    project = state.create_project(
        name=name,
        project_number=body.get("project_number", ""),
        address=body.get("address", ""),
    )
    return project


@app.get("/api/projects")
async def list_projects():
    return state.list_projects()


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    p = state.load_project(project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    return p


# ─── SSE Events ───────────────────────────────────────────
@app.get("/api/projects/{project_id}/events")
async def project_events(project_id: str):
    """SSE endpoint for real-time updates."""
    q: asyncio.Queue = asyncio.Queue()
    if project_id not in sse_clients:
        sse_clients[project_id] = []
    sse_clients[project_id].append(q)

    async def event_generator():
        try:
            yield f"data: {json.dumps({'event': 'connected'})}\n\n"
            while True:
                msg = await asyncio.wait_for(q.get(), timeout=30)
                yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'])}\n\n"
        except asyncio.TimeoutError:
            yield f": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if project_id in sse_clients:
                sse_clients[project_id].remove(q)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ─── Upload ───────────────────────────────────────────────
@app.post("/api/projects/{project_id}/upload")
async def upload_file(project_id: str, file: UploadFile = File(...)):
    """Handle file upload (ZIP or individual file). Streams to disk."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    files_dir = config.PROJECTS_DIR / project_id / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    # Stream to temp file
    tmp = tempfile.NamedTemporaryFile(delete=False, dir=str(config.UPLOADS_DIR))
    total = 0
    try:
        while chunk := await file.read(config.CHUNK_SIZE):
            total += len(chunk)
            if total > config.MAX_UPLOAD_SIZE:
                os.unlink(tmp.name)
                raise HTTPException(413, "File exceeds 2GB limit")
            tmp.write(chunk)
        tmp.close()
    except HTTPException:
        raise
    except Exception as e:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
        raise HTTPException(500, f"Upload failed: {e}")

    added_docs = []
    original_name = file.filename or "upload"

    # If ZIP, extract
    if original_name.lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(tmp.name, "r") as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    fname = Path(info.filename).name
                    if fname.startswith(".") or fname.startswith("__MACOSX"):
                        continue
                    safe_name = f"{uuid.uuid4().hex[:6]}_{fname}"
                    dest = files_dir / safe_name
                    with zf.open(info) as src, open(dest, "wb") as dst:
                        shutil.copyfileobj(src, dst)

                    file_hash = hashlib.md5(dest.read_bytes()).hexdigest()
                    doc = state.add_document(project, {
                        "original_filename": fname,
                        "stored_filename": safe_name,
                        "size_bytes": dest.stat().st_size,
                        "file_hash": file_hash,
                        "format": Path(fname).suffix.lower().lstrip("."),
                        "status": "uploaded",
                    })
                    added_docs.append(doc)
        except zipfile.BadZipFile:
            os.unlink(tmp.name)
            raise HTTPException(400, "Invalid or corrupt ZIP file")
        except Exception as e:
            os.unlink(tmp.name)
            raise HTTPException(500, f"ZIP extraction failed: {e}")
    else:
        # Single file
        safe_name = f"{uuid.uuid4().hex[:6]}_{original_name}"
        dest = files_dir / safe_name
        shutil.move(tmp.name, str(dest))
        tmp_deleted = True

        file_hash = hashlib.md5(dest.read_bytes()).hexdigest()
        doc = state.add_document(project, {
            "original_filename": original_name,
            "stored_filename": safe_name,
            "size_bytes": dest.stat().st_size,
            "file_hash": file_hash,
            "format": Path(original_name).suffix.lower().lstrip("."),
            "status": "uploaded",
        })
        added_docs.append(doc)

    # Clean up temp
    if os.path.exists(tmp.name):
        os.unlink(tmp.name)

    project["status"] = "uploaded"
    state.save_project(project)

    await send_sse(project_id, "upload_complete", {
        "document_count": len(added_docs),
        "documents": added_docs,
    })

    return {"documents": added_docs, "total": len(added_docs)}


# ─── Convert ──────────────────────────────────────────────
def convert_image_to_pdf(src: Path, dest: Path) -> bool:
    """Convert an image to PDF using Pillow + reportlab."""
    try:
        img = Image.open(src)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        w, h = img.size
        # Scale to fit letter page with margins
        max_w = 7.5 * 72  # 7.5 inches in points
        max_h = 10 * 72
        scale = min(max_w / w, max_h / h, 1.0)
        new_w, new_h = w * scale, h * scale

        c = canvas.Canvas(str(dest), pagesize=letter)
        # Center on page
        x = (letter[0] - new_w) / 2
        y = (letter[1] - new_h) / 2
        tmp_img = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        img.save(tmp_img.name, "JPEG", quality=85)
        c.drawImage(tmp_img.name, x, y, new_w, new_h)
        c.showPage()
        c.save()
        os.unlink(tmp_img.name)
        return True
    except Exception as e:
        logger.error(f"Image conversion failed for {src}: {e}")
        return False


def convert_word_to_pdf(src: Path, dest: Path) -> bool:
    """Convert Word doc to PDF using LibreOffice headless."""
    try:
        out_dir = dest.parent
        result = subprocess.run(
            ["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(src)],
            capture_output=True, timeout=120,
        )
        # LibreOffice outputs with same stem
        expected = out_dir / (src.stem + ".pdf")
        if expected.exists() and expected != dest:
            expected.rename(dest)
        return dest.exists()
    except Exception as e:
        logger.error(f"Word conversion failed for {src}: {e}")
        return False


@app.post("/api/projects/{project_id}/convert")
async def convert_documents(project_id: str):
    """Convert all non-PDF documents to PDF."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    files_dir = config.PROJECTS_DIR / project_id / "files"
    conv_dir = config.PROJECTS_DIR / project_id / "converted"
    conv_dir.mkdir(exist_ok=True)

    results = []
    for doc in project["documents"]:
        fmt = doc.get("format", "")
        src = files_dir / doc["stored_filename"]

        if not src.exists():
            state.update_document(project, doc["id"], {"status": "missing"})
            results.append({"id": doc["id"], "status": "missing"})
            continue

        if fmt == "pdf":
            # Already PDF, just copy/link to converted
            dest = conv_dir / doc["stored_filename"]
            if not dest.exists():
                shutil.copy2(str(src), str(dest))
            state.update_document(project, doc["id"], {
                "status": "converted",
                "converted_filename": doc["stored_filename"],
            })
            results.append({"id": doc["id"], "status": "converted"})

        elif fmt in ("jpg", "jpeg", "png", "tiff", "tif", "bmp", "gif"):
            dest = conv_dir / (Path(doc["stored_filename"]).stem + ".pdf")
            ok = convert_image_to_pdf(src, dest)
            status = "converted" if ok else "conversion_failed"
            state.update_document(project, doc["id"], {
                "status": status,
                "converted_filename": dest.name if ok else None,
            })
            results.append({"id": doc["id"], "status": status})

        elif fmt in ("docx", "doc"):
            dest = conv_dir / (Path(doc["stored_filename"]).stem + ".pdf")
            ok = convert_word_to_pdf(src, dest)
            status = "converted" if ok else "conversion_failed"
            state.update_document(project, doc["id"], {
                "status": status,
                "converted_filename": dest.name if ok else None,
            })
            results.append({"id": doc["id"], "status": status})

        else:
            state.update_document(project, doc["id"], {"status": "unsupported_format"})
            results.append({"id": doc["id"], "status": "unsupported_format"})

    project["status"] = "converted"
    state.save_project(project)

    await send_sse(project_id, "conversion_complete", {"results": results})
    return {"results": results}


# ─── Text Extraction ──────────────────────────────────────
def extract_text_from_pdf(pdf_path: Path) -> dict:
    """Extract text and metadata from a PDF using PyMuPDF."""
    try:
        doc = fitz.open(str(pdf_path))
        pages_text = []
        for page in doc:
            pages_text.append(page.get_text())
        full_text = "\n".join(pages_text)
        result = {
            "text": full_text,
            "page_count": len(doc),
            "pages_text": pages_text,
        }
        doc.close()
        return result
    except Exception as e:
        logger.error(f"Text extraction failed for {pdf_path}: {e}")
        return {"text": "", "page_count": 0, "pages_text": [], "error": str(e)}


@app.post("/api/projects/{project_id}/extract")
async def extract_text(project_id: str):
    """Extract text from all converted PDFs."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    conv_dir = config.PROJECTS_DIR / project_id / "converted"
    results = []

    for doc in project["documents"]:
        conv_file = doc.get("converted_filename")
        if not conv_file:
            results.append({"id": doc["id"], "status": "no_converted_file"})
            continue

        pdf_path = conv_dir / conv_file
        if not pdf_path.exists():
            results.append({"id": doc["id"], "status": "file_missing"})
            continue

        extraction = extract_text_from_pdf(pdf_path)
        state.update_document(project, doc["id"], {
            "status": "extracted",
            "text": extraction["text"][:50000],  # Cap stored text
            "page_count": extraction["page_count"],
            "has_text": len(extraction["text"].strip()) > 50,
        })
        results.append({
            "id": doc["id"],
            "status": "extracted",
            "page_count": extraction["page_count"],
            "text_length": len(extraction["text"]),
            "has_text": len(extraction["text"].strip()) > 50,
        })

    project["status"] = "extracted"
    state.save_project(project)

    await send_sse(project_id, "extraction_complete", {"results": results})
    return {"results": results}


@app.get("/api/projects/{project_id}/documents/{doc_id}/text")
async def get_document_text(project_id: str, doc_id: str):
    """Get extracted text for a single document."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    for doc in project["documents"]:
        if doc["id"] == doc_id:
            return {"id": doc_id, "text": doc.get("text", ""), "page_count": doc.get("page_count", 0)}
    raise HTTPException(404, "Document not found")


# ─── Classification ───────────────────────────────────────
@app.post("/api/projects/{project_id}/classify")
async def classify_documents(project_id: str):
    """Classify all extracted documents."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    router = LLMRouter()
    results = []

    for doc in project["documents"]:
        text = doc.get("text", "")
        filename = doc.get("original_filename", "")

        await send_sse(project_id, "classifying", {
            "doc_id": doc["id"],
            "filename": filename,
        })

        classification = await classify_document(router, text, filename, project.get("name", ""))

        state.update_document(project, doc["id"], {
            "status": "classified",
            "classification": classification,
        })

        state.add_reasoning(project, "classification", {
            "doc_id": doc["id"],
            "filename": filename,
            "classification": classification["doc_type"],
            "confidence": classification["confidence"],
            "reasoning": classification["reasoning"],
            "is_reference_report": classification.get("is_reference_report", False),
        })

        results.append({
            "id": doc["id"],
            "filename": filename,
            "classification": classification,
        })

        await send_sse(project_id, "classified", {
            "doc_id": doc["id"],
            "filename": filename,
            "classification": classification,
        })

    project["status"] = "classified"
    state.save_project(project)

    return {"results": results}


# ─── Assembly ─────────────────────────────────────────────
@app.post("/api/projects/{project_id}/assemble")
async def assemble_report(project_id: str):
    """Create assembly mapping from classified documents."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    assembly = create_assembly(project)
    project["assembly"] = assembly
    project["status"] = "assembled"
    state.save_project(project)

    await send_sse(project_id, "assembly_complete", {"assembly": assembly})
    return {"assembly": assembly}


@app.get("/api/projects/{project_id}/assembly")
async def get_assembly(project_id: str):
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return {"assembly": project.get("assembly")}


@app.put("/api/projects/{project_id}/assembly")
async def update_assembly(project_id: str, request: Request):
    """Update assembly (reorder, move, add, remove docs)."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    body = await request.json()
    project["assembly"] = body.get("assembly", project.get("assembly"))
    state.save_project(project)
    return {"assembly": project["assembly"]}


# ─── Export ───────────────────────────────────────────────
def create_divider_page(title: str, output_path: Path):
    """Create a PDF divider page with section title."""
    c = canvas.Canvas(str(output_path), pagesize=letter)
    w, h = letter
    c.setFont("Helvetica-Bold", 36)
    c.drawCentredString(w / 2, h / 2 + 50, title)
    c.setFont("Helvetica", 14)
    c.drawCentredString(w / 2, h / 2 - 20, "ODIC Environmental")
    c.showPage()
    c.save()


@app.post("/api/projects/{project_id}/export")
async def export_report(project_id: str):
    """Merge all assembled documents into final PDF(s)."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    assembly = project.get("assembly")
    if not assembly:
        raise HTTPException(400, "No assembly created yet")

    conv_dir = config.PROJECTS_DIR / project_id / "converted"
    export_dir = config.PROJECTS_DIR / project_id / "export"
    export_dir.mkdir(exist_ok=True)

    # Clean old exports
    for f in export_dir.iterdir():
        f.unlink()

    merger = fitz.open()
    total_pages = 0
    section_boundaries = []  # (page_num, section_name)

    for section in assembly.get("sections", []):
        section_name = section.get("title", "Untitled")
        doc_ids = section.get("document_ids", [])

        if not doc_ids:
            continue

        # Add divider page for appendices
        if section.get("is_appendix", False):
            divider_path = export_dir / f"divider_{section.get('key', 'x')}.pdf"
            create_divider_page(section_name, divider_path)
            divider_doc = fitz.open(str(divider_path))
            merger.insert_pdf(divider_doc)
            total_pages += len(divider_doc)
            divider_doc.close()

        section_boundaries.append((total_pages, section_name))

        for doc_id in doc_ids:
            doc_meta = next((d for d in project["documents"] if d["id"] == doc_id), None)
            if not doc_meta:
                continue
            conv_file = doc_meta.get("converted_filename")
            if not conv_file:
                continue
            pdf_path = conv_dir / conv_file
            if not pdf_path.exists():
                continue

            try:
                src = fitz.open(str(pdf_path))
                # Compress images if needed
                for page in src:
                    for img in page.get_images():
                        try:
                            xref = img[0]
                            pix = fitz.Pixmap(src, xref)
                            if pix.width > config.IMAGE_MAX_DPI * 8.5 or pix.height > config.IMAGE_MAX_DPI * 11:
                                # Downscale
                                scale = config.IMAGE_MAX_DPI * 8.5 / max(pix.width, 1)
                                new_w = int(pix.width * scale)
                                new_h = int(pix.height * scale)
                                # Re-encode at lower res
                                img_data = pix.tobytes("jpeg")
                                pil_img = Image.open(BytesIO(img_data))
                                pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)
                                buf = BytesIO()
                                pil_img.save(buf, "JPEG", quality=80)
                                # Note: full image replacement in PyMuPDF requires more work
                                # For now we accept existing DPI
                            pix = None
                        except Exception:
                            pass  # Skip image compression errors

                merger.insert_pdf(src)
                total_pages += len(src)
                src.close()
            except Exception as e:
                logger.error(f"Failed to merge {pdf_path}: {e}")

    if total_pages == 0:
        raise HTTPException(400, "No pages to export")

    # Save and potentially split
    export_files = []
    full_path = export_dir / f"{project.get('name', 'report').replace(' ', '_')}.pdf"
    merger.save(str(full_path), deflate=True, garbage=4)
    file_size = full_path.stat().st_size

    if file_size <= config.MAX_EXPORT_SIZE:
        export_files.append({
            "filename": full_path.name,
            "size_bytes": file_size,
            "page_count": total_pages,
            "part": 1,
            "total_parts": 1,
        })
    else:
        # Split at section boundaries
        parts = []
        current_start = 0
        current_size_est = 0
        avg_page_size = file_size / max(total_pages, 1)
        part_num = 0

        for i, (page_num, section_name) in enumerate(section_boundaries):
            est_size = (page_num - current_start) * avg_page_size
            next_boundary = section_boundaries[i + 1][0] if i + 1 < len(section_boundaries) else total_pages
            next_est = (next_boundary - current_start) * avg_page_size

            if next_est > config.MAX_EXPORT_SIZE and page_num > current_start:
                parts.append((current_start, page_num))
                current_start = page_num

        if current_start < total_pages:
            parts.append((current_start, total_pages))

        full_doc = fitz.open(str(full_path))
        for idx, (start, end) in enumerate(parts):
            part_doc = fitz.open()
            part_doc.insert_pdf(full_doc, from_page=start, to_page=end - 1)
            part_name = f"{project.get('name', 'report').replace(' ', '_')}_Part{idx+1}of{len(parts)}.pdf"
            part_path = export_dir / part_name
            part_doc.save(str(part_path), deflate=True, garbage=4)
            export_files.append({
                "filename": part_name,
                "size_bytes": part_path.stat().st_size,
                "page_count": end - start,
                "part": idx + 1,
                "total_parts": len(parts),
            })
            part_doc.close()
        full_doc.close()
        full_path.unlink()  # Remove unsplit version

    merger.close()

    project["export"] = {"files": export_files, "total_pages": total_pages}
    project["status"] = "exported"
    state.save_project(project)

    await send_sse(project_id, "export_complete", {"files": export_files})
    return {"files": export_files, "total_pages": total_pages}


@app.get("/api/projects/{project_id}/export/{filename}")
async def download_export(project_id: str, filename: str):
    """Download an exported file."""
    export_dir = config.PROJECTS_DIR / project_id / "export"
    file_path = export_dir / filename
    if not file_path.exists():
        raise HTTPException(404, "Export file not found")
    return FileResponse(str(file_path), filename=filename, media_type="application/pdf")


# ─── AI Reasoning ─────────────────────────────────────────
@app.get("/api/projects/{project_id}/reasoning")
async def get_reasoning(project_id: str):
    """Get all AI reasoning events for a project."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return {"reasoning": project.get("ai_reasoning", [])}


# ─── Document Management ─────────────────────────────────
@app.delete("/api/projects/{project_id}/documents/{doc_id}")
async def remove_document(project_id: str, doc_id: str):
    """Remove a document from the project."""
    project = state.load_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    project["documents"] = [d for d in project["documents"] if d["id"] != doc_id]
    state.save_project(project)
    return {"status": "removed"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
