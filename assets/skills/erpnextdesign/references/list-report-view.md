# Frappe/ERPNext List View, Report View & List Sidebar

## List View

### List page chrome, top to bottom (v16 ground truth — reproduce this exactly)

A real list page stacks, in this order: ① breadcrumb row (home **icon** + doctype title) with the action cluster right-aligned in the same row; ② the standard-filter toolbar; ③ the list header row (column labels + **record count + liked-by-me heart**); ④ rows; ⑤ paging footer. Misplacing any of these — count in the toolbar, missing view switcher, text-only breadcrumbs — is an instantly visible fidelity miss. All markup below is transcribed from frappe 16.18.3 source (`views/breadcrumbs.js`, `list/base_list.js`, `list/list_view.js`, `ui/sort_selector.html`), not reconstructed.

#### ① Breadcrumb row

```html
<ul class="nav navbar-breadcrumbs">
  <li><a href="/desk"><svg class="icon icon-md"><use href="#icon-home"></use></svg></a></li>
  <li><a href="/app/release">Release</a></li>
</ul>
```

- The **first crumb is always a home icon** — `breadcrumbs.js` `clear()` literally runs `append_breadcrumb_element("/desk", frappe.utils.icon("home"))` before anything else. Render `#icon-home` (Timeless, outline), never the text "Home".
- The `/` divider is CSS, not markup: every `a::before { content:"/" }` except the first crumb's — 14px, weight 420, `color: var(--ink-gray-4)` (≈ `--gray-500`), `margin: 0 6px`.
- Crumb links: `--text-lg` (16px), `font-weight: 500`, `color: var(--ink-gray-5)` (muted), hover `--ink-gray-7`, no underline.
- The **last crumb is the page title** — same 16px/500 but `color: var(--ink-gray-9)` (heading color). There is no separate `<h1>`; don't add one.
- A workspace crumb may sit between home and the doctype (`⌂ / CRM / Customer`), but the home icon comes first, always.

#### ② Action cluster (right side of the breadcrumb row), left → right

1. `List View ⌄` view switcher — `.inner-group-button` (`.btn.btn-default.ellipsis` + trailing `#icon-select` chevron at `.icon-xs`).
2. `Saved Filters ⌄` — the exact same `.inner-group-button` component, different label.
3. Refresh — square icon button `.btn.btn-default.icon-btn`, glyph `#es-line-reload` (`.es-icon.icon-sm`, **Espresso/filled** — not the Timeless outline `icon-refresh`).
4. `…` menu — `.btn.btn-default.icon-btn`, `#icon-dot-horizontal` (`.icon-sm`).
5. `+ Add {Doctype}` — `.btn.btn-primary.btn-sm` (near-black grayscale primary), leading `#icon-add` (`.icon-xs`, stroke `#fff`).

The raw `page.html` template ships `.custom-actions`/`.menu-btn-group`/`.primary-action` with `hide` classes, but on a **rendered desktop list page all five controls above are visible** — JS reveals them immediately. A prototype must render all five, in this order, every time. Only `.actions-btn-group` ("Actions ⌄") stays hidden until rows are bulk-selected.

#### ③ Standard-filter toolbar (`.page-form`)

Left = per-field quick filters; right = Filter button group + sort selector.

