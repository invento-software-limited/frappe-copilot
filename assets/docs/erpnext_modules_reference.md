# ERPNext Modules Developer Reference

This document serves as an expert developer-level domain reference for the core modules of ERPNext. Use it to implement programmatic document generation, mapping/conversion pipelines, ledger reporting, and integrations.

---

## 1. Accounts (Accounting) Module

The Accounts module is built around a double-entry bookkeeping ledger. All financial transactions eventually generate postings to the General Ledger (`GL Entry`) and the Payment Ledger (`Payment Ledger Entry`).

### Core DocTypes
* **Company**: The fundamental root for financial reporting, currency, and default accounts.
* **Account**: Chart of Accounts nodes (assets, liabilities, equity, income, expense).
* **Journal Entry (JE)**: Manual multi-account adjustments. Must balance total debits and credits.
* **Payment Entry**: Document capturing cash/bank inputs or outputs against invoices or general ledger accounts.
* **Sales Invoice & Purchase Invoice**: Document representing itemized sales and purchases, generating account receivables and payables respectively.

### Programmatic Invoice Creation
When generating a `Sales Invoice` programmatically, you must specify the customer, company, posting date, and an array of items with correct income accounts.
```python
import frappe

def create_sales_invoice(customer, item_code, qty, rate, income_account=None):
    invoice = frappe.get_doc({
        "doctype": "Sales Invoice",
        "company": "Your Company",
        "customer": customer,
        "posting_date": frappe.utils.today(),
        "items": [{
            "item_code": item_code,
            "qty": qty,
            "rate": rate,
            "income_account": income_account or "Sales - YC"
        }]
    })
    invoice.insert()
    invoice.submit() # Generates GL Entries: Debits Debtors, Credits Income Account
    return invoice
```

### Invoices and Payments Linking (Payment Entry API)
To create a payment against a specific invoice, use ERPNext's built-in `get_payment_entry` method rather than constructing the payment document manually:
```python
from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

def pay_invoice(invoice_name, paid_amount, bank_account):
    # Returns a drafted Payment Entry linked to the Sales Invoice
    pe = get_payment_entry(
        dt="Sales Invoice",
        dn=invoice_name,
        party_amount=paid_amount,
        bank_account=bank_account
    )
    pe.posting_date = frappe.utils.today()
    pe.reference_no = "REF-12345"
    pe.reference_date = frappe.utils.today()
    pe.insert()
    pe.submit()
    return pe
```

---

## 2. Stock (Inventory) Module

The Stock module manages physical inventory levels, warehouses, stock valuations, and item tracking. Every stock movement generates `Stock Ledger Entry` (SLE) records.

### Core DocTypes
* **Item**: Master representing products, services, raw materials, or finished goods.
* **Warehouse**: Physical or virtual locations where items are stored.
* **Stock Entry**: Document for physical material movements (Material Transfer, Material Issue, Material Receipt, Manufacture).
* **Purchase Receipt & Delivery Note**: Documents tracking items received from suppliers or delivered to customers.

### Programmatic Stock Balance Query
To retrieve the current inventory balance or valuation for an item, use the standard utilities:
```python
from erpnext.stock.utils import get_stock_balance

# Returns the current quantity balance of an item in a specific warehouse
qty_balance = get_stock_balance(
    item_code="ITEM-001",
    warehouse="Finished Goods - YC",
    posting_date=frappe.utils.today()
)
```

### Material Receipt Stock Entry
Creating a Stock Entry to manually receive inventory:
```python
def receive_material(item_code, qty, rate, target_warehouse):
    se = frappe.get_doc({
        "doctype": "Stock Entry",
        "purpose": "Material Receipt",
        "company": "Your Company",
        "posting_date": frappe.utils.today(),
        "items": [{
            "item_code": item_code,
            "qty": qty,
            "t_warehouse": target_warehouse, # Target warehouse is specified for receipts
            "valuation_rate": rate
        }]
    })
    se.insert()
    se.submit() # Generates Stock Ledger Entries and GL Entries (Debit Inventory, Credit Stock Adjustment Account)
    return se.name
```

---

## 3. Selling & Buying Modules

 These modules manage sales pipelines and procurement pipelines. Standard workflows flow from quotations to billing documents.

