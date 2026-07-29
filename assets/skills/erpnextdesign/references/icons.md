# Frappe/ERPNext Icon System (ground truth, extracted from real source)

Frappe Desk actually loads **three separate icon sprites** at boot and merges them into one flat `id` namespace in the DOM, plus one variable font. This file documents the real CSS rules and IDs (verified against `frappe/public/scss/common/icons.scss` and `frappe/public/icons/*`), not a reconstruction. A ready-to-embed curated sprite covering everything this skill's components need is at [assets/icon-sprite.svg](./assets/icon-sprite.svg) — inline its `<svg style="display:none">...</svg>` contents once per page and every `<use href="#icon-x">` below resolves.

## The three sprites

| Set | Source file | `id` prefix | Wrapper class | Render style |
|---|---|---|---|---|
| Timeless | `icons/timeless/icons.svg` | `icon-*` | `.icon` | outline (stroke-based) |
| Lucide (merged) | `icons/lucide/icons.svg` | `icon-*` (same namespace as Timeless — no `lucide-` prefix) | `.icon` | outline, some fill-shape |
| Espresso | `icons/espresso/icons.svg` | `es-line-*` / `es-solid-*` | `.es-icon` | **filled**, not outline |

Timeless and Lucide share the plain `icon-` prefix with no collisions in practice (e.g. `icon-heart` — outline, unliked — comes from Lucide; `icon-heart-active` — filled, liked — comes from Timeless). Don't assume every `icon-*` id lives in one file; if it's not in Timeless, check Lucide before inventing a new name.

## Real CSS rules (verbatim from `scss/common/icons.scss`)

```css
.icon{
  display:inline-block; font-size:0; width:20px; height:20px; margin:0 auto;
  background-size:cover; background-repeat:no-repeat; background-position:50% 50%;
  fill:var(--icon-fill); stroke:var(--icon-stroke);
  stroke-width:1.5px; stroke-linecap:round; stroke-linejoin:round;
}
.es-icon{ /* extends .icon */
  fill:var(--icon-stroke); stroke-width:0; /* es-icons render filled, not outlined */
}
use.like-icon{ --icon-stroke:transparent; cursor:pointer; stroke:var(--icon-stroke); }
#icon-file-large{ stroke:none; }
#icon-folder-normal-large{ stroke:none; }
#icon-close{ fill:var(--invert-neutral); }
.icon > .close-alt{ fill:var(--gray-500); }
.liked .like-icon,
.liked .like-icon use{ --icon-stroke:var(--invert-neutral); fill:var(--invert-neutral); }

.icon-xs{ width:12px; height:12px; }
.icon-sm{ width:16px; height:16px; }
.icon-base, .icon-md{ width:20px; height:20px; }
.icon-lg{ width:24px; height:24px; }
.icon-xl{ width:40px; height:40px; }
.no-stroke{ stroke:none; }
.current-color{ stroke:currentColor; }
```

- Default icon size is **20px** (`.icon-md`/`.icon-base`), not the 14px this skill's earlier drafts assumed — always pair `.icon` with an explicit `.icon-{size}` modifier.
- `stroke-width` is **1.5px**, not 1.6 or 2.
- Outline icons (`.icon`) are transparent-fill/colored-stroke; espresso icons (`.es-icon`) are the opposite — colored-fill/no-stroke. Don't apply the same `fill:none;stroke:currentColor` treatment to both.
- The like/heart icon swaps symbols on toggle rather than recoloring one shape: unliked → `<use href="#icon-heart">`; liked → the parent row/sidebar gets a `.liked` class and swaps to `<use href="#icon-heart-active">` (see List View, §3, and Form Sidebar, §5).

## Verified real icon IDs (curated set, exact usage from source)

