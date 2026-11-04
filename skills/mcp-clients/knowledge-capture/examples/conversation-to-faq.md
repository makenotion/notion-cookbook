# Example: Conversation to FAQ

This fictional walkthrough uses illustrative tool labels and arguments, not a
copy-and-run transcript. Use your connection's current tool names and schemas,
and replace sample IDs, URLs, and properties with values from actual tool results.

## User Request

> "Save this conversation about deployment troubleshooting to the FAQ"

**Context**: User just had a conversation explaining how to troubleshoot common deployment errors.

## Conversation Summary

The conversation covered:

1. **Question**: "Why does deployment fail with 'port already in use' error?"
2. **Answer**: Process from previous deployment still running, need to kill it
3. **Question**: "How do I find and kill the process?"
4. **Commands shared**: `lsof -ti:3000 | xargs kill -9` or use `pm2 restart app`
5. **Question**: "What about 'cannot connect to database' errors?"
6. **Answer**: Check database credentials, verify database is running, check network connectivity
7. **Best practice**: Always check logs first (`pm2 logs` or `docker logs`)

## Workflow Execution

### Step 1: Identify Content Type

This is Q&A content → **FAQ Entry** format is appropriate

### Step 2: Structure FAQ Entries

Extract distinct Q&A pairs from conversation:

**FAQ 1**: Port already in use error
**FAQ 2**: Cannot connect to database error
**FAQ 3**: General troubleshooting approach

### Step 3: Determine Destination

```
Notion:notion-search
query: "FAQ deployment"
query_type: "internal"
```

Found: "Deployment FAQ" database in Engineering Docs

```
Notion:notion-fetch
id: "deployment-faq-database-id"
```

**Schema**:

- Question (title)
- Category (select): Deployment, Configuration, Troubleshooting, etc.
- Tags (multi_select)
- Last Reviewed (date)

### Step 4: Create FAQ Entries

**FAQ Entry 1: Port Already in Use**

````
Notion:notion-create-pages

parent: { data_source_id: "collection://faq-db-uuid" }

pages: [{
  properties: {
    "Question": "Why does deployment fail with 'port already in use' error?",
    "Category": "Troubleshooting",
    "Tags": ["deployment", "errors", "ports"]
  },
  content: "## Answer\n\nA process from the previous deployment is still using the port. The conversation gave these alternatives for that process:\n\n```bash\nlsof -ti:3000 | xargs kill -9\n```\n\nor, for the app managed by PM2:\n\n```bash\npm2 restart app\n```"
}]
````

**FAQ Entry 2: Database Connection Errors**

```
Notion:notion-create-pages

parent: { data_source_id: "collection://faq-db-uuid" }

pages: [{
  properties: {
    "Question": "Why do I get 'cannot connect to database' errors during deployment?",
    "Category": "Troubleshooting",
    "Tags": ["deployment", "database", "errors"]
  },
  content: "## Answer\n\nCheck the database credentials, verify that the database is running, and check network connectivity. The conversation did not establish which check would resolve a particular failure."
}]
```

**FAQ Entry 3: General Troubleshooting**

```
Notion:notion-create-pages

parent: { data_source_id: "collection://faq-db-uuid" }

pages: [{
  properties: {
    "Question": "What's the first thing I should check when deployment fails?",
    "Category": "Troubleshooting",
    "Tags": ["deployment", "debugging", "best-practices"]
  },
  content: "## Answer\n\nCheck the logs first. The conversation named `pm2 logs` and `docker logs`."
}]
```

### Step 5: Update FAQ Index

```
Notion:notion-fetch
id: "faq-index-page-id"
```

Use the exact, unique heading returned by fetch as the anchor below. Preserve
the existing entries and other sections. If the new links are already present,
skip the insertion. Replace the sample mention URLs with the created page URLs.

```text
Notion:notion-update-page
{
  "page_id": "faq-index-page-id",
  "command": "update_content",
  "content_updates": [
    {
      "old_str": "## Deployment & Troubleshooting",
      "new_str": "## Deployment & Troubleshooting\n\n- <mention url=\"...\">Port already in use FAQ</mention>\n- <mention url=\"...\">Database connection FAQ</mention>\n- <mention url=\"...\">Troubleshooting first steps FAQ</mention>"
    }
  ]
}
```

Read back the updated index and check the three links and unrelated content.

## Summary Provided to User

After the creates and index update have succeeded, return the three created page
links and report any incomplete writes. Do not claim that prevention guidance,
extra debugging commands, or additional causes were captured: they were not in
the source conversation. Leave Last Reviewed unset unless a review date is known.

## Key Features Demonstrated

- Preserve the supplied answers and exact commands without adding troubleshooting advice.
- Use the fetched FAQ schema and the actual data source and page URLs.
- Add index links with a targeted edit that preserves existing content.
- Verify saved state before reporting that the FAQ and index were updated.
