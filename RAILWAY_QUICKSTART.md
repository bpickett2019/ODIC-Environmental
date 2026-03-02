# Railway.app Quick Start (5 Minutes)

**Goal:** Deploy ODIC Environmental to a live public URL in 5 minutes.

---

## Step 1: Railway Account (1 min)

1. Go to https://railway.app
2. Click "Start Free" (GitHub sign-in is easiest)
3. Authorize railway.app to access your GitHub
4. Done ✅

---

## Step 2: Create New Project (1 min)

1. In Railway dashboard, click "New Project"
2. Select "Deploy from GitHub repo"
3. Search for: `ODIC-Environmental`
4. Click "Deploy"
5. Railway auto-detects your Dockerfiles
6. Deployment starts automatically

---

## Step 3: Configure Environment (2 min)

While Railway is building (first deployment takes ~3 minutes), set environment variables:

### **For Backend Service:**

1. In Railway, go to **Variables** tab
2. Add:
   ```
   AI_BACKEND=ollama
   OLLAMA_URL=http://host.docker.internal:11434
   OLLAMA_MODEL=qwen2.5:7b
   OLLAMA_VL_MODEL=qwen2.5vl:7b
   OLLAMA_CONCURRENCY=8
   ```

3. Click "Save"

### **For Frontend Service:**

1. Add:
   ```
   VITE_API_URL=https://{backend-service-url}
   ```
   (Railway will show you the backend URL once deployed)

2. Click "Save"

---

## Step 4: Monitor Deployment (1 min)

1. Click **Logs** tab
2. Watch both services deploy
3. Look for:
   - Backend: `"Application startup complete"`
   - Frontend: `"✓ built in XXXms"`

---

## Step 5: Get Your Public URL

Once both services are deployed:

1. In Railway, click on the **frontend** service
2. Go to **Settings** → **Domains**
3. A domain is auto-generated (e.g., `odic-environmental-prod-abc123.railway.app`)
4. Click the domain to open in browser
5. ✅ Live! 

---

## Common Issues

### **Backend Service Not Starting**

**Symptom:** Logs show "ModuleNotFoundError" or similar Python errors

**Fix:**
1. Click **Settings** → **Build Command**
2. Set to: `pip install --no-cache-dir -r requirements.txt`
3. Restart deployment

### **Frontend Can't Connect to Backend**

**Symptom:** Frontend loads but shows "API Error" messages

**Fix:**
1. Get backend service URL from Railway
2. Update frontend's `VITE_API_URL` variable to the backend URL
3. Trigger redeploy (any commit to GitHub or manual restart)

### **Port Already in Use**

**Railway handles this automatically** — ignore port conflicts, Railway assigns available ports.

---

## Next: Upload Test Data

1. Open your deployed app
2. Create new report:
   - Name: "Test Report"
   - Address: "1199 El Camino Real, San Bruno, CA 94066"
   - Project: "6384674"
3. Download test files from Google Drive
4. Drag & drop into upload area
5. Watch classification happen in real-time
6. Test ordering, assembly, chat commands

---

## Advanced: Custom Domain

To use your own domain (e.g., `esa.yourdomain.com`):

1. Railway → Settings → Domains
2. Click "Add Custom Domain"
3. Enter your domain
4. Follow DNS instructions (update CNAME in your registrar)
5. Railway handles SSL automatically

---

## Cost

**Free Tier:** ~$5 credit/month
- Includes: 1 backend service + 1 frontend service
- Good for testing/demos

**Pay-as-you-go:** $0.50/GB RAM/month + storage
- For production: ~$10-30/month
- Recommended for reliability

---

## After Deployment

### **Auto-Deploy from Git**

Every time you push to GitHub, Railway automatically:
1. Pulls latest code
2. Rebuilds Docker images
3. Deploys new version
4. Zero downtime ✓

**Try it:**
```bash
cd /Users/bp/Ode
git add .
git commit -m "Update something"
git push origin main
# Watch Railway redeploy automatically
```

### **Monitor in Real-Time**

```bash
# Railway CLI (optional)
npm install -g @railway/cli
railway login
railway logs

# Or just watch in browser:
# Railway Dashboard → Logs tab → Live stream
```

---

## Environment Variables

**Update anytime in Railway Dashboard:**

1. Service → Variables
2. Edit values
3. Click "Save"
4. Railway redeploys automatically (few seconds)

**No need to push to GitHub!**

---

## Backup & Data

**SQLite Database:**
- Stored in Railway's file system
- Backed up automatically
- Persists between deploys ✓

**Uploads Folder:**
- All user uploads saved
- ~5GB free storage on Railway
- Upgrade if needed

---

## Troubleshooting

### **I see build errors**

→ Click **Logs** and scroll up to see the actual error

### **Services keep restarting**

→ Check memory usage. Free tier has 512MB limit. Contact Railway if needed.

### **Database not found**

→ Railway auto-creates `reports.db` first time. Delete if corrupted:
```bash
# Via Railway CLI
railway exec rm reports.db
```

### **Can't upload large files**

→ Railway free tier has request limit. Upgrade plan or split uploads.

---

## TL;DR

```
1. Sign up at railway.app (GitHub login)
2. New Project → Deploy from GitHub
3. Select ODIC-Environmental repo
4. Set env vars (AI_BACKEND, etc.)
5. Wait 3 minutes for build
6. Get public URL from Railway
7. Done! Live on the internet 🚀
```

**Total time: 5 minutes**

---

Need help? Check Railway docs: https://docs.railway.app
