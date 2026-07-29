# Canonical Layout Diagrams (never mismatch components)

Wireframes of the four Desk view types, traced from real Frappe v16 screenshots and source. Every region is labeled with its real class; every glyph maps to a real sprite ID via the legend. Before building any full-page prototype, find the matching diagram here and reproduce its regions in order — if a control isn't in the diagram for that view type, it doesn't belong on that view.

## Glyph legend (diagram marker → real icon)

| Marker | Icon id | Set / wrapper | Used for |
|---|---|---|---|
| ⌂ | `icon-home` | Timeless `.icon` | first breadcrumb crumb, links `/desk` |
| ⇅ | `icon-select` | Timeless `.icon` | labeled dropdown buttons (List View, Saved Filters, Actions, Status…), select controls |
| ⌄ | `icon-chevron-down` | Lucide `.icon` | sort-field dropdown chevron |
| ⟳ | `es-line-reload` | Espresso `.es-icon` | refresh icon button |
| ⋯ | `icon-dot-horizontal` | Timeless `.icon` | "…" menu button, widget menus |
| ▽ | `es-line-filter` | Espresso `.es-icon` | Filter button, chart filter |
| ✕ | `es-small-close` | Espresso `.es-icon` | clear-filters button |
| ≈ | `icon-equal-approximately` (⇄ `icon-equal`) | Lucide `.icon` | match-type operator on text standard filters |
| ↓ | `icon-sort-descending` / `icon-sort-ascending` | Timeless `.icon` | sort direction toggle |
| ♡ / ♥ | `icon-heart` (Lucide) / `icon-heart-active` (Timeless) | `.icon.like-icon` | unliked / liked (fill grayscale, never red) |
| 💬 | `es-line-chat-alt` | Espresso `.es-icon` | comment count in list rows |
| ‹ › | `es-line-left-chevron` / `es-line-right-chevron` | Espresso `.es-icon` | form prev/next document nav |
| ⎙ | `icon-printer` | Lucide `.icon` | print (form sidebar) |
| ＋ | `icon-add` (toolbar primary) / `es-line-add` (inline rows) | Timeless / Espresso | add buttons |
| ☐ | custom checkbox (see checkbox CSS) | — | never native |
| ● | 6px pill dot | `--indicator-dot-{color}` | Select-field status pills |

## 0. App shell — identical on every view

```text
┌ .body-sidebar (220px) ────┬ main area ─────────────────────────────────────────────────────────┐
│ [◙] Cadence             ⌄ │ .page-head:  ⌂ / {crumbs} / {Title}          [view-specific actions]│
│      subtitle             │────────────────────────────────────────────────────────────────────│
│ ⌕  Search         Ctrl+K  │                                                                    │
│ ⌾  Notification           │                                                                    │
│ ◫  Dashboard              │                                                                    │
│ Product Control         ⌄ │              .page-body                                            │
│ ▸ Releases    ◄ active    │              the current view mounts here                          │
│ ▸ SOW & Estimates         │              (diagrams 1–4 below)                                  │
│ ▸ Sprints                 │                                                                    │
│ Delivery                ⌄ │                                                                    │
│ ▸ Backlog & Stories       │                                                                    │
│      ⋮ more sections      │                                                                    │
│───────────────────────────│                                                                    │
│ (A) Administrator         │                                                                    │
│     admin@example.com     │                                                                    │
└───────────────────────────┴────────────────────────────────────────────────────────────────────┘
```

- Sidebar header: 32×32 logo (radius 8) + app title (14px/500) + subtitle (13px muted) + workspace-switcher chevron; row height 48px.
- `Search` row: a `.standard-sidebar-item` with a `Ctrl+K` kbd suffix (13px/420, `letter-spacing:.02em`, muted).
- Section labels (`Product Control`, `Delivery`…): collapsible `.section-break` group headers — 12–13px, `var(--text-muted)`, chevron right-aligned; NOT indented items.
- Items: 30px tall, radius 8, 16px icon + 13px label; active = `--sidebar-active-color` bg + `--shadow-sm`; hover = `--sidebar-hover-color`.
- Bottom: `.sidebar-user-button` — avatar + two-line name/email stack (13px / 12px muted).
- Sidebar and main share `--bg-color`; divider is `1px solid var(--border-color)`.
- **Every one of the four views below renders inside this shell.** Never a top navbar on desktop.

