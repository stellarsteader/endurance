# Design

Type, color, radius, and density for Endurance.
The values are CSS variables in `src/app/globals.css`.

Reading text is 15px. That is the largest size, headings in replies included. Page titles use it at medium weight.

## Type

| Role | Size | Line height | Use |
| --- | --- | --- | --- |
| Reading | 15px | 1.6 | Chat body, user messages, text being typed. Page titles use this size at medium weight. |
| UI | 13px | 1.4 | Session titles, settings menu, menu items, window title, settings row labels |
| Control | 12px | 1.35 | Model name on the composer, effort on a button, menu-row detail, settings hints, settings section labels, workspace tabs, pills |
| Meta | 11px | 1.3 | Group labels |
| Micro | 10px | 1.4 | Badges, counts |

Menu text is UI, including the effort menu. In a menu row, the label is UI and the detail beside it is Control.
Line height measures the text. Row height is separate, and the line box is centered in the row.

Use the sizes in the table.

UI text is Geist. Code is Geist Mono.

## Weight

Regular is 400. Medium is 500.
Names, page titles, and headings in replies are medium.
Session titles, menus, and body text are regular.

## Color

| Role | Token | Use |
| --- | --- | --- |
| Primary | `foreground` | Reading, UI labels, page titles |
| Secondary | `foreground` at 85% | Control labels |
| Muted | `muted-foreground` | Meta, micro, menu-row detail, settings hints, settings section labels |
| Disabled, placeholder | `muted-foreground` | Any role |

## Radius

| Role | Radius | Use |
| --- | --- | --- |
| Control | 6px | Sidebar rows, the filter and new buttons, chrome inputs |
| Row action | 4px | The 24px action on a 28px sidebar row: 6px minus the 2px inset |
| Menu row | 8px | Hover and selected rows inside a menu |
| Card | 12px | Settings cards, popovers, dropdowns |
| Composer | 16px | The composer, a user message, and the box for editing that message |
| Pill | full | The model name on the composer, switches, status dots, the context button |

A corner comes from a role in the table, or from the outer radius minus the padding.
Padding is the inset. The border sits outside the inset.

A surface without its own role uses the control radius.
Inside a rounded surface, every nested corner is the outer radius minus the padding, including the first and the last.
A menu row is 8px: the card is 12px and the padding is 4px.
A composer icon is 8px: the composer is 16px and the padding is 8px.

A control has one size and one radius.
The same radius on a smaller box looks rounder, so the radius stays with the control and with its container.

Specify px from this table. `rounded-lg`, `rounded-2xl`, and a component's default size are not radii in Endurance.

A menu divider is inset by the card padding, so it stops short of the corner.

Add, permissions, and voice are one control: 28px, 8px radius.
The send button is a pill.
Sidebar icon buttons are 28px at the control radius.

The search field and the filter and new buttons beside it are that control: 28px, 6px radius, 4px apart.
Hover, open, and pressed fills cover the box, border included. Ghost buttons have no border.
Focus keeps the same height and radius.

The context button is a circle under the composer.

## States

Open is stronger than hover. Hover is a translucent fill. Open, pressed, and selected are the full fill.
Hovering an open or selected control keeps the full fill.

In the sidebar, every hover fill is `sidebar-accent` at 60%. Selected and open are `sidebar-accent`.

A control that appears with a state, such as reset to default, always holds its space.
It fades in and moves nothing around it.

## Stable layout

Hover, focus, selection, and loading change color, opacity, and icons. They never change layout.
Nothing moves because the pointer passed over it.

Size every element for its largest state from the first frame.
A row whose actions show on hover is as tall as those actions while they are hidden.
Text beside a hidden control starts where it will be when the control shows.

A hidden control is laid out, transparent, and ignores the pointer.
It is never mounted on hover. Hover and focus inside its container show it, so the keyboard reaches it too.

State never changes size:

- Selected and open use fill, not bold. Weight changes the width of text.
- A border that shows on focus replaces a transparent border of the same width. A ring sits outside the box.
- A label that changes, such as Copy and Copied, keeps its width. Prefer swapping icons of the same size.
- A spinner replaces an icon of the same size, in the same place.
- Counts, times, and sizes that update use tabular figures.

Only what the person opens may push content: an inline editor, a disclosure, a thread they expand.
The push follows their action, and closing returns everything to where it was.

A disclosure in the chat opens at once: a thought, an agent trace, a tool call, a plan, sources.
Its content is there in the next frame, with no height, fade, or slide. The chevron turns without a transition.
Rows inside it do not animate in when it opens.
The chat does not scroll to follow it; content that grows at the bottom shows in place.

