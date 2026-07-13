# Frappe Client-Side Javascript API Reference

## 1. Document Page Lifecycle Events
Client Scripts are loaded when a DocType form page opens in the browser. Register event callbacks inside `frappe.ui.form.on`.

```javascript
frappe.ui.form.on('Sales Invoice', {
    onload: function(frm) {
        // Triggered when form is initialized (before data is loaded)
    },
    
    setup: function(frm) {
        // Triggered immediately during initialization
    },
    
    refresh: function(frm) {
        // Triggered when document is loaded, saved, or state changes (use for UI alterations)
        if (frm.doc.docstatus === 1) {
            frm.add_custom_button(__('Check Tax'), function() {
                frappe.msgprint("Button clicked!");
            });
        }
    },
    
    validate: function(frm) {
        // Triggered before saving. Return false to abort the save.
        if (frm.doc.grand_total < 0) {
            frappe.msgprint(__('Grand Total cannot be negative!'));
            return false;
        }
    },
    
    before_save: function(frm) {
        // Triggered immediately before data gets pushed to server
    },
    
    after_save: function(frm) {
        // Triggered after saving successfully
    }
});
```

---

## 2. Field Change Listeners
Trigger code when a specific field value is modified by the user.

```javascript
frappe.ui.form.on('Sales Invoice', {
    customer: function(frm) {
        // Triggered when the 'customer' field changes
        if (frm.doc.customer) {
            frm.set_value('remarks', 'Selected customer: ' + frm.doc.customer);
        }
    }
});
```

For child tables, the change listener resides inside the parent controller but maps to the child doctype name:
```javascript
frappe.ui.form.on('Sales Invoice Item', {
    qty: function(frm, cdt, cdn) {
        // cdt: Child DocType, cdn: Child Document Name (unique identifier)
        var row = locals[cdt][cdn];
        if (row.qty > 100) {
            frappe.model.set_value(cdt, cdn, 'discount_percentage', 10);
            frappe.msgprint(__('Bulk discount of 10% applied!'));
        }
    }
});
```

---

## 3. Manipulating Fields (UI Control)
Standard commands to show, hide, enable, or disable form fields.

### Read / Write Values
```javascript
// Get value
let customer = frm.doc.customer;

// Set value
frm.set_value('credit_days', 30);
```

### Toggle Field Settings
```javascript
// Hide a field
frm.toggle_display('discount_amount', false);

// Make a field read-only
frm.toggle_enable('posting_date', false);

// Make a field mandatory
frm.toggle_reqd('billing_address', true);
```

### Apply Field Property Updates
Set properties like description, labels, or query options:
```javascript
frm.set_df_property('posting_time', 'read_only', 1);
```

---

## 4. Server Calls (`frappe.call`)
Communicate with whitelisted server-side Python methods from Javascript.

```javascript
frappe.call({
    method: 'ace_advisory.api.get_tax_rate',
    args: {
        item_code: frm.doc.items[0].item_code,
        customer: frm.doc.customer
    },
    freeze: true, // Display a loading spinner to block screen
    freeze_message: __('Calculating rates...'),
    callback: function(r) {
        if (r.message) {
            frm.set_value('custom_tax_rate', r.message.rate);
            frm.refresh_field('custom_tax_rate');
        }
    }
});
```

---

## 5. UI Dialog API
Generate modular pop-up dialog forms dynamically.

```javascript
let d = new frappe.ui.Dialog({
    title: __('Enter Tax Reference'),
    fields: [
        {
            label: __('Reference ID'),
            fieldname: 'ref_id',
            fieldtype: 'Data',
            reqd: 1
        },
        {
            label: __('Attachment Date'),
            fieldname: 'attach_date',
            fieldtype: 'Date',
            default: frappe.datetime.get_today()
        }
    ],
    primary_action_label: __('Save'),
    primary_action(values) {
        frm.set_value('tax_reference_id', values.ref_id);
        frm.set_value('tax_reference_date', values.attach_date);
        d.hide();
    }
});
d.show();
```
