# Frappe Reporting Guide: Script Reports and Query Reports

This document covers report building paradigms in the Frappe Framework. It outlines the schema JSON config, Python backend controllers, JS client filters, and dashboard chart integrations.

---

## 1. Report Types in Frappe
1. **Query Report**: Built using a raw SQL select query (`.sql` file). Fast and simple, but has no python business logic execution.
2. **Script Report**: Built using Python (`.py` file) and Javascript (`.js` file). Offers maximum flexibility to run ORM operations, calculate complex margins, and join databases.

---

## 2. Report Configuration Metadata (`report.json`)
Every report is initialized as a record of the `Report` DocType. Standard app reports are stored in:
`[your_app]/[module]/report/[report_name]/[report_name].json`

### Key Schema Properties:
* `"report_type"`: Set to `"Script Report"` or `"Query Report"`.
* `"ref_doctype"`: The primary DocType this report queries (determines default permission scopes).
* `"is_standard"`: Must be `"Yes"` to track modifications in the app's git repository.
* `"add_total_row"`: Set to `1` to automatically add a summary total row at the bottom.
* `"roles"`: Always specify a list containing the `"System Manager"` role plus the relevant department-specific role (e.g. `"Accounts User"`, `"Stock User"`).

```json
{
  "doctype": "Report",
  "report_name": "Sales VAT Summary",
  "report_type": "Script Report",
  "ref_doctype": "Sales Invoice",
  "is_standard": "Yes",
  "add_total_row": 1,
  "roles": [
    {
      "role": "System Manager"
    },
    {
      "role": "Accounts User"
    }
  ]
}
```

---

## 3. Backend Python Controller (`report.py`)
The Python controller gathers data and builds columns. It must expose an `execute(filters=None)` method.

### Exposing Columns, Data, Messages, and Charts
```python
import frappe
from frappe import _

def execute(filters=None):
    if not filters:
        return [], []

    columns = get_columns()
    data = get_data(filters)
    chart = get_chart(data)
    report_summary = get_report_summary(data)

    return columns, data, None, chart, report_summary

def get_columns():
    return [
        {
            "label": _("Invoice ID"),
            "fieldname": "invoice",
            "fieldtype": "Link",
            "options": "Sales Invoice",
            "width": 140
        },
        {
            "label": _("Posting Date"),
            "fieldname": "posting_date",
            "fieldtype": "Date",
            "width": 120
        },
        {
            "label": _("Net Total"),
            "fieldname": "net_total",
            "fieldtype": "Currency",
            "options": "currency",
            "width": 120
        },
        {
            "label": _("VAT Amount"),
            "fieldname": "vat_amount",
            "fieldtype": "Currency",
            "options": "currency",
            "width": 120
        },
        {
            "label": _("Currency"),
            "fieldname": "currency",
            "fieldtype": "Link",
            "options": "Currency",
            "hidden": 1
        }
    ]

def get_data(filters):
    # Retrieve matches using standard query wrappers
    conditions = {"docstatus": 1}
    if filters.get("company"):
        conditions["company"] = filters.get("company")
    if filters.get("from_date") and filters.get("to_date"):
        conditions["posting_date"] = ["between", [filters.get("from_date"), filters.get("to_date")]]

    return frappe.get_all(
        "Sales Invoice",
        filters=conditions,
        fields=["name as invoice", "posting_date", "net_total", "custom_vat_amount as vat_amount", "currency"]
    )
```

---

## 4. Relevant Filters Matching & Validation Rules
To make the report performant and usable, you must always declare and validate filters matching the schema of the reference DocType:

* **Company Filter**: If the target DocType contains a `company` link, a `"company"` filter is **mandatory** (mark `"reqd": 1` in JS and validate in Python).
* **Date Range Filters**: If the DocType is transactional or date-logged (contains fields like `posting_date`, `transaction_date`, or `creation`), add `"from_date"` and `"to_date"` filters. 
* **Party Filters**: If the DocType contains link references to customers or suppliers, add optional `"customer"` or `"supplier"` filters.
* **Filter Validation in Python**: Always raise validation alerts at the beginning of `execute()` to block queries missing mandatory parameters:
```python
def validate_filters(filters):
    if not filters.get("company"):
        frappe.throw(_("Company is a mandatory filter."))
    if filters.get("from_date") and filters.get("to_date"):
        if filters.get("from_date") > filters.get("to_date"):
            frappe.throw(_("From Date cannot be after To Date."))
```

---

## 5. Frontend Client Filters (`report.js`)
Report filters appear at the top of the report screen. They are defined inside a `.js` companion script:

```javascript
frappe.query_reports["Sales VAT Summary"] = {
    filters: [
        {
            fieldname: "company",
            label: __("Company"),
            fieldtype: "Link",
            options: "Company",
            default: frappe.defaults.get_user_default("Company"),
            reqd: 1
        },
        {
            fieldname: "from_date",
            label: __("From Date"),
            fieldtype: "Date",
            default: frappe.datetime.add_months(frappe.datetime.get_today(), -1),
            reqd: 1
        },
        {
            fieldname: "to_date",
            label: __("To Date"),
            fieldtype: "Date",
            default: frappe.datetime.get_today(),
            reqd: 1
        }
    ]
};
```

---

## 5. Report Charts & Summaries

### A. Graph Data Schema (Chart)
You can return a line/bar chart to display on the report dashboard:
```python
def get_chart(data):
    if not data:
        return None

    labels = [row.get("invoice") for row in data]
    vat_dataset = [row.get("vat_amount") for row in data]

    return {
        "data": {
            "labels": labels[:10], # limit to 10 entries to avoid crowding
            "datasets": [
                {
                    "name": "VAT Collected",
                    "values": vat_dataset[:10]
                }
            ]
        },
        "type": "bar", # "bar", "line", "percentage", "donut"
        "colors": ["#4ec9b0"]
    }
```

### B. Report Summary Cards
Summary cards display core aggregates (like sum or count) at the top of the report layout:
```python
def get_report_summary(data):
    if not data:
        return []

    total_vat = sum(row.get("vat_amount") or 0.0 for row in data)
    total_net = sum(row.get("net_total") or 0.0 for row in data)

    return [
        {
            "value": total_net,
            "indicator": "Blue",
            "label": _("Total Net Amount"),
            "datatype": "Currency"
        },
        {
            "value": total_vat,
            "indicator": "Green",
            "label": _("Total VAT Collected"),
            "datatype": "Currency"
        }
    ]
```