The reply footer is the reference.
The actions are 28px icon buttons, then the model label.
On the last reply they are visible. On earlier replies they are laid out at full size and fade in on hover.
The model label and the checkpoint below stay where they are.

## Popups

A popup sits 6px from its trigger, measured to its ring.
The 1px ring sits outside the box, so the code uses a `sideOffset` of 7 (`POPUP_GAP`).
A submenu keeps the same 6px from its parent row.

A menu row's icon and label sit on the trigger's icon and label lines.
The card moves to make that true. The row padding stays the same.

Edges that nearly meet look like a mistake. They meet exactly or sit clearly apart.
A popup over the composer puts its ring on the composer's border.

## Cards

A card is one surface. Separate what is inside with space or a divider.

Code inside a card has a quiet background and no border.

A repeated object is its own card.
A test file stays inside its run, which is already the card.
A to-do list stays on the workspace panel, which is already the surface.

## Chat text

Markdown in a reply keeps the text's size and line height. Space, not size, shows its structure.
The same spacing holds in thoughts, the library, and summaries, at their own text size.

| Between | Space |
| --- | --- |
| Blocks: paragraphs, lists, code, tables, quotes | 12px |
| A paragraph and the list that follows it | 8px |
| List items, and a nested list below its item | 4px |
| A heading and what comes before it | 24px |
| A heading and what follows it | 4px |
| Text and a trace or tool card | 12px |

A heading is at the text's size, medium. It sits closer to what follows than to what came before, so it reads as the start of a section.
A reply that opens with a heading has no space above it.

The values are the `.chat-text` rules in `src/app/globals.css`.

## Agents

The list has 16px of padding. Group labels are UI, muted.
8px between a label and its rows. 24px between groups.

A row is one line. The name is 15px medium. The time is UI, muted. The mark is 24px.

Opening a row shows that agent's thread in the workspace panel. The chat stays where it is.
The header is the name at 15px medium and the model at UI, muted.
The body inset is 16px, and the turns are 24px apart.
The task and the result are Reading. The work line and each step are UI.
Back returns to the agent list.

## Density

Padding, gap, and margin sit on a 4px grid.
Type size, line height, icon size, and row height are independent of that grid.

Rows in a list are the exception: 2px apart, and a project row sits 2px above its first chat.
4px makes a long list loose. 0 lets a hover fill merge with the selected row.
Groups in the sidebar are 12px apart.

- Sidebar rows and the settings navigation are 28px.
- Dropdown rows are 26px.
- Icon buttons are 28px, in the sidebar and in the composer.
- Icons beside 13px text are 15px, in the sidebar and in menus. A trigger whose menu has icons uses the same 15px icon.

Sidebar content is inset 8px on both sides. Every row is the same width.
The scrollbar sits inside the right inset, so rows keep their width when the list scrolls.
Row icons start 8px into the row. A chat under a project starts where the project name starts: 8px, a 15px icon, 8px.

The sidebar footer puts the avatar on the icon line. The settings button sits 8px from the edge, under the new button.

The project and context buttons under the composer are inset 5px from its outer edge: the 1px border plus 4px.
That puts the project popup's ring on the composer's border.

## Sidebar session title

The title is UI and fills the row.
The row action is 24px. It overlays the trailing edge and takes no space in the row.
It shows on hover and stays visible while its menu is open.

Overflow fades across the last 32px, with no ellipsis.
The action sits in that fade, and the title fades across it.

Project names in the sidebar, and folder names in project settings, use the same fade.

## Settings

A settings page is a page title, then cards.
A named card has a section label above it.
The first card has no section label.

| Piece | Size | Line height | Color | Spacing |
| --- | --- | --- | --- | --- |
| Page title | 15px medium | 1.6 | Primary | Inset 8px from the card edge. 24px below, before the first card. |
| Section label | 12px regular | 1.35 | Muted | Inset 8px from the card edge. 8px above the card. 28px below the previous card. |
| Row label | 13px regular | 1.4 | Primary | Inside 12px padding on every side of the row. |
| Row hint | 12px regular | 1.35 | Muted | 4px below the row label's line box. |

Settings cards use the card radius, 12px.
A section label names a card, such as Typography or Agent Conversations.

Reset to default sits at the right end of a section label, or beside the control it resets.
It is always laid out and fades in when the value differs from the default.

Editing a row, such as a connection, opens its fields inline under the row. The rows below move down.
There is no dialog. The edit icon is a bare icon, not a bordered button.
A group label names a list inside a menu, such as Cloud models.