| Use | Real id | Set | Wrapper |
|---|---|---|---|
| **Breadcrumb home crumb** (always the first crumb, links `/desk` — see list-report-view.md) | `icon-home` | Timeless | `.icon` |
| **List-toolbar refresh button** (v16 `base_list.js` calls `page.add_action_icon("es-line-reload")`) | `es-line-reload` | **Espresso** | `.es-icon` |
| Refresh (legacy/other contexts) | `icon-refresh` | Timeless | `.icon` |
| "…" menu trigger | `icon-dot-horizontal` | Timeless | `.icon` |
| Add / primary-action plus | `icon-add` | Timeless | `.icon` |
| Inline "+" (form-sidebar Attachments/Tags/Share rows, tag editor) | `es-line-add` | **Espresso** | `.es-icon` |
| Dropdown-toggle chevron (view switcher, saved filters, all `.inner-group-button`s) | `icon-select` | Timeless | `.icon` |
| **Sort-field dropdown chevron** (`sort_selector.html` uses `frappe.utils.icon("chevron-down")`, NOT `icon-select`) | `icon-chevron-down` | **Lucide** | `.icon` |
| Collapsible form-section indicator, **closed** state | `icon-chevron-right` | **Lucide** | `.icon` |
| Collapsible form-section indicator, **open** state | `es-line-down` | **Espresso** | `.es-icon` |
| **Filter button** (v16 `.filter-button` in `base_list.js make_filter_list()`) | `es-line-filter` | **Espresso** | `.es-icon` |
| **Clear-filters ×** (v16 `.filter-x-button`) | `es-small-close` | **Espresso** | `.es-icon` |
| Filter (legacy/other contexts) | `icon-filter` / `icon-filter-x` | Timeless | `.icon` |
| **Match-type "=" operator** (standard-filter text input, `.match-type-dropdown-btn`) | `icon-equal` | **Lucide** | `.icon` |
| **Match-type "≈" operator** (default "Like" state of the same button) | `icon-equal-approximately` | **Lucide** | `.icon` |
| **Form prev/next document nav** (`form/toolbar.js`) | `es-line-left-chevron` / `es-line-right-chevron` | **Espresso** | `.es-icon` |
| **Print** (form sidebar `.form-print`, via `frappe.utils.icon("printer")`) | `icon-printer` | **Lucide** | `.icon` |
| Grid/column settings gear | `icon-setting-gear` | Timeless | `.icon` |
| Row edit pencil | `icon-edit` | Timeless | `.icon` |
| Assign (doc sidebar) | `icon-assign` | Timeless | `.icon` |
| Attachments (doc sidebar) | `icon-attachment` | Timeless | `.icon` |
| Toast success | `icon-solid-success` | Timeless | `.icon` |
| Toast error | `icon-solid-error` | Timeless | `.icon` |
| Toast warning | `icon-solid-warning` | Timeless | `.icon` |
| Toast info | `icon-solid-info` | Timeless | `.icon` |
| Duplicate (form menu) | `icon-duplicate` | Timeless | `.icon` |
| Liked/filled heart | `icon-heart-active` | Timeless | `.icon` + `.like-icon` |
| Close / dismiss | `icon-close` | Timeless | `.icon` |
| Sort ascending | `icon-sort-ascending` | Timeless | `.icon` |
| Sort descending | `icon-sort-descending` | Timeless | `.icon` |
| Home (sidebar) | `icon-home` | Timeless | `.icon` |
| Notification bell | `icon-notification` | Timeless | `.icon` |
| Small add (inline +) | `icon-small-add` | Timeless | `.icon` |
| Checkbox tick | `icon-tick` | Timeless | `.icon` |
| Mobile status dot | `icon-primitive-dot` | Timeless | `.icon` |
| Doctype/file tag | `icon-small-file` | Timeless | `.icon` |
| Unliked/outline heart | `icon-heart` | **Lucide** | `.icon` |
| Tags | `icon-tag` | **Lucide** | `.icon` |
| Share | `icon-share` | **Lucide** | `.icon` |
| Comment count icon (list row) | `es-line-chat-alt` | **Espresso** | `.es-icon` |
| Sidebar collapse toggle | `es-line-sidebar-collapse` | **Espresso** | `.es-icon` |
| Sidebar expand toggle | `es-line-sidebar-expand` | **Espresso** | `.es-icon` |

Corrections to earlier drafts of this skill: `icon-heart` alone is not liked/unliked-agnostic (it's specifically the *unliked* Lucide heart); the comment-count icon is `es-line-chat-alt` (espresso, filled), not a Timeless outline chat bubble; `icon-tag`/`icon-share` are Lucide, not Timeless; there is no `icon-empty-state` in any real sprite — use a real substitute like `icon-small-file` instead. **v16 correction (verified against frappe 16.18.3 source):** the list-page toolbar icons are Espresso, not Timeless — refresh is `es-line-reload`, the Filter button is `es-line-filter`, clear-filters is `es-small-close`; using the Timeless `icon-refresh`/`icon-filter` there is a visible fidelity miss (outline vs filled glyph). The sort selector's field-dropdown chevron is Lucide `icon-chevron-down`, not `icon-select` — only `.inner-group-button`s (view switcher, Saved Filters) and select-shaped form controls use `icon-select`. Collapsible **form sections** specifically (not general dropdowns) use an asymmetric real pair straight from `frappe/form/section.js`'s `set_icon()`: closed → `icon-chevron-right` (Lucide), open → `es-line-down` (Espresso) — two different icon sets for the two states of one toggle, swapped on click rather than one icon rotated by CSS. General dropdown-toggle chevrons elsewhere (view switcher, sort, filter buttons) still use the single `icon-select` glyph, just oriented differently by context — don't conflate the two.

## Usage in markup

```html
<!-- once per page, hidden -->
<svg style="display:none" id="frappe-icon-sprite"> ... <!-- paste assets/icon-sprite.svg contents --> ... </svg>

<!-- outline (Timeless/Lucide) -->
<svg class="icon icon-sm"><use href="#icon-refresh"></use></svg>

<!-- filled (Espresso) -->
<svg class="es-icon icon-sm"><use href="#es-line-chat-alt"></use></svg>

<!-- like toggle -->
<span class="list-row-like">
  <svg class="icon icon-sm like-icon"><use href="#icon-heart"></use></svg> <!-- unliked -->
</span>
<span class="list-row-like liked">
  <svg class="icon icon-sm like-icon"><use href="#icon-heart-active"></use></svg> <!-- liked -->
</span>
```

If a needed icon isn't in the curated sprite, pull the exact `<symbol id="...">...</symbol>` block from the real source file on disk (`frappe/public/icons/{timeless,lucide,espresso}/icons.svg` in any Frappe bench) rather than hand-drawing a path — the goal is byte-real markup, not a lookalike.

## Real self-hosted font

Frappe self-hosts Inter rather than loading it from a CDN: `frappe/public/css/fonts/inter/InterVariable.woff2` (a single variable-weight file, ~345KB, covers weights 100–900 — this is what backs the `--weight-regular:420` through `--weight-black:800` scale). For a self-contained HTML prototype, inline it once as a base64 `@font-face` — the ready-made snippet (already base64-encoded) is at [assets/inter-variable-fontface.css](./assets/inter-variable-fontface.css); paste its `<style>` contents in rather than re-encoding the font yourself.

```css
@font-face {
  font-family: "InterVariable";
  src: url(data:font/woff2;base64,...) format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
```
