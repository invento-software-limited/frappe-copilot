# Standard Script Report Python Controller Boilerplate
# File Path: apps/[app]/[module]/report/[report_name]/[report_name].py

import frappe
from frappe import _

def execute(filters=None):
    if not filters:
        return [], []

    validate_filters(filters)

    columns = get_columns(filters)
    data = get_data(filters)
    chart = get_chart(data)
    report_summary = get_report_summary(data)

    return columns, data, None, chart, report_summary

def validate_filters(filters):
    # Enforce mandatory filters based on reference DocType schema
    if not filters.get("company"):
        frappe.throw(_("Company is a mandatory filter."))
        
    if filters.get("from_date") and filters.get("to_date"):
        if filters.get("from_date") > filters.get("to_date"):
            frappe.throw(_("From Date cannot be after To Date."))

def get_columns(filters):
    return [
        {
            "label": _("ID"),
            "fieldname": "name",
            "fieldtype": "Data",
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
            "label": _("Currency"),
            "fieldname": "currency",
            "fieldtype": "Link",
            "options": "Currency",
            "hidden": 1
        }
    ]

def get_data(filters):
    conditions = {"docstatus": 1}
    if filters.get("company"):
        conditions["company"] = filters.get("company")
    if filters.get("from_date") and filters.get("to_date"):
        conditions["posting_date"] = ["between", [filters.get("from_date"), filters.get("to_date")]]

    return frappe.get_all(
        "{{RefDocType}}",
        filters=conditions,
        fields=["name", "posting_date", "net_total", "currency"]
    )

def get_chart(data):
    if not data:
        return None

    labels = [row.get("name") for row in data]
    dataset_values = [row.get("net_total") for row in data]

    return {
        "data": {
            "labels": labels[:10],
            "datasets": [
                {
                    "name": "Net Amount",
                    "values": dataset_values[:10]
                }
            ]
        },
        "type": "bar",
        "colors": ["#4ec9b0"]
    }

def get_report_summary(data):
    if not data:
        return []

    total_net = sum(row.get("net_total") or 0.0 for row in data)

    return [
        {
            "value": total_net,
            "indicator": "Blue",
            "label": _("Total Net Amount"),
            "datatype": "Currency"
        }
    ]
