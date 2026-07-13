# Frappe UI Design Guidelines: Workspaces, DocTypes, and Lists

This document defines the strict layout conventions and structural patterns for designing custom **DocTypes**, **Workspaces**, and **List Views** in Frappe and ERPNext applications. All generated UI configuration JSON files must follow these schemas.

---

## 1. DocType Structure & Configuration Conventions
When creating or generating custom DocType files (e.g. `[doctype].json`), adhere to these standards:

### A. Title Field Selection
Always specify a meaningful `title_field` in the DocType configuration. The title field determines the label displayed in Link search selectors and top headers.
* Set the `"title_field"` property to a string value (e.g., `"customer_name"`, `"subject"`, or `"reference_no"`).
* Avoid using the record name (`name`) as the title field if a human-friendly field exists.

```json
{
  "name": "Custom VAT Certificate",
  "doctype": "DocType",
  "title_field": "certificate_number",
  "autoname": "field:certificate_number",
  ...
}
```

### B. List View Configuration
To ensure clean and scan-friendly tables in Desk:
* Check `"in_list_view": 1` for exactly **3 to 5 critical fields** (e.g., identifier name, status, date, and company/owner).
* Do not mark description or long text fields for list view, as they break list column grids.
* Set `"search_fields": "status,posting_date"` for quick filter lookups.

### C. Standard Filters (List Headers)
Standard filters are dropdown filters that appear directly at the top of the List view.
* Mark `"in_standard_filter": 1` for fields frequently used to subset the list (e.g. `company`, `status`, `posting_date`, or `owner`).
* Keep standard filters limited to **2 or 3 fields** to prevent cluttering the desktop list header.

```json
{
  "fieldname": "company",
  "fieldtype": "Link",
  "label": "Company",
  "options": "Company",
  "in_list_view": 1,
  "in_standard_filter": 1
}
```

---

## 2. Workspace Sidebar & Layout Patterns
Workspaces in Frappe v13+ are defined as records in the `Workspace` DocType, which writes to `workspace.json` under `[module]/workspace/[name]/[name].json`.

### A. Sidebar Grouping Hierarchy
Every Workspace Link card table (`links`) must follow this exact grouping pattern:

1. **Dashboard & Number Cards**: (Top section) Display metrics using `number_cards` and `charts` tables.
2. **Important Links (Core Operations)**: A Card Break for primary entries and transactions (e.g., "Documents" or "Transactions").
3. **Reports Grouping**: A Card Break specifically listing analytical reports related to this module.
4. **Setup Grouping**: A Card Break for masters and settings configurations.
5. **Settings Grouping**: (Bottom section) A Card Break for administrative configurations.

### B. Workspace Link Child Table Schema
Link lines are stored in the child DocType `Workspace Link`. Each card division starts with a `Card Break` type row:

```json
"links": [
  {
    "type": "Card Break",
    "label": "Transactions",
    "icon": "octicon octicon-list-ordered"
  },
  {
    "type": "Link",
    "link_type": "DocType",
    "link_to": "Sales Invoice",
    "label": "Sales Invoice"
  },
  {
    "type": "Card Break",
    "label": "Reports",
    "icon": "octicon octicon-graph"
  },
  {
    "type": "Link",
    "link_type": "Report",
    "link_to": "Sales Invoice Register",
    "label": "Sales Invoice Register"
  },
  {
    "type": "Card Break",
    "label": "Setup",
    "icon": "octicon octicon-gear"
  },
  {
    "type": "Link",
    "link_type": "DocType",
    "link_to": "Tax Template Override",
    "label": "Tax Templates"
  }
]
```

---

## 3. Desktop Icon (Desk Cards)
In modern versions, Desk Icons (modules) are populated directly based on `public` workspaces with parent page set to `null` (or empty).
* Setting `"public": 1` makes the page visible in the Desk sidebar.
* Setting `"icon"` to a valid icon string (e.g., `"accounting"`, `"payment"`, `"sale"`) dictates the card icon.
* Order of sidebar pages is controlled via the `"sequence_id"` float parameter.

---

## 4. Document Connections (Links) & Document States
To ensure custom DocTypes integrate fully into the ERPNext ecosystem, you must configure their connections dashboard and color badge indicators.

### A. Document Links (Connections / Link Dashboard)
DocType links represent referenced tables that are rendered in the "connections" dashboard banner at the top of document views.
* Populate the `"links"` array inside the DocType configuration JSON using items of type `DocType Link`.
* Each link requires:
  * `"link_doctype"`: The linked DocType name.
  * `"link_fieldname"`: The name of the field inside the linked DocType referencing the parent.
  * `"group"`: The classification heading (e.g. `"Transactions"` or `"References"`).

```json
"links": [
  {
    "link_doctype": "Payment Entry Reference",
    "link_fieldname": "reference_name",
    "group": "Payments"
  },
  {
    "link_doctype": "VAT Deduction Certificate",
    "link_fieldname": "invoice_reference",
    "group": "Tax Documents"
  }
]
```

### B. Document States (Badge Colors)
DocType states represent custom document workflow stages or statuses (like Draft, Submitted, Cancelled, Approved, Pending, Rejected) and assign visual indicator badges to them.
* Populate the `"states"` array in the DocType configuration JSON using items of type `DocType State`.
* Supported colors: `"Blue"`, `"Cyan"`, `"Gray"`, `"Green"`, `"Light Blue"`, `"Orange"`, `"Pink"`, `"Purple"`, `"Red"`, `"Yellow"`.

```json
"states": [
  {
    "title": "Draft",
    "color": "Gray"
  },
  {
    "title": "Submitted",
    "color": "Blue"
  },
  {
    "title": "Cancelled",
    "color": "Red"
  },
  {
    "title": "Processed",
    "color": "Green"
  }
]
```

