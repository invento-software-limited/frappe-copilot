---
name: frappe-documentation-standards
description: >-
  Mandatory documentation requirements for DocTypes, controllers, server
  scripts, form scripts, and workflows. Use this skill any time the user
  mentions: documenting or writing docs for a DocType; adding docstrings to a
  Python controller (PEP-257/Google style); adding JSDoc comments to a form
  script; writing a docs/ markdown file; or says things like "document this
  doctype", "write docstrings for this function", "add a JSDoc comment", or
  "generate documentation for this controller".
---

# Frappe Documentation Standards

## 1. What Must Be Documented

| Component | Location | Minimum Content |
|---|---|---|
| DocType | `docs/doctype/<name>.md` | Purpose, field reference table, business rules, relationships |
| Controller (Python) | Inline docstrings + `docs/doctype/<name>.md` | Class docstring, method docstrings for all public methods |
| Server Script | `docs/server_scripts/<name>.md` | Trigger event, purpose, inputs/outputs, side effects |
| Form Script (JS) | Inline JSDoc + `docs/form_scripts/<name>.md` | Triggered events, UI logic |
| Workflow | `docs/workflows/<name>.md` | State diagram description, transition rules, roles |
| Scheduled Job | `docs/scheduled_jobs/<name>.md` | Frequency, what it does, dependencies |

## 2. DocType Documentation Template

Every DocType must have `docs/doctype/<doctype_name>.md`:

```markdown
# DocType: Sales Order

## Purpose
Records a confirmed order from a customer before fulfilment begins.

## Fields
| Field Name       | Type        | Required | Description                        |
|------------------|-------------|----------|------------------------------------|
| customer         | Link        | Yes      | The customer placing the order.    |
| delivery_date    | Date        | Yes      | Expected delivery date.            |

## Business Rules
- Delivery date must be >= today.
- Cannot submit if any line item has zero quantity.

## Relationships
- Links to: Customer, Item, Warehouse
- Linked from: Delivery Note, Sales Invoice

## Controller Hooks
| Hook         | Method               | Description                   |
|--------------|----------------------|-------------------------------|
| validate     | validate_dates()     | Ensures delivery_date >= today|
| on_submit    | create_stock_reservation() | Reserves stock       |
```

## 3. Inline Code Documentation

### Python — PEP-257 docstrings with Google style:
```python
class SalesOrder(Document):
    """Manages the lifecycle of a confirmed customer Sales Order.

    Hooks:
        validate      → validate_dates(), check_stock_availability()
        on_submit     → create_stock_reservation()
        on_cancel     → cancel_stock_reservation()
    """
    def validate_dates(self):
        """Ensure delivery_date is not in the past."""
        if self.delivery_date < frappe.utils.today():
            frappe.throw(_("Delivery date cannot be in the past."))
```

### JavaScript — JSDoc comments:
```javascript
/**
 * Triggered on form refresh. Shows/hides the discount field
 * based on the customer's credit tier.
 * @param {Object} frm - The current Frappe form object.
 */
frappe.ui.form.on('Sales Order', {
    refresh(frm) {
        frm.toggle_display('discount', frm.doc.credit_tier === 'Gold');
    }
});
```

## 4. AI-Assisted Documentation Generation

Use these prompt templates:

**DocType docs:** "Here is the JSON definition for my Frappe DocType: [paste] Generate a markdown documentation file following this structure: Purpose, Fields table (name/type/required/description), Business Rules, Relationships, and Controller Hooks."

**Controller docstrings:** "Here is my Frappe Python controller: [paste] Add PEP-257-compliant docstrings to the class and every public method, describing parameters, return values, and side effects. Follow the Google docstring style."

**Server Script docs:** "Here is my Frappe Server Script (trigger: [event], DocType: [name]): [paste] Generate docs covering: Trigger event, Purpose, Inputs consumed, Outputs/side effects, Dependencies."

Always verify accuracy after generation.

## 5. Documentation Review Checklist

- [ ] `docs/doctype/<name>.md` exists for every new/modified DocType
- [ ] All public Python methods have a docstring
- [ ] All JS form events have a JSDoc comment
- [ ] Server scripts and scheduled jobs have a `docs/` entry
- [ ] CHANGELOG.md entry written for the release version
- [ ] AI-generated content reviewed for accuracy
