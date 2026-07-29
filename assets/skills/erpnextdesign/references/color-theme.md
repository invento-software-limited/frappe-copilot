# Frappe/ERPNext Color & Theme System

## Theme switching mechanism

- Applied on `<html>` (`document.documentElement`) via **two attributes**:
  - `data-theme="light" | "dark"` — the one CSS selectors key off (`:root, [data-theme="light"] {...}` vs `[data-theme="dark"] {...}`)
  - `data-theme-mode="light" | "dark" | "automatic"` — the *user preference*, persisted server-side
- `automatic` resolves via `window.matchMedia("(prefers-color-scheme: dark)")`, with a listener that re-runs on OS theme change.
- Only two real palettes exist (Light = "Frappe Light", Dark = "Timeless Night"); "Automatic" just auto-picks one of the two.
- Dark mode also sets `color-scheme: dark` on the root (affects native form control rendering, scrollbars, etc.)

**To replicate:** put your CSS variables in `:root` (light defaults) and override a subset under `[data-theme="dark"]`. Toggle by setting the attribute on `<html>`, not by swapping classes on `<body>`.

## Base grey scale & semantic hue scale (identical values in both themes; only which token points to which shade changes)

Each hue has 10 steps, 50 (lightest) → 900 (darkest):

| Hue | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|---|
| gray | #f8f8f8 | #f3f3f3 | #ededed | #e2e2e2 | #c7c7c7 | #999999 | #7c7c7c | #525252 | #383838 | #171717 |
| blue | #f7fbfd | #edf6fd | #e3f1fd | #c9e7fc | #70b6f0 | #0289f7 | #007be0 | #0070cc | #005ca3 | #004880 |
| green | #f3fcf5 | #e4f5e9 | #daf0e1 | #cae5d4 | #b6dec5 | #59ba8b | #30a66d | #278f5e | #16794c | #173b2c |
| red | #fff7f7 | #fff0f0 | #fcd7d7 | #f9c6c6 | #eb9091 | #e03636 | #cc2929 | #b52a2a | #941f1f | #6b1515 |
| orange | #fff9f5 | #fff1e7 | #fce6d5 | #f7d6bd | #f0b58b | #e86c13 | #d45a08 | #bd3e0c | #9e3513 | #6b2711 |
| amber | #fdfaed | #fcf3cf | #f7e28d | #f5d261 | #f2be3a | #e79913 | #db7706 | #b35309 | #91400d | #763813 |
| yellow | #fffcef | #fff7d3 | #f7e9a8 | #f5e171 | #f2d14b | #edba13 | #d1930d | #ab6e05 | #8c5600 | #733f12 |
| cyan | #f5fbfc | #e0f8ff | #b3ecfc | #94e6ff | #6bd3f2 | #34bae3 | #32a4c7 | #267a94 | #125c73 | #164759 |
| teal | #f0fdfa | #e6f7f4 | #bae8e1 | #97ded4 | #73d1c4 | #36baad | #0b9e92 | #0f736b | #115c57 | #114541 |
| violet | #fbfaff | #f5f2ff | #e5e1fa | #dad2f7 | #bdb1f0 | #6846e3 | #5f46c7 | #4f3da1 | #392980 | #251959 |
| pink | #fff7fc | #feeef8 | #f8e2f0 | #f2d4e6 | #e9c4da | #e34aa6 | #cf3a96 | #9c2671 | #801458 | #570f3e |
| purple | #fdfaff | #f9f0ff | #f1e5fa | #e9d6f5 | #d6c1e6 | #9c45e3 | #8642c2 | #6e399d | #5c2f83 | #401863 |

Also: `--neutral-white:#ffffff`, `--neutral-black:#000000`; `--neutral` = white (light) / black (dark). Overlay ramps: `--white-overlay-50..900` and `--black-overlay-50..900` (rgba alpha 0.09→0.90).

**Note:** Frappe's "primary/brand" is grayscale by default, NOT blue — `--primary`/`--btn-primary` = gray-900 (`#171717`) in light mode. Blue (`blue-500`/`blue-600`) is used for links, focus rings, and info states, not as the dominant brand accent.

## Semantic tokens — LIGHT mode

