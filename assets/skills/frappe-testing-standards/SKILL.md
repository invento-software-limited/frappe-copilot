---
name: frappe-testing-standards
description: >-
  Mandatory test coverage requirements, naming conventions, and AI-assisted
  test generation for Frappe apps. Use this skill any time the user mentions:
  writing tests, unit tests, or a controller test; test coverage for a
  DocType, controller, server script, or workflow; testing permission/
  role-based access rules; FrappeTestCase; or says things like "write tests
  for this doctype", "add test coverage", "generate a controller test", or
  "test this DocType" — even when they just say "test" or "tests" without
  "Frappe".
---

# Frappe Testing Standards

## 1. Mandatory Coverage

Every PR with new DocTypes or Controllers **must** include test coverage. Tests must be written before or alongside the feature.

**What must be tested:**
- Every DocType — creation, validation rules, required fields, naming series
- Every controller method — `validate()`, `before_save()`, `on_submit()`, `on_cancel()`, custom methods
- Server scripts — business logic in hooks and scheduled jobs
- Workflows & transitions — valid and invalid state transitions
- Permissions & role checks — role-based access control

## 2. File & Naming Convention

Test files live alongside the DocType:

```
your_app/
  doctype/
    sales_order/
      sales_order.py
      test_sales_order.py
```

Standard structure:
```python
import frappe
import unittest

class TestSalesOrder(unittest.TestCase):

    def setUp(self):
        """Runs before each test. Create shared fixtures here."""
        pass

    def test_creation(self):
        doc = frappe.get_doc({
            "doctype": "Sales Order",
            "customer": "_Test Customer",
        })
        doc.insert()
        self.assertTrue(doc.name)

    def test_mandatory_customer_field(self):
        """Verify that missing customer raises a ValidationError."""
        doc = frappe.get_doc({"doctype": "Sales Order"})
        self.assertRaises(frappe.MandatoryError, doc.insert)

    def tearDown(self):
        frappe.db.rollback()
```

## 3. Running Tests

```bash
# All tests for your app
bench --site your.site run-tests --app your_app

# Specific DocType
bench --site your.site run-tests --doctype "Sales Order"

# Single test method
bench --site your.site run-tests --module your_app.doctype.sales_order.test_sales_order
```

## 4. AI-Assisted Test Generation

Use this prompt template with AI tools to generate initial test scaffolding:

> "Here is my Frappe DocType definition / controller code:
> [paste code]
>
> Generate a complete Python unittest file using frappe.test_runner conventions.
> Cover: field validation, mandatory checks, controller hooks (validate,
> before_save, on_submit), and at least one happy-path and one error-path test
> for each public method."

Always review and run generated tests before committing — AI output is a starting point, not a final product.
