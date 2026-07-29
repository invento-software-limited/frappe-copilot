# Frappe/ERPNext Form View

## Structural note — read this first

A Frappe form is a single scrolling page, not a modal or wizard. Header = breadcrumb + status pill + toolbar, and the toolbar's *contents* depend on document state (new/unsaved vs. saved). Below the header sits a horizontal **tab bar** that switches which fields are visible without changing route. The body is a label-above-field grid split into 2–3 columns, with secondary content pushed into collapsible sub-sections. A saved (has a docname) document additionally grows a right-hand **document sidebar** that a brand-new unsaved form does not have.

## Page head (form)

```html
<div class="page-head">
  <div class="breadcrumb">
    <a>Invoicing</a> / <a>Sales Invoice</a> / <span class="title-text">Ajay</span>
    <span class="indicator-pill orange no-indicator-dot">Not Saved</span>
  </div>

  <!-- toolbar: NEW / unsaved doc -->
  <div class="page-actions">
    <button class="btn btn-default btn-sm dropdown-toggle">Get Items From <svg class="chev icon"><use href="#icon-select"/></svg></button>
    <button class="btn btn-primary btn-sm">Save</button>
  </div>

  <!-- toolbar: SAVED doc -->
  <div class="page-actions">
    <button class="btn btn-default btn-sm dropdown-toggle">View <svg class="chev icon"><use href="#icon-select"/></svg></button>
    <button class="btn btn-default btn-sm dropdown-toggle">Create <svg class="chev icon"><use href="#icon-select"/></svg></button>
    <button class="btn btn-default btn-sm icon-btn" title="Menu"><svg class="icon"><use href="#icon-dot-horizontal"/></svg></button>
    <button class="btn btn-primary btn-sm">Update</button>
  </div>
</div>
```

- Title text is the doctype's autoname placeholder before the first save (`New Sales Invoice`, plain black/bold) and the record's title-field value after (`Ajay`).
- `.indicator-pill.orange.no-indicator-dot` = "Not Saved" — inline right after the title, same pill component as list-row status, not a separate banner. It appears both on a brand-new doc and on a saved doc with unsaved edits.
- The primary `.btn-primary` button's **label** is the only thing that changes with state — `Save` (new) → `Update` (dirty, already saved) → `Submit`/`Amend` (submittable workflow docs) — its color and position never change.
- `View`/`Create` are themselves dropdown-toggle buttons (e.g. `View` → Print/PDF/Timeline; `Create` → linked-doctype quick-creates), styled identically to the List View's view-switcher/menu buttons (see `list-report-view.md`) — reuse the same `.btn-default.btn-sm` token pair so form and list toolbars visually match.

## Tab bar

```html
<div class="form-tabs-list">
  <ul class="nav nav-tabs" role="tablist">
    <li class="nav-item"><a class="nav-link active" data-toggle="tab">Details</a></li>
    <li class="nav-item"><a class="nav-link" data-toggle="tab">Export LC</a></li>
    <li class="nav-item"><a class="nav-link" data-toggle="tab">Payments</a></li>
    <li class="nav-item"><a class="nav-link" data-toggle="tab">Address &amp; Contact</a></li>
    <li class="nav-item"><a class="nav-link" data-toggle="tab">Terms</a></li>
    <li class="nav-item"><a class="nav-link" data-toggle="tab">More Info</a></li>
    <li class="nav-item"><a class="nav-link" data-toggle="tab">Connections</a></li>
  </ul>
</div>
```

- Plain text tabs, `13px/500`, `padding: 10px 2px`, `margin-right: 24px` — no pill or card chrome.
- Active: `color: var(--heading-color)`, `border-bottom: 2px solid var(--gray-900)` (`var(--gray-300)` in dark mode). Inactive: `color: var(--text-muted)`, no border. The tab bar itself carries a 1px `var(--border-color)` bottom rule the active tab's border sits flush against.
- Tabs are **conditional**, not a fixed set: `Export LC` only appears when `Sales Type = Export`; `Connections` only appears once the document has been saved (nothing to link to before it has a docname). Don't hardcode a tab list — derive it from doctype config + current field values + save-state.

## Field grid

Ground truth from the real `frappe/form/section.js` + `frappe/form/column.js` — Frappe forms are **Bootstrap grid**, not CSS Grid. Each `.form-section` holds one `.section-body`, whose direct `.form-column` children each get a JS-computed `col-sm-{12/n}` class (3 columns → `col-sm-4`, 2 → `col-sm-6`; a 5-column section is special-cased to `col-sm-20`, i.e. it deliberately overflows rather than dividing evenly), recomputed live whenever a field's visibility changes.

