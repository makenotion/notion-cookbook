# Citation Styles

## Basic Page Citation

For Notion sources in saved Notion content, use page mentions. For external
sources or chat output, use ordinary Markdown links to the original source:

```markdown
<mention url="https://notion.so/workspace/Page-Title-uuid">Page Title</mention>
```

The URL must be provided. The title is optional but improves readability:

```markdown
<mention url="https://notion.so/workspace/Page-Title-uuid"/>
```

## Inline Citations

Cite immediately after referenced information:

```markdown
The Q4 revenue increased by 23% quarter-over-quarter (<mention url="...">Q4 Financial Report</mention>).
```

## Multiple Sources

When information comes from multiple sources:

```markdown
Customer satisfaction has improved across all metrics (<mention url="...">Q3 Survey Results</mention>, <mention url="...">Support Analysis</mention>).
```

## Section-Level Citations

For longer sections derived from one source:

```markdown
### Engineering Priorities

According to the <mention url="...">Engineering Roadmap 2025</mention>:

- Focus on API scalability
- Improve developer experience
- Migrate to microservices architecture
```

## Sources Section

For longer reports, collect cited sources at the end. A short brief with clear
inline citations does not need a duplicate list:

```markdown
## Sources

- <mention url="...">Strategic Plan 2025</mention>
- <mention url="...">Market Analysis Report</mention>
- <mention url="...">Competitor Research: Q3</mention>
- <mention url="...">Customer Interview Notes</mention>
```

Group by category for long lists:

```markdown
## Sources

### Primary Sources

- <mention url="...">Official Roadmap</mention>
- <mention url="...">Strategy Document</mention>

### Supporting Research

- <mention url="...">Market Trends</mention>
- <mention url="...">Customer Feedback</mention>

### Background Context

- <mention url="...">Historical Analysis</mention>
```

## Quoting Content

When quoting directly from source:

```markdown
The product team noted: "We need to prioritize mobile experience improvements" (<mention url="...">Product Meeting Notes</mention>).
```

For block quotes:

```markdown
> We need to prioritize mobile experience improvements to meet our Q4 goals. This includes performance optimization and UI refresh.
>
> — <mention url="...">Product Meeting Notes - Oct 2025</mention>
```

## Data Citations

When presenting data, cite the source:

```markdown
| Metric  | Q3    | Q4    | Change |
| ------- | ----- | ----- | ------ |
| Revenue | $2.3M | $2.8M | +21.7% |
| Users   | 12.4K | 15.1K | +21.8% |

Source: <mention url="...">Financial Dashboard</mention>
```

## Database Citations

When referencing database content:

```markdown
Based on analysis of the <mention type="database" url="...">Projects Database</mention>, 67% of projects are on track.
```

## User Citations

When attributing information to specific people:

```markdown
<mention url="...">Sarah Chen</mention> noted in <mention url="...">Architecture Review</mention> that the microservices migration is ahead of schedule.
```

## Citation Frequency

**Over-citing** (every sentence):

```markdown
The revenue increased (<mention url="...">Report</mention>).
Costs decreased (<mention url="...">Report</mention>).
Margin improved (<mention url="...">Report</mention>).
```

**Under-citing** (no attribution):

```markdown
The revenue increased, costs decreased, and margin improved.
```

**Right balance** (grouped citation):

```markdown
The revenue increased, costs decreased, and margin improved (<mention url="...">Q4 Financial Report</mention>).
```

## Outdated Information

Note when source information might be outdated:

```markdown
The original API design (<mention url="...">API Spec v1</mention>, last updated January 2024) has been superseded by the new architecture in <mention url="...">API Spec v2</mention>.
```

## Cross-References

Link to related research documents:

```markdown
## Related Research

This research builds on previous findings:

- <mention url="...">Market Analysis - Q2 2025</mention>
- <mention url="...">Competitor Landscape Review</mention>

For implementation details, see:

- <mention url="...">Technical Implementation Guide</mention>
```

## Citation Validation

Before finalizing research:

✓ Every key claim has a source citation
✓ All page mentions have valid URLs
✓ When included, the sources section includes all cited pages
✓ Outdated sources are noted as such
✓ Direct quotes are clearly marked
✓ Data sources are attributed

## Citation Style Consistency

Choose one citation style and use throughout:

**Inline style** (lightweight):

```markdown
Revenue grew 23% (Financial Report). Customer count increased 18% (Metrics Dashboard).
```

**Formal style** (full mentions):

```markdown
Revenue grew 23% (<mention url="...">Q4 Financial Report</mention>). Customer count increased 18% (<mention url="...">Metrics Dashboard</mention>).
```

**Recommend formal style** for most research documentation as it provides clickable navigation.
