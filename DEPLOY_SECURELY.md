# Deployment Guide — Secure API Key Setup

## ⚡ Quick Deploy (2-3 minutes)

### **Step 1: Click One Link** (on your phone or browser)

```
https://render.com/deploy?repo=https://github.com/bpickett2019/ODIC-Environmental
```

### **Step 2: Authorize GitHub**
- Click "Connect with GitHub"
- Authorize `bpickett2019/ODIC-Environmental` repo access

### **Step 3: Set Environment Variables**

When Render asks for environment variables, fill in:

| Variable | Value | Required? |
|----------|-------|-----------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` (your API key) | ✅ YES |
| `AI_BACKEND` | `ollama` | ⚠️ Optional (default: ollama) |
| `OLLAMA_URL` | Keep default | ⚠️ Optional |

**Your API Key** (from earlier):
```
sk-ant-oat01-SDTNBb2FNQf3fYU6NcbWJSRZqJDZHy4p2M4N3mmnRq6bAaDtUSUnwG9GWMEbE7UAQnU nwqS7lABp6Mcdla-GxA-6vfLWQAA
```

### **Step 4: Deploy**
- Click "Deploy"
- Render will build and start the app (~2-3 minutes)
- **Live URL**: `https://odic-esa.onrender.com`

**Done!** ✅ Your system is live.

---

## 🔐 API Key Security Best Practices

### **❌ NEVER do these:**
- Commit API key to git (visible in history forever)
- Put API key in `Dockerfile` (visible in images)
- Put API key in `.env` file in repo (visible to anyone)
- Hardcode API key in Python/JavaScript code
- Send API key in unencrypted URLs

### **✅ DO these:**
- Use environment variables (set in deployment UI, not in code)
- Use `.env` file locally (git-ignored via `.gitignore`)
- Use Render/Railway/Fly dashboard to set secrets
- Use GitHub Actions Secrets for CI/CD
- Rotate API keys regularly (Anthropic console)

### **How Render.com Keeps Keys Safe**
1. You paste key in Render web UI (HTTPS only)
2. Render stores in encrypted vault
3. Only readable by running container
4. Not visible in git, logs, or web UI after set
5. Can be rotated/deleted without code changes

---

## 🚀 Deployment Options (All Secure)

### **Option A: Render.com (EASIEST)**

**Time**: 2 minutes | **Cost**: Free tier available | **Complexity**: ⭐

```
https://render.com/deploy?repo=https://github.com/bpickett2019/ODIC-Environmental
```

**Steps**:
1. Click link
2. Fill API key in web form
3. Click "Deploy"
4. Wait 2-3 minutes
5. Live at `https://odic-esa.onrender.com`

**Pros**:
- ✅ One-click deploy
- ✅ GitHub integration (auto-redeploy on git push)
- ✅ Free tier ($7/month credit)
- ✅ Built-in health checks
- ✅ Persistent disk storage

**Cons**:
- Limited free tier (may need upgrade after 90 days)

---

### **Option B: Railway.app (GOOD FREE TIER)**

**Time**: 5 minutes | **Cost**: Free tier + $5/month | **Complexity**: ⭐⭐

**Steps**:

1. **Create account**: https://railway.app
2. **Connect GitHub**: Link your GitHub account
3. **Import project**: Select `bpickett2019/ODIC-Environmental`
4. **Set environment variables**:
   - Go to project settings
   - Add `ANTHROPIC_API_KEY = sk-ant-...`
   - Add `AI_BACKEND = ollama`
5. **Deploy**: Click "Deploy"
6. **Wait**: 3-5 minutes
7. **Live URL**: Check "Deployments" tab for URL

**Pros**:
- ✅ Better free tier ($5/month credit)
- ✅ Generous limits
- ✅ No credit card needed for free tier
- ✅ PostgreSQL support

**Cons**:
- Requires more manual setup
- UI is less intuitive than Render

---

### **Option C: Fly.io (GLOBAL DEPLOYMENT)**

**Time**: 10 minutes | **Cost**: Free tier + pay-as-you-go | **Complexity**: ⭐⭐

**Steps**:

1. **Install Fly CLI**:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Authenticate**:
   ```bash
   flyctl auth login
   ```

3. **Create app**:
   ```bash
   flyctl launch --repo https://github.com/bpickett2019/ODIC-Environmental
   ```

4. **Set secret**:
   ```bash
   flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```

5. **Deploy**:
   ```bash
   flyctl deploy
   ```

6. **Check status**:
   ```bash
   flyctl status
   ```

**Pros**:
- ✅ Global deployment (fast for worldwide users)
- ✅ Modern infrastructure
- ✅ Free tier available

**Cons**:
- Requires CLI installation
- More complex for beginners

---

## 🔑 Managing Your API Key Safely

### **What's Your Key?**
```
sk-ant-oat01-SDTNBb2FNQf3fYU6NcbWJSRZqJDZHy4p2M4N3mmnRq6bAaDtUSUnwG9GWMEbE7UAQnU nwqS7lABp6Mcdla-GxA-6vfLWQAA
```

### **Where to Paste It:**

**Render.com**: 
1. Fill environment variable form in deploy UI
2. Name: `ANTHROPIC_API_KEY`
3. Value: Paste key above
4. Click "Deploy"

