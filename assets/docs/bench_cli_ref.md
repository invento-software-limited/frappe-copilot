# Frappe Bench CLI Command Reference

`bench` is the command-line utility used to manage Frappe benches, sites, apps, and deployments.

## 1. Bench Basics & Server Operations
Manage background services and developer setups.

### Start the Bench
Starts the redis queue, web server, and worker processes.
```bash
bench start
```

---

## 2. Site Administration
Manage specific websites (tenants) installed inside the bench.

### Create a New Site
```bash
bench new-site [site-name] --admin-password [password] --db-name [db-name]
```

### Reinstall a Site
Resets the site database back to clean schema, deleting all custom records:
```bash
bench --site [site-name] reinstall
```

### Drop a Site
Deletes a site database and deletes the site folder:
```bash
bench drop-site [site-name]
```

### Set Default Site
```bash
bench use [site-name]
```

---

## 3. App Development & Control
Manage Frappe applications within the bench.

### Create a New App Scaffold
```bash
bench new-app [app-name]
```

### Install an App onto a Site
This creates custom DB tables for the app's DocTypes:
```bash
bench --site [site-name] install-app [app-name]
```

### Uninstall an App from a Site
```bash
bench --site [site-name] uninstall-app [app-name]
```

### Get/Download an App
Fetches an app repository using Git:
```bash
bench get-app [repo-url]
```

---

## 4. Updates, Migrations & Database
Commands for database schema updates and cache management.

### Database Migrations
Runs schema updates (creates new columns, updates property setters, applies changes in doctype `.json` configurations) and resets cache.
```bash
bench --site [site-name] migrate
```

### Clear Cache
```bash
bench --site [site-name] clear-cache
```

### Database Console (Direct DB Access)
Opens mysql/mariadb terminal for the site:
```bash
bench --site [site-name] db-console
```

### Bench Console (Introspective Python REPL)
Launches interactive python session loaded with the site context:
```bash
bench --site [site-name] console
```
*Example usage inside console:*
```python
In [1]: import frappe
In [2]: frappe.get_meta("Customer").fields
```

---

## 5. Assets, Build & Production
Bundles and compiles frontend JavaScript/CSS files.

### Build Assets
```bash
bench build
```

### Auto-watch Assets (Hot Reloading)
```bash
bench watch
```

### Enable Production Mode
Configures supervisor and nginx configurations:
```bash
sudo bench setup production
```
