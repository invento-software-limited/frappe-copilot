<!-- name: Hooks Reference -->
<!-- description: doc_events, scheduler_events, and override_whitelisted_methods wiring in hooks.py, with common gotchas. -->

## Hooks Reference

All of these are registered in `<app>/<app>/hooks.py`. After adding or changing hooks.py, a `bench migrate`/restart is usually needed for the framework to pick up the new registration — the harness handles this automatically once your turn ends.

### doc_events — react to document lifecycle
```python
doc_events = {
    "Sales Order": {
        "validate": "myapp.myapp.events.sales_order.validate",
        "on_submit": "myapp.myapp.events.sales_order.on_submit",
        "on_cancel": "myapp.myapp.events.sales_order.on_cancel",
    },
    "*": {
        "on_update": "myapp.myapp.events.audit.log_update",  # applies to every DocType
    },
}
```
Prefer this over editing a DocType's own controller when the logic is cross-cutting (e.g. an audit log) or belongs to a *different* app than the one that owns the DocType — you can't always edit another app's controller directly.

### scheduler_events — background jobs on a schedule
```python
scheduler_events = {
    "daily": ["myapp.myapp.tasks.expire_stale_points"],
    "hourly": ["myapp.myapp.tasks.sync_inventory"],
    "cron": {
        "0 2 * * *": ["myapp.myapp.tasks.nightly_cleanup"],
    },
}
```
Keep the scheduled function itself thin — have it enqueue the real work via `frappe.enqueue(...)` if it might take more than a few seconds, so a slow job doesn't block the scheduler's worker.

### override_whitelisted_methods — replace a core/another-app's API
```python
override_whitelisted_methods = {
    "frappe.desk.reportview.get": "myapp.myapp.overrides.custom_reportview_get",
}
```
Use sparingly — this replaces core behavior globally for every caller, not just your app's own UI. Prefer a new whitelisted method with a different name unless you specifically need to intercept an existing call site you don't control.

### Other commonly-needed hooks
- `fixtures` — data (Custom Fields, Property Setters, Roles, etc.) exported/imported with the app, useful for shipping configuration alongside code.
- `doctype_js` — attach an extra `.js` file to a DocType's form *without* owning that DocType (e.g. adding a button to core's Sales Invoice from your own app).
- `permission_query_conditions` / `has_permission` — see the permissions-patterns skill.
- `on_session_creation` / `on_logout` — auth lifecycle hooks, rarely needed outside SSO/session-side-effect scenarios.
