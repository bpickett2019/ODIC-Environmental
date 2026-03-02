# Ollama Setup Guide — Local Development

**Why this matters**: For local testing before deployment, you need Ollama running. It's free, local, and powers document classification.

---

## 🚀 Quick Start (5 minutes)

### **macOS**
```bash
brew install ollama
ollama serve &
ollama pull qwen2.5:7b
```

### **Linux (Ubuntu/Debian)**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
systemctl start ollama
ollama pull qwen2.5:7b
```

### **Windows**
1. Download: https://ollama.ai/download/windows
2. Install and run
3. Open PowerShell/CMD:
   ```powershell
   ollama pull qwen2.5:7b
   ```

### **Docker**
```bash
docker run -d --name ollama -p 11434:11434 ollama/ollama:latest
docker exec ollama ollama pull qwen2.5:7b
```

---

## 📥 Installation Details

### **Step 1: Install Ollama**

**macOS:**
```bash
brew install ollama
```

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

Or manual install:
```bash
wget https://ollama.ai/download/ollama-linux-x86_64.tgz
tar -xzf ollama-linux-x86_64.tgz
sudo mv ollama /usr/bin/
```

**Windows:**
1. Visit https://ollama.ai/download/windows
2. Download installer
3. Run installer (will add to PATH)
4. Restart terminal

### **Step 2: Download Model (First Time)**

The first time you run Ollama, it downloads the model (~4.5GB for qwen2.5:7b).

```bash
ollama pull qwen2.5:7b
```

This happens automatically when you first use it, or you can pre-download:
```bash
ollama pull qwen2.5:7b
```

**Expected output:**
```
pulling manifest
pulling d95e37e87e65... 100% |████████████████████| 4.5 GB
pulling df97dd0e7a09... 100%
pulling 08adc1c5a5b2... 100%
pulling 7db3bb4f5937... 100%
pulling dd0fcdd7487d... 100%
verifying sha256 digest
writing manifest
removing any unused layers
success
```

### **Step 3: Start Ollama Server**

**Option A: Foreground (easy debugging)**
```bash
ollama serve
```

**Expected output:**
```
time=2026-03-01T22:35:00.123Z level=INFO msg="Listening on 127.0.0.1:11434"
```

**Option B: Background**

**macOS/Linux:**
```bash
ollama serve &
```

**Windows (PowerShell):**
```powershell
Start-Process ollama -ArgumentList serve -WindowStyle Hidden
```

**Option C: System Service**

**macOS:**
```bash
brew services start ollama
```

**Linux (systemd):**
```bash
sudo systemctl start ollama
sudo systemctl enable ollama  # Auto-start on boot
```

### **Step 4: Verify It's Running**

```bash
curl http://localhost:11434/api/tags
```

**Expected output:**
```json
{
  "models": [
    {
      "name": "qwen2.5:7b",
      "modified_at": "2026-03-01T22:35:00Z",
      "size": 4500000000,
      "digest": "..."
    }
  ]
}
```

If you see the model listed, ✅ Ollama is running correctly.

---

## ⚙️ Configuration

### **Backend Configuration**

The backend automatically looks for Ollama at `http://localhost:11434`.

To change the URL, set environment variable:

```bash
export OLLAMA_URL=http://other-host:11434
python -m uvicorn backend/main:app --reload
```

Or in `.env`:
```
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
```

### **System Requirements**

**Minimum:**
- RAM: 8GB (qwen2.5:7b runs on 8GB, tight)
- Disk: 5GB free (for model)
- CPU: 2+ cores

**Recommended:**
- RAM: 16GB+ (comfortable, allows other apps)
- Disk: 10GB free (room for other models)
- GPU: NVIDIA (CUDA) or Apple Silicon (Metal) for speed

**If you don't have enough RAM:**
Use a smaller model:
```bash
ollama pull qwen2.5:3b   # 2.2GB, faster
ollama pull orca-mini     # 1.7GB, minimal
```

