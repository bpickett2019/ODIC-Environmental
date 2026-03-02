# Rose's User Guide — How to Use ODIC ESA Report Assembly

**For**: Rose (ESA report compiler)  
**Purpose**: Create professional 12K-15K page ESA reports in <5 minutes  
**Cost**: $0 per report

---

## 🎯 What This System Does

Instead of:
- Manually sorting 554 documents into folders
- Copying and pasting pages into a master PDF
- Numbering appendices by hand
- **10+ hours of work** ❌

You:
- Upload documents
- System auto-classifies into sections
- Drag-and-drop to adjust if needed
- Click "Assemble"
- Download final PDF
- **5 minutes of active time** ✅

---

## 🚀 Getting Started

### **Access the System**

Open your browser and go to:
```
https://odic-esa.onrender.com
```

You should see an upload interface with a "New Report" button.

---

## 📋 Step-by-Step: Creating Your First Report

### **Step 1: Create a New Report**

1. Click **"New Report"** button
2. Fill in the form:
   - **Report Name**: (e.g., "1199 El Camino Real - San Bruno")
   - **Location**: (e.g., "San Bruno, CA")
3. Click **"Create"**

You'll see an empty document list.

---

### **Step 2: Upload Documents**

1. Click **"Upload Documents"** (or drag-and-drop)
2. Select PDF, DOCX, or image files
3. Multiple files at once? That's fine — upload in batches
4. System auto-converts Word docs to PDF
5. Wait for "Upload Complete" message

The system will start classifying documents automatically.

---

### **Step 3: Review Classifications**

As documents upload, you'll see them in a list:

```
Document Name          | Category        | Pages | Included
────────────────────────────────────────────────────────
site_photos_1.pdf      | APPENDIX_B      | 12    | ✓
sanborn_map_1902.pdf   | APPENDIX_D      | 1     | ✓
property_profile.pdf   | APPENDIX_E      | 3     | ✓
```

**Column meanings:**
- **Category**: Where it goes in the report (COVER, APPENDIX_A, etc.)
- **Pages**: How many pages in this document
- **Included**: Checkbox to include/exclude from final report

---

### **Step 4: Fix Classifications (If Needed)**

#### **Option A: Using Chat Commands**

If a document is in the wrong place, just ask:

```
"Move docs 5,6,7 to Appendix D"
```

The system will move them. Other commands:

```
"Exclude all X-rays"
→ Removes any X-ray scans you don't want

"Show me documents in Appendix E"
→ Lists all supporting documents

"How many pages total?"
→ Total page count of selected documents

"Undo"
→ Revert last action
```

#### **Option B: Using UI Buttons**

1. Find document in list
2. Click the document row to select
3. Choose action:
   - **Include/Exclude** toggle
   - **Edit Category** dropdown
   - **Move to Section** menu
   - **Delete Pages** (if you want specific pages removed)

#### **Option C: Drag-and-Drop Reordering**

Some systems support dragging documents to reorder within a section. Check if your section shows drag handles (⋮⋮).

---

### **Step 5: Assemble the Report**

Once documents are classified and you're happy with the order:

1. Click **"Assemble Report"** button
2. Or send chat: `"Assemble report"`
3. System will:
   - Compile all included documents
   - Apply smart ordering (Appendix D: Sanborn → Aerial → Topo → City Dir)
   - Add page numbers
   - Create final PDF
4. This takes **<5 minutes** for a 12K-page report
5. You'll see **"Assembly Complete"** notification

---

### **Step 6: Download Your Report**

1. Click **"Download PDF"** button
2. Final report saved to your Downloads folder
3. File size: Usually 50-150MB (ready for email)

---

## 🎯 Example Workflows

### **Workflow 1: Simple Assembly (No Adjustments)**

1. Create report
2. Upload 90 documents
3. System classifies automatically
4. Click "Assemble"
5. Download PDF
6. **Done in 5 minutes** ✅

### **Workflow 2: Fix Ordering**

1. Create report
2. Upload documents
3. See that Sanborn maps are mixed with Aerial photos in Appendix D
4. Chat: `"Move docs 15,16,17 to Sanborn section"`
5. System reorders them
6. Click "Assemble"
7. Download PDF
8. **Done in 10 minutes** ✅

### **Workflow 3: Exclude Unwanted Docs**

1. Create report
2. Upload all 554 documents
3. System auto-selects ~200 relevant ones
4. You see some duplicates or unwanted X-rays
5. Chat: `"Exclude docs 23, 45, 67"`
6. Or click checkboxes to uncheck them
7. Click "Assemble"
8. Download smaller PDF
9. **Done in 12 minutes** ✅

---

## 💬 Chat Commands Reference

Send these as chat messages to control the report:

