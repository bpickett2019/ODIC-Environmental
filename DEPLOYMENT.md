# ODIC Environmental - Deployment Guide

**Quick Links:**
- 🚀 **Production Deployment:** Railway.app (recommended)
- 🐳 **Local Docker:** `docker-compose up`
- 💻 **Local Development:** See README.md

---

## Option 1: Railway.app Deployment (Recommended)

### **What You'll Get**
- ✅ Public URL (e.g., `https://odic-reports.railway.app`)
- ✅ Auto-deploys from GitHub
- ✅ Free tier available (or ~$5/month for better performance)
- ✅ Built-in monitoring & logs
- ✅ Easy scaling

### **Setup (5 minutes)**

#### **Step 1: Create Railway Account**
1. Go to https://railway.app
2. Sign up with GitHub (easier)
3. Create new project

#### **Step 2: Connect GitHub Repo**
1. In Railway, click "New Project"
2. Select "Deploy from GitHub"
3. Choose: `bpickett2019/ODIC-Environmental`
4. Give Railway access to the repo

#### **Step 3: Add Services**

Railway will auto-detect, but make sure:

**Backend Service:**
- Dockerfile: `backend/Dockerfile`
- Port: `8000`
- Environment variables:
  ```
  AI_BACKEND=ollama
  OLLAMA_URL=http://host.docker.internal:11434
  OLLAMA_MODEL=qwen2.5:7b
  ```

**Frontend Service:**
- Dockerfile: `frontend/Dockerfile`
- Port: `5173`
- Environment variables:
  ```
  VITE_API_URL=https://{backend-url}
  ```

#### **Step 4: Deploy**
1. Click "Deploy"
2. Watch logs (should see "Application startup complete")
3. Get public URL from Railway dashboard
4. Done! ✅

### **Railway Console**
```bash
# If you want to deploy from CLI instead:
npm install -g @railway/cli
railway login
railway up
```

---

## Option 2: Docker Compose (Local)

### **Prerequisites**
- Docker Desktop installed
- Ollama running on your machine (`localhost:11434`)

### **Run Locally**

```bash
cd /Users/bp/Ode

# Build and start both services
docker-compose up

# First time will take ~2 minutes (building images)
# Subsequent runs will be instant
```

**Access at:** http://localhost:5173

### **Useful Commands**

```bash
# View logs
docker-compose logs -f

# Restart everything
docker-compose restart

# Stop everything
docker-compose down

# Rebuild images
docker-compose up --build

# Run only backend
docker-compose up backend

# Access backend shell
docker-compose exec backend bash

# Clear database
docker-compose exec backend rm reports.db
```

---

## Option 3: Traditional Deploy (Heroku, Render, etc.)

### **For Heroku (deprecated but still works)**
```bash
# Create Heroku app
heroku create odic-reports

# Set buildpacks
heroku buildpacks:add heroku/python
heroku buildpacks:add heroku/nodejs

# Deploy
git push heroku main

# View logs
heroku logs -t
```

### **For Render.com**
1. Create account at https://render.com
2. New "Web Service"
3. Connect GitHub repo
4. Set:
   - Build: `pip install -r backend/requirements.txt && cd frontend && npm install && npm run build`
   - Start: `cd backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000`

---

## Environment Variables

### **Backend (.env file)**

```bash
# AI Backend
AI_BACKEND=ollama              # or "anthropic"
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_VL_MODEL=qwen2.5vl:7b

# Optional: Anthropic Claude
ANTHROPIC_API_KEY=sk-...       # Only if AI_BACKEND=anthropic

# Database
DATABASE_URL=sqlite:///./reports.db   # or PostgreSQL in production

# Paths
TESSERACT_PATH=/usr/bin/tesseract
GHOSTSCRIPT_PATH=/usr/bin/gs
```

### **Frontend (.env file)**

```bash
VITE_API_URL=http://localhost:8000    # For local dev
# or
VITE_API_URL=https://api.yourdomain.com  # For production
```

---

## Production Checklist

- [ ] Environment variables set (no secrets in code)
- [ ] Database backed up (SQLite → PostgreSQL recommended)
- [ ] CORS configured for your domain
- [ ] Health checks passing
- [ ] Error logging configured
- [ ] Rate limiting enabled (optional)
- [ ] HTTPS enforced
- [ ] Monitoring/alerts set up
- [ ] Deployment tested with real data
- [ ] Backups automated

---

## Monitoring

### **Check Service Health**

```bash
# Backend health
curl https://your-domain.app/health

# Response should be:
# {"status": "ok", "timestamp": "2024-03-01T..."}
```

### **View Logs**

**Railway:**
- Go to Railway dashboard → Project → Logs tab
- Real-time streaming of all events

**Docker Compose:**
```bash
docker-compose logs -f backend
docker-compose logs -f frontend
```

**Local:**
- Backend: stdout in terminal
- Frontend: browser console (F12)

---

## Troubleshooting

### **Backend Won't Start**

```bash
# Check if Ollama is running
curl http://localhost:11434

# If not, start Ollama
ollama serve

# Then restart backend
docker-compose restart backend
```

### **Frontend Can't Connect to Backend**

1. Check API URL in `.env`: `VITE_API_URL`
2. Verify backend is responding: `curl {VITE_API_URL}/health`
3. Check CORS headers: Backend should allow frontend origin
4. Look at browser console for actual error

### **Database Errors**

```bash
# Reset database
docker-compose exec backend rm reports.db

# Reinitialize
docker-compose restart backend
```

### **Out of Memory**

```bash
# Increase Docker memory limit
# Docker Desktop → Settings → Resources → Memory: 4GB+

# Or restart backend with memory limit
docker-compose down
docker-compose up --memory=4g
```

---

## Scaling (When You Get Big)

### **1. Use PostgreSQL Instead of SQLite**

```bash
# In docker-compose.yml, add PostgreSQL service
# Update DATABASE_URL to postgres://...
# More reliable for concurrent users
```

### **2. Scale Backend Instances**

```yaml
# docker-compose.yml
backend:
  deploy:
    replicas: 3
```

### **3. Add Nginx Reverse Proxy**

```yaml
nginx:
  image: nginx:alpine
  ports:
    - "80:80"
  depends_on:
    - backend
    - frontend
```

---

## Cost Estimates

| Service | Free Tier | Paid |
|---------|-----------|------|
| Railway.app | $5 credit/month | $10-50/month |
| Database (PostgreSQL) | Limited | ~$15/month |
| Storage (uploads) | Limited | ~$5-10/month |
| **Total** | ~**Free** | **~$30-50/month** |

Railway's free tier might cover your needs. Upgrade only if needed.

---

## After Deployment

1. **Share the URL** with your team
2. **Upload test data** (6384674-ESAI)
3. **Test all features:**
   - File upload
   - Classification
   - Assembly
   - Chat commands
4. **Monitor logs** for errors
5. **Set up backups** if using PostgreSQL

---

## Support

### **Railway Docs**
https://docs.railway.app

### **Docker Compose Docs**
https://docs.docker.com/compose/

### **Common Issues Forum**
https://docs.railway.app/troubleshooting

---

## Summary

```bash
# LOCAL (easiest to start)
docker-compose up
# Access: http://localhost:5173

# PRODUCTION (recommended: Railway.app)
# 1. Push to GitHub ✓
# 2. Connect Railway to GitHub repo
# 3. Click Deploy
# 4. Get public URL
# Done!
```

**Recommendation:** Start with Docker Compose locally to test, then deploy to Railway.app for production.

Good luck! 🚀