## 1. List View

```text
┌ sidebar ┬─────────────────────────────────────────────────────────────────────────────────────┐
│         │ ⌂ / Release                    [List View ⇅] [Saved Filters ⇅] [⟳] [⋯] [＋ Add Release]   ← .page-head
│ (see 0) │─────────────────────────────────────────────────────────────────────────────────────│
│         │ [ID        |≈] [Product Project ] [Status ⇅]      [▽ Filter ✕] [↓ | Last Updated On ⌄]   ← .page-form
│         │─────────────────────────────────────────────────────────────────────────────────────│
│         │ ☐  ID           Product Project     Project Name    Release Name   Status   1 of 1 ♡    ← .list-row-head
│         │─────────────────────────────────────────────────────────────────────────────────────│
│         │ ☐  REL-…-00001  Shangu Group ERP…                   Shangu Group…  ●Active  1w 💬0 · ♡   ← .list-row
│         │    …more rows (30px min height, hover --highlight-color, no zebra)…                  │
│         │─────────────────────────────────────────────────────────────────────────────────────│
│         │ [20][100][500][2500]                                        20 of 46  [Load More]       ← .list-paging-area
└─────────┴─────────────────────────────────────────────────────────────────────────────────────┘
```

Row-by-row ownership:

| Region | Class | Contents (exact order) |
|---|---|---|
| Breadcrumb + actions | `.page-head` | ⌂ crumb → doctype title (16px/500 heading color) · right: **List View ⇅ · Saved Filters ⇅ · ⟳ · ⋯ · ＋ Add {Doctype}** — all five, always, this order |
| Filter toolbar | `.page-form` | left `.standard-filter-section` (text input + ≈ button, Link input, Select trigger with ⇅) · right `.filter-section` (▽ Filter ✕ btn-group, then ↓ + field ⌄ sort btn-group) |
| Column header | `.list-row-head` | ☐ select-all → column labels (muted) → **`.list-count` "1 of 1" + ♡ liked-by-me filter** at far right |
| Rows | `.list-row` | ☐ → bold subject link → field columns → status pill (● dot) → right cluster: modified · 💬 count · ♡ |
| Footer | `.list-paging-area` | page-length segmented control left · count + Load More right |

**Never:** count in the toolbar · native `<select>` for Status · missing List View/Saved Filters · "Actions ⇅" visible before rows are selected · red liked hearts.

## 2. Dashboard / Workspace view

```text
┌ sidebar ┬─────────────────────────────────────────────────────────────────────────────────────┐
│         │ ⌂ / Payments / Dashboard / Payments                                        [⋯]         ← .page-head (menu only)
│ (see 0) │─────────────────────────────────────────────────────────────────────────────────────│
│         │ ┌ number-widget-box ┐ ┌───────────────────┐ ┌───────────────────┐ ┌────────────────┐ │
│         │ │ Total Outgoing  ⋯ │ │ Total Incoming  ⋯ │ │ Total Incoming  ⋯ │ │ Total Outgo… ⋯ │ │
│         │ │ ৳ 0.00            │ │ ৳ 0.00            │ │ ৳ 0.00            │ │ ৳ 0.00         │ │
│         │ └───────────────────┘ └───────────────────┘ └───────────────────┘ └────────────────┘ │
│         │ ┌ dashboard-widget-box ─────────────────────┐ ┌ dashboard-widget-box ──────────────┐ │
│         │ │ Incoming Bills (Purchase Invoice)         │ │ Outgoing Bills (Sales Invoice)     │ │
│         │ │ Last synced just now                      │ │ …                                  │ │
│         │ │             [▽] [Last Year ⇅] [Monthly ⇅] [⋯] │ │                                │ │
│         │ │ 5┤                                        │ │                                    │ │
│         │ │  ┤     (chart canvas)                     │ │                                    │ │
│         │ │ 1┤                                        │ │                                    │ │
│         │ │  └ Jul 2025 … Jul 2026   (12px muted)     │ │                                    │ │
│         │ │ ◦ <0  ◦ 0-30  ◦ 31-60  ◦ 61-90  ◦ 91-120  │ │  ← legend dots (donut/ageing only) │ │
│         │ └───────────────────────────────────────────┘ └────────────────────────────────────┘ │
│         │ ┌ dashboard-widget-box full-width ──────────────────────────────────────────────────┐│
│         │ │ Bank Balance                                  [▽] [Last Year ⇅] [Monthly ⇅] [⋯]   ││
│         │ └───────────────────────────────────────────────────────────────────────────────────┘│
└─────────┴─────────────────────────────────────────────────────────────────────────────────────┘
```

