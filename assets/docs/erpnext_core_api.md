# ERPNext Customization & Core Transactional APIs

This reference guide covers the standard Python API patterns, helper functions, and transaction factories in ERPNext. Use these in custom apps (like overrides or hooks) to interact with ERPNext's sales, purchasing, inventory, and accounting flows.

---

## 1. Transaction Factories (Mapping & Copying Docs)
ERPNext utilizes modular "make" methods to copy details from one document type to another (e.g. creating an Invoice from an Order).

### Creating a Payment Entry from an Invoice/Order
Use `erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry`:
```python
from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

# Create a draft Payment Entry for Sales Invoice "SINV-2026-0001"
pe = get_payment_entry(
    dt="Sales Invoice",
    dn="SINV-2026-0001",
    party_amount=1500.0,
    bank_account="HDFC - Company Bank Account",
    payment_type="Receive"
)
pe.reference_no = "CHQ998273"
pe.reference_date = "2026-07-12"
pe.insert()
pe.submit()
```

### Creating Sales Invoice from Sales Order
```python
from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice

# Generate a draft Sales Invoice from Sales Order "SO-2026-0004"
invoice = make_sales_invoice("SO-2026-0004")
invoice.posting_date = "2026-07-12"
invoice.insert()
```

### Creating Delivery Note from Sales Order
```python
from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note

dn = make_delivery_note("SO-2026-0004")
dn.insert()
```

---

## 2. Master Data Lookup & Helpers
Never lookup pricing, accounts, or addresses manually. Use ERPNext's optimized helper methods.

### Getting Customer or Supplier Defaults (`get_party_details`)
Fetches default billing details, default receivable/payable accounts, currency, price list, and tax templates.
```python
from erpnext.accounts.party import get_party_details

details = get_party_details(
    party="Customer-001",
    party_type="Customer",
    company="Ace Advisory",
    posting_date="2026-07-12"
)
# Returns a dictionary:
# {
#   "receivable_account": "Debtors - AA",
#   "price_list": "Standard Selling",
#   "currency": "BDT",
#   "supplier_group": None, ...
# }
```

### Getting Item Details (`get_item_details`)
Retrieves default rates, UOMs, valuation rates, tax templates, expense/income accounts, and warehouse details for a specific item.
```python
from erpnext.stock.get_item_details import get_item_details

item_info = get_item_details({
    "item_code": "TAX-SVC-01",
    "customer": "Customer-001",
    "qty": 5,
    "company": "Ace Advisory",
    "price_list": "Standard Selling",
    "posting_date": "2026-07-12"
})
# Returns a dictionary containing standard rate, warehouse, and income_account
```

---

## 3. General Ledger (GL) & Accounting Entries
When custom sub-ledgers or custom accounting calculations are submitted, you may need to post direct entries to the General Ledger.

### Posting GL Entries
GL entries are created by passing a list of dictionaries to `make_gl_entries`:
```python
from erpnext.accounts.general_ledger import make_gl_entries

gl_map = [
    {
        "account": "Debtors - AA",
        "party_type": "Customer",
        "party": "Customer-001",
        "debit": 1000.0,
        "credit": 0.0,
        "voucher_type": "Journal Entry",
        "voucher_no": "JV-0001",
        "posting_date": "2026-07-12",
        "company": "Ace Advisory",
        "cost_center": "Main - AA"
    },
    {
        "account": "Service Revenue - AA",
        "debit": 0.0,
        "credit": 1000.0,
        "voucher_type": "Journal Entry",
        "voucher_no": "JV-0001",
        "posting_date": "2026-07-12",
        "company": "Ace Advisory",
        "cost_center": "Main - AA"
    }
]

# Write and post to GL
make_gl_entries(gl_map, cancel=False)
```

### Reversing GL Entries (On Cancel)
```python
from erpnext.accounts.general_ledger import make_reverse_gl_entries

make_reverse_gl_entries(voucher_type="Journal Entry", voucher_no="JV-0001")
```

---

## 4. Multi-Currency exchange Rates
```python
from erpnext.setup.utils import get_exchange_rate

# Get exchange rate between USD and BDT for a specific date
rate = get_exchange_rate(
    from_currency="USD",
    to_currency="BDT",
    transaction_date="2026-07-12",
    company="Ace Advisory"
)
```
