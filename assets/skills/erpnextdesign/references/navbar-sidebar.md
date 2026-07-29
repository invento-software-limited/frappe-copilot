# Frappe/ERPNext Navbar & Sidebar

## Structural note — read this first

Modern Frappe (v15+) has **no persistent horizontal top navbar** on desktop. The `<header>` is only populated with a classic `.navbar` bar for: read-only mode banners, user impersonation, an unread announcement widget, or **mobile viewport**. On desktop, all primary app chrome — logo, global search, notifications, help, user menu — lives in the **left sidebar** (`.body-sidebar`). Per-page search/breadcrumbs live in the page header (`.page-head`), which belongs to the current list/form view, not the app shell.

**Design implication:** if you're prototyping an "ERPNext-style" desktop app, put logo/search/notifications/user-menu in a left rail, not a top bar. Reserve a top bar only for mobile or banner-style alerts.

## Navbar (`.navbar`) — mobile / read-only / banner path

- Height: `48px` (`$navbar-height`, `--navbar-height`)
- Background: `var(--navbar-bg)` → `var(--neutral)` (white light / black dark)
- `border-bottom: 1px solid var(--border-color)`
- `.navbar-brand` (logo, 32×32 img) hidden at `md`+ breakpoint — mobile only
- `.nav-item { margin: auto; margin-left: var(--margin-md) }`, text `sm/regular`, `line-height: 1rem`
- `.vertical-bar` divider: `border-right: 1px solid var(--dark-border-color); height: 24px`
- `.container { padding: 0 1rem }`
- Search bar: max-width 300px, input height 28px, `padding-left: 36px`; `.search-icon { border-radius: 8px; padding: 6px; background: var(--control-bg) }`; focus adds `box-shadow: var(--shadow-2xl)` + `background-color: var(--awesomebar-focus-bg)`; results dropdown `border-radius: 0 0 var(--border-radius) var(--border-radius)`.

## Sidebar (`.body-sidebar`) — the real navigation chrome

### DOM skeleton

```html
<div class="body-sidebar-container [expanded]">
  <div class="body-sidebar-placeholder"></div>  <!-- static spacer matching width -->
  <div class="body-sidebar">
    <div class="standard-items-sections">
      <div class="dropdown-notifications hidden">
        <div class="notifications-list" role="menu">
          <div class="notification-list-header">...</div>
          <div class="notification-list-body">
            <div class="panel-notifications"></div>
            <div class="panel-events"></div>
            <div class="panel-changelog-feed"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="body-sidebar-top">
      <div class="sidebar-items"><!-- workspace/module links --></div>
      <div class="edit-mode standard-sidebar-item hidden" data-name="add-sidebar-item"></div>
    </div>
    <div class="body-sidebar-cards"><!-- promo/upsell cards --></div>
    <div class="body-sidebar-bottom">
      <div class="edit-mode bottom-edit-controls hidden"><!-- Discard / Save --></div>
      <div class="promotional-banners"></div>
      <p><a class="onboarding-sidebar">Getting Started</a></p>
      <div class="nav-item dropdown dropdown-navbar-user dropdown-mobile">
        <a class="sidebar-user-button"><!-- avatar + name + email --></a>
      </div>
    </div>
    <div class="sidebar-resize-handle"></div>
  </div>
  <div class="overlay"></div>  <!-- mobile scrim -->
</div>
```

### Sidebar header (app/workspace title, top of rail)

```html
<a class="sidebar-header">
  <span class="sidebar-item-icon header-logo"><!-- 32x32 icon/img --></span>
  <div class="title-container">
    <span class="sidebar-item-label header-title"></span>
    <span class="sidebar-item-label header-subtitle"></span>
  </div>
  <button class="btn-reset drop-icon show-in-edit-mode"></button>
</a>
```

### Sidebar item (one row = one workspace/module link)