- Page actions: **only ⋯** (edit/customize workspace). No Add button, no view switcher, no filter toolbar row.
- Number cards: 12px radius, 1px border, `min-height:84px`, `padding:12px`; label 13px/500 muted + trailing ⋯; value 20px/600. On a dashboard page they render 4-up (auto-fill grid, gap 20px).
- Chart cards: `min-height:240px`, title 14px/500 + subtitle 13px muted ("Last synced just now"); header controls right-aligned: ▽ filter (btn-xs) · timespan dropdown (`Last Year ⇅`) · interval dropdown (`Monthly ⇅`) · ⋯ menu — all `.btn-default btn-sm` with `icon-select` chevrons.
- Axis/tick labels 11–12px `var(--text-light)`; single accent color per series (no rainbow palettes).
- Full-width charts span both columns (`.grid-col-1` / `full-width`).

**Never:** filter/sort toolbar on a dashboard · primary Add button · shadows at rest (hover only) · pie-chart default (bars/lines/donut per widget config).

## 3. Report View (query report / report builder)

```text
┌ sidebar ┬─────────────────────────────────────────────────────────────────────────────────────┐
│         │ ⌂ / Cadence / Cadence Cash Flow                            [Actions ⇅] [⟳] [⋯]          ← .page-head
│ (see 0) │─────────────────────────────────────────────────────────────────────────────────────│
│         │ [Release        ]                                                                       ← .page-form (report filters)
│         │─────────────────────────────────────────────────────────────────────────────────────│
│         │ ┌ .datatable (real <table>) ────────────────────────────────────────────────────┐   │
│         │ │    │ Release            │ Invoice        │ Date    │     Amount │ Status      │      ← .dt-row-header (subtle-fg)
│         │ │    │ [        ]         │ [      ]       │ [   ]   │ [        ] │ [   ]       │      ← .dt-row-filter (inline filters)
│         │ │  1 │ Shangu Group ERP…  │ ACC-SINV-2026… │ 06-07-… │ ৳750,000.00│ ● Draft     │      ← .dt-row (35px)
│         │ │  2 │ …                  │                │         │            │             │   │
│         │ └────────────────────────────────────────────────────────────────────────────────┘   │
│         │ For comparison, use >5, <10 or =324. For ranges, use 5:10   Execution Time: 0.0015 sec ← .report-footer
└─────────┴─────────────────────────────────────────────────────────────────────────────────────┘
```

- Page actions for a **query report**: `Actions ⇅` (btn-default inner-group-button) · ⟳ · ⋯ — **no** Add button, no List View/Saved Filters switcher. (The *report view of a doctype* keeps the List View switcher; a standalone query report does not.)
- Real `<table>` via DataTable — never the list-row flex markup: leading **row-index column**, then an **inline filter row** of gray inputs directly under the header row.
- Numeric columns right-aligned with `font-variant-numeric: tabular-nums`; currency symbols inline.
- Status column renders the same `indicator-pill` component inside a cell.
- Footer: filter-syntax hint left (12px muted) + `Execution Time: {n} sec` right.

**Never:** flex rows in a report · missing row-index/inline-filter rows · centered numbers · a primary Add button.

## 4. Form View (saved document)