```html
<div class="page-form flex">
  <div class="standard-filter-section flex">
    <!-- free-text filter (ID/name): input wrapped in an input-group with a match-type operator button -->
    <div class="form-group frappe-control input-max-width">
      <div class="input-group">
        <input type="text" class="form-control input-sm" placeholder="ID">
        <div class="input-group-btn mr-0">
          <button class="btn btn-default match-type-dropdown-btn" data-toggle="dropdown">
            <svg class="icon icon-sm"><use href="#icon-equal-approximately"></use></svg>
          </button>
          <ul class="dropdown-menu match-type-dropdown-menu dropdown-menu-right">
            <li class="dropdown-item" data-match-type="=">Equals</li>
            <li class="dropdown-item" data-match-type="like">Like</li>
          </ul>
        </div>
      </div>
    </div>
    <!-- Link-field filter: plain text input (autocomplete-backed), no operator button -->
    <div class="form-group frappe-control input-max-width">
      <input type="text" class="form-control input-sm" placeholder="Product Project">
    </div>
    <!-- Select-field filter: NOT a native <select> — a control-styled trigger with a trailing #icon-select chevron -->
    <div class="form-group frappe-control input-max-width">
      <button class="form-control input-sm ellipsis" style="display:flex;align-items:center;justify-content:space-between;text-align:left">
        <span style="color:var(--text-light)">Status</span>
        <svg class="icon icon-xs"><use href="#icon-select"></use></svg>
      </button>
    </div>
  </div>
  <div class="filter-section flex">
    <div class="filter-selector">
      <div class="btn-group">
        <button class="btn btn-default btn-sm filter-button">
          <span class="filter-icon button-icon"><svg class="es-icon icon-sm"><use href="#es-line-filter"></use></svg></span>
          <span class="button-label hidden-xs">Filter</span>
        </button>
        <button class="btn btn-default btn-sm filter-x-button" title="Clear all filters">
          <span class="filter-icon button-icon"><svg class="es-icon icon-sm"><use href="#es-small-close"></use></svg></span>
        </button>
      </div>
    </div>
    <div class="sort-selector">
      <div class="btn-group">
        <button class="btn btn-default btn-sm btn-order" data-value="desc" title="ascending">
          <span class="sort-order"><svg class="icon icon-sm"><use href="#icon-sort-descending"></use></svg></span>
        </button>
        <button class="btn btn-default btn-sm sort-selector-button text-nowrap" data-toggle="dropdown">
          <span class="dropdown-text hidden-sm">Last Updated On</span>
          <span><svg class="icon icon-sm"><use href="#icon-chevron-down"></use></svg></span>
        </button>
      </div>
    </div>
  </div>
</div>
```

- The match-type button defaults to **`≈` (`#icon-equal-approximately`, i.e. "Like")** on free-text standard filters; choosing "Equals" swaps the glyph to `#icon-equal`. Only Data/text inputs get this attached button — Link and Select filters never do.
- **Never use a native `<select>` (or native date picker) anywhere in a Frappe prototype** — the OS-drawn dropdown arrow is one of the most visible "not Frappe" giveaways. Every select-shaped control is a styled trigger with the `#icon-select` up/down chevron on the right.
- Sort cluster = two `.btn-default.btn-sm` buttons sharing one `.btn-group`: direction toggle (`#icon-sort-descending` ⇄ `#icon-sort-ascending` swapped on click) + a field button showing the current sort field's label with a `#icon-chevron-down` chevron (Lucide — this one is NOT `icon-select`).
- Every control in this row is 28px tall and resolves to the same two tokens: bg `var(--control-bg)`/`var(--btn-default-bg)` (same gray by design), border `var(--border-color)`. Focused text inputs only: bg `var(--fg-color)`, border `var(--blue-500)`.

#### ④ Record count + "Liked by me" — in the list header row, NOT the toolbar

From `list_view.js get_header_html()` — the sticky header row's `.level-right` contains exactly:

```html
<div class="level-right">
  <span class="list-count">1 of 1</span>
  <span class="level-item list-liked-by-me hidden-xs">
    <span title="Liked by me"><svg class="icon icon-sm like-icon"><use href="#icon-heart"></use></svg></span>
  </span>
</div>
```

- `.list-count` ("{shown} of {total}") sits at the far right of the column-label header row, `var(--text-muted)`, 12–13px. It repeats in the paging footer next to "Load More" — it never appears in the filter toolbar.
- The heart beside it is the **"Liked by me" filter toggle**, outline `#icon-heart` by default; when active the wrapper gains `.liked` and the glyph swaps to filled `#icon-heart-active` (grayscale `var(--invert-neutral)`, never red).

### Row DOM (flexbox, NOT a `<table>`)

```html
<div class="list-row-container" tabindex="1">
  <div class="level list-row">
    <div class="level-left ellipsis">
      <div class="list-row-col ellipsis list-subject level">
        <span class="select-like"><input class="list-row-checkbox" type="checkbox"></span>
        <span class="level-item [seen|bold] ellipsis"><a href="...">Title</a></span>
      </div>
      <div class="list-row-col hidden-xs ellipsis">
        <!-- Select-field status columns render WITH the 6px dot (no `no-indicator-dot`);
             only get_indicator()-driven doc-status pills add `no-indicator-dot` — see "Badges / indicator pills" below -->
        <span class="indicator-pill {color} filterable ellipsis">
          <span class="ellipsis">Status Label</span>
        </span>
      </div>
      <div class="list-row-col tag-col hide hidden-xs ellipsis">
        <div class="tag-pill ellipsis" style="background-color:var(--bg-x);color:var(--text-on-x)">tag</div>
      </div>
      <!-- more .list-row-col per visible field -->
    </div>
    <div class="level-right text-muted ellipsis">
      <div class="level-item list-row-activity hidden-xs">
        <div class="list-assignments d-flex align-items-center"><!-- avatar group --></div>
        <span class="modified">2d</span>
        <span class="comment-count d-flex align-items-center"><!-- chat icon --> 3</span>
        <span class="mx-2">·</span>
        <span class="list-row-like hidden-xs"><!-- heart icon --></span>
      </div>
    </div>
  </div>
</div>
```

