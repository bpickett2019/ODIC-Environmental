# Decision Record: BMAD OpenClaw as Standard Development Methodology

**Date**: March 2, 2026  
**Owner**: Bailey + Cortana  
**Status**: ✅ ADOPTED

---

## The Problem

Building software as a single agent (me) causes:
- ✗ Context pollution (analysis + design + code mixed together)
- ✗ Implicit decisions ("why did I choose FastAPI?" — not documented)
- ✗ No specialist focus (jack-of-all-trades, master of none)
- ✗ Hard to hand off (no clear phase boundaries)
- ✗ Can't scale to multiple agents (context bleeding)

**Example**: ODIC project had good code, but decisions scattered throughout:
- Why smart sampling? (Buried in classifier_enhancements.py)
- Why Ollama primary? (Implicit in config.py)
- Why Appendix D ordering with regex? (Described in assembler.py comments)

---

## The Solution: BMAD OpenClaw

**BMAD** = Bridging the BMad Method to OpenClaw

Structured, phase-based development with **dedicated specialists**:

```
You (User)
  ↓
BMad Master (Orchestrator)
  ├─ Spawn Analyst Agent (fresh context) → ANALYSIS.md
  ├─ Spawn PM Agent (fresh context) → PRD.md
  ├─ Spawn Architect Agent (fresh context) → ARCHITECTURE_DECISIONS.md
  └─ Spawn Dev Agent (fresh context) → Code + BUILD_SUMMARY.md
```

Each agent has **zero context from previous phase**.

---

## What This Changes

### Before (Ad-Hoc)
```
Me
├─ Read requirements (analysis)
├─ Design system (planning)
├─ Write code (implementation)
└─ Create docs (documentation)

Result: 
- ✗ Why did I choose X? (no clear record)
- ✗ What decisions were made? (scattered)
- ✗ How do we scale? (single person)
```

### After (BMAD)
```
Analyst Agent
├─ Research problem
├─ Identify constraints
└─ Output: ANALYSIS.md

PM Agent
├─ Define requirements
├─ Plan timeline
└─ Output: PRD.md

Architect Agent
├─ Design system
├─ Document decisions (ADRs)
└─ Output: ARCHITECTURE_DECISIONS.md

Dev Agent
├─ Implement code
├─ Write tests
└─ Output: Code + BUILD_SUMMARY.md

Result:
- ✅ Clear decision rationale
- ✅ Specialist focus per phase
- ✅ Reusable artifacts
- ✅ Scales to multiple agents
```

---

## ODIC As The Template

ODIC project became the test case:

**Phase 1: Analysis** ✅
- Understood ESA report problem (10+ hours → <5 min)
- Researched domain (Appendix D ordering rules)
- Identified constraints (cost, performance, accuracy)
- Identified persona (Rose)

**Phase 2: Planning** ✅
- Created PRD (requirements, user stories, timeline)
- Defined success criteria
- Planned feature list

**Phase 3: Solutioning** ✅
- Documented 7 Architecture Decision Records (ADRs)
- Justified tech stack choices
- Designed deployment strategy

**Phase 4: Implementation** ✅
- Built code (2100+ backend, 1500+ frontend)
- Created comprehensive docs (119 pages)
- Verified compilation (no syntax errors)

**Phase 5: Deployment** ⏳
- Awaits user to click deploy link
- Then real-world testing

Result: Clear decision record, reusable artifacts, template for future projects.

---

## How This Benefits Future Projects

### Project 1: New AI Tool
```
1. Analysis Agent researches AI/ML landscape
   → ANALYSIS.md
2. PM Agent defines features
   → PRD.md
3. Architect Agent designs API
   → ARCHITECTURE_DECISIONS.md
4. Dev Agent builds
   → Code + BUILD_SUMMARY.md

Artifacts are reference for Project 2, 3, 4...
```

### Project 2: Mobile App
```
Reuse ANALYSIS.md framework (same research structure)
Reuse PRD.md template (same requirements format)
Reuse ARCHITECTURE_DECISIONS.md pattern (same ADR format)
Reuse BUILD_SUMMARY.md template (same code status format)

Result: Faster project kickoff
```

### Scaling to Multi-Agent

When using actual BMad OpenClaw plugin:
```
You send: "Build me a document assembly tool"
  ↓
BMad Master spawns:
  - Analyst Agent (independent context)
  - PM Agent (independent context)
  - Architect Agent (independent context)
  - Dev Agent (independent context)

Each agent runs in parallel, hand-offs are automatic.
Result: Faster development, no context pollution
```

---

## Key Commitments

