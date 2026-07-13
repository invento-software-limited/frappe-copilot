# Frappe Server-Side Python API Reference

## 1. Document Operations
Documents are instances of DocTypes. Always interact with records using the Document API rather than raw SQL for validation and hook triggers.

### Get / Load a Document
```python
# Load a document by DocType and Name
doc = frappe.get_doc("Customer", "CUST-00001")
print(doc.customer_name)
print(doc.billing_currency)
```

### Create a Document
```python
doc = frappe.new_doc("ToDo")
doc.description = "Task description"
doc.assigned_by = "administrator@example.com"
doc.insert() # Triggers before_insert and after_insert
```

### Save / Update a Document
```python
doc = frappe.get_doc("ToDo", "TDO-00001")
doc.description = "Updated task description"
doc.save() # Triggers validate, before_save, on_update
frappe.db.commit() # Save to DB (only call in API endpoints, hooks commit automatically)
```

### Submit / Cancel a Document
Submitting and cancelling are only available on doctypes where `Is Submittable` is checked.
```python
doc = frappe.get_doc("Sales Invoice", "ACC-SINV-2026-00001")
doc.submit() # Sets docstatus to 1, triggers on_submit

doc.cancel() # Sets docstatus to 2, triggers on_cancel
```

### Update a Single Field Without Hooks
Avoid triggering validation or hooks if doing simple state updates:
```python
doc.db_set("status", "Closed")
```

---

## 2. Database Queries (Fast & Safe)
Use these methods instead of SQL where possible. They automatically respect user permissions and return clean dicts.

### `frappe.get_value`
Get values of specific fields from a record.
```python
# Get single field
email = frappe.get_value("User", "administrator@example.com", "email")

# Get multiple fields (returns a dict or tuple)
name, status = frappe.get_value("User", {"email": "admin@example.com"}, ["first_name", "status"])
```

### `frappe.db.set_value`
Update a value directly in the database without loading document objects.
```python
frappe.db.set_value("Customer", "CUST-00001", "credit_limit", 50000)
```

### `frappe.get_all` vs `frappe.get_list`
* `frappe.get_list`: Filters records by user permissions (RAG / security compliant).
* `frappe.get_all`: Fetches all records regardless of user's permissions (use with caution in frontend APIs).

```python
# Get active customers
customers = frappe.get_all("Customer",
    filters={"status": "Active"},
    fields=["name", "customer_name", "territory"],
    order_by="creation desc",
    limit=50
)
```

### Raw SQL Queries
Use only for complex joins or reporting. Avoid when standard DB wrappers work.
```python
data = frappe.db.sql("""
    SELECT parent, SUM(qty) as total_qty
    FROM `tabSales Invoice Item`
    WHERE docstatus = 1
    GROUP BY parent
""", as_dict=True)
```

---

## 3. Whitelisting API Methods
To expose a Python function to the frontend Client Script (via `frappe.call`), use the `@frappe.whitelist()` decorator.

```python
@frappe.whitelist()
def get_invoice_summary(company, from_date, to_date):
    # Verify permission manually if needed
    if not frappe.has_permission("Sales Invoice", "read"):
        frappe.throw("Not permitted", frappe.PermissionError)
        
    return frappe.db.sql("""
        SELECT SUM(grand_total) as grand_total
        FROM `tabSales Invoice`
        WHERE company = %s AND posting_date BETWEEN %s AND %s AND docstatus = 1
    """, (company, from_date, to_date), as_dict=True)
```

Allow guest access (without login):
```python
@frappe.whitelist(allow_guest=True)
def get_public_announcements():
    return frappe.get_all("Announcement", fields=["title", "content"])
```

---

## 4. Standard Controller Lifecycle Hooks
Define these methods inside the Python controller class of your custom DocType (e.g. `todo.py`):

```python
from frappe.model.document import Document

class ToDo(Document):
    def before_insert(self):
        # Triggered before record is inserted into database
        pass

    def validate(self):
        # Triggered before every save/insert. Perfect for validations.
        if not self.description:
            frappe.throw("Description is required.")

    def on_update(self):
        # Triggered after document is written to database
        pass

    def on_submit(self):
        # Triggered after document status changes to 1 (Submitted)
        pass

    def on_cancel(self):
        # Triggered after document status changes to 2 (Cancelled)
        pass
```