Header row = same skeleton with `.list-row-head`, plus a `.checkbox-actions` block that replaces the header subject when rows are selected, showing `"{n} items selected"` in `.list-header-meta`.

**Checkboxes are custom-drawn, never native** (verbatim from `scss/element/checkbox.scss` + `css_variables.scss`):

```css
input[type="checkbox"]{
  appearance:none; -webkit-appearance:none;
  width:14px; height:14px;               /* --checkbox-size; 18px on mobile */
  border:1px solid var(--gray-500); border-radius:4px;
  background-repeat:no-repeat; background-position:center;
}
input[type="checkbox"]:checked{
  border:none; background-color:var(--primary); background-size:57%;
  background-image:url("data:image/svg+xml, <svg viewBox='0 0 8 7' fill='none' xmlns='http://www.w3.org/2000/svg'><path d='M1 4.00001L2.66667 5.80001L7 1.20001' stroke='white' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
}
input[type="checkbox"]:focus{ outline:none; box-shadow:0 0 0 2px var(--gray-300); }
```

Non-pill status dot: `<span class="indicator {color}"></span>` (8px `::before` circle) — used on mobile.

### Layout mechanics & CSS styling

- `.level-left { flex: 4; min-width: 80%; }`, `.level-right { flex: 0 0 130–200px; position: sticky; right: 0; }` (width varies with assignee-avatar count).
- `.list-row-col { flex: 1; margin-right: 15px; color: var(--text-muted); }` — subject column `flex: 2`. The non-subject/non-link columns in a list row must use `color: var(--text-muted)` to bring the softness characteristic of the Frappe Desk style.
- Column pixel widths further computed in JS (`apply_column_widths`, ~text-length-based) and applied inline.
- `.result-container { overflow-x: auto }`; row width `fit-content; min-width: 100%`.
- `.list-row-head` (the header row wrapper) styling:
  ```css
  .list-row-head {
    position: sticky;
    top: 0;
    background: var(--subtle-fg);
    z-index: 2;
    padding-top: 5px;
    border-radius: 7px;
    padding-bottom: 5px;
  }
  ```
- `.page-form` (the filter/sort toolbar row) styling:
  ```css
  .page-form {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border-color);
    flex-wrap: wrap;
  }
  ```

### Page header actions (view switcher, saved filters, refresh, menu, primary action)

Ground truth transcribed from the real `frappe/public/js/frappe/ui/page.html` template + `page.js` (`add_inner_button`/`get_or_add_inner_group_button`) + `list_view_select.js` — not reconstructed from a screenshot. Sits in `.page-head .page-actions`, above the filter toolbar.