Then tell backend to use it:
```bash
export OLLAMA_MODEL=qwen2.5:3b
```

---

## 🧪 Testing Ollama

### **Test 1: Direct API Call**

```bash
curl -X POST http://localhost:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:7b",
    "prompt": "What is an ESA report?",
    "stream": false
  }' | jq .
```

**Expected output:**
```json
{
  "model": "qwen2.5:7b",
  "created_at": "2026-03-01T22:35:00Z",
  "response": "An ESA report (Environmental Site Assessment)...",
  "done": true,
  "total_duration": 5123456789,
  "load_duration": 234567890,
  "prompt_eval_duration": 123456789,
  "eval_duration": 456789012
}
```

### **Test 2: Backend Integration**

1. Start backend:
   ```bash
   cd backend
   python -m uvicorn main:app --reload
   ```

2. Visit: http://localhost:8000/docs

3. Find POST `/api/reports/1/chat`

4. Send test message:
   ```json
   {
     "message": "How many pages?"
   }
   ```

5. Should respond with status (using Ollama, not Claude)

---

## 🛠️ Troubleshooting

### **"Connection refused" on localhost:11434**

**Problem**: Ollama not running  
**Fix**:
```bash
ollama serve
```

### **"Model not found: qwen2.5:7b"**

**Problem**: Model not downloaded  
**Fix**:
```bash
ollama pull qwen2.5:7b
```

### **"Out of memory"**

**Problem**: Model too large for your RAM  
**Fix**: Use smaller model:
```bash
ollama pull qwen2.5:3b
export OLLAMA_MODEL=qwen2.5:3b
```

### **"Very slow (10+ seconds per response)"**

**Problem**: Running on CPU (no GPU acceleration)  
**Expected**: Normal for CPU. GPU would be 5-10x faster.  
**Fix**: GPU setup (NVIDIA CUDA or Apple Metal)

---

## 📊 Performance Expectations

### **With CPU (8GB RAM)**
- Classification: 5-10 seconds per document
- Memory: Steady 4-5GB while running
- Performance: Acceptable for testing

### **With GPU (NVIDIA CUDA)**
- Classification: 1-2 seconds per document
- Memory: 4-6GB VRAM
- Performance: Production-ready

### **With Apple Silicon (Metal)**
- Classification: 2-3 seconds per document
- Memory: 4-6GB shared
- Performance: Good for testing

---

## 🚀 Production Deployment

**Good news**: For production deployment (Render, Railway, Fly.io):
- ❌ Do NOT use Ollama (not available on free tier)
- ✅ Use Claude API instead
- ✅ Set `AI_BACKEND=anthropic` in environment variables
- ✅ Cost: $0.01-0.02 per document (reasonable)

Ollama is for **local development only**.

---

## 📝 After Setup

Once Ollama is running:

1. **Backend connects automatically** — No config needed
2. **Classification is instant** — <5 seconds per doc
3. **It's free** — No API costs

To test:

```bash
cd ODIC-Environmental
cd backend
python -m uvicorn main:app --reload

# In another terminal
cd frontend
npm run dev

# Visit http://localhost:5173
# Create report, upload PDF, should classify automatically
```

---

## 💡 Tips

### **Keep Ollama Running**
```bash
# macOS: Background service
brew services start ollama

# Linux: Systemd service
sudo systemctl start ollama
sudo systemctl enable ollama

# Or just keep terminal open
ollama serve
```

### **Monitor Ollama**
```bash
# Check if running
curl http://localhost:11434/api/tags

# View logs (macOS)
tail -f ~/.ollama/logs/server.log

# View logs (Linux)
journalctl -u ollama -f
```

### **Update Ollama**
```bash
brew upgrade ollama    # macOS
# Linux: Re-download and replace /usr/bin/ollama
# Windows: Re-run installer
```

---

## ✅ READY

Once you see:
```
time=2026-03-01T22:35:00.123Z level=INFO msg="Listening on 127.0.0.1:11434"
```

Ollama is running. You're ready to develop locally.

