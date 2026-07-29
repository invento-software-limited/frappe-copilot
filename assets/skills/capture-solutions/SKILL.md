---
name: capture-solutions
description: >-
  Whenever you (Claude) struggle with a problem — a command that didn't work, a
  bug that took 3+ minutes to debug, a config you had to look up, a Frappe
  gotcha, a Docker quirk — save the solution as a reference so future sessions
  never repeat the struggle.
---

# Capture Solutions

## When to capture

Save something as a skill/reference when ANY of these are true:

- You tried ≥2 approaches before one worked
- You had to `WebSearch` or `WebFetch` to find the answer
- You read docs / error messages / stack traces to understand why it failed
- The solution wasn't obvious from the error message alone
- You'd want to remember this if you saw it again 3 months later

Do NOT capture for trivial typos, one-shot commands, or things already well
documented in the framework's own docs.

## Where to save

### Small / narrow — save as a memory

If the solution is a single fact (one command flag, one config key, one import path):

```
~/.claude/projects/<project-path>/memory/<name>.md
```

With frontmatter:
```markdown
---
name: kebab-case-name
description: One-line summary — what this solves
metadata:
  type: reference
---

## Problem

What was happening / what I was trying to do.

## Solution

The exact command, config, or code that fixed it.

## Root cause

Why the first approach didn't work and this one does.
```

Then add a one-line pointer to `MEMORY.md`.

### Larger / structured — save as a skill reference file

If the solution covers a workflow (multiple steps, multiple commands, a
procedure to follow):

```
~/.claude/skills/capture-solutions/references/<name>.md
```

With a clear title, step-by-step instructions, and the problem context.

## How to know if it worked

When future Claude sessions handle the same problem without hesitation or
debugging — that's the signal this skill is working. If a saved solution
turns out wrong or outdated, update or delete it.

## What to include

Every capture should answer:

1. **Problem** — What were you trying to do? What went wrong? Paste the error.
2. **Solution** — The exact working command / code / config. No placeholders.
3. **Root cause** — Why it failed and why the fix works.
4. **How to detect recurrence** — Error message text, symptoms, or conditions
   that mean "this problem again."
