# FigJam Quick Bar Study

This note is a product and interaction study for Mivo. It intentionally studies public FigJam behavior, public Figma help articles, and mature open-source canvas tools. It does not reverse engineer or copy private FigJam code.

## Goals

- Make Mivo quick bars feel closer to FigJam: compact, contextual, icon-led, and low-risk.
- Treat secondary quick-bar menus as first-class UI, not generic vertical command lists.
- Keep complete/rare/destructive actions in right-click menus.
- Preserve Mivo's own AI canvas direction: original assets are never overwritten, and every AI operation leaves readable metadata.

## Source Notes

- Figma help: [Make or edit an image with AI](https://help.figma.com/hc/en-us/articles/24004542669463-Make-or-edit-an-image-with-AI)
- Figma help: [Apply colors in FigJam](https://help.figma.com/hc/en-us/articles/1500004291341-Apply-colors-in-FigJam)
- Figma help: [Create diagrams and flows with connectors in FigJam](https://help.figma.com/hc/en-us/articles/1500004414542-Create-diagrams-and-flows-with-connectors-in-FigJam)
- Figma help: [Select, move, and order objects in FigJam](https://help.figma.com/hc/en-us/articles/1500004292221-Select-move-and-order-objects-in-FigJam)
- Figma help: [Visualize information using shapes with text](https://help.figma.com/hc/en-us/articles/1500004414382-Visualize-information-using-shapes-with-text)
- Open-source implementation references for Mivo decisions: [tldraw](https://github.com/tldraw/tldraw), [Excalidraw](https://github.com/excalidraw/excalidraw), and [react-colorful](https://github.com/omgovich/react-colorful).

## Core Rules

1. Quick bars are for the next likely action.
2. Quick bars should avoid destructive actions unless the object is temporary drawing markup.
3. Quick bars should avoid broad `Copy`; keyboard shortcuts and right-click are better places for copy.
4. Secondary menus should match the control type:
   - colors use swatch palettes
   - line weights use compact visual choices
   - line styles use segmented choices
   - AI image edit uses a vertical command list because each action starts a workflow
   - alignment uses an icon grid or compact icon list
5. Details are opened by double-click, not by a quick-bar button.
6. The selected object's primary visible state should be reflected in the quick bar: selected color ring, active stroke style, active lock state, current title visibility, current line endpoint mode.

## Quick Bar Matrix

| Selection | Primary quick bar | Secondary menus | Keep out of quick bar |
| --- | --- | --- | --- |
| Image | Crop, AI Edit | AI Edit workflow list | Details, Copy, Delete, Download |
| Text | Size, Bold, Align, Color | Color swatches; future font/size menu | Copy, Delete, Details |
| Markup shape | Edit text, Fill, Line, Duplicate, Front, Delete | Fill swatches, line palette + style + weight, arrowheads, corner radius | Copy, Download |
| Connector / Arrow | Edit text, Fill, Line, Arrowheads, Duplicate, Delete | endpoint/arrowhead choices, line choices | Copy |
| Section | Fill, Line, Rename, Title visibility, Lock, Focus | Fill palette, line palette + style + weight, lock choices | Copy, Delete with contents |
| Multi-select | Duplicate, Group/Ungroup, Align, Lock, Front | Align/distribute grid | Copy, Delete |
| AI Slot | Generate, Duplicate, Front | future prompt/model choices | Copy, Delete |
| AI Annotation | Generate, Edit, Duplicate | future source/result choices | Copy, Delete |
| Markdown | No quick bar for now | future display-mode toggle | Download, Copy, Delete |
| Video | No quick bar for now | future Play/Mute/Trim if needed | Download, Copy, Delete |
| PDF | Download original for now | future page picker / open detail | Copy, Delete |

## Secondary Menu Details

### Color Palette

FigJam's color menus feel like a palette, not a list. Mivo should keep:

- the toolbar Fill affordance as the current color chip, not a paint icon
- circular chips in a fixed grid
- a selected ring on the active chip
- checkerboard chip for transparent/no-fill
- accessible labels on each chip
- no visible color names in the compact menu
- optional custom color chip later

Mivo currently has this pattern for Section fill/line and Markup fill/line. Text color chips should share the same ring, chip size, and hover state.

Future custom color picker: prefer `react-colorful` because it is React-native, small, TypeScript-friendly, and dependency-free. Do not add it until users need arbitrary colors beyond presets.

### AI Image Edit

FigJam's public AI image-edit flow maps well to Mivo's image quick bar:

- Edit with prompt
- Select area
- Remove background
- Expand
- Boost resolution

Mivo should keep these as workflow starts, not pretend they are final AI integrations. Current behavior can create prompt/area annotation nodes or mock derived results, while storing `aiWorkflow.operation` as `prompt-edit`, `area-edit`, `remove-background`, `outpaint`, or `upscale`.

### Connector / Arrow

Connector secondary menus should eventually support:

- endpoint mode: none, start arrow, end arrow, both
- a combined Line menu with stroke color swatches, thin/medium/bold visual weight choices, and solid/dashed style
- connector type: straight, elbow, curved
- text label edit

Endpoint snapping should remain intentionally loose: hot zones near center/edges bind to objects, while free interior space allows loose arrows.

### Section

Section quick bars should read as organization controls:

- Fill palette with current-fill chip in the toolbar
- Line menu that combines border palette, border style, and thin/medium/bold border weight
- Rename
- Show/hide title
- Lock menu: lock background only, lock all, unlock
- Focus

Delete section and contents belongs in the right-click menu because it is destructive.

### Multi-select

Multi-select is mostly layout:

- Duplicate
- Group/Ungroup
- Align
- Distribute when 3+ objects are selected
- Lock/Unlock
- Front

Do not add Delete or Copy to the quick bar. Right-click and keyboard shortcuts are enough.

## Current Mivo Decisions

- Image quick bar is intentionally small: Crop + AI Edit.
- Markdown and Video quick bars should be hidden for now; their details are opened by double-click and right-click keeps complete actions.
- PDF keeps Download original in the quick bar because downloading a PDF source is a direct file action.
- Markup keeps Delete because temporary drawing cleanup is frequent and low-risk compared with deleting content assets or sections.
- No `More` button for now. If a quick bar needs `More`, that is a sign the action set should be reduced or moved to right-click.

## Implementation Checklist

- [x] Remove Details from quick bars.
- [x] Remove broad Copy actions from quick bars.
- [x] Remove most Delete actions from quick bars.
- [x] Use swatch palettes for Section and Markup colors.
- [x] Align Text color chip styling with the same palette system.
- [x] Use FigJam-like AI image actions for Image quick bar.
- [x] Remove Markdown and Video quick-bar download actions.
- [x] Replace text letters for Align/Distribute with proper icons.
- [x] Add active-state indicators for stroke width and dashed/solid style.
- [x] Split Section line secondary menu into color palette plus style/weight controls.
- [ ] Add connector type controls when elbow/curved connector geometry exists.
