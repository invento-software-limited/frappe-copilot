# Programmatic Code & Scaffold Generation in Frappe

This guide details how to leverage Frappe's internal module builders via the `bench execute` CLI to programmatically generate standard folders, configurations, and boilerplate scripts. 

Always use these commands to scaffold new components before modifying them.

---

## 1. Prerequisites: Developer Mode
For Frappe to write scaffolding files to the disk upon object creation, the active site must have **Developer Mode** enabled:

Ensure `site_config.json` has:
```json
{
  "developer_mode": 1
}
```

---

## 2. Scaffolding DocTypes Programmatically
Instead of writing DocType folders and JSON files from scratch, run a Python execution script that inserts the DocType object into the database. Frappe will automatically create the folder structure and boilerplates on disk.

### Command Execution:
```bash
bench --site [site_name] execute frappe.model.meta.create_new_doc --args '{"doctype": "DocType", "name": "Custom Certificate", "module": "Accounts", "custom": 0, "fields": [{"fieldname": "certificate_no", "fieldtype": "Data", "label": "Certificate No", "reqd": 1}]}'
```

### Alternatively, using standard `bench execute` with a python snippet:
```bash
bench --site [site_name] execute --command "
import frappe
doc = frappe.get_doc({
    'doctype': 'DocType',
    'name': 'Custom Certificate',
    'module': 'Accounts',
    'custom': 0,  # 0 makes it standard, creating files on disk
    'autoname': 'field:certificate_no',
    'fields': [
        {'fieldname': 'certificate_no', 'fieldtype': 'Data', 'label': 'Certificate No', 'reqd': 1},
        {'fieldname': 'issue_date', 'fieldtype': 'Date', 'label': 'Issue Date', 'in_list_view': 1}
    ]
})
doc.insert()
frappe.db.commit()
"
```

### Generated Artifacts:
The above command automatically scaffolds the following files inside `apps/[app]/[module]/doctype/custom_certificate/`:
* `custom_certificate.json` (DocType definition schema)
* `custom_certificate.py` (Server-side Python controller class)
* `custom_certificate.js` (Client-side Form scripts template)
* `test_custom_certificate.py` (Unit testing template)

---

## 3. Scaffolding Reports Programmatically
Similarly, standard script reports should be initialized programmatically so Frappe handles folder routing and template generation.

### Command Execution:
```bash
bench --site [site_name] execute --command "
import frappe
doc = frappe.get_doc({
    'doctype': 'Report',
    'report_name': 'Sales Tax Register',
    'report_type': 'Script Report',
    'ref_doctype': 'Sales Invoice',
    'module': 'Accounts',
    'is_standard': 'Yes',
    'roles': [{'role': 'System Manager'}, {'role': 'Accounts User'}]
})
doc.insert()
frappe.db.commit()
"
```

### Generated Artifacts:
This writes files inside `apps/[app]/[module]/report/sales_tax_register/`:
* `sales_tax_register.json` (Report configuration schema)
* `sales_tax_register.py` (Script report execute script template)
* `sales_tax_register.js` (Client-side report filters script template)

---

## 4. Post-Generation Workflow
Once the templates are generated on the filesystem:
1. **Modify Boilerplates**: Use file editing tools to populate controller actions inside `[name].py` and form behaviors in `[name].js`.
2. **Apply Changes**: Run migration to rebuild index maps and apply DB column alterations:
   ```bash
   bench --site [site_name] migrate
   bench --site [site_name] clear-cache
   ```