```html
<div class="align-center flex standard-items-section">
  <div class="flex col page-actions justify-content-end">
    <div class="filters flex"></div>

    <!-- .custom-actions is literally `this.inner_toolbar` — every add_inner_button()/
         View-switcher/Saved-Filters button below lives here, in DOM order added -->
    <div class="custom-actions hide hidden-xs hidden-md">
      <!-- View switcher ("List View ⌄") — an .inner-group-button, NOT a bespoke component -->
      <div class="inner-group-button" data-label="List%20View">
        <button type="button" class="btn btn-default ellipsis" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
          List View
          <svg class="icon icon-xs"><use href="#icon-select"></use></svg>
        </button>
        <div role="menu" class="dropdown-menu"><!-- Report / Kanban / Calendar / Gantt / ... --></div>
      </div>

      <!-- Saved Filters — the exact same .inner-group-button component, different label -->
      <div class="inner-group-button" data-label="Saved%20Filters">
        <button type="button" class="btn btn-default ellipsis" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
          Saved Filters
          <svg class="icon icon-xs"><use href="#icon-select"></use></svg>
        </button>
        <div role="menu" class="dropdown-menu dropdown-menu-right"><!-- saved filter list --></div>
      </div>
    </div>
    <div class="custom-mobile-actions"></div>

    <div class="standard-actions flex">
      <span class="page-icon-group hide hidden-xs hidden-sm"></span>
      <div class="menu-btn-group hide">
        <button type="button" class="btn btn-default icon-btn menu-more-button" data-toggle="dropdown" aria-label="Menu">
          <svg class="icon icon-sm"><use href="#icon-dot-horizontal"></use></svg>
        </button>
        <ul class="dropdown-menu dropdown-menu-right" role="menu">
          <li class="user-action"><a class="grey-link dropdown-item visible-xs" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="Refresh"><span><span class="alt-underline">R</span>efresh</span></span>
          </a></li>
          <li class="user-action hidden-xl"><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="Saved Filters &gt; Filters">Saved Filters &gt; Filters</span>
          </a></li>
          <li class="dropdown-divider user-action visible-xs"></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="Import"><span><span class="alt-underline">I</span>mport</span></span>
          </a></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="User Permissions"><span><span class="alt-underline">U</span>ser Permissions</span></span>
          </a></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="Role Permissions Manager"><span>R<span class="alt-underline">o</span>le Permissions Manager</span></span>
          </a></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label">Customize</span>
            <kbd class="pull-right"><span>Ctrl+Y</span></kbd>
          </a></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="Edit DocType"><span><span class="alt-underline">E</span>dit DocType</span></span>
          </a></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="Customize Quick Filters"><span><span class="alt-underline">C</span>ustomize Quick Filters</span></span>
          </a></li>
          <li><a class="grey-link dropdown-item" href="#" onclick="return false;">
            <span class="menu-item-label" data-label="List Settings"><span><span class="alt-underline">L</span>ist Settings</span></span>
          </a></li>
        </ul>
      </div>
      <!-- .actions-btn-group: the "Actions" split button, appears only once rows are bulk-selected -->
      <div class="actions-btn-group hide">
        <button type="button" class="btn btn-primary btn-sm justify-center" data-toggle="dropdown">
          <span class="hidden-xs actions-btn-group-label">Actions</span>
          <svg class="icon icon-xs"><use href="#icon-select"></use></svg>
        </button>
        <ul class="dropdown-menu dropdown-menu-right" role="menu"></ul>
      </div>
      <button class="btn btn-primary btn-sm hide primary-action">Add {Doctype}</button>
    </div>
  </div>
</div>
```

- View switcher and Saved Filters are **the same real component** (`.inner-group-button`, built by `page.get_or_add_inner_group_button()`), not a custom `.select-view` class — a labeled `.btn.btn-default.ellipsis` trigger plus trailing `#icon-select` chevron (see `icons.md`), next to a sibling `.dropdown-menu`.
- These live inside `.custom-actions` (== `this.inner_toolbar`), which sits *before* `.standard-actions` in DOM order — filters, then inner-group-buttons, then the icon-button cluster, then Actions/primary.
- `.page-icon-group`, `.menu-btn-group`, `.actions-btn-group`, and `.primary-action` all ship `hide` by default and are revealed by JS per-page/per-state — `.actions-btn-group` (the primary-styled "Actions ⌄" split button) only appears once rows are bulk-selected; don't render it in a prototype's idle list state.
- Menu contents are static per doctype: `Import`, `User Permissions`, `Role Permissions Manager`, `Customize` (`Ctrl+Y`), `Edit DocType`, `Customize Quick Filters`, `List Settings`, plus two **responsive-only** entries below the `xl`/mobile breakpoints: `Refresh` (`.visible-xs`) and `{Inner Group Label} > {item}` (`.hidden-xl`, one per collapsed inner-group-button — the real markup literally string-concatenates `"{group} > {label}"`).
- `.alt-underline` marks the access-key letter for each item — underline that single character, don't bold or recolor it.

### Toolbar (lives in the page header, not a sidebar)

- `.standard-filter-section.flex` — per-field standard filters + group-by dropdowns (Assigned To / Created By / Tags):
  ```html
  <div class="group-by-field list-link form-group frappe-control input-max-width">
    <a class="btn btn-default btn-sm flex justify-between list-sidebar-button w-100"
       data-toggle="dropdown" data-label="Assigned To">
      <span class="ellipsis">Assigned To</span><span><!-- chevron --></span>
    </a>
    <ul class="dropdown-menu group-by-dropdown">
      <div class="dropdown-search"><input class="dropdown-search-input form-control input-xs"></div>
      <div class="group-by-item selected" data-value="...">
        <a class="dropdown-item">
          <span class="applied"><!-- check icon --></span>
          <span class="group-by-value ellipsis">Me</span><span class="group-by-count">12</span>
        </a>
      </div>
    </ul>
  </div>
  ```