### Quotation-to-Cash Pipeline
$$\text{Quotation} \longrightarrow \text{Sales Order} \longrightarrow \text{Delivery Note} \longrightarrow \text{Sales Invoice} \longrightarrow \text{Payment Entry}$$

### Procurement (Procure-to-Pay) Pipeline
$$\text{Material Request} \longrightarrow \text{Purchase Order} \longrightarrow \text{Purchase Receipt} \longrightarrow \text{Purchase Invoice} \longrightarrow \text{Payment Entry}$$

### Document Mapping/Conversion APIs
ERPNext uses mapper functions to convert documents between states. Do not manually copy fields; use standard document builders:
```python
# 1. Convert Sales Order to Sales Invoice
from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice
sales_invoice = make_sales_invoice(sales_order_name)

# 2. Convert Sales Order to Delivery Note
from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note
delivery_note = make_delivery_note(sales_order_name)

# 3. Convert Purchase Order to Purchase Invoice
from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice
purchase_invoice = make_purchase_invoice(purchase_order_name)
```

---

## 4. Human Resources & Payroll Modules

HR and Payroll modules coordinate employee lifecycle documents, attendance tracking, leave balances, and salary payouts.

### Core DocTypes
* **Employee**: Core employee profile.
* **Attendance**: Single-day presence logs (Present, Absent, Half Day, On Leave).
* **Leave Application**: Leave requests linking leave types and balancing sheets.
* **Salary Structure**: Definition of earnings (Basic, HRA) and deductions (PF, Tax).
* **Salary Slip**: Document containing monthly payroll computations and bank disbursement mappings.

### Programmatic Attendance Marking
```python
def mark_attendance(employee, date, status="Present"):
    attendance = frappe.get_doc({
        "doctype": "Attendance",
        "employee": employee,
        "attendance_date": date,
        "status": status,
        "company": "Your Company"
    })
    attendance.insert()
    attendance.submit()
    return attendance.name
```

### Programmatic Payroll Processing
To generate Salary Slips for active structures:
```python
from erpnext.payroll.doctype.salary_slip.salary_slip import make_salary_slip

def generate_slip(employee, start_date, end_date):
    slip = make_salary_slip(
        source_name=employee,
        posting_date=frappe.utils.today(),
        start_date=start_date,
        end_date=end_date
    )
    slip.insert()
    # slip.submit() # Validates earnings and updates Salary Register
    return slip
```

---

## 5. Manufacturing Module

The Manufacturing module coordinates Bill of Materials (BOM) creation, workstation capacities, routing schedules, and shop-floor execution logs.

### Core DocTypes
* **BOM (Bill of Materials)**: Static recipe linking raw materials, operations, routing, and scrap item parameters to produce a single item.
* **Work Order**: Authorization to manufacture a specified quantity of a BOM item.
* **Job Card**: Detailed operation instruction assigned to a Workstation. Work Order automatically generates Job Cards.
* **Workstation**: Physical or virtual location where manufacturing operations are performed.

### Bill of Materials Cost Calculations
ERPNext calculates cost rollups recursively. Operation costs are derived from Workstation operational costs per hour, operational timings, and raw material purchase histories.

### Programmatic Work Order Lifecycle
1. **Create Work Order**:
   ```python
   def create_work_order(item_code, qty, bom_no, warehouse):
       wo = frappe.get_doc({
           "doctype": "Work Order",
           "company": "Your Company",
           "production_item": item_code,
           "bom_no": bom_no,
           "qty": qty,
           "wip_warehouse": "Work In Progress - YC",
           "fg_warehouse": warehouse,
           "planned_start_date": frappe.utils.today()
       })
       wo.insert()
       wo.submit() # Generates Job Cards
       return wo.name
   ```
2. **Issue Materials & Finish Goods**:
   After job cards are updated/completed, materials are issued to WIP warehouse, and finished goods are completed using `Stock Entry` (Manufacture):
   ```python
   from erpnext.manufacturing.doctype.work_order.work_order import make_stock_entry
   
   # Generates Stock Entry of type "Manufacture" (consumes raw materials, adds finished product)
   se = make_stock_entry(work_order_name, "Manufacture", qty=1)
   se.insert()
   se.submit()
   ```
