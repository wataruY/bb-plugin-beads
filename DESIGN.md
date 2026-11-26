---
name: Beads issues for bb
description: The beads issue graph in a bb side panel. Legible at a glance, workable by thumb.
colors:
  background: "oklch(19.5% 0 0)"
  foreground: "oklch(81% 0 0)"
  muted-foreground: "oklch(78% 0 0)"
  subtle-foreground: "oklch(68% 0 0)"
  border: "oklch(31% 0 0)"
  primary: "oklch(82% 0 0)"
  primary-foreground: "oklch(21.78% 0 0)"
  surface-recessed: "oklch(23.5% 0 0)"
  surface-selected: "oklch(27% 0 0)"
  status-in-progress: "oklch(72% 0.09 250)"
  status-blocked: "oklch(65% 0.16 22)"
  status-closed: "oklch(74% 0.15 155)"
  priority-high: "oklch(75% 0.16 50)"
  type-epic: "oklch(68% 0.18 295)"
typography:
  title:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.333
  meta:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.333
  id:
    fontFamily: "Moralerspace Krypton HW, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  touch: "44px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "{spacing.touch}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.subtle-foreground}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "{spacing.touch}"
  chip-property:
    backgroundColor: "{colors.surface-recessed}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "32px"
  issue-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "{spacing.touch}"
  issue-row-selected:
    backgroundColor: "{colors.surface-selected}"
  input-field:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
---

# Design System: Beads issues for bb

## Overview

**Creative North Star: "The Field Logbook"**

This is a working logbook carried into the field, not a dashboard on a wall.
The user opens it on a phone between other things. It has to say at once
what is moving, what is stuck, and what is ready, and it has to take a new
entry with one thumb. Every visual decision answers two questions: can this
be read in a glance, and can it be hit with a thumb? When style competes with
either, style loses.

The logbook is bound in bb's own cover. Colours, type, surfaces, and focus
rings come from bb's theme variables and follow bb's light and dark modes.
The panel adds only one layer of its own: the status vocabulary of beads,
which is glyphs and a few semantic hues. Layout follows the conventions users
know from GitHub, Linear, and Jira:

- a title-first form;
- property chips;
- a tree of epics and sub-issues;
- "Blocked by" and "Blocks" relation lists.

Density is comfortable, not compact. Desktop may tighten rows for pointer
input, but the phone layout is the baseline and the reference.

**Key Characteristics:**

- Monochrome bb chrome. Colour is spent only on state: status, blocking,
  priority, and type.
- Status is carried by glyph shape first and colour second.
- Rows and controls are sized for thumbs (44px) on touch, and tighten only
  for fine pointers.
- Metadata never drops below 12px.
- Flat surfaces. Tonal layers carry depth, not shadows.

## Colors

The chrome is a neutral grey scale from bb. Five semantic hues mark state,
and nothing else.

All values are bb theme variables. The frontmatter records the dark-theme
values. Light-theme values are in `.impeccable/design.json`. Always reference
the variable (`var(--timeline-accent)`, `bg-surface-recessed`), never the
literal.

Two text colours are derived from those variables in `panel.css`, because
some palettes' own values fall below 4.5:1 for text (Catppuccin Latte:
`--subtle-foreground` 2.7:1, `--warning` 1.8:1). Use `--beads-faint` and
`--beads-caution` for text, never the raw `--subtle-foreground` or
`--warning`.

### Primary
- **Ink Button** (`--primary`, oklch(82% 0 0) dark / oklch(27% 0 0) light): the
  single primary action on a screen, such as "Create issue" or "Save
  changes". It is high contrast against the background and never used
  decoratively.

### Semantic (state only)
- **Working Blue** (`--timeline-accent`, oklch(72% 0.09 250)): in progress.
  It fills half of the status glyph.
- **Stop Red** (`--destructive-text`, oklch(65% 0.16 22)): blocked, waiting
  on an open issue, errors, P0, and the bug type.
- **Done Green** (`--success`, oklch(74% 0.15 155)): closed, and sub-issue
  progress.
- **Caution Amber** (`--warning`, oklch(75% 0.16 50)): P1 priority. A 30%
  mix of it also marks search matches in row titles. P1 text uses
  `--beads-caution`, which caps the lightness at 0.45 in light themes.
- **Epic Violet** (`--pr-merged`, oklch(68% 0.18 295)): the epic type glyph.

### Neutral
- **Night Paper** (`--background`): the panel ground.
- **Ink** (`--foreground`): titles and primary text.
- **Pencil** (`--muted-foreground`): section labels and secondary text.
- **Faint Pencil** (`--beads-faint`): IDs, timestamps, placeholders, and
  idle icons. It is `--subtle-foreground` mixed toward Ink (35% in light,
  70% in dark) so it passes 4.5:1 on the background, and Ink itself on the
  selected tint.