**Railway**:
1. Project Settings → Environment
2. Click "New Variable"
3. Name: `ANTHROPIC_API_KEY`
4. Value: Paste key above
5. Save

**Fly.io**:
```bash
flyctl secrets set ANTHROPIC_API_KEY="sk-ant-oat01-..."
```

**GitHub Actions** (for auto-deploy):
```bash
gh secret set ANTHROPIC_API_KEY --body "sk-ant-oat01-..."
```

### **Rotating Your Key (if compromised)**

1. Go to **https://console.anthropic.com**
2. Click "API Keys"
3. Find the key, click "Deactivate"
4. Create new key
5. Update in Render/Railway/Fly dashboard
6. **No code changes needed!**

---

## 🆔 Checking Deployment Status

### **Render.com**

```bash
# Check logs
curl https://odic-esa.onrender.com/health

# Expected output:
# {"status": "ok"}
```

### **Railway**

```bash
# Check logs via web UI
# Project → Deployments → View Logs

# Or check health
curl https://<railway-url>/health
```

### **Fly.io**

```bash
# Check status
flyctl status

# View logs
flyctl logs
```

---

## 🔧 Local Development (Without API Key in Git)

### **Setup:**

1. **Clone repo**:
   ```bash
   git clone https://github.com/bpickett2019/ODIC-Environmental.git
   cd ODIC-Environmental
   ```

2. **Create local `.env`** (git-ignored):
   ```bash
   cp .env.example .env
   ```

3. **Edit `.env`**:
   ```bash
   nano .env
   # Paste your API key
   # ANTHROPIC_API_KEY=sk-ant-...
   ```

4. **Verify `.env` is in `.gitignore`**:
   ```bash
   cat .gitignore | grep "^\.env"
   # Should output: .env
   ```

5. **Start backend**:
   ```bash
   cd backend
   python -m uvicorn main:app --reload
   ```

6. **Start frontend** (new terminal):
   ```bash
   cd frontend
   npm run dev
   ```

7. **Visit**: `http://localhost:5173`

**Key principle**: `.env` lives on your machine only, never in git.

---

## 🚨 Troubleshooting

### **"Health check failed"**

**Cause**: Backend not starting  
**Solution**:
1. Check logs in Render/Railway dashboard
2. Verify `ANTHROPIC_API_KEY` is set
3. Verify Python version (needs 3.11+)

### **"502 Bad Gateway"**

**Cause**: Container crashed or too slow  
**Solution**:
1. Check build logs (Render → "Build")
2. Ensure `Dockerfile.prod` is present
3. Verify environment variables (look for typos)

### **"Cannot classify documents"**

**Cause**: Ollama not available or key invalid  
**Solution**:
1. If using Ollama: Deploy local Ollama instance
2. If using Claude: Verify API key is correct
3. Check logs for error message

### **"Upload fails with 413 Payload Too Large"**

**Cause**: File >25MB  
**Solution**:
1. Split file before upload
2. Or increase `MAX_STANDARD_SIZE_MB` in `.env`

---

## 📊 Monitoring After Deployment

### **Check App Health** (daily)

```bash
curl https://odic-esa.onrender.com/health
# Expected: {"status": "ok"}
```

### **Monitor Logs** (weekly)

**Render.com**:
- Dashboard → Select app → Logs
- Filter by "ERROR" or "WARNING"

**Railway**:
- Project → Logs
- Search for failures

**Fly.io**:
```bash
flyctl logs --follow
```

### **Performance Monitoring**

**Render.com Dashboard** shows:
- CPU usage
- Memory usage
- Request count
- Response time

---

## 🔄 Auto-Deploy on Git Push

Once deployed, push to main branch triggers auto-redeploy:

```bash
git add ARCHITECTURE.md TOOLS_AND_DEPENDENCIES.md
git commit -m "docs: add complete architecture and tools documentation"
git push origin main
```

**Render.com** automatically:
1. Detects git push
2. Rebuilds Docker image
3. Restarts container
4. Keeps API key (no need to re-enter)

**Downtime**: ~1-2 minutes (blue-green deployment coming)

---

## ✅ Post-Deployment Checklist

- [ ] **Health check passes**: `curl /health → {"status": "ok"}`
- [ ] **Upload page loads**: Visit `https://odic-esa.onrender.com`
- [ ] **Upload file**: Test with small PDF
- [ ] **Classification works**: Check if document auto-classifies
- [ ] **Chat commands work**: Send "How many pages?"
- [ ] **Logs are clean**: No ERROR or WARNING spam
- [ ] **Database persists**: Create report, refresh page, data still there
- [ ] **API key is secure**: Not visible in logs, git, or Dockerfile

---

## 🎯 Next Steps

1. ✅ Click Render deploy link
2. ✅ Paste API key in environment variable form
3. ✅ Click "Deploy" and wait 2-3 minutes
4. ✅ Test with sample file (ask Rose for small test PDF)
5. ✅ Download test data from Google Drive (6384674-ESAI)
6. ✅ Upload and validate ordering
7. ✅ Monitor logs for 24 hours
8. ✅ Go live!

**Estimated time to production**: <5 minutes (deploy) + 30 minutes (testing) = ~35 minutes total.

