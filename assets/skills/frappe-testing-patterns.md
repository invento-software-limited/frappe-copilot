<!-- name: Testing Patterns -->
<!-- description: Test file placement/naming, FrappeTestCase structure, and bench run-tests scoping. -->

## Testing Patterns

### File placement
Tests live alongside the code they cover, prefixed `test_`:
```
your_app/doctype/sales_order/
  sales_order.py
  test_sales_order.py
```
For non-DocType modules (a whitelisted API, a hooks handler), the test file sits next to that module with the same `test_<module_name>.py` convention.

### Structure
```python
import frappe
from frappe.tests.utils import FrappeTestCase

class TestSalesOrder(FrappeTestCase):
    def setUp(self):
        # runs before each test — create shared fixtures here
        self.customer = frappe.get_doc({
            "doctype": "Customer",
            "customer_name": "_Test Customer",
        }).insert(ignore_if_duplicate=True)

    def test_creation(self):
        doc = frappe.get_doc({
            "doctype": "Sales Order",
            "customer": self.customer.name,
        })
        doc.insert()
        self.assertTrue(doc.name)

    def test_mandatory_field_raises(self):
        doc = frappe.get_doc({"doctype": "Sales Order"})
        self.assertRaises(frappe.MandatoryError, doc.insert)

    def test_permission_denied_for_other_user(self):
        with self.set_user("test2@example.com"):
            self.assertRaises(frappe.PermissionError, frappe.get_doc(
                "Sales Order", self.some_other_users_order
            ).save)
```
`FrappeTestCase` (not plain `unittest.TestCase`) wraps each test in a DB transaction that's rolled back automatically — you don't need a manual `tearDown` with `frappe.db.rollback()` for data created via `insert()`.

### What must be covered
Every new DocType or controller change needs: creation/validation happy path, at least one mandatory-field or validation-error path, every custom controller method (`validate`, `before_save`, `on_submit`, `on_cancel`, any public method), and permission checks if the DocType has non-default rules.

### Running tests
```bash
# everything in an app
bench --site your.site run-tests --app your_app

# scoped to one doctype (fast — use this while iterating)
bench --site your.site run-tests --doctype "Sales Order"

# a specific module (for non-doctype code)
bench --site your.site run-tests --module your_app.utils.test_pricing
```
Always scope to the narrowest relevant target while iterating on a fix — a full `--app` run is slow feedback for a single failing test.