- `.filter-section.flex` → `.filter-selector .btn-group`: `button.filter-button` (`#es-line-filter` + "Filter" label + count pill) + `button.filter-x-button` (`#es-small-close`, clear all) — exact markup in "③ Standard-filter toolbar" above.
- `.sort-selector .btn-group`: `button.btn-order` (`#icon-sort-descending`/`#icon-sort-ascending` toggle) + `button.sort-selector-button` (current field label + `#icon-chevron-down`) — exact markup in ③ above.
- **Bulk action bar:** on selection, header subject swaps for `.checkbox-actions` ("{n} items selected"), and the page's Actions split-button appears with bulk edit/export/assign/tag/print/submit/cancel/delete.

### Colors & Sidebar styling

- `--border-color` (row divider), `--highlight-color` (hover/selected bg), `--subtle-fg` (header bg), `--bg-color`, `--card-bg`, `--text-color`, `--text-muted`, `--control-bg`, `--primary`. **No zebra striping** — only `:hover`/`:focus { background-color: var(--highlight-color) }`. `border-bottom: 1px solid var(--border-color)` per row.
- **Sidebar Background and Borders:** The left sidebar (`.body-sidebar`) must have a distinct background color, typically a warm, soft light grey (`#faf8f7` or `var(--gray-50)`), separated from the white main content area (`#ffffff`) by a 1px solid right border (`var(--border-color)`).
- **Active and Hover Sidebar Items:** Active items in the sidebar use a soft capsule background (`background: var(--sidebar-active-bg, #ececec); border-radius: 8px`) and darker, weight-500 text, while hover uses a lighter background (`#f2f0ef`).
- **Sidebar Folders and Nested Items:** Standard sections act as collapsible folders (header has a grey folder outline icon and `⌄` chevron on the right). Sub-items inside them are indented by 14px or 16px.

### Typography & spacing

- **Font Sizes:**
  - Standard buttons (`.btn`) & inputs (`.form-control`): `base/regular` (14px / weight 420).
  - List row columns (`.list-row-col`): `base/regular` (14px / weight 420).
  - List header columns (`.list-row-head .list-row-col`): `xs/medium` (12px / weight 500).
  - Row activity timestamps & comment counts (`.list-row-activity`): `xs/regular` (12px / weight 420).
- **Icon Sizing Rules:**
  - Filter icons, heart/like icons, reload icons, and chat/comment count icons in list rows use `icon-sm` (16px).
  - Inner button select icons / chevrons (e.g. Approximately `≈` or double chevron dropdown indicator) use `icon-xs` (12px).
- **Short Relative Timestamps:** Frappe never uses full relative time phrases like "1 week ago", "5 days ago", or "2 months ago" in list rows, timeline activities, sidebars, or comment cards. It strictly uses short abbreviations: `1w` (week), `5d` (days), `2d` (days), `1m` (month), `2m` (months), `1y` (year), `1h` (hour), `5m` (minutes), etc.
- Unseen docs: `.bold`; seen: `.seen` (weight toggle on subject).
- `.list-row-container { padding-inline: var(--padding-sm) }` (7px); `.level-left { padding: var(--padding-xs) 0 }` (5px); `.level-right { padding: 9px 10px }`; row height `--list-row-height: 30px`; column gutter 15px.

### Badges / indicator pills & dot values

- `indicator-pill {color}` where color ∈ `green, cyan, blue, orange, yellow, gray, grey, red, pink, darkgrey, purple, light-blue`. `background: var(--bg-{color})`, `color: var(--text-on-{color})`. Select-field values reuse this via `frappe.utils.guess_colour(value)` (deterministic hash → color).
- **Dot Values (Non-Status Select Columns):** Columns that represent other select categories (e.g. `Resource Type`, `Role Level`) do NOT get background pills. Instead, they render as plain text with a leading neutral gray dot (`● Value`). Only status fields (e.g. `Status` -> `● Available`) get the full pastel background capsule pill.
- Exact pill metrics (from `scss/common/indicator.scss`): height **20px**, `padding: 4.5px 8px`, `border-radius: var(--border-radius-full)`, text 13px/weight 420, `display: inline-flex; align-items: center`.