```text
┌ sidebar ┬─────────────────────────────────────────────────────────────────────────────────────┐
│         │ ⌂ / Release / REL-SHANGU-2026-00001  (Active)              [‹] [›] [⋯] [ Save ]        ← .page-head
│ (see 0) │─────────────────────────────────────────────────────────────────────────────────────│
│         │ Overview   Commercial   Scores                            │ .form-sidebar (saved only)│
│         │ ────────  ← active tab underline                          │ REL-SHANGU-202…   ⎙  ♡    │
│         │  Release Details                 ← section heading        │───────────────────────────│
│         │  Product Project *      Status                            │ Assign                 ＋ │
│         │  [Shangu Group ERP…]    [Active              ⇅]           │ Attachments            ＋ │
│         │  Project Template       Start Date                        │ Tags                   ＋ │
│         │  [                 ]    [06-07-2026          ]            │ Share                  ＋ │
│         │  Release Name *         End Date                          │───────────────────────────│
│         │  [Shangu Group ERP…]    [10-08-2027          ]            │ Last Edited By You        │
│         │  Description            Delivery Lead                     │ 1w                        │
│         │  [                 ]    [                    ]            │ Created By You            │
│         │  [                 ]    % Complete                        │ 1w                        │
│         │                         [0.000%              ]            │                           │
│         │─────────────────────────────────────────────────────────────────────────────────────│
│         │ Comments                                                                             │
│         │ (A) [Type a reply / comment                                              ]           │
│         │ Activity                                                       [＋ New Email]         │
│         │ • You last edited this · 1w                                                          │
│         │ • You created this · 1w                                                       (↑)    │
└─────────┴─────────────────────────────────────────────────────────────────────────────────────┘
```

- Breadcrumb: ⌂ / doctype (links to list) / **docname** + status `indicator-pill` inline after the title.
- Toolbar (saved doc): **‹ › prev/next document** icon buttons (`es-line-left-chevron`/`es-line-right-chevron`, from `form/toolbar.js`) · ⋯ form menu · primary button (`Save` → `Update` when dirty → `Submit` for submittables). A saved doc may also show `View ⇅` / `Create ⇅` inner-group-buttons before them.
- Tab bar: plain text tabs 13px/500, active = 2px bottom border `var(--gray-900)`; bar has a 1px border-bottom rule.
- Field grid: Bootstrap `col-sm-*` columns, label above gray control box (30px, `--control-bg`, radius 8); filled values **bold** (500, heading color); required = red `*` after label; selects/date fields get trailing ⇅/no native pickers.
- Document sidebar (**only after first save**): bold truncated docname + ⎙ print + ♡ like; rows Assign/Attachments/Tags/Share each with trailing `es-line-add` ＋; then two-line audit stacks (Last Edited By / Created By, 12px muted).
- Below the field area: **Comments** (avatar + reply input) then **Activity** timeline (bulleted, relative times) with `＋ New Email`; round scroll-to-top FAB bottom-right.
- New unsaved doc: no ‹ ›, no sidebar (grid runs full width), title `New {Doctype}`, orange `Not Saved` pill, primary = `Save`.

**Never:** a sidebar on an unsaved doc · a modal/wizard instead of the single scrolling page · blue primary Save · tabs styled as pills/cards.

## Chrome ownership matrix — which control belongs to which view

| Control | List | Report (query) | Form (saved) | Dashboard |
|---|---|---|---|---|
| `List View ⇅` + `Saved Filters ⇅` | ✔ | ✖ | ✖ | ✖ |
| `Actions ⇅` (btn-default) | only when rows selected (btn-primary) | ✔ always | ✖ | ✖ |
| ⟳ refresh icon button | ✔ | ✔ | ✖ (Reload lives in ⋯ menu) | ✖ |
| ⋯ menu icon button | ✔ | ✔ | ✔ | ✔ (the only control) |
| Primary button | `＋ Add {Doctype}` | ✖ | `Save`/`Update`/`Submit` | ✖ |
| ‹ › prev/next doc nav | ✖ | ✖ | ✔ | ✖ |
| `.page-form` filter row | standard filters + Filter/sort cluster | report filters only (no Filter/sort btn-groups) | ✖ | ✖ |
| `{n} of {total}` count + ♡ | list header row | `.list-count` in toolbar area | ✖ | ✖ |
| Page-length `20/100/500/2500` footer | ✔ | ✖ (datatable scrolls) | ✖ | ✖ |
| Tab bar | ✖ | ✖ | ✔ | ✖ |
| Document sidebar | ✖ | ✖ | ✔ saved only | ✖ |
| Number cards / chart cards | ✖ | ✖ | ✖ | ✔ |

If a prototype puts a control in a cell marked ✖, it's wrong — no exceptions for "looks nicer".
