# System Requirements — LibreOffice & Ghostscript

**Status**: ✅ Updated & Fixed (Commit 427df39)

---

## 🔴 CRITICAL DEPENDENCIES

These MUST be installed for the system to work:

### **LibreOffice** (REQUIRED)
- **Purpose**: Convert .docx, .doc, .vsd, .vsdx files to PDF
- **Why**: ESA reports often come as Word documents
- **Location in code**: `backend/converter.py` → `_convert_with_libreoffice()`
- **Config**: `backend/config.py` → `LIBREOFFICE_PATH` (default: `soffice`)

**Installation:**

```bash
# Linux (Ubuntu/Debian)
sudo apt-get install libreoffice

# macOS
brew install libreoffice

# Windows
# Download from https://www.libreoffice.org/download/download/

# Docker (Dockerfile.prod)
RUN apt-get install -y libreoffice
```

**Verify:**
```bash
soffice --version
# Should output: LibreOffice 7.x.x.x
```

---

### **Ghostscript** (REQUIRED)
- **Purpose**: Compress PDFs by reducing DPI
- **Why**: Final assembled reports need email-friendly file sizes
- **Location in code**: `backend/assembler.py` → PDF compression logic
- **Config**: `backend/config.py` → `GHOSTSCRIPT_PATH` (default: `gs`)

**Installation:**

```bash
# Linux (Ubuntu/Debian)
sudo apt-get install ghostscript

# macOS
brew install ghostscript

# Windows
# Download from https://www.ghostscript.com/download/gsdnld.html

# Docker (Dockerfile.prod)
RUN apt-get install -y ghostscript
```

**Verify:**
```bash
gs --version
# Should output: GPL Ghostscript 10.x.x or higher
```

---

## ✅ VERIFIED IN CODE

### **LibreOffice Usage**

**File: `backend/converter.py`** (280 lines)

```python
def convert_to_pdf(input_path, output_dir):
    """Converts various formats to PDF"""
    
    ext = input_path.suffix.lower()
    
    if ext in {".docx", ".doc", ".vsd", ".vsdx"}:
        return _convert_with_libreoffice(input_path, output_dir)
    # ... other formats
```

**Used in `backend/main.py`:**
- Line 39: Import `convert_to_pdf`, `async_convert_to_pdf`
- Lines 424, 628, 756, 1122, 1935, 2083: Called during file upload & processing

### **Ghostscript Usage**

**File: `backend/assembler.py`**

```python
def compress_pdf(pdf_path, output_path, dpi=150):
    """Compress PDF using Ghostscript"""
    
    cmd = [
        GHOSTSCRIPT_PATH,
        "-sDEVICE=pdfwrite",
        f"-dDEVICEWIDTHPOINTS=612",
        # ... other options
    ]
```

---

## 📦 DOCKER CONFIGURATION

### **Dockerfile.prod** (Now Updated ✅)

```dockerfile
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    ghostscript \
    libreoffice \        # ← ADDED in commit 427df39
    curl \
    && rm -rf /var/lib/apt/lists/*
```

**Result**: Production container has LibreOffice + Ghostscript automatically installed.

---

## 🚀 LOCAL DEVELOPMENT SETUP

### **Ubuntu/Debian**

```bash
# Install required system dependencies
sudo apt-get update
sudo apt-get install -y \
    python3.11 \
    python3-pip \
    nodejs \
    npm \
    libreoffice \
    ghostscript \
    tesseract-ocr

# Clone and setup
git clone https://github.com/bpickett2019/ODIC-Environmental.git
cd ODIC-Environmental

# Backend
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

### **macOS**

```bash
# Install required system dependencies
brew install python@3.11 node libreoffice ghostscript tesseract

# Clone and setup
git clone https://github.com/bpickett2019/ODIC-Environmental.git
cd ODIC-Environmental

# Backend
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

### **Windows**

1. **Install Python 3.11** from https://www.python.org
2. **Install Node.js 20+** from https://nodejs.org
3. **Install LibreOffice** from https://www.libreoffice.org
4. **Install Ghostscript** from https://www.ghostscript.com
5. **Clone repo**:
   ```bash
   git clone https://github.com/bpickett2019/ODIC-Environmental.git
   cd ODIC-Environmental
   ```
6. **Backend**:
   ```bash
   cd backend
   pip install -r requirements.txt
   python -m uvicorn main:app --reload
   ```
7. **Frontend** (new terminal):
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

---