**Dot rules — two real variants, both appear in list rows:**
- Select-field column pills (`list_view.js:989`, via `guess_colour`) render **with** the leading dot: 6px circle via `::before`, `border-radius: 50%`, `margin-right: 6px`, `background: var(--indicator-dot-{color})` — this is the "● Active" style seen in a Status column.
- Doc-status/indicator pills from `get_indicator()` (`list_view.js:1373`) add `.no-indicator-dot` — text only, no dot.
- When unsure which a field is, a colored Select "Status" column gets the dot.

## Report View

Report view renders through **Frappe DataTable** — a real `<table>`, not the list-row flex markup.

### Structure

`.report-view .layout-main-section > .page-form (toolbar) + .frappe-list > .result-container > .datatable`. Row `.dt-row` (height 35px), cell `td.dt-cell`, header row `.dt-row-header` (bg `var(--subtle-fg)`), inline column-filter row `.dt-row-filter` (`.dt-filter.dt-input`). Bulk checkbox: `.report-action-checkbox .checkbox` (`margin-left: 10px`).

### Layout mechanics

Scrollable body: `.dt-scrollable { height: calc(100vh - 240px) }`. Column resize via DataTable's own `.dt-cell__resize-handle`. Page: `.layout-main-section { display:flex; flex-direction:column; height: calc(100vh - var(--page-head-height)) }`, `.frappe-list { flex-grow:1; overflow:hidden }`.

### Report-specific toolbar

- `.group-by-popover` (min-width 500px) — Group By builder (`.group-by-box`, `.remove-group-by`).
- `.group-by-icon.active` / `.filter-icon.active` → `--icon-stroke: var(--primary)`.
- `.list-count` — "{shown} of {total}" (`base/regular`).
- `.report-summary` — optional stat row: `.summary-item` (flex column, 160–300px wide, 62px tall), `.summary-label`, `.summary-value` (`--text-2xl` 20px / weight 600), color modifiers `.green/.red/.blue` → `var(--green-500|red-500|blue-500)`. `.summary-separator .summary-value` styled as a chip: `background: var(--card-bg); border: 1px solid var(--dark-border-color); border-radius: var(--border-radius-sm)`.
- `.report-footer { border-top: 1px solid var(--border-color) }`.
- Column picker: `.column-picker-dialog .column-list-item { padding: 10px; border-bottom: 1px solid var(--border-color) }`, drag handle `.sortable-handle`.

### DataTable CSS custom properties (`--dt-*`)

```
--dt-primary-color: var(--primary)
--dt-light-bg: var(--highlight-color)
--dt-cell-bg: var(--fg-color)
--dt-border-color: var(--table-border-color)
--dt-header-cell-bg: var(--subtle-fg)
--dt-selection-highlight-color: var(--highlight-color)
--dt-text-color: var(--text-muted)
```
Focused-cell border: `var(--gray-200)`. Total row: `.dt-row-totalRow { font-weight: bold }`. Numeric columns: `font-feature-settings: "tnum"` (tabular numerals).

## List Sidebar — deprecated in current builds

The classic per-doctype left sidebar (saved filters, "Assigned to Me", "Liked by Me", tag list) is effectively unused/dead code in current Frappe. The equivalent UI now lives **inline in the page toolbar** as the `group-by-field` dropdowns shown above, reusing the older sidebar CSS classes: `.list-sidebar-button { display:flex; justify-content:space-between; padding:4px 8px; color: var(--text-muted) }`; dropdown `{ max-height:300px; min-width:180px; font-size: var(--text-sm) }`; `.sidebar-action { color: var(--primary) }` (Edit Filters / Add links).

`.layout-side-section` (the true sidebar column) still exists structurally but is force-hidden for list/report routes: `.no-list-sidebar[data-page-route^="List/"] .layout-side-section { display:none }`.

**Design implication:** don't build a separate filter sidebar next to list/report tables — put saved-filter/group-by controls in the toolbar row above the table instead, matching current Frappe UX.

## Cross-cutting cheat sheet

- Row rhythm: ~30px min row height, 5–9px padding, 15px column gutter.
- Radius: buttons/pills 8px, pill shape `--border-radius-full`, small chips ~4px.
- Font stack: `"InterVariable","Inter",-apple-system,...`. Weights 420/500/600.
- Text scale: 12 / 13 / 14 / 16 / 20px.
- List View → flexbox `.level/.level-left/.level-right`. Report View → real `<table>` via DataTable.
