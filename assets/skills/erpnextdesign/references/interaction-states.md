# Frappe/ERPNext Interaction & Feedback States

Toasts, validation errors, empty/loading states, and confirm dialogs — the visual states a CRUD prototype needs beyond the static List/Form/Widget components. Same token system as everywhere else in this skill (`color-theme.md`).

## Toast / alert (save confirmation, errors, warnings)

```html
<div class="desk-alert alert-success" role="alert">
  <div class="alert-message">
    <svg class="icon icon-sm"><use href="#icon-solid-success"/></svg>
    Saved
  </div>
  <svg class="icon icon-xs alert-dismiss"><use href="#icon-close"/></svg>
</div>
```

```css
.desk-alert{
  position:fixed; right:20px; bottom:20px; z-index:2000;
  min-width:260px; max-width:380px; padding:10px 14px; border-radius:8px;
  background:var(--fg-color); box-shadow:var(--shadow-lg);
  border-left:3px solid var(--gray-400); /* overridden per variant below */
  font-size:14px; display:flex; align-items:center; gap:8px;
  animation:toast-in .15s ease-out;
}
.desk-alert + .desk-alert{ margin-bottom:8px; } /* stack upward as more arrive */
.desk-alert.alert-success{ border-left-color:var(--green-500); }
.desk-alert.alert-success svg{ stroke:var(--green-500); }
.desk-alert.alert-error{ border-left-color:var(--red-500); }
.desk-alert.alert-error svg{ stroke:var(--red-500); }
.desk-alert.alert-warning{ border-left-color:var(--orange-500,#e86c13); }
.desk-alert.alert-info{ border-left-color:var(--blue-500); }
.alert-dismiss{ margin-left:auto; opacity:0; cursor:pointer; }
.desk-alert:hover .alert-dismiss{ opacity:1; }
@keyframes toast-in{ from{ transform:translateY(8px); opacity:0 } to{ transform:translateY(0); opacity:1 } }
```

- Stacks bottom-right, newest on top, auto-dismiss after ~4–5s with a fade-out (reverse of `toast-in`); dismiss `×` only appears on hover, not permanently.
- Left color bar is the only thing that changes per severity — background/text stay the same neutral card colors in every variant.
- Save/Update/Delete should each fire exactly one toast (`"Saved"`, `"{Doctype} updated"`, `"{Doctype} deleted"`) — don't stack a toast **and** a full-page banner for the same event.

## Field validation error

```html
<div class="frappe-control has-error" data-fieldtype="Data">
  <label class="control-label">Customer <span class="text-danger">*</span></label>
  <div class="control-input-wrapper">
    <input class="input-with-feedback form-control">
  </div>
  <div class="help-box text-danger">Customer is required</div>
</div>
```

```css
.frappe-control .help-box{
  font-size:12px; color:var(--red-500); margin-top:4px; min-height:16px; /* reserve space so it never jank-shifts the grid when it appears/disappears */
}
.frappe-control.has-error input,
.frappe-control.has-error .input-with-feedback{
  border-color:var(--red-500) !important;
}
```

- Only the border goes red — Frappe does **not** tint the field's background red; the gray `--control-bg` fill stays as-is.
- On a failed Save attempt: focus + scroll to the first invalid field, mark it `.has-error`, and fire an `alert-error` toast: `"{Field Label} is mandatory"`.
- Clearing the error (user fixes the value) removes `.has-error` and the `.help-box` text immediately on next valid input, not only on next save attempt.

## Empty state (no records yet / no rows match filters)

```html
<div class="no-result text-center">
  <svg class="icon icon-xl empty-icon"><use href="#icon-small-file"/></svg>
  <div class="no-result-message">No Sales Invoice created yet</div>
  <button class="btn btn-primary btn-sm">+ Add Sales Invoice</button>
</div>
```

There is no dedicated "empty state" illustration in the real icon sprites (see `icons.md`) — `icon-small-file` at `.icon-xl` (40px) is a reasonable real substitute; don't invent an `icon-empty-state` id.