| Category | Variable | Value |
|---|---|---|
| Brand | `--primary`, `--brand-color`, `--primary-color` | `var(--gray-900)` `#171717` |
| Backgrounds | `--bg-color`, `--fg-color`, `--card-bg`, `--navbar-bg`, `--modal-bg`, `--toast-bg`, `--popover-bg` | white |
| | `--subtle-accent` | `var(--gray-50)` |
| | `--subtle-fg`, `--fg-hover-color`, `--control-bg` | `var(--gray-100)` |
| | `--control-bg-on-gray` | `var(--gray-200)` |
| | `--disabled-control-bg`, `--placeholder-color` | `var(--gray-50)` |
| Text | `--heading-color`, `--text-neutral` | `var(--gray-900)` |
| | `--text-color` | `var(--gray-800)` |
| | `--text-muted` | `var(--gray-700)` |
| | `--text-light`, `--disabled-text-color` | `var(--gray-600)` |
| | `--text-dark` | `var(--fg-color)` |
| Borders | `--border-color`, `--table-border-color` | `var(--gray-200)` |
| | `--border-primary` | `var(--gray-900)` |
| | `--dark-border-color` | `var(--gray-300)` |
| Buttons | `--btn-primary` | `var(--gray-900)` |
| | `--btn-default-bg` | `var(--gray-100)` |
| | `--btn-default-hover-bg` | `var(--gray-300)` |
| | `--btn-ghost-hover-bg` | `var(--gray-200)` |
| Icons | `--icon-fill` | transparent |
| | `--icon-stroke` | `var(--gray-800)` |
| Scrollbar | `--scrollbar-thumb-color` / `--scrollbar-track-color` | `var(--gray-400)` / `var(--gray-200)` |
| Code | `--code-block-bg` / `--code-block-text` | `var(--gray-900)` / `var(--gray-400)` |

### Badge/tag/pill background+text pairs (light)

| Color | bg var → value | text var → value |
|---|---|---|
| blue | `--bg-blue` → blue-100 | `--text-on-blue` → blue-700 |
| light-blue | `--bg-light-blue` → blue-50 | `--text-on-light-blue` → blue-600 |
| dark-blue | `--bg-dark-blue` → blue-300 | `--text-on-dark-blue` → blue-800 |
| green | `--bg-green` → green-100 | `--text-on-green` → green-800 |
| yellow | `--bg-yellow` → yellow-100 | `--text-on-yellow` → yellow-700 |
| orange | `--bg-orange` → orange-100 | `--text-on-orange` → orange-700 |
| red | `--bg-red` → red-100 | `--text-on-red` → red-700 |
| gray/grey | `--bg-gray`/`--bg-grey` → gray-100 | `--text-on-gray` → gray-700 |
| dark-gray | `--bg-dark-gray` → gray-400 | `--text-on-dark-gray` → gray-800 |
| light-gray | `--bg-light-gray` → gray-100 | `--text-on-light-gray` → gray-800 |
| purple | `--bg-purple` → purple-100 | `--text-on-purple` → purple-700 |
| pink | `--bg-pink` → pink-50 | `--text-on-pink` → pink-700 |
| cyan | `--bg-cyan` → cyan-50 | `--text-on-cyan` → cyan-700 |

Alerts: danger red-600 text / red-50 bg · warning yellow-700 / yellow-50 · info blue-700 / blue-50 · success green-700 / green-100.
Diff: added green-200 · removed red-200 · changed blue-200.

## Semantic tokens — DARK mode (only redefinitions; everything else inherits light)

Base scale override: `--gray-700:#383838`, `--gray-800:#232323` (rest of the grey scale is unchanged).

| Variable | Dark value |
|---|---|
| `--bg-color`, `--fg-color`, `--card-bg`, `--modal-bg`, `--popover-bg` | `var(--gray-900)` `#171717` |
| `--subtle-accent` | `var(--gray-800)` `#232323` |
| `--subtle-fg`, `--fg-hover-color` | `var(--gray-800)`/`var(--gray-700)` `#383838` |
| `--control-bg`, `--control-bg-on-gray`, `--disabled-control-bg` | `var(--gray-800)` |
| `--disabled-text-color` | `var(--gray-400)` |
| `--text-color` | `var(--gray-50)` `#f8f8f8` |
| `--heading-color`, `--text-neutral` | `var(--gray-50)` |
| `--text-dark` | `var(--gray-900)` |
| `--text-muted` | `var(--gray-400)` |
| `--text-light` | `var(--gray-300)` |
| `--border-color` | `var(--gray-800)` |
| `--border-primary` | `var(--gray-200)` |
| `--dark-border-color` | `var(--gray-600)` |
| `--btn-default-bg` | `var(--gray-800)` |
| `--btn-default-hover-bg` | `var(--gray-700)` |
| `--btn-primary` | `var(--gray-300)` |
| `--icon-stroke` | `var(--gray-300)` |
| `--scrollbar-thumb-color` / track | gray-600 / gray-700 |
| `--placeholder-color` | `var(--gray-700)` |
| `--error-bg` | `var(--red-800)` |
| `--diff-added/removed/changed` | green-800 / red-800 / blue-800 |
| `--shadow-base` | `0px 4px 8px rgba(114,176,233,.06), 0px 0px 4px rgba(112,172,228,.12)` |
| `--highlight-shadow` | `1px 1px 10px var(--blue-900), 0px 0px 4px var(--blue-500)` |
| `color-scheme` | `dark` |