## 🧪 TESTING THE INSTALLATION

### **Quick Verification Script**

```bash
#!/bin/bash
echo "Checking system dependencies..."

echo -n "Python 3.11+: "
python3 --version || echo "NOT FOUND"

echo -n "Node.js 20+: "
node --version || echo "NOT FOUND"

echo -n "npm: "
npm --version || echo "NOT FOUND"

echo -n "LibreOffice: "
soffice --version || echo "NOT FOUND"

echo -n "Ghostscript: "
gs --version || echo "NOT FOUND"

echo -n "Tesseract: "
tesseract --version | head -1 || echo "NOT FOUND"

echo ""
echo "If all show versions, you're ready to deploy!"
```

---

## 🐳 DEPLOYMENT CHECKLIST

### **Before Deploying to Render/Railway/Fly.io:**

- ✅ Dockerfile.prod has LibreOffice + Ghostscript (DONE)
- ✅ Environment variables set (ANTHROPIC_API_KEY)
- ✅ Git committed and pushed
- ✅ Health check endpoint working locally

### **After Deployment:**

```bash
# Verify system dependencies in container
curl -X GET https://[deployed-url]/health
# Should return: {"status":"ok"}

# Test with .docx file
# 1. Visit deployed URL
# 2. Create new report
# 3. Upload a .docx file
# 4. System should auto-convert to PDF and classify
```

---

## 🔍 WHAT HAPPENS IF MISSING

### **If LibreOffice is Missing**

**Error**: "LibreOffice conversion failed"

```
[ERROR] LibreOffice conversion failed for document.docx
[ERROR] [Errno 2] No such file or directory: 'soffice'
```

**Result**: .docx files cannot be processed; system fails on upload.

### **If Ghostscript is Missing**

**Error**: "Ghostscript compression failed"

```
[ERROR] Ghostscript compression failed
[ERROR] [Errno 2] No such file or directory: 'gs'
```

**Result**: Final PDFs are large (not compressed for email); system still works but with larger file sizes.

---

## 📋 TECH STACK SUMMARY (CORRECTED)

| Component | Status | Required? | Cost |
|-----------|--------|-----------|------|
| **Python 3.11** | ✅ | Yes | $0 |
| **Node.js 20+** | ✅ | Yes | $0 |
| **Docker** | ✅ | For deployment | $0 |
| **LibreOffice** | ✅ FIXED | **Yes** | $0 |
| **Ghostscript** | ✅ FIXED | **Yes** | $0 |
| **Tesseract OCR** | ✅ | Optional | $0 |
| **Ollama** | ✅ | For classification | $0 |
| **Claude API** | ✅ | Optional tiebreaker | $0.01-0.02/doc |

---

## ✅ WHAT WAS FIXED (Commit 427df39)

### **Issue**: LibreOffice marked as "optional" but actually required

### **Fix #1: Dockerfile.prod**
```diff
- # Install system dependencies
- RUN apt-get update && apt-get install -y \
-     tesseract-ocr \
-     ghostscript \
-     curl \

+ # Install system dependencies
+ RUN apt-get update && apt-get install -y \
+     tesseract-ocr \
+     ghostscript \
+     libreoffice \
+     curl \
```

### **Fix #2: TECH_STACK.md**
```diff
### **Required**
- Docker               Container engine (for deployment)

+ Docker               Container engine (for deployment)
+ LibreOffice          Convert .docx/.doc/.vsd to PDF (REQUIRED for Word docs)
+ Ghostscript          PDF compression (optimize DPI for final assembly)

### **Optional**
- Ghostscript          PDF compression (optimize DPI)
- Tesseract OCR        Optical character recognition
- LibreOffice          Document format conversion
+ Tesseract OCR        Optical character recognition (scanned PDFs)
```

### **Fix #3: Installation Instructions**
- Added `libreoffice` to Ubuntu/Debian apt-get
- Added `libreoffice` to macOS brew install
- Added LibreOffice to Windows manual install list

---

## 🎯 BOTTOM LINE

**LibreOffice + Ghostscript are REQUIRED, not optional.**

- ✅ Now in Dockerfile.prod (production deployments have them)
- ✅ Now marked REQUIRED in TECH_STACK.md
- ✅ Installation instructions updated for all platforms
- ✅ Code verification: Used in `converter.py` (10+ code paths)

**Production deployment (Render/Railway/Fly.io) will have both automatically.**

**Local development: Install with `apt-get install libreoffice ghostscript`** before running backend.

