# Advanced Frappe Architecture: Overrides, Background Jobs, and Custom Patches

This advanced guide covers backend overrides, background worker tasks, real-time UI streaming, patches, and unit testing within the Frappe framework.

---

## 1. Class and Method Overrides (hooks.py)
Custom apps can override core Frappe/ERPNext classes and whitelisted methods to customize default behaviors globally.

### Overriding standard DocType Controllers
Define custom classes that inherit from the parent controller and map them in `hooks.py`:

**Step A: Define custom controller class (`custom_sales_invoice.py`)**
```python
from erpnext.accounts.doctype.sales_invoice.sales_invoice import SalesInvoice
import frappe

class CustomSalesInvoice(SalesInvoice):
    def validate(self):
        # Run parent validations
        super().validate()
        
        # Inject custom calculations or validations
        if self.grand_total > 500000:
            frappe.msgprint("Large transaction detected. Flagging for high-priority review.")
            self.custom_review_flag = 1
```

**Step B: Map override in custom app's `hooks.py`**
```python
override_doctype_class = {
    "Sales Invoice": "my_custom_app.overrides.custom_sales_invoice.CustomSalesInvoice"
}
```

### Overriding Whitelisted Methods
Replace backend endpoints dynamically:
```python
# In hooks.py:
override_whitelisted_methods = {
    "erpnext.accounts.party.get_party_details": "my_custom_app.api.custom_get_party_details"
}
```

---

## 2. Background Jobs & Scheduler Tasks
For operations that take longer than a standard HTTP timeout (e.g. calculating bulk taxes, sending emails), enqueue tasks to Background Workers.

### Enqueueing background methods (`frappe.enqueue`)
```python
from frappe.utils.background_jobs import enqueue

def trigger_bulk_tax_calculation(company, fiscal_year):
    # Offloads execution asynchronously to the 'long' queue
    enqueue(
        method="my_custom_app.tasks.calculate_taxes",
        queue="long",
        timeout=600,
        is_async=True,
        company=company,
        fiscal_year=fiscal_year
    )
```

### Real-Time Desk UI Streams (WebSockets)
Push messages from the background job back to the user's browser:
```python
import frappe

def calculate_taxes(company, fiscal_year):
    # 1. Update progress bar in Desk
    frappe.publish_progress(
        percent=50,
        title="Processing Taxes",
        description="Parsing accounts ledger..."
    )
    
    # 2. Publish real-time events to user session
    frappe.publish_realtime(
        event="tax_calc_update",
        message={"status": "Ledger completed. Starting calculation."},
        user=frappe.session.user
    )
```

---

## 3. Safe Schema Patches (`patches.txt`)
When upgrading app releases, schema or data changes that cannot be achieved via standard DocType changes should be deployed using patches.

### Adding a Patch
1. Create a Python script in `patches/v1_0/update_tax_defaults.py`.
2. Implement the `execute()` method.
3. Reference the patch path in `patches.txt`.

**Example Patch Code (`update_tax_defaults.py`):**
```python
import frappe

def execute():
    # 1. Safe schema update (ensures column exists)
    frappe.db.sql("ALTER TABLE `tabCompany` ADD COLUMN IF NOT EXISTS `custom_tax_number` varchar(140)")
    
    # 2. Migrating custom values safely
    companies = frappe.get_all("Company", filters={"country": "Bangladesh"})
    for company in companies:
        frappe.db.set_value("Company", company.name, "custom_tax_number", "BD-VAT-PENDING")
```

---

## 4. Writing Backend Unit Tests
All custom controllers should have robust unit tests. Frappe tests run on a separate test database.

### Core Test Class Structure
Define tests inside the `tests/` subdirectory of your module folder (e.g. `tests/test_todo.py`):

```python
import frappe
from frappe.tests.utils import FrappeTestCase

class TestToDoCustomizations(FrappeTestCase):
    def setUp(self):
        # Run setup code before every test
        self.todo = frappe.get_doc({
            "doctype": "ToDo",
            "description": "Test baseline todo",
            "assigned_by": "Administrator"
        }).insert()

    def tearDown(self):
        # Run cleanup code after every test
        self.todo.delete()

    def test_validation_rules(self):
        # 1. Assert field insertion
        self.assertEqual(self.todo.status, "Open")
        
        # 2. Test constraint throwing
        doc = frappe.new_doc("ToDo")
        doc.description = ""
        self.assertRaises(frappe.ValidationError, doc.insert)
```