Badge pairs shift up a shade for contrast, e.g.: `--bg-blue: blue-600` / `--text-on-blue: blue-50`; `--bg-green: green-900` / `--text-on-green: green-100`; `--bg-red: red-600`; `--bg-gray/grey: gray-600`; `--bg-purple: purple-700`; `--bg-pink: pink-700`; `--bg-cyan: cyan-800`. Alerts invert to darker bg + lighter text (e.g. `--alert-bg-danger: red-900`, `--alert-text-danger: red-300`).

## Typography tokens

- **Font stack:** `"InterVariable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`
- **Base:** `html, body { font-size: 16px }`; Bootstrap base `0.875rem` (14px)
- **Size scale:** tiny 11px · 2xs/xs 12px · sm 13px · md/base 14px · lg 16px · xl 18px · 2xl 20px · 3xl 24px · 4xl 26px · 5xl 28px · 6xl 32px · 7xl 40px · 8xl 44px · 9xl 48px · 10xl 52px · 11xl 56px · 12xl 64px
- **Headings:** h1 28px · h2 24px · h3 20px · h4 18px · h5 14px · h6 11px
- **Weights:** `--weight-regular:420`, `--weight-medium:500`, `--weight-semibold:600`, `--weight-bold:700`, `--weight-black:800`
- Text color tokens: `--heading-color`, `--text-color`, `--text-muted`, `--text-light`, `--text-neutral`, `--text-dark`

## Spacing scale

Padding/margin steps use the same suffixes: xs 5px · sm 7px · md 15px · lg 20px · xl 30px · 2xl 40px.
Component-specific: `--input-padding: 6px 8px`, `--dropdown-padding: 4px 8px`, `--grid-padding: 10px 8px`, `--number-card-padding: 8px 8px 8px 12px`.

## Border radius scale

`--border-radius-tiny:4px` · `--border-radius-sm:8px` · `--border-radius:8px` · `--border-radius-md:10px` · `--border-radius-lg:12px` · `--border-radius-xl:16px` · `--border-radius-2xl:20px` · `--border-radius-full:999px`

## Shadow/elevation scale (same values both themes, except `--shadow-base`/`--highlight-shadow` redefined in dark — see above)

| Token | Value |
|---|---|
| `--shadow-xs` | `rgba(0,0,0,.05) 0 .5px 0 0, rgba(0,0,0,.08) 0 0 0 1px, rgba(0,0,0,.05) 0 2px 4px 0` |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.1)` |
| `--shadow-base` | `0 0 1px rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.1)` |
| `--shadow-md` | `0 0 1px rgba(0,0,0,.12), 0 .5px 2px rgba(0,0,0,.15), 0 2px 3px rgba(0,0,0,.16)` |
| `--shadow-lg` | `0 0 1px rgba(0,0,0,.35), 0 6px 8px -4px rgba(0,0,0,.1)` |
| `--shadow-xl` | `0 0 1px rgba(0,0,0,.19), 0 1px 2px rgba(0,0,0,.07), 0 6px 15px -5px rgba(0,0,0,.11)` |
| `--shadow-2xl` | `0 0 1px rgba(0,0,0,.2), 0 1px 3px rgba(0,0,0,.05), 0 10px 24px -3px rgba(0,0,0,.1)` |

Focus rings (all `0 0 0 2px <color>`): default `#c9c9c9` · blue `#65b9fc` · green `#5bb98c` · yellow `#fff0ad` · red `#eb9091`.
Aliases: `--modal-shadow: var(--shadow-md)`, `--card-shadow: var(--shadow-sm)`, `--btn-shadow: var(--shadow-xs)`.

## Minimal CSS to bootstrap a clone

```css
:root {
  --gray-50:#f8f8f8; --gray-100:#f3f3f3; --gray-200:#ededed; --gray-300:#e2e2e2;
  --gray-400:#c7c7c7; --gray-500:#999999; --gray-600:#7c7c7c; --gray-700:#525252;
  --gray-800:#383838; --gray-900:#171717;
  --blue-500:#0289f7; --blue-600:#007be0; --green-500:#59ba8b; --red-500:#e03636;

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
