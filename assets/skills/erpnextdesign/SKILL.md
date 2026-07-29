---
name: erpnextdesign
description: >-
  Frappe/ERPNext Desk visual design system, reverse-engineered from the actual
  frappe app source (SCSS + JS templates) so a prototype can look pixel-close
  to real Frappe/ERPNext. Use this skill whenever the user asks to design,
  clone, mock up, or build a UI "like Frappe", "like ERPNext", "like the Desk",
  or asks for a sidebar/navbar/list view/report view/dashboard/number
  card/chart/theme that should match Frappe's look and feel. Covers exact CSS
  variable names/values, light+dark theming, spacing/radius/shadow scales,
  and DOM structure for navbar, sidebar, list view, report view, number
  cards, charts, and workspace widgets.
---

# ERPNext / Frappe Desk Design System

**If the deliverable is a standalone HTML page meant to look like Frappe/ERPNext Desk, use
`frappe-prototype` instead** — it reuses real captured DOM + the actual compiled CSS
bundle, which is strictly more accurate than reconstructing from tokens, and loading both
skills for the same request just doubles tokens spent for no gain. Use *this* skill when
the target is a different stack (React/Vue/Tailwind, an existing app's component) where
literal skeleton reuse isn't the approach, or when only isolated tokens/recipes are needed.

This skill encodes Frappe Desk's actual design tokens and component markup, reverse-engineered from the real Frappe Desk source (SCSS variables and JS-rendered templates). It is NOT a generic "make it look nice" skill — it's a literal spec so an AI can reproduce Frappe's UI conventions exactly, in any stack (plain HTML/CSS, React, Vue, Tailwind, etc.), with no access to the original source required.

**Key architectural fact:** modern Frappe Desk (v15+) has no persistent desktop top navbar — all primary chrome (logo, search, notifications, user menu) lives in a **left sidebar**. A top bar only appears on mobile or for banner-style alerts. Don't default to a top-nav layout when asked to clone Frappe.

## How to use this skill

1. Always start with the **Quick reference** below — it covers the tokens needed for ~80% of prototypes (colors, spacing, radius, type, theme switching).
2. Load ONLY the reference file(s) relevant to what's being built — don't read all of them upfront.

| Topic | When to load | File |
|---|---|---|
| **Canonical layout diagrams** — annotated wireframes of List/Dashboard/Report/Form views (each with sidebar + breadcrumb chrome), glyph→icon-id legend, and a chrome-ownership matrix of which control belongs to which view | **FIRST, for any full-page prototype** — before choosing components, match the view to its diagram | [layout-diagrams.md](./references/layout-diagrams.md) |
| Colors, light/dark theme, typography, spacing, radius, shadows | Any styling/theming work, or setting up CSS variables | [color-theme.md](./references/color-theme.md) |
| Top navbar, left app sidebar (workspace nav, user menu) | Building the app shell / navigation | [navbar-sidebar.md](./references/navbar-sidebar.md) |
| List view, report view (data table), filter/sort toolbar, status pills | Building a data table / record list page | [list-report-view.md](./references/list-report-view.md) |
| Number cards, dashboard charts, workspace shortcut/link cards | Building a dashboard or home/workspace page | [widgets-charts.md](./references/widgets-charts.md) |
| Form view: page head/toolbar, tab bar, field grid, child tables, document sidebar, "…" menu | Building a create/edit record page | [form-view.md](./references/form-view.md) |
| Toasts, validation errors, empty/loading states, confirm dialogs — exact CSS/HTML for each | Any interactive/CRUD prototype (Save/Delete feedback, invalid fields, no-data states) | [interaction-states.md](./references/interaction-states.md) |
| Real icon sprite (3 actual source files, curated + embeddable), exact icon CSS rules, self-hosted Inter font as a ready base64 `@font-face` | Any prototype that needs real (not hand-drawn) icons/type, not just a lookalike | [icons.md](./references/icons.md) |

Each reference file ends with a minimal HTML/CSS "component recipe" — use those as a starting skeleton. For full list page development, use the baseline templates at [assets/list-view-template.html](./references/assets/list-view-template.html) and [assets/list-view-template.css](./references/assets/list-view-template.css) to guarantee layout correctness, correct checkbox styling, `.list-row-head` styling, and `.page-form` layout without mistakes. **For icons specifically, always use [icons.md](./references/icons.md) and its embeddable [assets/icon-sprite.svg](./references/assets/icon-sprite.svg)** — real `<use href="#icon-x">` references against real symbol IDs — rather than hand-drawing SVG paths inline; a hand-drawn approximation is the single biggest visible gap between a prototype and actual Frappe output.

## Fidelity gate — every prototype MUST pass all of these (non-negotiable)

Side-by-side comparisons of skill-built prototypes against real ERPNext showed the gap is never the tokens — it's these six things. Check each one before delivering; if any fails, the output does not look like Frappe, full stop.

1. **Real font, actually embedded.** Paste the base64 `@font-face` from [assets/inter-variable-fontface.css](./references/assets/inter-variable-fontface.css) into the page and set `font-family:"InterVariable",...` + `font-weight:420` on `body`. Declaring `"Inter"` without embedding it silently falls back to Arial/Helvetica in a self-contained artifact (CSP blocks CDNs) — that fallback is the single most visible "not Frappe" tell.
2. **Real icons, zero hand-drawn.** Inline [assets/icon-sprite.svg](./references/assets/icon-sprite.svg) once (hidden) and reference every glyph via `<svg class="icon icon-sm"><use href="#icon-x">`. No hand-drawn paths, no emoji, no Unicode arrows/hearts, no other icon library. If a glyph is missing from the sprite, pull the real `<symbol>` from a Frappe bench (`frappe/public/icons/{timeless,lucide,espresso}/icons.svg`) and add it.
3. **No native form controls.** Never a bare `<select>` (OS arrow ≠ Frappe's `#icon-select` chevron), never a native date picker. Checkboxes get Frappe's real `appearance:none` styling — 14px, 4px radius, `1px solid var(--gray-500)` border; checked = `var(--primary)` fill + white tick (exact recipe in list-report-view.md).
4. **Page chrome composed exactly** per the wireframe for that view type in [layout-diagrams.md](./references/layout-diagrams.md) — breadcrumb starts with the **home icon** crumb; each view gets its own action cluster (List: `List View ⌄ · Saved Filters ⌄ · ⟳ · … · + Add`; Report: `Actions ⌄ · ⟳ · …`; Form: `‹ › · … · Save`; Dashboard: `…` only); the record count + liked-by-me heart live in the **list header row**, not the toolbar. The chrome-ownership matrix at the bottom of that file is binding — a control in a ✖ cell must not appear on that view.
5. **Grayscale primary, pastel pills.** Primary buttons near-black (light mode), never blue; status pills = pastel bg + colored text (+ 6px dot for Select-field status columns); liked hearts fill grayscale, never red.
6. **Self-review against the real thing.** Before delivering, re-render mentally (or screenshot) and diff against a real Frappe list/form: font weight/size rhythm, icon shapes, chrome order, count placement. If any element required inventing markup not in these references, re-check the reference first — the answer is almost always already specified.

## Interactive prototypes (CRUD)

When the deliverable is an HTML/JS prototype (not just a visual reference), it should be a **working mini-app**, not a static picture of one — wire up a real Create → Read/List → Update → Delete loop so the user can click through it. Pair the behavior below with the exact CSS/HTML in [interaction-states.md](./references/interaction-states.md) for the toast, validation-error, empty-state, loading-skeleton, and confirm-dialog markup — don't invent your own ad hoc versions of those.

- **Data store:** one in-memory array of plain record objects (seeded with realistic values, never lorem) as the single source of truth for every view; optionally mirror to `localStorage` so state survives a reload. No view keeps its own shadow copy.
- **List → Form:** clicking a row opens the Form View pre-filled from that record (read); "+ Add {Doctype}" opens a blank form with no sidebar and a "Not Saved" pill (see form-view.md). Empty doctype or a filtered-to-zero list renders the `.no-result` empty state, not a blank white area (interaction-states.md).
- **Form → Save:** validate required (`*`) fields first — missing ones get `.has-error` + `.help-box` text and an `alert-error` toast (interaction-states.md), focus jumps to the first invalid field. On success: new doc → append to the store, flip title from `New {Doctype}` to the entered value, drop the "Not Saved" pill, switch the button label to `Update`, reveal the document sidebar only now (never earlier), and fire an `alert-success` toast (`"Saved"`). Existing doc → patch the record in place, toast `"{Doctype} updated"`.
- **Delete:** from the form's "…" menu or a dedicated action — show the confirm dialog from interaction-states.md (`btn-danger`, "This action cannot be undone") before removing anything; on confirm, remove the record from the store, toast `"{Doctype} deleted"`, and return to the List View, which re-renders without that row.
- **List interactions:** checkboxes toggle selection + bulk-action bar; the heart/like icon toggles filled state on the record; page-size buttons and "Load More" actually change the rendered row count, not just their own active styling.
- **Keep it plain:** vanilla JS/CSS/HTML in one file unless told otherwise — no build step, no external deps.
- **Before calling it done:** create a record, watch it appear in the list, open and edit it, save, delete it. Any dead click means the prototype isn't finished.

## Quick reference (read first, always)

### Theme switching
Set `data-theme="light"|"dark"` on `<html>` (not a class on `<body>`). Define light tokens in `:root`, override a subset under `[data-theme="dark"]`. "Automatic" mode = watch `matchMedia("(prefers-color-scheme: dark)")` and set the attribute accordingly.

### Core CSS variables (bootstrap block — see color-theme.md for the full token set)

```css
:root {
  --gray-50:#faf8f7; --gray-100:#f4f2f1; --gray-200:#ebeae8; --gray-300:#dcdad8;
  --gray-400:#c7c5c3; --gray-500:#9c9a98; --gray-600:#7c7a78; --gray-700:#52504e;
  --gray-800:#383635; --gray-900:#171514;
  --blue-500:#0289f7; --blue-600:#007be0; --green-500:#278f5e; --red-500:#e03636;

  --bg-color:#fff; --fg-color:#fff; --card-bg:#fff;
  --text-color:var(--gray-800); --heading-color:var(--gray-900); --text-muted:var(--gray-700);
  --border-color:var(--gray-200); --control-bg:var(--gray-100);
  --primary:var(--gray-900); --btn-primary:var(--gray-900);
  --border-radius:8px; --border-radius-lg:12px; --border-radius-full:999px;
  --font-stack:"InterVariable","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
[data-theme="dark"] {
  --gray-700:#383838; --gray-800:#232323;
  --bg-color:var(--gray-900); --fg-color:var(--gray-900); --card-bg:var(--gray-900);
  --text-color:var(--gray-50); --heading-color:var(--gray-50); --text-muted:var(--gray-400);
  --border-color:var(--gray-800); --control-bg:var(--gray-800);
  --primary:var(--gray-300); --btn-primary:var(--gray-300);
  color-scheme: dark;
}
```

**Important:** Frappe's "primary" color is grayscale (near-black in light mode, light-gray in dark mode), NOT blue. Blue is reserved for links/focus/info accents. Don't default to a blue-primary SaaS look when cloning Frappe.

### Type scale
Font stack `InterVariable/Inter`. Sizes: 12 / 13 / 14 (base) / 16 / 18 / 20 / 24px. Weights: regular 420, medium 500, semibold 600.

### Spacing / radius / shadow
Spacing steps: 5 / 7 / 15 / 20 / 30 / 40px. Radius: 8px (default), 12px (cards), full/999px (pills). Card shadow: `0 0 1px rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.1)` (`--shadow-base`).

### Status/badge colors (indicator pills)
Twelve named colors: `green, cyan, blue, orange, yellow, gray, grey, red, pink, darkgrey, purple, light-blue`. Pattern: `background: var(--bg-{color}); color: var(--text-on-{color})` — pastel bg + saturated text, never a solid-fill badge. Full value tables in [color-theme.md](./references/color-theme.md).

### Layout defaults
- Sidebar-first app shell: left rail ~220px expanded / 50px collapsed, not a top navbar.
- List rows: flexbox, ~30px row height, no zebra striping, hover = `var(--highlight-color)`.
- Report/data tables: real `<table>`, tabular-number cells, sticky header.
- Cards (widgets, number cards, dashboard charts): 12px radius, 1px `var(--border-color)` border, subtle shadow on hover only.
