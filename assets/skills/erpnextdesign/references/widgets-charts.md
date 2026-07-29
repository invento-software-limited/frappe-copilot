# Frappe/ERPNext Dashboard Widgets: Number Cards, Charts, Workspace Cards

## Base widget shell (shared by every widget type)

```html
<div class="widget" data-widget-name="...">
  <div class="widget-head">
    <div class="widget-label">
      <div class="widget-title"></div>
      <div class="widget-subtitle"></div>
    </div>
    <div class="widget-control"></div>
  </div>
  <div class="widget-body"></div>
  <div class="widget-footer"></div>
</div>
```

`.widget { padding: 7px; border-radius: var(--border-radius-lg) (12px); background-color: var(--card-bg); height: 100% }`. Hover elevation only with `.widget-shadow`: `box-shadow: var(--shadow-base)`. Number Card and Chart widgets both opt into shadow.

## Number Card

Adds `.number-widget-box` on top of `.widget`:

```css
&.number-widget-box {
  cursor: pointer;
  min-height: 84px;
  padding: 12px;
  border: 1px solid var(--border-color);
  .widget-title { font-weight: var(--weight-medium); font-size: var(--text-sm); }  /* 13px */
  .widget-content { padding-top: 12px; }
  .number { font-size: var(--text-2xl) /* 20px */; font-weight: 600; line-height: var(--text-line-height-3xl) /* 115% */; color: var(--text-color); }
}
```

Body markup:

```html
<div class="widget-content">
  <div class="number" style="color: <card_doc.color>">42.5K</div>
  <div class="card-stats <green-stat|red-stat|grey-stat>">
    <span class="percentage-stat-area">
      <span class="indicator-pill-round green"><svg icon="es-line-arrow-up-right"></svg></span>
      5% since yesterday
    </span>
  </div>
</div>
```

Trend colors: `.green-stat { color: var(--green-500) }` `#59ba8b`, `.red-stat { color: var(--red-500) }` `#e03636`, `.grey-stat { color: var(--gray-600) }` `#7c7c7c` (used when there's no meaningful delta — no arrow icon shown, just gray text). `.indicator-pill-round` is an 18px circle holding a 10×10 up/down-right arrow icon.

### Number card grid

Multiple cards live in a parent `.widget-group` (workspace) or `.dashboard-view` (Dashboard page):
- `.grid-col-2`: `grid-template-columns: 1fr 1fr; column-gap: 15px; row-gap: 15px` — the standard number-card layout (2-up)
- `.grid-col-3`: `repeat(auto-fill, minmax(300px, 1fr))`
- `.grid-col-1`: `repeat(auto-fill, minmax(550px, 1fr))` (used for charts)
- On a Dashboard page, `.grid-col-2` gaps widen to 20px.
- Responsive: below 768px, `grid-col-2`/`grid-col-3` collapse to `repeat(auto-fill, minmax(300px,1fr))`, `grid-col-1` to `minmax(250px,1fr)`.

## Dashboard Chart

Adds `.dashboard-widget-box` (+ `.full-width` for wide charts, `.heatmap-chart` for heatmaps):

```css
&.dashboard-widget-box {
  min-height: 240px;
  border: 1px solid var(--border-color);
  .widget-head { padding: 4px 8px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; }
  .widget-subtitle { font-size: var(--text-sm); color: var(--text-muted); margin-top: var(--margin-xs); }
  .widget-body { padding-top: 7px; }
  .chart-loading-state { border-radius: 7px; background-color: var(--subtle-accent); }
}
```

Chart actions menu:

```html
<div class="chart-actions dropdown pull-right">
  <button class="btn btn-xs btn-secondary chart-menu"><svg class="icon icon-sm"><use href="#icon-ellipsis"/></svg></button>
  <ul class="dropdown-menu dropdown-menu-right">...</ul>
</div>
```

Filter controls: `.time-interval-filter` / `.timespan-filter` pills, `.filter-chart.btn.btn-xs` (funnel icon).

**Default series color**: `frappe.utils.make_chart()` falls back to `colors: ["light-blue"]` (a named frappe-charts color token) when the Dashboard Chart doc has no custom `y_axis[].color`. Per-chart custom colors come straight from the doc, e.g. `#5e64ff`. There is no hardcoded categorical palette array in Frappe's own JS beyond what frappe-charts ships internally.

**Heatmap legend** (hardcoded, GitHub-contribution-graph style, light→dark green):
```
#ebedf0, #c6e48b, #7bc96f, #239a3b, #196127
```

## Workspace widget group (masonry/grid container)

```css
.widget-group {
  margin-bottom: var(--margin-2xl);
  .widget-group-head { display:flex; justify-content:space-between; align-items:center; }
  .widget-group-title { color: var(--heading-color); font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--margin-md); }
}
```
Grid variants: see `.grid-col-1/2/3` above.

### Shortcut widget (`.shortcut-widget-box`)

```css
&.shortcut-widget-box {
  cursor: pointer;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  &:hover { border-color: var(--invert-neutral); .widget-title { color: var(--invert-neutral); } }
  .widget-label .widget-title { font-size: var(--text-lg); }
  .indicator-pill { font-size: var(--text-xs); }
}
```

### Links widget (`.links-widget-box`)

```css
&.links-widget-box {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  .widget-head .widget-label .widget-title { font-size: var(--text-base); font-weight: var(--weight-medium); }
  .link-item {
    display: flex; font-size: var(--text-sm); color: var(--text-color);
    padding: 4px; margin-left: -4px; border-radius: var(--border-radius-md); /* 10px */
    &:first-child { margin-top: 12px; }
    .link-content:hover { color: var(--invert-neutral); }
    .disabled-link { color: var(--text-muted); }
  }
}
```

### Onboarding widget (`.onboarding-widget-box`)

Full-bleed banner, breaks out of the card grid: `margin: 0 -15px; padding: 0 15px; padding-bottom: 30px; background-color: var(--bg-color); border-bottom: 1px solid var(--border-color); border-radius: 0`.

### Shared conventions across widget types

- Border `1px solid var(--border-color)` on all interactive card variants (base `.widget` itself has no border unless a modifier adds one).
- Radius `var(--border-radius-lg)` (12px) on the widget root.
- Hover: either `.widget-shadow` (`box-shadow: var(--shadow-base)`) or `border-color: var(--invert-neutral)` (shortcut/links).
- Drag-reorder ghost: `.sortable-ghost { background-color: var(--gray-100); border-color: var(--gray-100); }`.
- Empty/placeholder slot: `.new-widget { border: 1px dashed var(--gray-400); background-color: var(--control-bg); min-height: 65px; }`.

## Component recipe (minimal clone)

```html
<div class="widget-group" style="display:grid;grid-template-columns:1fr 1fr;gap:15px">
  <div class="number-card" style="padding:12px;border:1px solid var(--border-color);border-radius:12px;background:var(--card-bg)">
    <div style="font-weight:500;font-size:13px;color:var(--text-muted)">Total Sales</div>
    <div style="font-size:20px;font-weight:600;margin-top:12px">42.5K</div>
    <div style="color:var(--green-500);font-size:12px;display:flex;align-items:center;gap:4px;margin-top:4px">
      <span style="display:inline-flex;width:18px;height:18px;border-radius:50%;align-items:center;justify-content:center;background:var(--bg-green)">↑</span>
      5% since yesterday
    </div>
  </div>
</div>
```