```html
<div class="sidebar-item-container [is-draggable] [section-item]">
  <div class="standard-sidebar-item [indent]">
    <a class="item-anchor [section-break]">
      <span class="sidebar-item-icon text-ink-gray-7"><!-- svg icon --></span>
      <span class="sidebar-item-label"></span>
      <span class="sidebar-item-suffix"><!-- optional, e.g. kbd shortcut --></span>
      <span class="sidebar-item-control"><!-- chevron --></span>
    </a>
    <div class="sidebar-item-edit-controls edit-mode hidden">
      <button class="drag-handle"></button>
      <button class="setting-btn edit-menu"></button>
    </div>
  </div>
  <div class="sidebar-child-item nested-container"><!-- nested children --></div>
</div>
```

### Dimensions

| Element | Value |
|---|---|
| `--sidebar-width` | 220px |
| Collapsed rail width | 50px |
| `.body-sidebar` padding | `8px 8px 10px 8px` (0 on mobile) |
| `.body-sidebar` section gap | 14px |
| `.body-sidebar-top` item gap | 2px |
| Sidebar header height | 48px, padding 8px |
| Item row height (`.item-anchor`) | 30px, icon padding 7px |
| Header logo / item icon | 32×32px, radius 8px (inner `.icon-container` 10px) |
| Sidebar card | radius 12px, padding 16px |
| `.card-outline` radius | `calc(var(--border-radius-lg) + 2px)` |
| Active/hover item radius | 8px |
| Resize handle | width 8px, `right: -4px` |
| Nested indent | `margin-left: 16px` |
| z-index | sidebar 1020, mobile overlay 1021, resize handle 1022 |

Mobile (`@media (max-width: sm)`): sidebar collapses to 0px width, `overflow: hidden`; expanded state becomes an absolute overlay with `.overlay { background: rgba(128,128,128,0.5) }`.

### Color variables (names only — resolve values via [color-theme.md](./color-theme.md))

`--sidebar-hover-color`, `--sidebar-active-color`, `--sidebar-border-color`, `--divider-color`, `--sidebar-width`, `--surface-menu-bar` (sidebar bg), `--sidebar-select-color`, `--ink-gray-4..9` (text/icon on items), `--surface-gray-3` (logo fallback bg), `--surface-modal` (card bg), `--sidebar-card-button-*`, `--outline-gray-2` (card border), `--gray-300` (divider), `--ink-gray-2` (resize handle hover).

### Typography

- Item label: `font-size: var(--text-sm)` (13px), truncated (ellipsis)
- Sidebar-card title: `base/medium` (14px/500)
- Header title: `font-weight: 500; line-height: 1.2`
- Header subtitle: `font-size: var(--text-sm)`, `color: var(--ink-gray-6)`
- Keyboard-shortcut suffix: `font-size: var(--text-sm); font-weight: 420; letter-spacing: 0.02em`
- Icons via `frappe.utils.icon(name, "sm")`, `text-ink-gray-7` fill; edit/drag icons use `xs`

### Interaction states

- `.body-sidebar-container.expanded` — collapsed/expanded toggle, persisted in `localStorage["sidebar-expanded"]`
- `.active-sidebar` (current route) → `background: var(--sidebar-active-color); box-shadow: var(--shadow-sm); border-radius: 8px`
- `.hover` mixin → `background-color: var(--sidebar-hover-color); border-radius: 8px`; selector excludes section breaks: `&:not(.active-sidebar):has(a:not(.section-break)):hover`
- `[data-mode="edit"]` on the container reveals drag handle + `⋮` menu on hover, hides promo/user-menu
- Resize via `.sidebar-resize-handle` (`cursor: e-resize`/`w-resize` when expanded)
- `.section-break` items act as collapsible group headers; `.divider { border-top: 1px solid var(--gray-300) }` separates sections
- Notifications dropdown positioned `left: 100%` (desktop) / `left: 0` (mobile)

## Page shell (outer DOM skeleton, verbatim from real `page.html`)

