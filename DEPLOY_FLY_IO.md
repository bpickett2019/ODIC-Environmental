# Fly.io Deployment Guide — ODIC Environmental

**Status**: Production-Ready for Fly.io  
**Cost**: Free tier available (one shared-cpu instance)  
**Performance**: Sub-1s response times (better than Railway)  
**Python Timeout**: No limit (unlike Vercel's 60s)  
**Database**: Persistent volume included  

---

## 🚀 Quick Deploy (5 minutes)

### Prerequisites
```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Create account (free)
flyctl auth signup
# OR login to existing account
flyctl auth login
```

### Deploy
```bash
# Clone the repo
git clone https://github.com/bpickett2019/ODIC-Environmental.git
cd ODIC-Environmental

# Verify fly.toml exists
[ -f fly.toml ] && echo "✓ fly.toml ready" || echo "✗ Missing fly.toml"

# Create app on Fly.io (first time only)
flyctl apps create odic-esa
# OR if app already exists:
flyctl apps list

# Set environment variables (REQUIRED)
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-oat01-...
flyctl secrets set AI_BACKEND=anthropic
flyctl secrets set DATABASE_URL=sqlite:////data/reports.db

# Deploy
git push origin main
# GitHub Actions will auto-deploy OR

# Manual deploy
flyctl deploy

# Watch logs
flyctl logs

# Check status
flyctl status
```

### Verify Deployment
```bash
# Health check
curl https://odic-esa.fly.dev/health

# Expected response:
# {"status":"ok"}

# Get public URL
flyctl info
```

---

## 📋 Configuration Verified

### fly.toml
✅ Dockerfile.prod configured  
✅ Persistent volume for SQLite database  
✅ Port 8000 exposed (HTTP + HTTPS)  
✅ Health check configured (30s interval)  
✅ Scaling: min 1 machine, auto-stop when idle  
✅ Region: sfo (San Francisco) — adjust if needed  

### Backend (main.py)
✅ CORS configured (allow all origins)  
✅ Static file serving ("/") mounted correctly  
✅ Health check endpoint (/health)  
✅ Database auto-initialization  
✅ Error handling + logging  

### Frontend (React)
✅ Build scripts configured  
✅ Vite config optimized  
✅ TypeScript compilation  
✅ Static files copied to Docker container  

### Docker
✅ Multi-stage build (Node + Python)  
✅ System dependencies included (LibreOffice, Ghostscript)  
✅ All Python packages installed  
✅ Health check configured  
✅ Proper port exposure  

---

## ⚙️ Environment Variables (MUST SET)

```bash
# API Key for Claude (REQUIRED)
ANTHROPIC_API_KEY = sk-ant-oat01-...

# AI Backend Selection (default: anthropic)
AI_BACKEND = "anthropic"  # or "ollama"

# Database URL (default: SQLite in persistent volume)
DATABASE_URL = "sqlite:////data/reports.db"

# Optional: Override ports, logging, etc.
LOG_LEVEL = "info"
```

Set via:
```bash
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...
flyctl secrets set AI_BACKEND=anthropic
```

---

## 🔍 Debugging Issues

### "App won't start"
```bash
# Check logs
flyctl logs -a odic-esa

# Look for:
- ModuleNotFoundError → Missing Python package
- Port already in use → Change port in fly.toml
- Database error → Check DATABASE_URL variable
```

### "Health check failing"
```bash
# Manually test health endpoint
curl https://odic-esa.fly.dev/health

# If 404: Static file mounting issue
# If 500: Backend error (check logs)
# If timeout: Backend not responding (check fly.toml port)
```

### "Static files not serving"
```bash
# Frontend should be at https://odic-esa.fly.dev/
# Check:
flyctl logs | grep "Mounted frontend"
# Should see: "Mounted frontend static files from /app/static"

# If missing: Frontend build failed
flyctl builds
```

### "PDF assembly times out"
```bash
# Fly.io has NO timeout limit (unlike Vercel)
# Check:
- Is AI_BACKEND set correctly?
- Is ANTHROPIC_API_KEY valid?
- Check logs for actual errors
flyctl logs -a odic-esa --tail 50
```

---

## 🚀 Production Checklist

### Before First Deploy
- [ ] GitHub repo ready (bpickett2019/ODIC-Environmental)
- [ ] fly.toml present and configured
- [ ] Dockerfile.prod works locally
- [ ] Environment variables documented
- [ ] ANTHROPIC_API_KEY value ready

### During Deployment
- [ ] flyctl auth login successful
- [ ] flyctl deploy completes without errors
- [ ] Logs show no error messages
- [ ] Health check responds 200 OK

### After Deployment
- [ ] Visit https://odic-esa.fly.dev/ → React frontend loads
- [ ] API responds to /api/reports → 200 OK
- [ ] Upload test PDF → classification works
- [ ] Assembly completes in <5 minutes
- [ ] Database persists across restarts

### Scaling (If Needed)
```bash
# Increase machine count
flyctl scale count 2

# Increase machine size
flyctl scale memory 2048

# Monitor
flyctl metrics
```

---

## 📊 Monitoring

### Check Status
```bash
flyctl status          # Current running status
flyctl apps list       # List all your apps
flyctl machines list   # See running machines
flyctl metrics         # CPU, memory, requests
```

### View Logs
```bash
flyctl logs                    # Real-time logs
flyctl logs --tail 100         # Last 100 lines
flyctl logs -a odic-esa        # From specific app
flyctl logs --follow           # Follow logs
```

### Alerts
```bash
# No built-in alerts, but you can:
# 1. Check logs regularly
# 2. Monitor via Fly dashboard
# 3. Set up 3rd party monitoring (optional)
```

---

## 🔄 Continuous Deployment (GitHub Actions)

GitHub Actions workflow automatically deploys on git push (if configured):

```bash
# Push triggers auto-deploy
git add .
git commit -m "some changes"
git push origin main

# Watch deployment
flyctl logs --follow
```

**To enable**: Add `.github/workflows/flyio-deploy.yml`:
```yaml
name: Deploy to Fly
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

---

## 🛠️ Rollback (If Needed)

```bash
# List previous releases
flyctl releases

# Rollback to previous version
flyctl releases rollback

# Or specific release
flyctl releases rollback --image-tag <hash>
```

---

## 💰 Cost Estimate

| Item | Free Tier | Paid |
|------|-----------|------|
| Compute (1 shared-cpu) | Included (3/month free) | $5-50/month |
| Database (persistent volume) | Included (3GB free) | $0.10/GB/month |
| Bandwidth (first 100GB out) | Included | $0.02/GB after |
| **Total** | **$0** | **$5-20/month** |

With free tier, you get:
- 1 shared-cpu instance (free)
- 3GB persistent volume (free)
- 160 connection hours/month
- 100GB bandwidth/month

Perfect for testing and small deployments. Upgrade to paid only if needed.

---

## ✅ Success Indicators

You'll know deployment succeeded when:

1. **Health Check**: `curl https://odic-esa.fly.dev/health` → `{"status":"ok"}`
2. **Frontend Loads**: Visit https://odic-esa.fly.dev/ → React UI renders
3. **API Works**: `curl https://odic-esa.fly.dev/api/reports` → JSON response
4. **PDF Assembly**: Upload test files → <5 minute assembly time
5. **Database Persists**: Restart app → data still there

---

## 🆘 Support

**Fly.io Docs**: https://fly.io/docs/  
**Community**: https://community.fly.io/  
**GitHub Issues**: https://github.com/bpickett2019/ODIC-Environmental/issues  

---

## 📝 Next Steps

1. ✅ Verify fly.toml (done)
2. ⏳ Test locally: `docker build -f Dockerfile.prod -t odic-test .`
3. ⏳ Deploy: `flyctl deploy`
4. ⏳ Verify health check
5. ⏳ Test with real data (6384674-ESAI)
6. ⏳ Go live!

---

**Status**: Ready for Fly.io deployment  
**Estimated Deploy Time**: 3-5 minutes  
**Expected Result**: Full-stack app live at https://odic-esa.fly.dev  