| Command | What It Does | Example |
|---------|------------|---------|
| How many pages? | Get total page count | "How many pages?" |
| Move docs X to Y | Relocate to section | "Move docs 5,6,7 to Appendix D" |
| Exclude all X | Remove matching docs | "Exclude all X-rays" |
| Show X docs | List documents in section | "Show Appendix E docs" |
| Assemble report | Compile final PDF | "Assemble report" |
| Compress for email | Reduce file size | "Compress for email" |
| Split for email | Break into <20MB chunks | "Split for email" |
| Undo | Revert last action | "Undo" |

---

## 🔤 Understanding Document Categories

The system sorts into these sections automatically:

| Category | What Goes Here | Example |
|----------|------------|---------|
| **COVER** | Title page, summary | Executive summary (1-2 pages) |
| **APPENDIX_A** | Phase I ESA | Phase I Environmental Site Assessment |
| **APPENDIX_B** | Photos & site visit | Site photos, walkthrough photos |
| **APPENDIX_C** | EDR radius search | Environmental search results (often 1000+ pages) |
| **APPENDIX_D** | Historical maps | Sanborn maps, old aerials, topographic maps, city directories |
| **APPENDIX_E** | Supporting docs | Permits, property profiles, reports, regulatory records |
| **APPENDIX_F** | Professional quals | Resume, certifications, qualifications |

---

## ⚠️ Important Notes

### **Appendix D Ordering**

The system automatically sorts historical maps in this order:
1. **Sanborn maps** (oldest, most detailed)
2. **Fire insurance maps**
3. **Marked aerials** (with annotations)
4. **Topographic maps** (terrain)
5. **City directories** (newest)

You usually don't need to adjust this — it's automatic.

### **Appendix E Ordering**

- **Property Profile** always goes first
- Everything else is in the order you specify
- No strict ordering rules

### **Page Count**

The system counts pages in each document. If a DOCX file is 10 pages, it shows "10 pages" — this is accurate.

---

## 🆘 Troubleshooting

### **"Upload failed"**

**Why**: File too large or unsupported format  
**Fix**: 
- Max file size: 25MB per file
- Supported: PDF, DOCX, DOC, JPG, PNG, HEIC, TIFF
- If file is too large, split it or compress it first

### **"Document won't move to Appendix D"**

**Why**: Chat command formatting issue  
**Fix**: Try:
```
"Move document 5 to APPENDIX_D"
(with ID number instead of "docs 5")
```

### **"Assembly stuck/spinning"**

**Why**: Large report (10K+ pages) still compiling  
**Fix**: 
- Wait up to 10 minutes
- Don't refresh page (will lose progress)
- Check notification bar for updates

### **"Downloaded PDF is too large for email"**

**Why**: ~150MB file exceeds email limit  
**Fix**: Chat: `"Compress for email"`
- Reduces to ~50MB by lowering image quality
- Still readable, smaller attachment

### **"Can't find a document"**

**Why**: Chat command formatting  
**Fix**: Chat: `"Show Appendix E docs"`
- Lists all documents in that section
- Find the one you want by name
- Then move it if needed

---

## 💡 Tips & Tricks

### **Quick Drag-and-Drop**

If the UI supports it, you can drag documents to reorder within a section. Look for drag handles (⋮⋮) on document rows.

### **Batch Operations**

Instead of moving one document at a time:
```
"Move docs 5,6,7,8,9 to Appendix D"
(comma-separated IDs work too)
```

### **Undo Mistakes**

Made a wrong move? Just chat: `"Undo"`

The system keeps the last action snapshot, so one undo reverts it.

### **Check Your Work**

Before assembling, always ask:
```
"How many pages?"
→ Should match your expected total
```

---

## 📊 Performance Expectations

| Task | Time | Notes |
|------|------|-------|
| Create report | <1 min | Just fill in name/location |
| Upload 90 docs | 2-3 min | Depends on file sizes |
| AI classification | Automatic | Happens while you upload |
| Fix orderings | 2-5 min | Chat commands or UI buttons |
| Assemble (12K pages) | <5 min | System merges + orders automatically |
| Download | <1 min | PDF saved to your computer |
| **Total** | **~12 minutes** | Ready for email/client |

---

## 🎓 Learning More

### **About the System**

- **Technical details**: See https://github.com/bpickett2019/ODIC-Environmental
- **What it does**: Smart page sampling, AI classification, automatic ordering
- **Cost**: $0 per report (no fees, no subscriptions)

### **Getting Help**

If something breaks:
1. Refresh the page
2. Check if Appendix is empty (no docs uploaded yet)
3. Try a different document
4. Reach out to Bailey with error message

---

## ✅ Ready to Go

You're all set! Start by:

1. Opening https://odic-esa.onrender.com
2. Creating a new report
3. Uploading some test documents
4. Watching the magic happen ✨

For the 6384674-ESAI test project:
1. Download 554 files from Google Drive
2. Upload in batches (25 files at a time max)
3. Let system classify
4. Review the ordering
5. Assemble
6. Download final PDF
7. Verify it looks right

**Questions?** Bailey can help. The system is designed to be intuitive — try it and see!

---

**Happy assembling! 🎉**

