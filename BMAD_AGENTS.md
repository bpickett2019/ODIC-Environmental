# BMAD Agents — ODIC Environmental Full Team

**Framework**: BMAD OpenClaw (Bridging the BMad Method to OpenClaw)  
**Architecture**: Master Agent orchestrates specialist agents per phase  
**Team Model**: 7 specialized agents + 1 orchestrator

---

## 🎭 Complete Agent Roster

### **Master Agent: BMad Master** (Orchestrator)
**Role**: Coordinates workflow, spawns specialists, manages handoffs

```
Responsibilities:
├─ Initialize project (_bmad/ structure)
├─ Analyze current state (state.json)
├─ Determine next phase needed
├─ Spawn appropriate specialist agent
├─ Receive completion announcement
└─ Propose next workflow
```

**Context**: Fresh at each spawn  
**Skills**: Orchestration, decision routing, workflow management  
**Availability**: Always (coordinates phases)

---

## 📊 Phase 1: Analysis

### **Agent: Mary (Analyst)**

**Name**: Mary  
**Role**: Analyst  
**Phase**: Analysis  
**Status**: ✅ Completed

**Responsibilities**:
```
├─ Understand problem domain
├─ Research ESA report structure
├─ Identify constraints (cost, performance, accuracy)
├─ Define personas and success metrics
├─ Document domain knowledge
├─ Assess risks and mitigation
└─ Produce ANALYSIS.md artifact
```

**Expertise**: Requirements analysis, domain research, problem scoping  
**Output**: `_bmad-output/analysis/ANALYSIS.md` (136 lines)  
**Key Findings**:
- ESA reports: 12K-15K pages from 554+ documents
- Current process: 10+ hours manual work
- Target: <5 minutes automated
- Success metric: 95%+ accuracy, $0 cost

**Context Window**: Fresh (no prior phase context)

---

## 📝 Phase 2: Planning

### **Agent: John (PM)**

**Name**: John  
**Role**: Product Manager  
**Phase**: Planning  
**Status**: ✅ Completed

**Responsibilities**:
```
├─ Define product goals
├─ Write user stories
├─ Plan features (MVP + Phase 2)
├─ Estimate timeline
├─ Identify dependencies
├─ Define success criteria
└─ Produce PRD.md artifact
```

**Expertise**: Product strategy, requirements definition, prioritization  
**Output**: `_bmad-output/planning/PRD.md` (176 lines)  
**Key Deliverables**:
- 5 product goals
- 4 core user stories
- Feature list (MVP: 10 features)
- Timeline: 16-25 hours
- Success criteria: Measurable

**Input From**: Mary's ANALYSIS.md  
**Context Window**: Analysis phase context (problem statement, constraints)

---

### **Agent: Sally (UX Designer)** *(Collaboration)*

