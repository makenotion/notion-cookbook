# Standard Implementation Plan Template

Adapt this template to the requested scope. Use plain checklist items when task
pages were not requested; add page links when they exist. Omit unknown dates,
estimates, and empty sections rather than inventing values.

Use this template for most feature implementations.

```markdown
# Implementation Plan: [Feature Name]

## Overview

[1-2 sentence feature description and business value]

## Linked Specification

<mention url="...">Original Specification</mention>

## Requirements Summary

### Functional Requirements

- [Requirement 1]
- [Requirement 2]
- [Requirement 3]

### Non-Functional Requirements

- **Performance**: [Targets]
- **Security**: [Requirements]
- **Scalability**: [Needs]

### Acceptance Criteria

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

## Technical Approach

### Architecture

[High-level architectural decisions]

### Technology Stack

- Backend: [Technologies]
- Frontend: [Technologies]
- Infrastructure: [Technologies]

### Key Design Decisions

1. **[Decision]**: [Rationale]
2. **[Decision]**: [Rationale]

## Implementation Phases

### Phase 1: Foundation (Week 1)

**Goal**: Set up core infrastructure

**Tasks**:

- [ ] <mention url="...">Database schema design</mention>
- [ ] <mention url="...">API scaffolding</mention>
- [ ] <mention url="...">Authentication setup</mention>

**Deliverables**: Working API skeleton
**Estimated effort**: 3 days

### Phase 2: Core Features (Week 2-3)

**Goal**: Implement main functionality

**Tasks**:

- [ ] <mention url="...">Feature A implementation</mention>
- [ ] <mention url="...">Feature B implementation</mention>

**Deliverables**: Core features working
**Estimated effort**: 1 week

### Phase 3: Integration & Polish (Week 4)

**Goal**: Complete integration and refinement

**Tasks**:

- [ ] <mention url="...">Frontend integration</mention>
- [ ] <mention url="...">Testing & QA</mention>

**Deliverables**: Production-ready feature
**Estimated effort**: 1 week

## Dependencies

### External Dependencies

- [Dependency 1]: [Status]
- [Dependency 2]: [Status]

### Internal Dependencies

- [Team/component dependency]

### Blockers

- [Known blocker] or None currently

## Risks & Mitigation

### Risk 1: [Description]

- **Probability**: High/Medium/Low
- **Impact**: High/Medium/Low
- **Mitigation**: [Strategy]

### Risk 2: [Description]

- **Probability**: High/Medium/Low
- **Impact**: High/Medium/Low
- **Mitigation**: [Strategy]

## Timeline

| Milestone        | Target Date | Status     |
| ---------------- | ----------- | ---------- |
| Phase 1 Complete | [Date]      | ⏳ Planned |
| Phase 2 Complete | [Date]      | ⏳ Planned |
| Phase 3 Complete | [Date]      | ⏳ Planned |
| Launch           | [Date]      | ⏳ Planned |

## Success Criteria

### Technical Success

- [ ] All acceptance criteria met
- [ ] Performance targets achieved
- [ ] Security requirements satisfied
- [ ] Test coverage > 80%

### Business Success

- [ ] [Business metric 1]
- [ ] [Business metric 2]

## Resources

### Documentation

- <mention url="...">Design Doc</mention>
- <mention url="...">API Spec</mention>

### Related Work

- <mention url="...">Related Feature</mention>

## Progress Tracking

[This section updated regularly]

### Phase Status

- Phase 1: ⏳ Not Started
- Phase 2: ⏳ Not Started
- Phase 3: ⏳ Not Started

**Overall Progress**: 0% complete

### Latest Update: [Date]

[Brief status update]
```
