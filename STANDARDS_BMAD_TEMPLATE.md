# BMAD Project Template

**Use this for every new software project.**

Copy this structure and fill in the blanks.

---

## 🎯 Phase 1: Analysis

**Owner**: Analyst  
**Output**: `_bmad-output/analysis/ANALYSIS.md`  
**Duration**: 2-3 hours

### Create `_bmad-output/analysis/ANALYSIS.md`

```markdown
# Analysis — [PROJECT_NAME]

## Problem Statement
What's the user pain point? What does success look like?

## Domain Research
What do we know about this space?

## Key Constraints
Cost? Performance? Accuracy? User skill level?

## Personas
Who's using this? What are their goals?

## Success Metrics
How do we measure if this works?

## Risks
What could go wrong?

## Next Steps
Ready for Planning phase.
```

### Update `_bmad/state.json`

```json
{
  "phase": "analysis",
  "status": "completed",
  "completedPhases": ["analysis"],
  "currentPhase": "planning"
}
```

---

## 📋 Phase 2: Planning

**Owner**: PM + UX  
**Output**: `_bmad-output/planning/PRD.md`  
**Duration**: 3-4 hours

### Create `_bmad-output/planning/PRD.md`

```markdown
# Product Requirements Document (PRD)

## Executive Summary
What is this product?

## Product Goals
5-7 key goals.

## User Stories
- As [user], I want [action] so that [benefit]
- Acceptance: [criteria]

## Feature List
MVP features vs Phase 2 nice-to-haves.

## Success Criteria
Measurable goals for launch.

## Timeline
How long will each phase take?

## Dependencies
What do we need to build this?

## Risks & Mitigation
What could block us?

---

## Next Steps
Ready for Solutioning phase.
```

### Update `_bmad/state.json`

```json
{
  "phase": "planning",
  "status": "completed",
  "completedPhases": ["analysis", "planning"],
  "currentPhase": "solutioning"
}
```

---

## 🏛️ Phase 3: Solutioning

**Owner**: Architect  
**Output**: `_bmad-output/solutioning/ARCHITECTURE_DECISIONS.md`  
**Duration**: 4-5 hours

### Create `_bmad-output/solutioning/ARCHITECTURE_DECISIONS.md`

```markdown
# Solutioning — Architecture Decisions

## ADR-001: [Decision Title]

**Decision**: [What we chose]

**Rationale**: [Why]

**Impact**: [Cost, speed, complexity]

**Trade-offs**: [What we give up]

---

## ADR-002: [Decision Title]

[same format]

---

## Tech Stack Summary

| Layer | Tech | Decision | Why |
|-------|------|----------|-----|
| Frontend | [tech] | [choice] | [reason] |
| Backend | [tech] | [choice] | [reason] |
| Database | [tech] | [choice] | [reason] |
| Deployment | [tech] | [choice] | [reason] |

---

## Deployment Architecture

[Diagram or description]

---

## Scaling Considerations

What happens at 10x, 100x usage?

---

## Next Steps
Ready for Implementation phase.
```

### Update `_bmad/state.json`

```json
{
  "phase": "solutioning",
  "status": "completed",
  "completedPhases": ["analysis", "planning", "solutioning"],
  "currentPhase": "implementation"
}
```

---

## 💻 Phase 4: Implementation

**Owner**: Dev Team  
**Output**: Code + `_bmad-output/implementation/BUILD_SUMMARY.md`  
**Duration**: 6-10 hours

### Create `_bmad-output/implementation/BUILD_SUMMARY.md`

```markdown
# Implementation — Build Summary

## Code Status

### Backend
- [component] - [status] ✅
- [component] - [status] ✅
- [component] - [status] ✅

### Frontend
- [component] - [status] ✅
- [component] - [status] ✅

### Infrastructure
- [item] - [status] ✅
- [item] - [status] ✅

## Test Coverage

| Area | Status | Notes |
|------|--------|-------|
| Syntax | ✅ | All files compile |
| Runtime | ⏳ | Awaits deployment |
| Integration | ⏳ | Awaits deployment |

## Known Issues / Limitations

1. [Issue] - [Status]
2. [Issue] - [Status]

## Performance Characteristics

| Operation | Expected | Notes |
|-----------|----------|-------|
| [op] | [time] | [bottleneck] |
| [op] | [time] | [bottleneck] |

## Deployment Readiness

✅ Code compiles  
✅ Docker builds  
✅ Config template ready  
⏳ Needs production testing  

## Next Steps
Ready for Deployment phase.
```

### Update `_bmad/state.json`

```json
{
  "phase": "implementation",
  "status": "completed",
  "completedPhases": ["analysis", "planning", "solutioning", "implementation"],
  "currentPhase": "deployment"
}
```

---

## 🚀 Phase 5: Deployment

**Owner**: DevOps + User  
**Output**: Live system + validation  
**Duration**: 1-3 hours

### Deployment Checklist

- [ ] Deploy to production
- [ ] Health check passes
- [ ] Test with real data
- [ ] Performance validated
- [ ] User acceptance confirmed
- [ ] Go live

### Update `_bmad/state.json`

```json
{
  "phase": "deployment",
  "status": "completed",
  "completedPhases": ["analysis", "planning", "solutioning", "implementation", "deployment"],
  "currentPhase": "monitoring",
  "metrics": {
    "liveDate": "2026-03-XX",
    "status": "production"
  }
}
```

---

## 📁 Full Directory Structure

```
project/
├── _bmad/
│   ├── state.json                    (phase tracking)
│   └── config.yaml                   (project config)
│
├── _bmad-output/
│   ├── analysis/
│   │   └── ANALYSIS.md               (problem, research)
│   ├── planning/
│   │   └── PRD.md                    (requirements)
│   ├── solutioning/
│   │   └── ARCHITECTURE_DECISIONS.md (ADRs, tech stack)
│   └── implementation/
│       └── BUILD_SUMMARY.md          (code status)
│
├── [source code]
├── [config files]
├── [tests]
└── [deployment configs]
```

---

## 🎯 Key Principles

1. **Each phase has dedicated output** — No mixing
2. **Decisions are documented** — Why we chose X (not just that we did)
3. **Progress is tracked** — state.json updates per phase
4. **Artifacts are reusable** — Future projects can reference these
5. **Handoffs are explicit** — Phase N → Phase N+1 is clear
6. **Context is fresh** — Next phase doesn't inherit previous phase's assumptions

---

## ⏱️ Timeline Estimate

| Phase | Duration | Owner |
|-------|----------|-------|
| Analysis | 2-3h | Analyst |
| Planning | 3-4h | PM |
| Solutioning | 4-5h | Architect |
| Implementation | 6-10h | Dev |
| Deployment | 1-3h | DevOps |
| **Total** | **16-25h** | Team |

---

## 🚀 To Start a New Project

1. Create project directory
2. Create `_bmad/` and `_bmad-output/` structure
3. Copy `_bmad/state.json` and `_bmad/config.yaml` from template
4. Start with Analysis phase
5. Follow each phase sequentially
6. Update state.json after each phase
7. Commit artifacts to git

---

## 🔗 References

- **BMAD OpenClaw**: https://github.com/ErwanLorteau/BMAD_Openclaw
- **BMad Method**: https://github.com/bmadcode/BMAD-METHOD
- **ODIC Example**: https://github.com/bpickett2019/ODIC-Environmental/tree/bmad-refactor

---

**This is the standard. Use it for every project.**
