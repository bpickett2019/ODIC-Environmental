# Deploy to Fly.io from Your Phone 📱

## You're 99% Done!

Your app is ready. Here's how to deploy it in **2 steps from your phone**:

### **Step 1: Add Your Fly.io Token to GitHub**

Go to this link on your phone:
```
https://github.com/bpickett2019/ODIC-Environmental/settings/secrets/actions
```

Click **"New repository secret"** and fill in:

| Field | Value |
|-------|-------|
| **Name** | `FLY_API_TOKEN` |
| **Value** | (paste below) |

**Paste this as the value:**
```
FlyV1 fm2_lJPECAAAAAAAEUcLxBDavibTnSy3fl7uKXsvTVeLwrXodHRwczovL2FwaS5mbHkuaW8vdjGUAJLOABZA2B8Lk7lodHRwczovL2FwaS5mbHkuaW8vYWFhL3YxxDwQCQWRgq7ZbM0pZb+DnAB64V/ZoBgBd18MiUYTckyckLU+hHYE1jtYa6J5jXMoOR3ntyTPqS6lF3Ku+wTETkAS/JJqdwQlsu0w5dATpDwhTmblNIXfRGTW9osjRL6SutIduG2J2wk3gcolrPCgq7Uxf6GJAPR2xbeiYr1eO4uYDPnbJhFWM7F1B3b8W8QgGjuG7ZK4cnq7W/lKWrXkl0Sskk6Jok67qAoUmE37NSo=,fm2_lJPETkAS/JJqdwQlsu0w5dATpDwhTmblNIXfRGTW9osjRL6SutIduG2J2wk3gcolrPCgq7Uxf6GJAPR2xbeiYr1eO4uYDPnbJhFWM7F1B3b8W8QQJ75HKt+9CPWVlDpmLKI6ysO5aHR0cHM6Ly9hcGkuZmx5LmlvL2FhYS92MZgEks5ppOR4zwAAAAElnQKWF84AFVveCpHOABVb3gzEEJkb7syKy2ZjHCptu6kWvIDEIN6x6VzGg0qbf9bmrjpkjhzBHqvt4wyytRu8I+wTg5R1
```

Click **"Add secret"**

### **Step 2: Trigger Deployment**

That's it! GitHub Actions will automatically:
1. ✅ Build your Docker image
2. ✅ Deploy to Fly.io
3. ✅ Configure Claude API
4. ✅ Go live

**Your app will be live at:** https://odic-esa.fly.dev (in ~5 minutes)

---

## What Was Done

✅ Unified Docker container (backend + frontend in one)  
✅ Fixed all code issues  
✅ Set Claude API as AI backend  
✅ Created automated deployment workflows  
✅ Pushed everything to GitHub  

---

## That's All!

Just add the secret above and watch it deploy. You're done! 🚀
