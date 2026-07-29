# Installing `insights` app fails in Frappe Docker (mysqlclient/gcc/apps.txt/frontend)

## Problem

Running `bench get-app insights` / `bench install-app insights` inside a
Frappe Docker app container (Debian bookworm base image) fails in a chain of
distinct errors:

1. `uv pip install -e apps/insights` fails building `mysqlclient`:
   ```
   Trying pkg-config --exists mariadb ... returned non-zero exit status 1
   Exception: Can not find valid pkg-config name.
   ```
2. After fixing (1), the same pip install fails with:
   ```
   error: command 'gcc' failed: No such file or directory
   ```
3. After fixing (1) and (2), `bench install-app insights` fails with:
   ```
   builtins.Exception: App insights not in apps.txt
   ```
   even though `insights.hooks` imports fine and the module is installed.
4. After fixing (1)-(3), `bench build --app insights` fails with:
   ```
   $ vite build ...
   /bin/sh: 1: vite: not found
   ```

## Solution

Run these as root inside the app container (`docker exec -u root <container> ...`):

```bash
# 1. Fix mysqlclient/pkg-config build failure — the base image ships
#    mariadb-client but not the -dev headers/pkg-config file
apt-get update -qq
apt-get install -y libmariadb-dev pkg-config

# 2. Fix "gcc: No such file or directory" — no C toolchain in the image
apt-get install -y build-essential
```

Then retry the pip install as the frappe user (or via `bench get-app`):

```bash
docker exec -w /home/frappe/frappe-bench <container> \
  uv pip install --quiet -e /home/frappe/frappe-bench/apps/insights \
  --python /home/frappe/frappe-bench/env/bin/python
```

If `bench install-app insights` then errors with `App insights not in
apps.txt`, the get-app/pip-install flow didn't register the app in
`sites/apps.txt` (this happens when you did the pip install manually instead
of via a fully successful `bench get-app`). Fix by appending it manually
(watch for a missing trailing newline corrupting the last existing line):

```bash
docker exec -w /home/frappe/frappe-bench <container> bash -c \
  "printf '%s\n' \$(cat sites/apps.txt) insights > sites/apps.txt"
# or just rewrite the whole file explicitly with printf if unsure
```

Then `bench --site <site> install-app insights` succeeds.

Finally, `bench build --app insights` fails with `vite: not found` because
the app's `frontend/` yarn workspace has never had `yarn install` run (only
Python deps were installed, not JS deps):

```bash
docker exec -w /home/frappe/frappe-bench/apps/insights/frontend <container> \
  yarn install
```

Then `bench build --app insights` completes successfully.

## Root cause

- The Frappe docker app image is a minimal Debian install: it has the
  MariaDB *client* (`mariadb-client`, `libmariadb3`) but not the *dev*
  package (`libmariadb-dev`) that ships the `.pc` pkg-config file and
  headers `mysqlclient` needs to compile against. It also has no C compiler
  at all.
- `bench get-app` normally does pip install + apps.txt registration + node
  frontend install as one atomic-ish flow; if the pip install step fails
  partway (as it does here on a fresh image), retrying just the pip install
  command directly skips the apps.txt bookkeeping and the yarn install step,
  so those need to be done by hand afterward.
- The container runs as the `frappe` user by default; installing system
  packages requires `docker exec -u root`.

## How to detect recurrence

- `pkg-config --exists mariadb` returns non-zero exit status 1 during a pip
  build of `mysqlclient`.
- `error: command 'gcc' failed: No such file or directory` during a Python C
  extension build inside the app container.
- `builtins.Exception: App insights not in apps.txt` (or any other app name)
  during `bench install-app` right after a manual/partial pip install.
- `/bin/sh: 1: vite: not found` during `bench build --app <app>` for any app
  with a `frontend/` yarn workspace that was never `yarn install`ed.

This is not insights-specific — any Frappe app depending on
`ibis-framework[mysql]` / `mysqlclient` (or any package needing a C
extension) will hit steps 1-2 on a fresh minimal Frappe docker image.
