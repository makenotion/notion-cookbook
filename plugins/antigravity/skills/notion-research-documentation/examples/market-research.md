# Example: Market Research

This fictional walkthrough uses illustrative tool labels and arguments, not a
copy-and-run transcript. Use your connection's current tool names and schemas,
and replace sample IDs, URLs, and properties with values from actual tool results.

**User Request**: "Research the current state of AI coding assistants market and create a summary document in Notion"

## Workflow

### 1. Search

```
Notion:notion-search
query: "AI coding assistants market"
```

Found 3 relevant pages across Engineering, Strategy, and Product teamspaces.

### 2. Fetch & Analyze

```
Notion:notion-fetch (3x)
```

Extracted market size, competitive landscape, technology trends from source pages.

### 3. Create Documentation

```
Notion:notion-create-pages
```

## Output (Condensed)

```markdown
# AI Coding Assistants Market Research - Oct 2025

## Executive Summary

The AI coding assistant market is experiencing 150%+ YoY growth. GitHub Copilot dominates with 60% share, but specialized tools are gaining traction in specific niches.

## Key Findings

### Market Size and Growth

$800M in 2024 → $2.5B projected by 2026. Developer adoption: 23% (2023) → 47% (2024).
Source: <mention url="...">Market Trends Q3 2025</mention>

### Competitive Landscape

- GitHub Copilot: 60% (strong IDE integration)
- Cursor: 15% (rapid growth, full IDE)
- Tabnine: 10% (enterprise, on-premise)
- Cody: 5% (codebase-aware)
- CodeWhisperer: 8% (AWS integration)
  Source: <mention url="...">AI Tools Competitive Analysis</mention>

### Technology Trends

Key differentiators: context awareness, customization, multi-modal interfaces, code verification.
Source: <mention url="...">Developer Tools Landscape</mention>

## Next Steps

1. Monitor Cursor growth and feature releases
2. Evaluate Cody's codebase-aware capabilities
3. Document enterprise security/compliance requirements
4. Track pricing trends
```

## Key Takeaways

- Found relevant pages across multiple teamspaces
- Synthesized competitive, market, and technical perspectives
- Used proper citations linking to source pages
- Created actionable recommendations
