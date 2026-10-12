# DD2 Save Manager — design

A quiet tool that sits beside a dark game, usually at night. It should read at a glance, leave
room around everything, and never compete with the game for attention.

Reference: the **Linear** entry of the awesome-design-md collection (see `docs/design-source.md`).
Taken from it: hierarchy through a ladder of surfaces and hairlines instead of shadows, one scarce
accent, weight 600 headings over weight 400 body, a 4px spacing base, 8px controls in 12px panels,
"the dark canvas is the whitespace". Changed for this product: the canvas is a warm charcoal rather
than Linear's blue-black, and the accent is an aged gold rather than lavender, to sit next to
Dragon's Dogma 2 without dressing up as it.

The values below live in `web/styles.css` as CSS variables; this file explains them. Keep the two
in step.

## Colour

| Token | Value | Use |
|---|---|---|
| `--canvas` | `oklch(0.155 0.006 75)` | Window background; the whitespace |
| `--surface-1` | `oklch(0.19 0.007 75)` | Panels, the sidebar |
| `--surface-2` | `oklch(0.225 0.008 75)` | Inputs, hovered rows, raised parts inside a panel |
| `--surface-3` | `oklch(0.265 0.009 75)` | Menus, toasts, the apply bar |
| `--hairline` | `oklch(0.27 0.008 75)` | 1px borders and dividers |
| `--hairline-strong` | `oklch(0.36 0.01 75)` | Input borders, focused or hovered edges |
| `--ink` | `oklch(0.94 0.01 85)` | Headings and values |
| `--ink-muted` | `oklch(0.78 0.014 85)` | Body text, labels |
| `--ink-subtle` | `oklch(0.63 0.014 85)` | Hints, meta, column heads |
| `--ink-faint` | `oklch(0.48 0.012 85)` | Disabled, placeholders |
| `--accent` | `oklch(0.8 0.105 82)` | The one accent: primary action, selection, focus, "changed" |
| `--ok` / `--warn` / `--danger` | green / amber / red | State only, never decoration |

- The accent is scarce. It marks the primary button, the selected item, the focus ring and values
  the user has changed. It is not a background for sections.
- No second accent, no gradients, no glow. State colours appear only with the state they report.
- Text contrast: body text on any surface stays above 4.5:1.

## Type

One family, system fonts only (nothing is downloaded): Pretendard if installed, then Segoe UI
Variable, then the system font of the language in use (Malgun Gothic, Yu Gothic UI, Microsoft
YaHei UI). The `lang` attribute on `<html>` picks the CJK order so Han characters render in the
right national forms.

| Role | Size / weight / tracking |
|---|---|
| View title | 22px / 600 / -0.02em |
| Panel title | 15px / 600 / -0.01em |
| Body, controls | 14px / 400 |
| Small, table cells | 13px / 400 |
| Caption, column heads | 12px / 500 |

Numbers use tabular figures. No uppercase eyebrows, no letter-spaced labels.

## Space and shape

- 4px base: 4, 8, 12, 16, 24, 32, 48, 64.
- Panels: 24px inside, 12px radius, a hairline, 32px between panels. Views start 40px below the
  title bar and keep a measure of 920px; the canvas shows on both sides.
- Controls: 32px tall, 8px radius, 12px horizontal padding. Compact, never pill-shaped.
- Inside a panel, groups are separated by a hairline and 24px, not by nested boxes.
- Tables: 44px rows, no zebra, a hairline between rows, hover lifts the row to `--surface-2`.

## Layout

- A frameless window: a 40px title bar that is the drag area (brand, game state, language, window
  buttons), a 232px sidebar, and the content column, which is the only part that scrolls.
- The sidebar holds the two views and, under Edit, the sections of the save with their count of
  pending changes.
- The apply bar rises from the bottom of the content column only while there is something to
  apply; it is the single place the primary button lives.
- Text can be a third longer in French or Spanish than in Korean. Nothing that holds text has a
  fixed width; labels wrap, buttons grow.

## Elevation

Surfaces and hairlines carry depth. Shadows are kept for what floats above the page: menus,
toasts and the apply bar. Lifted panels get a faint light edge on top (`inset 0 1px` at 4% white).

## Motion

Motion explains a change or confirms a press; it is never decoration. If something is used many
times a minute (typing, ticking boxes, switching tabs with the keyboard) it does not animate.

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Anything entering or responding |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Things that move while staying on screen |
| `--t-fast` | 120ms | Hover, press, colour |
| `--t-base` | 180ms | Menus, badges, rows, the selection marker |
| `--t-slow` | 260ms | View changes, panels opening, the apply bar |

- Views cross-fade with a 6px rise; panels of a freshly opened view follow in a short stagger
  (30ms apart, first six only).
- The sidebar's selection marker slides between items.
- Buttons press to 0.97; nothing scales up from zero.
- A count badge pops when its number changes; a value that was just applied flashes its field once.
- Enter is slower than exit (exit about two thirds of the enter time).
- Only `transform` and `opacity` animate. With "reduce motion" on, movement is removed and only
  short fades remain.

## States

Every view has its loading (skeleton rows, not spinners), empty, error and read-only states, and
every control its hover, focus-visible, disabled and invalid states. The game running is a state
of the whole window: writes are blocked and the title bar says so.

## Don't

- Don't add a second accent, gradients, glass or glow.
- Don't put panels inside panels.
- Don't use shadows to separate sections.
- Don't animate layout properties, and don't animate what the user does all the time.
- Don't hard-code widths around text.
