<!-- name: DocType Basics -->
<!-- description: DocType JSON shape, field types/naming conventions, and controller boilerplate for creating or modifying a DocType. -->

## DocType Basics

### File layout
A DocType lives under `<app>/<app>/<module>/doctype/<doctype_name>/`:
- `<doctype_name>.json` — the schema (fields, permissions, links)
- `<doctype_name>.py` — the controller (even if it just `class X(Document): pass`)
- `<doctype_name>.js` — client script, only if the form needs custom behavior
- `test_<doctype_name>.py` — tests (see the testing-patterns skill)

`doctype_name` is always snake_case for the folder/file, but the JSON's `"name"` field is the human-readable Title Case display name (e.g. folder `loyalty_point_entry`, name `"Loyalty Point Entry"`).

### Field conventions
- `fieldname`: snake_case, must be unique within the DocType.
- `label`: Title Case, shown to the user.
- `fieldtype`: common ones — `Data`, `Text`, `Small Text`, `Int`, `Float`, `Currency`, `Check`, `Select` (needs `options` as newline-separated values), `Link` (needs `options` = target DocType), `Table` (child table, needs `options` = child DocType), `Date`, `Datetime`, `Attach`.
- Set `reqd`, `in_list_view`, `in_standard_filter`, `read_only` deliberately per field — don't default everything to visible/required, it clutters the list view and blocks legitimate drafts.
- `unique: 1` on a field enforces a DB-level unique constraint — use for natural keys, not surrogate ones.

### Naming
Set `"autoname"` to control how new documents get their `name`:
- `"field:fieldname"` — use another field's value directly
- `"naming_series:"` — user-selectable prefix + running number (needs a `naming_series` Select field)
- `"format:PREFIX-{#####}"` — a fixed pattern with an auto-incrementing counter
- Omit for `hash` (random) naming — fine for child tables and internal-only records.

### Controller boilerplate
```python
import frappe
from frappe.model.document import Document

class LoyaltyPointEntry(Document):
    def validate(self):
        # runs on every save, before insert/update — put invariants here
        pass

    def before_save(self):
        pass

    def on_submit(self):
        # only relevant if is_submittable = 1
        pass
```

### After changing a DocType JSON
The harness runs `bench migrate` automatically once your turn ends (see the Verification section of your system prompt) — don't run it yourself, and don't tell the user to. Just say in your summary which DocType(s) changed.
