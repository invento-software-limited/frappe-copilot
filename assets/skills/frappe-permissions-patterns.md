<!-- name: Permissions Patterns -->
<!-- description: Role-based permission rows vs has_permission hooks, and when to use which for DocType access control. -->

## Permissions Patterns

### Prefer role permission rows
Most access control belongs in the DocType's own `permissions` array (in its JSON), not in Python. Each row grants a `role` a combination of `read`/`write`/`create`/`delete`/`submit`/`cancel`/`amend`/`report`/`export`/`import`/`share`/`print`/`email` at a given `permlevel` (0 = whole document; >0 = specific fields marked with that `permlevel`).

Use `if_owner: 1` on a permission row to scope it to documents the user created (`owner == frappe.session.user`) — this alone covers the common "users can only see their own records" requirement without any custom code.

### When to add a `has_permission` hook instead
Only when the rule genuinely can't be expressed as a static role grant:
- Depends on document **state** (e.g. only editable while `workflow_state == "Draft"`)
- Depends on the requesting user's **linked records** (e.g. a Sales Person can only see Sales Orders where they're the assigned rep, not all Sales Orders)
- Cross-references another DocType's data at check time

```python
# hooks.py
permission_query_conditions = {
    "Sales Order": "myapp.myapp.permissions.sales_order_query_conditions",
}
has_permission = {
    "Sales Order": "myapp.myapp.permissions.sales_order_has_permission",
}
```
```python
# myapp/permissions.py
import frappe

def sales_order_query_conditions(user):
    if not user:
        user = frappe.session.user
    if "Sales Manager" in frappe.get_roles(user):
        return ""  # no extra restriction
    return f"`tabSales Order`.sales_person = {frappe.db.escape(user)}"

def sales_order_has_permission(doc, ptype, user):
    if "Sales Manager" in frappe.get_roles(user):
        return True
    return doc.sales_person == user
```
Note the two-hook pair: `permission_query_conditions` filters **list views/reports** (SQL-level, fast), `has_permission` gates a **single document** open/save (Python-level). You usually need both for the rule to be consistently enforced everywhere.

### Whitelisted API endpoints
An `@frappe.whitelist()` method bypasses the standard doctype permission model entirely unless you check explicitly:
```python
@frappe.whitelist()
def award_points(customer, points):
    if not frappe.has_permission("Loyalty Point Entry", "create"):
        frappe.throw("Not permitted", frappe.PermissionError)
    ...
```
Never assume a whitelisted method is safe just because the UI only calls it from an authorized screen — anyone can call it directly via the REST API.