Every List/Report/Form page is rendered inside this literal skeleton (transcribed from `frappe/public/js/frappe/ui/page.html`), which sits to the right of the sidebar above. Reproduce this nesting, not just the components inside it, or a prototype's structure won't match a real page even if the individual pieces look right.

```html
<div class="page-head flex">
  <div class="container">
    <div class="row flex-nowrap align-center page-head-content justify-between">
      <div class="page-title">
        <button class="btn-reset sidebar-toggle-btn navbar-brand">
          <svg class="icon icon-md sidebar-toggle-placeholder"><use href="#icon-menu"></use></svg>
          <span class="sidebar-toggle-icon">
            <svg class="es-icon icon-md"><use href="#es-line-sidebar-collapse"></use></svg>
          </span>
        </button>
        <div class="flex title-area ellipsis">
          <ul class="nav d-sm-flex navbar-breadcrumbs ellipsis"></ul>
          <button class="btn btn-default more-button hide">
            <svg class="icon icon-sm"><use href="#icon-dot-horizontal"></use></svg>
          </button>
          <span class="indicator-pill whitespace-nowrap page-indicator-pill"></span>
        </div>
      </div>
      <div class="align-center flex standard-items-section">
        <!-- .page-actions — see list-report-view.md "Page header actions" for the full contents -->
        <div class="flex col page-actions justify-content-end"></div>
      </div>
    </div>
  </div>
</div>
<div class="container page-body">
  <div class="page-toolbar hide"><div class="container"></div></div>
  <div class="page-wrapper">
    <div class="page-content">
      <!-- the actual List/Report/Form view mounts here -->
      <div class="workflow-button-area btn-group pull-right hide"></div>
      <div class="clearfix"></div>
    </div>
  </div>
</div>
```

- `.page-head` is `.flex`, wraps a Bootstrap `.container` (not full-bleed) — the breadcrumb/toolbar row is itself a `.row` (`page-head-content`), meaning it participates in Bootstrap's grid/gutter system, not a bespoke flex container.
- The sidebar-toggle button on the far left is only meaningful on mobile/collapsed-sidebar states: it renders **two** icons — a placeholder hamburger (`#icon-menu`, usually invisible/unused) and the real toggle glyph `#es-line-sidebar-collapse` (Espresso set, swapped to `#es-line-sidebar-expand` when collapsed).
- `.page-indicator-pill` sits inline in the title area (this is the same `.indicator-pill` component used for "Not Saved"/status everywhere else) — reuse it, don't build a separate status-badge component for the page title.
- `.page-toolbar` (report/list secondary toolbar row, e.g. summary stats) and `.workflow-button-area` (submit/cancel workflow buttons) both ship `hide` by default — only render them when the current view actually populates them.
- `.page-wrapper > .page-content` is where List View's `.result-container`, Report View's DataTable, or a Form's tab content actually mounts — everything documented in `list-report-view.md` and `form-view.md` lives one level inside `.page-content`, not directly under `.page-body`.

## Component recipe (minimal clone)

```html
<aside class="sidebar" style="width:220px;padding:8px;display:flex;flex-direction:column;gap:14px;background:var(--bg-color);border-right:1px solid var(--border-color)">
  <a class="sidebar-header" style="display:flex;align-items:center;gap:8px;padding:8px;height:48px">
    <span style="width:32px;height:32px;border-radius:8px;background:var(--control-bg)"></span>
    <div>
      <div style="font-weight:500;line-height:1.2">Workspace</div>
      <div style="font-size:13px;color:var(--text-muted)">Subtitle</div>
    </div>
  </a>
  <nav style="display:flex;flex-direction:column;gap:2px">
    <a class="item active" style="display:flex;align-items:center;gap:8px;height:30px;padding:0 7px;border-radius:8px;font-size:13px;background:var(--sidebar-active-color, var(--control-bg))">Home</a>
    <a class="item" style="display:flex;align-items:center;gap:8px;height:30px;padding:0 7px;border-radius:8px;font-size:13px">Settings</a>
  </nav>
</aside>
```