```css
.no-result{ padding:60px 20px; color:var(--text-muted); }
.no-result-message{ font-size:14px; margin-bottom:16px; }
```

- Centered in `.result-container`, replacing the row list and its header entirely (don't render a header row over zero data rows).
- Two copies depending on cause: genuinely empty doctype → message + a single primary "+ Add {Doctype}" CTA; filtered-to-zero → `"No results found for these filters"` + a plain-link "Clear Filters" instead of the CTA (never both a CTA and a clear-filters link at once).

## Loading / skeleton state

```html
<div class="list-row-container skeleton-row">
  <div class="skeleton-block" style="width:34px"></div>
  <div class="skeleton-block" style="width:140px"></div>
  <div class="skeleton-block" style="width:70px"></div>
  <div class="skeleton-block" style="width:90px"></div>
</div>
```

```css
.skeleton-row{ pointer-events:none; }
.skeleton-block{
  height:14px; border-radius:4px; margin-right:15px;
  background:linear-gradient(90deg,var(--gray-100) 25%,var(--gray-200) 37%,var(--gray-100) 63%);
  background-size:400% 100%; animation:skeleton-loading 1.4s ease infinite;
}
[data-theme="dark"] .skeleton-block,
@media (prefers-color-scheme:dark){ .skeleton-block{ background-image:linear-gradient(90deg,var(--gray-800) 25%,var(--gray-700) 37%,var(--gray-800) 63%); } }
@keyframes skeleton-loading{ 0%{ background-position:100% 50% } 100%{ background-position:0 50% } }
```

- Render 3–5 skeleton rows at the real row height (30–44px, matching List View §3) while data loads — never a bare spinner over blank list content.
- Respect `prefers-reduced-motion`: fall back to a static two-tone block (no animation) when set.

## Disabled controls

- `.btn:disabled,.btn[disabled]{ opacity:.5; cursor:not-allowed; }` — no hover-state change while disabled.
- Read-only fields (e.g. `Posting Time` in a New Sales Invoice form) use the same gray control box as an editable field, just `color:var(--text-muted)` instead of `var(--heading-color)`, and never change border/background on click/focus.

## Confirm dialog (destructive actions, e.g. Delete)

```html
<div class="modal-backdrop"></div>
<div class="modal-dialog confirm-dialog">
  <div class="modal-content">
    <div class="modal-header"><h5>Delete Sales Invoice</h5></div>
    <div class="modal-body">Are you sure you want to delete "Ajay"? This action cannot be undone.</div>
    <div class="modal-footer">
      <button class="btn btn-default btn-sm">Cancel</button>
      <button class="btn btn-sm btn-danger">Delete</button>
    </div>
  </div>
</div>
```

```css
.modal-backdrop{ position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:1040; }
.confirm-dialog{ max-width:480px; margin:10vh auto 0; } /* full create/edit form modals instead use 600-900px */
.modal-content{ background:var(--popover-bg); border-radius:var(--border-radius-lg); box-shadow:var(--shadow-lg); }
.modal-header{ padding:16px 20px; border-bottom:1px solid var(--border-color); }
.modal-body{ padding:20px; color:var(--text-color); }
.modal-footer{ padding:12px 20px; border-top:1px solid var(--border-color); display:flex; justify-content:flex-end; gap:8px; }
.btn-danger{ background:var(--red-500); color:#fff; border-color:var(--red-500); }
.btn-danger:hover{ filter:brightness(1.1); }
```

- `.btn-danger` is one of the only places a solid, non-grayscale primary-style button appears — Frappe's default primary is grayscale (see Color & Theme System), red is reserved specifically for destructive confirmation.
- Confirm dialogs are intentionally small (max-width ~480px) and centered higher (`margin-top:10vh`) than a full create/edit form modal (600–900px, more vertically centered) — don't reuse one size for both.