```html
<div class="form-section" data-fieldname="details_section">
  <div class="section-body">
    <div class="form-column col-sm-4" data-fieldname="col_break1">
      <form>
        <div class="frappe-control" data-fieldtype="Link" data-fieldname="company">
          <label class="control-label">Company <span class="text-danger">*</span></label>
          <div class="control-input-wrapper">
            <div class="input-with-feedback form-control bold">Pran-RFL Group (Demo)</div>
          </div>
        </div>
        <!-- Series, Invoice Type, Sales Type, Customer, Vehicle, Vehicle Number, Vehicle Type... -->
      </form>
    </div>
    <div class="form-column col-sm-4"><form><!-- Date, Posting Time, Edit Posting Date and Time, Payment Due Date, Export LC, LC Number --></form></div>
    <div class="form-column col-sm-4"><form><!-- standalone checkbox fields --></form></div>
  </div>
</div>
```

- Each `.form-column` wraps its fields in a real `<form onsubmit="return false">` — every column is its own tiny form element, not a plain div.
- `col-sm-{n}` is **recomputed at runtime** (`resize_all_columns()`) whenever a field's visibility changes — a prototype should redistribute remaining columns' widths when a conditional field's column hides, not leave a gap.
- One `<label class="control-label">` **above** its input, `13px/500`; a required field appends a plain `<span class="text-danger">*</span>` to the label text — not a separate column or icon.
- Control box: 30px tall, `background: var(--control-bg)`, `border: 1px solid var(--border-color)`, `border-radius: var(--border-radius-sm)`, `padding: var(--input-padding)` (6px 8px).
- A field that already has a value renders it **bold** (`font-weight:500; color:var(--heading-color)`) inside that same gray box — bold is how Frappe marks "filled", it isn't a different input style. Empty fields show the plain gray box with a lighter placeholder.
- Select-shaped fields (Series, Invoice Type, Sales Type) are the same control box plus a trailing right-aligned `#icon-select` chevron.
- Checkbox fields (`Include Payment (POS)`, `Is Return (Credit Note)`, …) break the stacked label/input pattern: `display:flex; align-items:flex-start; gap:8px`, checkbox first, bold inline label after, with an optional `.text-muted` helper line wrapping underneath at `12px/1.4` (e.g. "Issue a debit note with 0 qty against an existing Sales Invoice").
- Being Bootstrap `col-sm-*`, the grid collapses to full-width stacked columns below the `sm` breakpoint automatically — no bespoke media query needed, unlike the widget grids in `widgets-charts.md` which are hand-rolled CSS Grid.

## Collapsible sub-sections

Ground truth from `frappe/form/section.js`. Two real details worth preserving: the indicator class is `.collapse-indicator` (not a generic "chevron"), and the open/closed icon is an **asymmetric pair from two different icon sets**, not one icon rotated by CSS.

```html
<div class="form-section" data-fieldname="accounting_dimensions_section">
  <div class="section-head collapsible" tabindex="0">
    Accounting Dimensions
    <span class="collapse-indicator" tabindex="0">
      <svg class="icon icon-sm mb-1"><use href="#icon-chevron-right"/></svg> <!-- closed (Lucide) -->
      <!-- open state swaps to: <svg class="es-icon icon-sm mb-1"><use href="#es-line-down"/></svg> (Espresso) -->
    </span>
  </div>
  <div class="section-body hide"></div>
</div>
```

- Header row `13px/500`, `padding: 12px 0`, `border-top: 1px solid var(--border-color)`.
- The indicator **swaps symbols** on toggle rather than rotating one shape: closed → `icon-chevron-right` (Lucide, `.icon`); open → `es-line-down` (Espresso, `.es-icon`) — see `icons.md`. General dropdown-toggle chevrons elsewhere (view switcher, sort, filter) are unrelated and still use `icon-select`.
- Open/closed state persists in `localStorage` keyed by the section's `css_class + "-closed"` — a reload should remember which sections were collapsed.
- Secondary sections (`Accounting Dimensions`, `Currency and Price List`) default **closed**; the doctype's primary content section (`Items`) defaults **open** and has no chevron/collapse affordance of its own.

## Child table (grid field, e.g. Items)

```html
<div class="grid-body">
  <div class="grid-heading-row">
    No. · Item · Quantity · Rate (USD) * · Amount (USD) · Warehouse · Serial and Batch · Use Serial/Batch
    <svg class="icon icon-xs grid-settings"><use href="#icon-setting-gear"/></svg>
  </div>
  <div class="grid-row">
    <div class="data-row">
      1 · GT ProBook X15 Laptop · 100 · $4.17 · $417.00 · — · —
      <input type="checkbox" checked> <svg class="icon icon-xs edit-row"><use href="#icon-edit"/></svg>
    </div>
  </div>
</div>
```

