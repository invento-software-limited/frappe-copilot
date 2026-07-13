# Standard DocType Python Controller Boilerplate
# File Path: apps/[app]/[module]/doctype/[doctype]/[doctype].py

import frappe
from frappe.model.document import Document
from frappe import _

class {{DocTypeClass}}(Document):
    def before_insert(self):
        # Triggered before record is inserted into database
        pass

    def validate(self):
        # Triggered before every save/insert. Perfect for validations and calculations.
        self.validate_mandatory_fields()

    def before_save(self):
        # Triggered before record is saved to DB
        pass

    def on_update(self):
        # Triggered after document is written to database (post-save)
        pass

    def on_submit(self):
        # Triggered after document status changes to 1 (Submitted)
        pass

    def on_cancel(self):
        # Triggered after document status changes to 2 (Cancelled)
        pass

    def validate_mandatory_fields(self):
        # Custom logic goes here
        pass
