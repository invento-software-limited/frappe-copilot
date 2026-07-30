---
name: frappe-release-workflow
description: >-
  Version control, branching, changelog, commit-message standards, and
  release management for Frappe apps. Use this skill any time the user
  mentions: bumping the app version, SemVer (major/minor/patch), writing a
  CHANGELOG entry, structuring release branches, commit message conventions,
  or tagging a release; or says things like "bump the version", "create a
  release", "tag a new release", or "write a changelog entry".
---

# Frappe Release Workflow

## 1. App Versioning (SemVer)

Version lives in `your_app/__init__.py`:
```python
__version__ = "1.0.1"
```

- **MAJOR**: Breaking changes (schema migrations, backward-incompatible APIs)
- **MINOR**: New features, backwards-compatible enhancements
- **PATCH**: Bug fixes, minor security updates

## 2. Branching Strategy

| Branch | Purpose |
|---|---|
| `develop` | Main integration branch — all features merge here first |
| `version-16` | Stable branch — only bug fixes and critical patches after testing in develop |
| `feature/*` | Short-lived feature branches (e.g. `feature/payment-gateway`) |
| `fix/*` | Short-lived bug fix branches |

## 3. Changelog Format

Place version-specific markdown in `your_app/change_log/vN/vN_N_N.md` — Frappe auto-shows a "What's New" dialog from these files.

Structure:
```
## [1.0.1] - 2026-05-11

### ✨ Added
- New dashboard widget.

### 🐞 Fixed
- Naming series validation error.

### 🛡 Security
- Integrated Semgrep scanning in CI.
```

## 4. Commit Message Standards (Conventional Commits)

| Prefix | When |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `style:` | Formatting, whitespace — no logic change |
| `refactor:` | Code change with no bugfix or feature |
| `chore:` | Build, config, package updates |
| `test:` | Adding/updating tests |

Example: `feat(portal): add employee details to timesheet list cards`

## 5. Release Workflow (develop → stable)

1. **Bump version** in `__init__.py` and `hooks.py`
2. **Update changelog** — add version header in `CHANGELOG.md`
3. **Create PR** from `develop` to `version-16`
4. **Tag after merge**:
   ```bash
   git tag -a v1.0.1 -m "Release version 1.0.1"
   git push origin v1.0.1
   ```
