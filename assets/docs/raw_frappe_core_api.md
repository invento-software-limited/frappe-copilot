# Raw Frappe Framework Python & Database Core API Reference

This document covers the deep, internal Python and database APIs of the Frappe Framework. Use these methods in server controller files (`[doctype].py`), custom scripts, and backend APIs.

---

## 1. Global Context variables (`frappe.local`)
Frappe runs multi-tenant site processes scoped inside thread-local variables. You can import `frappe` and access:

* **`frappe.db`**: Local database connector (resolves to standard MariaDB, Postgres, or SQLite cursor wrapper).
* **`frappe.qb`**: Pypika-backed Query Builder instance.
* **`frappe.session`**: Current request session parameters:
  * `frappe.session.user`: Currently logged-in username (e.g. `"Administrator"`, `"Guest"`, or an email).
  * `frappe.session.sid`: Session ID hash.
* **`frappe.conf`**: Config parameters loaded from current site's `site_config.json`.
* **`frappe.form_dict`**: Dict containing HTTP query parameters and POST body variables.
* **`frappe.request`**: Werkzeug Request wrapper.
* **`frappe.flags`**: Runtime execution flags (e.g., `frappe.flags.in_migrate`, `frappe.flags.in_test`).

---

## 2. Advanced Document Factory API (`frappe.model.document`)
Import directly from `frappe` or `frappe.model.document`.

### `frappe.get_doc(arg1, arg2=None)`
Gets a document from the database or creates a new one in memory from a dictionary.
```python
# 1. Load existing document from DB (triggers load_from_db)
doc = frappe.get_doc("Sales Invoice", "SINV-2026-0002")

# 2. Get Single DocType (name is identical to doctype)
settings = frappe.get_doc("System Settings")

# 3. Create document in memory from dict (Not recommended, use frappe.new_doc)
doc = frappe.get_doc({
    "doctype": "ToDo",
    "description": "Prepare tax return",
    "status": "Open"
})
```

### `frappe.new_doc(doctype, parent_doc=None, parentfield=None, as_dict=False)`
Initializes a new document in memory with standard default values populated.
```python
new_todo = frappe.new_doc("ToDo")
new_todo.description = "New workflow test"
new_todo.insert() # Writes to DB
```

### `frappe.get_cached_doc(doctype, name)`
Loads a document from Redis cache if available, otherwise loads from DB and caches it.
```python
cached_customer = frappe.get_cached_doc("Customer", "CUST-00001")
```

### `frappe.get_last_doc(doctype, filters=None, order_by="creation desc")`
Finds and loads the last inserted document matching the filters.
```python
last_invoice = frappe.get_last_doc("Sales Invoice", filters={"company": "Ace Advisory"})
```

---

## 3. Controller Hook Triggers & Saving lifecycle
When executing operations on a Document object, the following methods are fired sequentially:

```
new_doc() / get_doc()
   └── doc.insert()
         ├── set_defaults()
         ├── check_permission("create")
         ├── doc.run_method("before_insert")
         ├── doc.run_method("before_save") 
         ├── doc.run_method("validate")
         ├── db_insert() (Writes parent and child records to DB)
         ├── doc.run_method("after_insert")
         └── doc.run_method("on_update") (Post-commit operations)
```

```
doc = get_doc()
   └── doc.save()
         ├── check_permission("write")
         ├── doc.run_method("before_save")
         ├── doc.run_method("validate") (Skipped on cancel)
         ├── db_update() (Updates modified fields)
         └── doc.run_method("on_update")
```

### Throwing Errors during hooks
If an error is thrown, the transaction is automatically rolled back:
```python
# Halts execution and prints a message dialog
frappe.throw(
    msg="The base amount cannot exceed grand total.",
    exc=frappe.ValidationError,
    title="Validation Failed"
)
```

---

## 4. Low-Level Database API (`frappe.db`)
Direct interface to Mariadb, Postgres, or SQLite queries.

### `frappe.db.sql(query, values=None, as_dict=False, pluck=False, as_iterator=False)`
Executes raw SQL commands. Always pass parameters via `values` to prevent SQL injection.
```python
# Retrieve as a list of dicts
items = frappe.db.sql(
    "SELECT item_code, stock_value FROM tabItem WHERE disabled = %s",
    (0,),
    as_dict=True
)

# Pluck first column only (returns flat list)
names = frappe.db.sql(
    "SELECT name FROM tabUser WHERE status = %s",
    ("Active",),
    pluck=True
)
```

### `frappe.db.get_value(doctype, filters, fieldname, as_dict=False, cache=False, for_update=False)`
Returns a specific property or a list of properties.
```python
# Get single field from name key
limit = frappe.db.get_value("Customer", "CUST-00001", "credit_limit")

# Get multiple fields using dict filter
vals = frappe.db.get_value("User", 
    {"email": "admin@example.com"}, 
    ["first_name", "last_name", "status"], 
    as_dict=True
)
```

### `frappe.db.set_value(doctype, name_or_filters, field, value=None, update_modified=True)`
Directly updates one or more fields in the database. **Warning:** This bypasses all document validations and hooks.
```python
# Update status directly
frappe.db.set_value("Sales Invoice", "SINV-2026-0001", "status", "Paid")

# Update multiple fields
frappe.db.set_value("Customer", "CUST-00001", {"credit_limit": 100000, "status": "Active"})
```

### `frappe.db.get_single_value(doctype, fieldname)`
Fetch properties of a Single DocType.
```python
company = frappe.db.get_single_value("Global Defaults", "default_company")
```

### `frappe.db.set_single_value(doctype, fieldname, value)`
Update properties of a Single DocType.
```python
frappe.db.set_single_value("System Settings", "deny_multiple_sessions", 1)
```

### `frappe.db.exists(doctype, name_or_filters)`
Checks if a record matching the filters exists in the database. Returns the document name if found, otherwise `None`.
```python
if frappe.db.exists("Customer", "CUST-00001"):
    pass
    
# check with filters
if frappe.db.exists("Sales Invoice", {"customer": "CUST-00001", "docstatus": 1}):
    pass
```

### Transaction Control
By default, Frappe auto-commits transactions at the end of successful HTTP requests. For manual controls:
* `frappe.db.commit()`: Commits the current transaction.
* `frappe.db.rollback()`: Reverts database writes since the last commit.
