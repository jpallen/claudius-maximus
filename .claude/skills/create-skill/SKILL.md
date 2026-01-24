---
name: create-skill
description: Create a new Claude Code skill for this project. Use when adding new skills or understanding how skills work.
---

# Creating Skills

Skills extend Claude's capabilities. Create a skill directory with a `SKILL.md` file, and Claude can use it automatically or you can invoke it with `/skill-name`.

## Skill Location

For this project, skills go in `.claude/skills/<skill-name>/SKILL.md`.

## Skill Structure

Each skill is a directory:

```
.claude/skills/
  my-skill/
    SKILL.md           # Required - main instructions
    template.md        # Optional - templates for Claude to fill
    examples/          # Optional - example outputs
    scripts/           # Optional - scripts Claude can run
```

## SKILL.md Format

Every `SKILL.md` needs YAML frontmatter and markdown content:

```yaml
---
name: my-skill
description: What this skill does and when to use it
---

Instructions for Claude when this skill is invoked...
```

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name (defaults to directory name). Lowercase, hyphens, max 64 chars. |
| `description` | Recommended | What it does and when to use it. Claude uses this to decide when to load it. |
| `disable-model-invocation` | No | Set `true` to prevent Claude from auto-loading. User must invoke with `/name`. |
| `user-invocable` | No | Set `false` to hide from `/` menu. Only Claude can invoke. |
| `allowed-tools` | No | Tools Claude can use without permission when skill is active. |
| `context` | No | Set `fork` to run in an isolated subagent. |
| `agent` | No | Subagent type when `context: fork` (e.g., `Explore`, `Plan`). |

## Skill Types

### Reference Skills (background knowledge)

For conventions, patterns, or domain knowledge that Claude should apply automatically:

```yaml
---
name: api-conventions
description: API design patterns for this codebase
user-invocable: false
---

When writing API endpoints:
- Use RESTful naming
- Return consistent error formats
```

### Task Skills (user-invoked actions)

For specific workflows like deployments or commits:

```yaml
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---

Deploy $ARGUMENTS to production:
1. Run tests
2. Build application
3. Push to deployment target
```

## Variable Substitution

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | Arguments passed when invoking (e.g., `/skill-name arg1 arg2`) |
| `${CLAUDE_SESSION_ID}` | Current session ID |

## Dynamic Context

Use `!`command`` to inject shell command output:

```yaml
---
name: pr-summary
description: Summarize a pull request
---

PR diff: !`gh pr diff`
PR comments: !`gh pr view --comments`

Summarize this PR...
```

## Examples

### Read-only exploration skill

```yaml
---
name: explore-code
description: Explore codebase without making changes
allowed-tools: Read, Grep, Glob
---

Explore the codebase to answer questions. Do not modify any files.
```

### Subagent skill

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS:
1. Find relevant files
2. Analyze the code
3. Summarize findings
```

## To Create a New Skill

1. Create directory: `mkdir -p .claude/skills/<skill-name>`
2. Create `SKILL.md` with frontmatter and instructions
3. Test with `/skill-name` or by asking Claude something matching the description