- `.grid-heading-row` background `var(--subtle-fg)`, same header treatment as the Report View's DataTable header (`list-report-view.md`) — child tables and report tables should look like the same component.
- Row height ~35px; numeric columns (`Quantity`, `Rate`, `Amount`) are right-aligned with `font-variant-numeric: tabular-nums`.
- Trailing header cell is a gear icon (`#icon-setting-gear`) opening the grid's column picker/settings — it isn't a real data column.
- Each row's trailing pencil (`.edit-row`) opens that row in an expanded quick-entry form. In real Frappe it only appears on row hover; in a **static prototype always render it** rather than hiding the only way to open a row.

## Document sidebar (saved documents only)

```html
<aside class="form-sidebar">
  <div class="sidebar-title-row">
    <h4>Ajay</h4>
    <svg class="icon icon-md like-icon"><use href="#icon-heart"/></svg>
  </div>
  <div class="doc-name text-muted">ACC-SINV-2026-18419</div>
  <ul class="sidebar-menu">
    <li><svg class="icon icon-sm"><use href="#icon-assign"/></svg>Assign<span class="pull-right">+</span></li>
    <li><svg class="icon icon-sm"><use href="#icon-attachment"/></svg>Attachments<span class="pull-right">+</span></li>
    <li><svg class="icon icon-sm"><use href="#icon-tag"/></svg>Tags<span class="pull-right">+</span></li>
    <li><svg class="icon icon-sm"><use href="#icon-share"/></svg>Share<span class="pull-right">+</span></li>
  </ul>
  <div class="text-muted small">Last Edited by Abdullah Al Munim<br>3w</div>
  <div class="text-muted small">Created By Abdullah Al Munim<br>3w</div>
</aside>
```

- Only renders once a document has a docname (i.e. has been saved at least once) — a brand-new unsaved form has **no sidebar**, the field grid runs full width instead. Don't render an empty/placeholder sidebar on the new-doc state; omit the column entirely.
- Each `.sidebar-menu` row: icon + label + trailing `+` affordance, `padding: 6px 0`, hover `background: var(--highlight-color)`.
- The heart beside the title reuses the exact like/heart component from the list row (`list-report-view.md`): unliked → `#icon-heart` (outline, Lucide); liked → parent gains `.liked`, icon swaps to `#icon-heart-active` (filled, Timeless) at `var(--invert-neutral)` — **grayscale, not red** (see `icons.md`).
- Audit lines (`Last Edited by` / `Created By`) are two-line stacked, `12px`, `var(--text-muted)`: name on line one, relative time on line two.

## Form-level "…" menu (distinct from the List View menu)

```html
<ul class="dropdown-menu dropdown-menu-right">
  <li><a class="dropdown-item">Toggle Sidebar</a></li>
  <li><a class="dropdown-item">Reload</a></li>
  <li><a class="dropdown-item">Duplicate<kbd class="pull-right">⇧+D</kbd></a></li>
  <li><a class="dropdown-item">New Sales Invoice<kbd class="pull-right">Ctrl+B</kbd></a></li>
  <li class="dropdown-divider"></li>
  <li><a class="dropdown-item">Jump to field<kbd class="pull-right">Ctrl+J</kbd></a></li>
  <li><a class="dropdown-item">Show Links</a></li>
  <li><a class="dropdown-item">Copy to Clipboard</a></li>
  <li><a class="dropdown-item">Remind Me<kbd class="pull-right">⇧+R</kbd></a></li>
  <li><a class="dropdown-item">Undo<kbd class="pull-right">Ctrl+Z</kbd></a></li>
  <li><a class="dropdown-item">Redo<kbd class="pull-right">Ctrl+Y</kbd></a></li>
  <li class="dropdown-divider"></li>
  <li><a class="dropdown-item">Customize</a></li>
  <li><a class="dropdown-item">Edit DocType</a></li>
</ul>
```

- Same popover chrome as the List View menu (`var(--popover-bg)`, `var(--shadow-md)`, item padding `6px 12px`, hover `var(--highlight-color)`) — but a **different item set**. Don't reuse List View's Import/Permissions/List Settings items here, and don't reuse this doc-action set on the List View menu.
- Grouped by two dividers into three clusters: document actions (Toggle Sidebar, Reload, Duplicate, New {Doctype}) → navigation/editing (Jump to field, Show Links, Copy to Clipboard, Remind Me, Undo, Redo) → developer actions (Customize, Edit DocType).
- Right-aligned `<kbd>` only appears on items that actually have a shortcut; items without one (`Reload`, `Show Links`, `Copy to Clipboard`, `Customize`, `Edit DocType`) render no trailing element.

### Component recipe (minimal clone)

```html
<div class="form-column-container" style="display:grid;grid-template-columns:1fr 1fr;gap:0 32px;max-width:700px">
  <div>
    <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">Company <span style="color:var(--red-500)">*</span></label>
    <div style="height:30px;display:flex;align-items:center;padding:0 8px;background:var(--control-bg);border:1px solid var(--border-color);border-radius:8px;font-weight:500">Pran-RFL Group (Demo)</div>
  </div>
</div>
```
