---
name: frappe-docker-bench
description: >-
  Run Frappe bench commands via Docker in a containerized Frappe/ERPNext setup.
  Load this skill when the Frappe environment is containerized with Docker and
  bench commands must be executed inside the app container, not directly on the
  host. Use for all bench operations: migrate, console, build, install-app,
  run-tests, new-app, etc.
---

# Frappe Docker Bench Runner

## Overview

In this setup, Frappe runs inside a Docker container. **Never run bench directly on the host.** All bench commands must be executed inside the running app container using `docker exec`.

## Container & Project Detection

### Finding the app container

The app container is named `<project>_localhost-app`. Detect it automatically:

```bash
# Auto-detect the running Frappe app container
FRAPPE_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '\-app$' | head -1)
echo "$FRAPPE_CONTAINER"
```

### Getting the site name

Check the current site:

```bash
docker exec "$FRAPPE_CONTAINER" cat /home/frappe/frappe-bench/sites/currentsite.txt
```

The default site can also be found in:
```bash
docker exec "$FRAPPE_CONTAINER" cat /home/frappe/frappe-bench/sites/common_site_config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('default_site',''))"
```

## How to Run Bench Commands

### Base command pattern

```bash
docker exec -w /home/frappe/frappe-bench <container> bench <subcommand> --site <site> [args]
```

Set variables once:
```bash
CONTAINER="aeroness_localhost-app"
SITE="aeroness.localhost"
```

Then use:
```bash
docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" <cmd>
```

### Quick alias approach

For a session, you can also export an alias or shell function:

```bash
alias bench-docker='docker exec -w /home/frappe/frappe-bench aeroness_localhost-app bench'
# Then use: bench-docker --site aeroness.localhost console
```

## Essential Bench Commands (Docker Pattern)

### App & Site Lifecycle

| Host command (don't use) | Docker equivalent |
|------------------------|------------------|
| `bench new-app <name>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench new-app <name>` (pipe input: `printf 'title\ndesc\npub\nemail\nMIT\nn\nn\nn\n'`) |
| `bench --site <site> install-app <app>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" install-app <app>` |
| `bench --site <site> list-apps` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" list-apps` |
| `bench --site <site> migrate` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" migrate` |

### Development

| Host command (don't use) | Docker equivalent |
|------------------------|------------------|
| `bench --site <site> console` | `docker exec -it -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" console` |
| `bench --site <site> execute <fn>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" execute <fn>` |
| `bench build --app <app>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench build --app <app>` |
| `bench --site <site> run-tests --app <app>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" run-tests --app <app>` |
| `bench --site <site> run-tests --doctype <dt>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" run-tests --doctype "<dt>"` |

### Site Maintenance

| Host command (don't use) | Docker equivalent |
|------------------------|------------------|
| `bench --site <site> backup` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" backup` |
| `bench --site <site> clear-cache` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" clear-cache` |
| `bench --site <site> set-config <k> <v>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" set-config <k> <v>` |
| `bench set-config -g <k> <v>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench set-config -g <k> <v>` |
| `bench --site <site> export-fixtures --app <app>` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" export-fixtures --app <app>` |

### Utility

| Host command (don't use) | Docker equivalent |
|------------------------|------------------|
| `bench version` | `docker exec -w /home/frappe/frappe-bench "$CONTAINER" bench version` |
| `bench --site <site> mariadb` | `docker exec -it -w /home/frappe/frappe-bench "$CONTAINER" bench --site "$SITE" mariadb` |

## Filesystem Layout

### Host → Container mapping

| Host path | Container path | Notes |
|-----------|---------------|-------|
| `/opt/frappe-docker/<project>_localhost-frappe-bench/apps/` | `/home/frappe/frappe-bench/apps/` | Bind mount — **readable/writable from host** |
| *(Docker volume)* | `/home/frappe/frappe-bench/sites/` | Docker volume — **not directly accessible from host**; manage via `docker exec` |
| *(Docker volume)* | `/home/frappe/frappe-bench/logs/` | Docker volume |
| `/opt/frappe-docker/<project>_localhost-frappe-bench/` | *(not in container)* | Bench root on host; has `apps/`, README, project files |

### Container internal layout

```
/home/frappe/frappe-bench/
├── apps/          # Frappe apps (bind-mounted, editable from host)
├── sites/         # Site databases, config, public files (Docker volume)
│   ├── common_site_config.json
│   ├── currentsite.txt
│   ├── assets/
│   └── <site>/    # Per-site config, private/public files
├── env/           # Python virtual environment
├── config/        # Bench config
├── logs/          # Logs (Docker volume)
├── assets/        # Built assets
└── patches.txt
```

## Important Notes

1. **Always use `--site <site>`** on site-scoped commands. Never run bare `bench migrate`.
2. **Session vs non-session**: Use `-it` flag for interactive commands (console, mariadb). Omit `-it` for non-interactive commands.
3. **App code is accessible from host** in `/opt/frappe-docker/<project>_localhost-frappe-bench/apps/<app>/` — you can read/write app code from the host directly (no `docker exec` needed). Use this for reading app source, modifying Python files, etc.
4. **bench migrate must run in the container** after code changes to apply schema/DB changes.
5. **Container name** ends with `-app`. The running app container name follows the pattern `<project>_localhost-app`.
6. **If you run `bench build`**, it compiles inside the container; the output goes to the sites volume (assets are served from there).
7. **Restart containers after major changes** only if needed — bench migrate handles most changes live.