- **Ruled Line** (`--border`): field outlines and dividers.
- **Recessed Tint** (`--surface-recessed`, 6% ink): hover, chips, label
  pills, and count pills.
- **Selected Tint** (`--surface-selected`): the selected row and the
  selected segment.

### Named Rules
**The State-Only Colour Rule.** Hue appears only where it encodes issue
state, priority, or type. Chrome, borders, buttons, and section headings stay
neutral. The one exception is the search-match highlight.

**The Shape-First Rule.** Every status reads without colour: a ring for
open, a half fill for in progress, a slash for blocked, a dashed ring for
deferred, and a filled check for closed. Colour only reinforces the shape.

## Typography

**Body Font:** Inter Variable (bb's UI font)
**Mono Font:** Moralerspace Krypton HW (bb's mono). Use it only for issue IDs.

**Character:** A plain, legible UI sans. Hierarchy comes from size and
weight steps, never from a second display face.

### Hierarchy
- **Title** (600, 15px, 1.375): the issue title in detail and the title input
  in the form. Balanced wrap, never truncated in detail.
- **Body** (400, 13px, 1.625): Markdown prose such as description,
  acceptance, design, and notes, plus form textareas. Use 16px inputs on
  touch so iOS does not zoom on focus.
- **Label** (500, 12px): section headings, property labels, and button text.
- **Row** (400, 13px on touch, 12px on fine pointer): issue titles in the
  list and tree.
- **Meta** (400, 12px): IDs, counts, dates, labels, and chip text.

### Named Rules
**The 12px Floor Rule.** No text is smaller than 12px. bb's `text-2xs`
(10px) is not used for anything the user must read. The incumbent panel
still uses `text-2xs` for chips, pills, IDs, and dates. Migrating those is
open work.

**The Tabular Numbers Rule.** Counts, progress (2/11), priorities, and dates
use `tabular-nums`.

## Layout

The panel is one column, mobile first.

**On a phone (coarse pointer, full-width panel):**
- Rows are 44px tall.
- Horizontal padding is 16px.
- The issue form and issue detail open full screen, with a back or Cancel
  control at top left.
- The primary action sits at top right of the header bar and stays reachable
  without scrolling.

**On desktop (fine pointer, narrow side panel):**
- Rows may tighten to 28 to 32px.
- Padding may tighten to 12 to 14px.
- The split layout (list over a resizable detail pane) is allowed because a
  pointer can hit the splitter.

**Rhythm:**
- 4px inside a cluster (glyph to text, chip to chip).
- 8px between related controls.
- 16px between sections.
- More space above a section heading than below it.

**Hierarchy of a screen:**
1. A header bar with the view controls and actions, or a back control.
2. The title.
3. The property chips.
4. The property rows (Parent, Owner, Labels).
5. The prose sections.
6. The relation sections (Sub-issues, Blocked by, Blocks).
7. The provenance footer.

## Elevation & Depth

The system is flat. Depth comes from tonal layers, not shadows:

- the recessed tint for hover and chips;
- the selected tint for the current row;
- outlined fields.

Two exceptions: the inline issue picker's dropdown and the Display menu get
a soft, offset shadow (`0 4px 12px -4px rgb(0 0 0 / 0.18)`) so they read as
floating over the rows below.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow is allowed
only on something that floats over content, such as a picker or popover.

## Shapes

- Corners are gently rounded:
  - 6px for rows, fields, and buttons (`rounded-md`);
  - 4px for small tags (`rounded`);
  - fully round for property chips and count pills.
- Borders are 1px in the ruled-line colour. They appear only on inputs,
  chips, segmented controls, the ID tag, and popovers.
- No cards. Sections are separated by space and headings, not boxes.

## Components

### Buttons
- **Primary:** the ink background with inverse text, 6px radius, and 500
  weight label. Use one per screen.
- **Ghost:** transparent with faint-pencil text and an icon plus a label
  (Edit, Sub-issue, Add, Cancel). It takes the recessed tint on hover.
- **Icon:** a square icon-only button for toolbar actions (`#`, Display,
  New issue, Refresh), with an `aria-label` and a `title`.
- **Hit area:** at least 44 by 44px on touch, even when the drawn icon is
  14px. Pad the button, don't enlarge the glyph.
- **Focus:** a 1 to 2px `--ring` outline on `:focus-visible`.
- **Disabled:** 40% opacity.

### Property chips
- **Style:** a pill with a 1px border on the raised surface. It holds a
  glyph and a label (status, priority, type).
- **Editable variant:** the chip wraps a transparent native `<select>`. This
  gives the platform picker on phones (a wheel or sheet) and full keyboard
  support. A small chevron marks it as editable.

### Issue rows (tree, grouped list, relation lists, picker)
- **Anatomy:** status glyph, type glyph (epic or bug only), title (truncated,
  full text in `title`), then optional meta: parent crumb, label, due date,
  progress, and a P0/P1 badge.
- **ID overlay:** with `#` on, the short ID (the issue prefix stripped) sits
  at the row's right end, over the meta. It is mono 12px in a 4px-radius tag
  with a 1px border, on an opaque panel-coloured halo. It is the only overlay
  in a row. It never moves or re-truncates the title, and it is not a tap
  target. Relation lists show it too.
- **States:** recessed tint on hover, selected tint on selection, and a ring
  on keyboard focus.
- **Closed issues:** the title is in faint pencil.
- **Context rows:** in the tree, an ancestor shown only because a descendant
  matches is dimmed. Its title is in faint pencil and the row is at 75%
  opacity.
- **Search matches:** matched title text gets the amber highlight.

### Inputs / Fields
- **Title input:** borderless at title size. The title is the form's
  headline.
- **Textareas:** a 1px ruled-line border, 6px radius, a transparent fill, and
  auto-growing height (`field-sizing: content`). bb's voice input
  (`experimental_VoiceInputTextarea`) is on every prose field.
- **Focus:** the border shifts to `--ring`.
- **Errors:** an inline tinted note, with Stop Red at 12% mix behind
  Stop Red text. It names the problem and the recovery.

### Navigation
The list toolbar has three rows. The approved mockup is
[`assets/mockups/panel-toolbar.html`](assets/mockups/panel-toolbar.html).

- **Header bar:** a Tree|Status segmented control, a spacer, then icon
  actions: `#` (ID overlay), Display, New issue, and Refresh. The segment
  labels collapse to icons when the panel is narrow. `#` takes the recessed
  tint while pressed. A dot on Display marks a menu-only value that differs
  from its default.
- **Search field:** full width under the header. It matches id, title, and
  label; a `#label` token matches labels only. `/` focuses it, and Esc
  clears it, then leaves it.
- **Status chips:** one per status, with the glyph and the count. Each chip
  toggles that status in the list. A hidden chip is dashed and faint.
  Deferred and closed are hidden by default. The row fits on one line at
  320px. On touch, each chip's hit area is at least 44px square. Three-digit
  counts can push it onto a second line, which is the intended fallback.
- **List note:** under the list, the match count and what the chips hide,
  with a Show link.
- **Display menu:** a popover with every view option. It holds Group by,
  Detail (desktop only), Show (one checkbox per status), Issue IDs, and
  Reset to defaults. It mirrors the header controls and holds no state of
  its own.
- **Where view state lives:** list view and detail mode are plugin settings.
  The panel writes them, so the settings page and the panel agree. Hidden
  statuses and the ID overlay are kept per project on each device. The
  search query is not kept.
- **Drill-in:** a back control at top left, with a chevron and the parent
  context ("Issues", "Cancel").

### Issue form (signature component)
One form, two variants. Create starts empty, or under a parent when opened
from an epic's "Sub-issue". Edit starts from the loaded issue, fixed at the
moment the form opened. The form reads top to bottom:

1. Header: Cancel, then "New issue" or "Edit issue" with the ID, then the
   primary action.
2. Title.
3. Description.
4. Status, priority, and type chips.
5. Parent and Labels rows.
6. "Blocked by" and "Blocks" relation sections with an inline search picker.
7. Acceptance, design, and notes, behind a disclosure.

⌘/Ctrl+Enter saves. Esc discards, but with unsaved changes it asks for a
second Esc first.

## Do's and Don'ts

### Do:
- **Do** use bb theme variables and Tailwind tokens (`text-foreground`,
  `bg-surface-recessed`, `var(--timeline-accent)`). Never use literal colours
  or Tailwind palette classes.
- **Do** give every touch target at least 44 by 44px on coarse pointers.
- **Do** keep text at 12px or larger, and use 16px in inputs on touch.
- **Do** pair every status colour with its glyph shape.
- **Do** follow issue-tracker conventions (title first, property chips,
  sub-issues, blocked-by) before inventing a pattern.
- **Do** show `bd`'s own error text inline and keep the user's draft intact.

### Don't:
- **Don't** add colour to chrome, headings, or buttons. Colour encodes state
  only.
- **Don't** use `text-2xs` (10px) for readable content.
- **Don't** reveal actions only on hover. Touch has no hover. The incumbent
  copy-ID button does this, and it should be made always visible or moved
  into a menu.
- **Don't** put a form or detail in a modal. They take over the panel, with
  a back control.
- **Don't** use cards, nested boxes, side-stripe accents, or decorative
  shadows.