**Name**: Sally  
**Role**: UX Designer  
**Phase**: Planning  
**Status**: ✅ Completed (via John's PRD)

**Responsibilities**:
```
├─ Understand user workflows
├─ Define information architecture
├─ Plan UI components
├─ Create user interaction flows
└─ Contribute to UX_DESIGN section (in PRD)
```

**Expertise**: User experience, interface design, interaction flows  
**Collaboration**: Works with John (PM) on same phase  
**Key Contribution**: 
- Rose persona (non-technical, needs intuitive UI)
- Interaction flow (upload → classify → assemble → download)
- Component requirements (drag-drop, chat, PDF preview)

**Note**: In ODIC, Sally's work embedded in John's PRD. In full multi-agent mode, separate session.

---

## 🏛️ Phase 3: Solutioning

### **Agent: Winston (Architect)**

**Name**: Winston  
**Role**: Solutions Architect  
**Phase**: Solutioning  
**Status**: ✅ Completed

**Responsibilities**:
```
├─ Design system architecture
├─ Create Architecture Decision Records (ADRs)
├─ Define technology stack
├─ Plan data models and APIs
├─ Design deployment strategy
├─ Consider scaling and performance
└─ Produce ARCHITECTURE_DECISIONS.md artifact
```

**Expertise**: System design, architecture patterns, technology selection  
**Output**: `_bmad-output/solutioning/ARCHITECTURE_DECISIONS.md` (263 lines)  
**Key Decisions** (7 ADRs):
- ADR-001: Smart Sampling (18K → 500 pages)
- ADR-002: Ollama primary, Claude optional
- ADR-003: Regex for hints, AI for classification
- ADR-004: Unified Docker container
- ADR-005: Chat interface
- ADR-006: DOCX preview (MVP vs Phase 2)
- ADR-007: Local-first database

**Tech Stack Decisions**:
- Frontend: React 19 + TypeScript + Vite
- Backend: FastAPI + SQLAlchemy
- AI: Ollama (local) + Claude (cloud)
- Deployment: Docker + Render/Railway/Fly.io

**Input From**: John's PRD  
**Context Window**: Planning phase context (requirements, features, timeline)  
**Deliverable**: Rationale for every technology choice

---

## 💻 Phase 4: Implementation

### **Agent: Bob (Backend Developer)**

**Name**: Bob  
**Role**: Backend Developer / Software Engineer  
**Phase**: Implementation  
**Status**: ✅ 95% Complete

**Responsibilities**:
```
├─ Implement backend APIs (50+ endpoints)
├─ Build AI classification pipeline
├─ Implement PDF assembly logic
├─ Build chat interface
├─ Handle database operations
├─ Implement error handling
├─ Write server-side logic
└─ Contribute to BUILD_SUMMARY.md
```

**Expertise**: Backend engineering, API design, database, AI integration  
**Output**: `backend/` (2100+ lines Python)  
**Key Modules**:
- `main.py` (FastAPI server, 50+ endpoints)
- `classifier.py` (Ollama integration, confidence scoring)
- `assembler.py` (PDF merging, ordering logic)
- `chat.py` (LLM chat, action execution)
- `models.py` (SQLAlchemy ORM)
- `database.py` (database setup)

**Code Quality**: ✅ Verified (syntax, structure)  
**Test Status**: ⏳ Runtime testing (awaits production)

**Input From**: Winston's architecture decisions  
**Context Window**: Solutioning phase context (architecture, tech choices)

---

### **Agent: Amelia (Frontend Developer)**

**Name**: Amelia  
**Role**: Frontend Developer / Software Engineer  
**Phase**: Implementation  
**Status**: ✅ 95% Complete

**Responsibilities**:
```
├─ Build React UI components
├─ Implement drag-and-drop
├─ Build chat interface
├─ Create PDF preview
├─ Build DOCX editor
├─ Handle client-side state
├─ Implement API integration
└─ Contribute to BUILD_SUMMARY.md
```

**Expertise**: Frontend engineering, React, TypeScript, UI/UX implementation  
**Output**: `frontend/` (1500+ lines TypeScript/React)  
**Key Components**:
- ReportList (view, create reports)
- ReportDetail (upload, classify)
- DocumentList (drag-drop reordering)
- ChatInterface (send commands)
- PDFPreview (view results)
- DocxEditor (preview/edit DOCX)

**Code Quality**: ✅ Verified (TypeScript, React patterns)  
**Test Status**: ⏳ Runtime testing (awaits production)

**Input From**: Winston's architecture, John's UX requirements  
**Context Window**: Planning + Solutioning context (requirements, design decisions)

---

## 🚀 Phase 5: Deployment

### **Agent: Rose (User + DevOps)**

**Name**: Rose  
**Role**: DevOps Engineer / End User / QA  
**Phase**: Deployment  
**Status**: ⏳ Pending (awaiting action)

**Responsibilities**:
```
├─ Click deploy link (Render/Railway/Fly.io)
├─ Verify health checks
├─ Test with sample documents
├─ Download and test real data (6384674-ESAI)
├─ Validate Appendix D ordering
├─ Validate Appendix E ranking
├─ Performance testing (<5 min assembly)
├─ User acceptance testing
└─ Go-live sign-off
```

**Expertise**: Operations, testing, user workflow validation  
**Deliverables**:
- Live system at public URL
- Validation report (ordering, performance)
- User acceptance (Rose can use system)
- Production-ready sign-off

**Input From**: Bob & Amelia (implementation code)  
**Context Window**: Full project context (requirements, architecture, code)  
**Blockers**: Awaiting user action (deployment click, test file download)

**Dual Role**:
- As **DevOps**: Deploy, monitor, validate infrastructure
- As **User**: Test system usability, validate workflows

---

## 🔄 Orchestration Flow

```
You (Initiator)
  │
  ├─→ BMad Master (Start)
  │     │
  │     ├─→ Spawn: Mary (Analyst) [Fresh context]
  │     │   └─ Produce: ANALYSIS.md
  │     │   └─ Announce: "Analysis complete"
  │     │
  │     ├─→ Spawn: John + Sally (PM + UX) [Fresh context]
  │     │   └─ Input: ANALYSIS.md
  │     │   └─ Produce: PRD.md
  │     │   └─ Announce: "Planning complete"
  │     │
  │     ├─→ Spawn: Winston (Architect) [Fresh context]
  │     │   └─ Input: PRD.md
  │     │   └─ Produce: ARCHITECTURE_DECISIONS.md
  │     │   └─ Announce: "Solutioning complete"
  │     │
  │     ├─→ Spawn: Bob + Amelia (Devs) [Fresh context]
  │     │   └─ Input: Architecture decisions
  │     │   └─ Produce: Code + BUILD_SUMMARY.md
  │     │   └─ Announce: "Implementation 95% complete"
  │     │
  │     ├─→ Spawn: Rose (DevOps + User) [Full context]
  │     │   └─ Input: All prior phases
  │     │   └─ Action: Deploy + Test
  │     │   └─ Announce: "Go-live ready" or "Validation failed"
  │     │
  │     └─→ All Phases Complete
  │
  └─ BMad Master proposes next workflow (Phase 2, bug fixes, etc.)
```

---

## 👥 Agent Characteristics

### **Isolation & Context**

| Agent | Fresh Context | Prior Context | Handoff Input |
|-------|---------------|---------------|---------------|
| Mary | ✅ Yes | ❌ No | (None) |
| John + Sally | ✅ Yes | ❌ No | ANALYSIS.md |
| Winston | ✅ Yes | ❌ No | PRD.md |
| Bob + Amelia | ✅ Yes | ❌ No | ARCHITECTURE_DECISIONS.md |
| Rose | ⚠️ Full | ✅ All | All prior artifacts |

**Key**: Each specialist has **zero context pollution** from previous phases.

---

## 🎯 Agent Specialization

| Agent | Expertise | Scope | Constraint |
|-------|-----------|-------|-----------|
| Mary | Domain research | Problem space | Questions only, no solutions |
| John | Product strategy | Definitions | Goals + stories, no architecture |
| Sally | UX/Design | User workflows | Flows + components, no backend |
| Winston | Architecture | System design | Decisions + tech stack, no code |
| Bob | Backend | Server logic | APIs + AI + database, no UI |
| Amelia | Frontend | Client logic | Components + state, no backend |
| Rose | Operations + Testing | Infrastructure + QA | Deploy + validate, sign-off |

**Benefit**: Each agent is **specialist**, not generalist.

---

## 📊 Phase Handoff Matrix

```
Phase 1 (Mary)         →  Produces: ANALYSIS.md
                           ↓
Phase 2 (John + Sally) →  Consumes: ANALYSIS.md
                           ↓
                           Produces: PRD.md
                           ↓
Phase 3 (Winston)      →  Consumes: PRD.md
                           ↓
                           Produces: ARCHITECTURE_DECISIONS.md
                           ↓
Phase 4 (Bob + Amelia) →  Consumes: ARCHITECTURE_DECISIONS.md
                           ↓
                           Produces: Code + BUILD_SUMMARY.md
                           ↓
Phase 5 (Rose)         →  Consumes: All prior artifacts
                           ↓
                           Produces: Live system + validation
```

---

## 🔀 Parallel Agents (Optional)

In full BMAD OpenClaw mode, agents within a phase can work **in parallel**:

**Phase 2 (Planning)**:
- John (PM) defines features in parallel with Sally (UX) designing flows
- No blocking — both have same ANALYSIS.md input
- Output: Combined PRD + UX design document

**Phase 4 (Implementation)**:
- Bob (Backend) builds APIs in parallel with Amelia (Frontend) builds UI
- Coordination via API contract (from Winston's architecture)
- Output: Backend + Frontend + BUILD_SUMMARY.md

---

## 💡 Key Insights

### **Why 7 Agents?**

1. **Specialization** — Each agent master one domain
2. **No context pollution** — Fresh context per agent
3. **Parallel execution** — Within-phase agents work simultaneously
4. **Clear handoffs** — Artifacts are explicit inputs/outputs
5. **Scalability** — Easy to add agents for larger projects

### **Why Master Agent?**

1. **Orchestration** — Decides next workflow
2. **State management** — Tracks progress (state.json)
3. **Handoff coordination** — Ensures artifacts flow correctly
4. **Re-planning** — If a phase fails, master re-routes

### **What Makes BMAD Work**

✅ Each agent has **one objective per phase**  
✅ Each agent gets **fresh context** (no prior bias)  
✅ Each agent produces **clear artifacts** (PRD, architecture, code)  
✅ Handoffs are **explicit** (artifact → next phase)  
✅ Agents can work **in parallel** (within same phase)  

---

## 🚀 Scaling BMAD

### **1 Person (Current ODIC)**
```
One person role-plays all 7 agents
├─ "I'm Mary now" → analyze
├─ "I'm John now" → plan
├─ "I'm Winston now" → architect
├─ "I'm Bob now" → code backend
├─ "I'm Amelia now" → code frontend
└─ "I'm Rose now" → deploy + test
```

**Downside**: Context bleeding, slower  
**Upside**: All in one head, can parallelize manually

### **Multi-Agent Team (Future)**
```
OpenClaw spawns dedicated agents per phase
├─ Mary spawned fresh for analysis phase
├─ John + Sally spawned fresh for planning
├─ Winston spawned fresh for solutioning
├─ Bob + Amelia spawned fresh for implementation
└─ Rose spawned for deployment

Each agent: Independent context, specialized focus
Result: Parallel execution, no pollution, faster delivery
```

---

## 📋 ODIC Agent Status

| Agent | Current Status | Real Person? | Context |
|-------|----------------|--------------|---------|
| Mary (Analyst) | ✅ Completed | No (me) | Role-played |
| John (PM) | ✅ Completed | No (me) | Role-played |
| Sally (UX) | ✅ Completed | No (me) | Role-played (in PRD) |
| Winston (Architect) | ✅ Completed | No (me) | Role-played |
| Bob (Backend) | ✅ 95% Complete | No (me) | Role-played |
| Amelia (Frontend) | ✅ 95% Complete | No (me) | Role-played |
| Rose (DevOps + User) | ⏳ Pending | YES (Bailey) | Real person, awaits action |
| BMad Master | ✅ Coordinating | No (me) | Orchestrator |

---

## 🎯 Summary

**BMAD has 7 specialized agents + 1 orchestrator:**

1. **Mary** (Analyst) — Research phase, problem scope
2. **John** (PM) — Product planning, requirements
3. **Sally** (UX) — User experience, flows (parallel with John)
4. **Winston** (Architect) — System design, tech decisions
5. **Bob** (Backend Developer) — Server, APIs, AI
6. **Amelia** (Frontend Developer) — UI, client logic (parallel with Bob)
7. **Rose** (DevOps + User) — Deployment, testing, validation
8. **BMad Master** (Orchestrator) — Workflow coordination

**Next step**: Deploy (Rose's responsibility). Once live, you can add agents for Phase 2 features, monitoring, support, etc.

