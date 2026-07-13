// Standard DocType Client Script Boilerplate
// File Path: apps/[app]/[module]/doctype/[doctype]/[doctype].js

frappe.ui.form.on('{{DocType}}', {
    onload: function(frm) {
        // Triggered when form is initialized (before data is loaded)
    },
    
    setup: function(frm) {
        // Triggered immediately during initialization
    },
    
    refresh: function(frm) {
        // Triggered when document is loaded, saved, or state changes (use for UI alterations)
        if (frm.doc.docstatus === 1) {
            frm.add_custom_button(__('Custom Action'), function() {
                frappe.msgprint("Button clicked!");
            });
        }
    },
    
    validate: function(frm) {
        // Triggered before saving. Return false to abort the save.
    },
    
    before_save: function(frm) {
        // Triggered immediately before data gets pushed to server
    },
    
    after_save: function(frm) {
        // Triggered after saving successfully
    }
});