1. **Every project starts with BMAD structure**
   - Create `_bmad/` + `_bmad-output/` directories
   - Initialize `state.json` and `config.yaml`
   - Use BMAD_TEMPLATE.md

2. **Each phase produces clear artifacts**
   - Analysis → ANALYSIS.md
   - Planning → PRD.md
   - Solutioning → ARCHITECTURE_DECISIONS.md
   - Implementation → Code + BUILD_SUMMARY.md
   - Deployment → Live system + validation

3. **Decisions are documented, not implicit**
   - Use Architecture Decision Records (ADRs)
   - Explain "why we chose X" not just "we chose X"
   - Future agents (and future-you) benefit

4. **Progress is tracked**
   - Update `_bmad/state.json` after each phase
   - Commit phase artifacts to git
   - Handoffs are explicit

5. **Artifacts are reusable**
   - ANALYSIS.md framework = template for next project
   - PRD.md template = copied and filled in
   - ARCHITECTURE_DECISIONS.md pattern = repeatable
   - BUILD_SUMMARY.md checklist = reused

---

## Timeline: From Decision to Implementation

| When | What |
|------|------|
| **Now** | Codified BMAD as standard (SOUL.md, AGENTS.md, BMAD_TEMPLATE.md) |
| **Next project** | Use BMAD_TEMPLATE.md as starting point |
| **Phase 1** | Create ANALYSIS.md (2-3 hours) |
| **Phase 2** | Create PRD.md (3-4 hours) |
| **Phase 3** | Create ARCHITECTURE_DECISIONS.md (4-5 hours) |
| **Phase 4** | Build code (6-10 hours) |
| **Phase 5** | Deploy + validate (1-3 hours) |
| **Total** | ~20-25 hours to production (like ODIC) |

---

## Comparison: ODIC vs BMAD Process

| Aspect | ODIC Actual | ODIC with BMAD | Future Projects |
|--------|------------|-----------------|-----------------|
| **Analysis** | Scattered (in memory) | ANALYSIS.md | Reuse template |
| **Planning** | Mixed in docs | PRD.md | Reuse template |
| **Architecture** | Embedded in code | ARCHITECTURE_DECISIONS.md | Reuse template |
| **Decision record** | Implicit | Explicit ADRs | Reference |
| **Handoffs** | Blurry | Clear phase boundaries | Automatic |
| **Reusability** | Low | High | Compound |
| **Time to understand** | 2-3 hours | 30 minutes | 15 minutes |

---

## Why This Works

1. **Humans think in phases**
   - Understand problem → plan solution → design system → build → deploy
   - BMAD formalizes this

2. **Specialists focus better**
   - Analyst doesn't think about code
   - Architect doesn't think about marketing
   - Dev doesn't think about user research
   - Each person = better at their job

3. **Handoffs are explicit**
   - Phase 1 output = Phase 2 input
   - No surprises, no rework
   - Clear expectations

4. **Artifacts compound**
   - ANALYSIS.md from Project 1 → Reference for Project 2
   - PRD.md template → Used in 5 projects
   - ARCHITECTURE_DECISIONS.md → Decision patterns repeat

5. **Scales from 1 to N agents**
   - Today: One agent per phase (me)
   - Tomorrow: Multiple agents per phase (parallelization)
   - Beyond: Full team of specialists

---

## The Guarantee

Using BMAD means:

✅ **Clear why**: Future-you understands why we chose X  
✅ **Fast kickoff**: Next project uses proven templates  
✅ **No context pollution**: Each phase is independent  
✅ **Better decisions**: Specialists focus, not generalists  
✅ **Scaling ready**: Multi-agent orchestration when needed  

---

## This Is Non-Negotiable

Every project, every time:

1. ✅ Create BMAD structure (`_bmad/` + `_bmad-output/`)
2. ✅ Follow phases sequentially (Analysis → Planning → Solutioning → Implementation → Deployment)
3. ✅ Document decisions explicitly (ADRs, rationale)
4. ✅ Produce phase artifacts (ANALYSIS.md, PRD.md, etc.)
5. ✅ Track progress (`state.json`)
6. ✅ Commit to git

---

## Reference

- **BMAD OpenClaw**: https://github.com/ErwanLorteau/BMAD_Openclaw
- **BMad Method**: https://github.com/bmadcode/BMAD-METHOD
- **ODIC BMAD Branch**: https://github.com/bpickett2019/ODIC-Environmental/tree/bmad-refactor
- **Template**: See BMAD_TEMPLATE.md in this workspace

---

**Status**: ✅ ADOPTED

**Effective**: Now (all future projects)

**Next**: Apply to next software project

