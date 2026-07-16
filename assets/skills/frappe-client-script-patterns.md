<!-- name: Client Script Patterns -->
<!-- description: frm.set_value/set_df_property/add_custom_button and frappe.call conventions, plus common client-script gotchas. -->

## Client Script Patterns

### Where client scripts live
Either a `<doctype_name>.js` file next to the DocType's controller (ships with the app, version-controlled), or a standalone **Client Script** DocType record (workspace-editable, no deploy needed). Check which pattern the app already uses via `grep_search` before adding a new one — mixing both for the same DocType gets confusing fast.

### Core form API
```javascript
frappe.ui.form.on('Loyalty Point Entry', {
    refresh(frm) {
        if (!frm.is_new() && frm.doc.docstatus === 0) {
            frm.add_custom_button('Award Points', () => {
                frappe.call({
                    method: 'myapp.myapp.api.award_points',
                    args: { customer: frm.doc.customer, points: frm.doc.points },
                    callback(r) {
                        if (!r.exc) frm.reload_doc();
                    }
                });
            });
        }
    },

    customer(frm) {
        // fires when the `customer` field changes
        frm.set_value('customer_name', '');  // clear dependent field
        if (frm.doc.customer) {
            frm.set_df_property('points', 'read_only', 0);
        }
    },

    validate(frm) {
        if (frm.doc.points < 0) {
            frappe.throw('Points cannot be negative');
        }
    }
});
```

### Common gotchas
- `frm.set_value(field, value)` triggers the field's own change handler and marks the form dirty — don't set a value inside that same field's own handler without a guard, or you can loop.
- `frm.doc.field = value` sets the value silently (no change event, no dirty flag) — only use this when you deliberately don't want side effects, e.g. inside a `refresh` handler adjusting display state.
- Child table rows: use `frm.add_child('table_field', {...})` then `frm.refresh_field('table_field')` — mutating the array directly won't re-render.
- `frappe.call` runs async — never assume the callback has fired by the next line; chain follow-up logic inside the `callback`.

### Client-side validation is UX only
Anything checked in a `validate` client handler is a convenience, not security — the server-side `validate()` in the Python controller is what actually enforces the rule (a direct API call or a different client bypasses JS entirely). If you find validation that only exists client-side, flag it — don't assume it's covered.
