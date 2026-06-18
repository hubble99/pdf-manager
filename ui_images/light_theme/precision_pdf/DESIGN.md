---
name: Precision PDF
colors:
  surface: '#faf8ff'
  surface-dim: '#d9d9e5'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3fe'
  surface-container: '#ededf9'
  surface-container-high: '#e7e7f3'
  surface-container-highest: '#e1e2ed'
  on-surface: '#191b23'
  on-surface-variant: '#434655'
  inverse-surface: '#2e3039'
  inverse-on-surface: '#f0f0fb'
  outline: '#737686'
  outline-variant: '#c3c6d7'
  surface-tint: '#0053db'
  primary: '#004ac6'
  on-primary: '#ffffff'
  primary-container: '#2563eb'
  on-primary-container: '#eeefff'
  inverse-primary: '#b4c5ff'
  secondary: '#505f76'
  on-secondary: '#ffffff'
  secondary-container: '#d0e1fb'
  on-secondary-container: '#54647a'
  tertiary: '#943700'
  on-tertiary: '#ffffff'
  tertiary-container: '#bc4800'
  on-tertiary-container: '#ffede6'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b4c5ff'
  on-primary-fixed: '#00174b'
  on-primary-fixed-variant: '#003ea8'
  secondary-fixed: '#d3e4fe'
  secondary-fixed-dim: '#b7c8e1'
  on-secondary-fixed: '#0b1c30'
  on-secondary-fixed-variant: '#38485d'
  tertiary-fixed: '#ffdbcd'
  tertiary-fixed-dim: '#ffb596'
  on-tertiary-fixed: '#360f00'
  on-tertiary-fixed-variant: '#7d2d00'
  background: '#faf8ff'
  on-background: '#191b23'
  surface-variant: '#e1e2ed'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  title-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  toolbar-height: 56px
  sidebar-width: 260px
---

## Brand & Style

This design system is engineered for a high-performance PDF desktop application, prioritizing clarity, focus, and structural integrity. The brand personality is professional and dependable, designed to feel like a high-end productivity tool that fades into the background to let the user's content lead.

The aesthetic follows a **Modern Minimalist** approach. It leverages heavy whitespace and a strictly controlled color palette to reduce cognitive load during long periods of document review. Rather than using depth-based metaphors like heavy shadows or skeuomorphism, the system relies on high-contrast outlines, intentional alignment, and a sophisticated typographic scale to establish hierarchy. The result is an "airy" interface that feels fast, precise, and native to modern desktop environments.

## Colors

The palette is centered on a "Pure White" surface to mimic the physical paper experience while providing a sterile, distraction-free environment. 

- **Primary (Brilliant Blue):** Used for critical actions, active states, and focus indicators. It provides a high-energy contrast against the white canvas.
- **Secondary (Slate Gray):** Reserved for metadata, secondary icons, and supportive text to maintain a calm visual hierarchy.
- **Accent:** A softer blue used for hover states and subtle highlights (e.g., text selection).
- **Error:** A vibrant red for destructive actions or PDF validation errors.
- **Borders:** A consistent light gray (#E2E8F0) is used to define regions (sidebars, toolbars) without the visual weight of shadows.

## Typography

The design system utilizes **Inter** exclusively to ensure maximum legibility and a systematic, utilitarian feel. 

The typographic hierarchy is intentionally tight. Since this is a desktop application, font sizes are optimized for high-density information display. We use a bold weight for headlines to create immediate "anchor points" on the page, while body text uses a standard weight with generous line height to prevent eye fatigue during reading. Labels use a slightly heavier weight and occasional uppercase styling to differentiate them from interactive text.

## Layout & Spacing

This design system uses a **Fixed-Fluid Hybrid** layout. 
- **Sidebars & Toolbars:** Fixed widths (260px) and heights (56px) ensure that navigation and tools are always in a predictable location.
- **Document Canvas:** A fluid central area that centers the PDF content, providing "Infinite" vertical scrolling.

A strict **4px grid** governs all internal spacing. Elements like buttons and input fields are separated by 8px or 12px, while larger sections (like the Inspector Panel vs. the Page Thumbnails) are separated by 24px of whitespace. Padding inside containers is consistently 16px to maintain an "airy" feel even in data-dense sidebars.

## Elevation & Depth

In line with the minimalist philosophy, this design system eschews traditional shadows in favor of **Tonal Seperation** and **Ghost Outlines**.

- **Level 0 (Canvas):** The background of the application is a very light gray (#F8FAFC).
- **Level 1 (Surface):** The document and main panels are #FFFFFF, separated from the background by a 1px border (#E2E8F0).
- **Level 2 (Popovers/Modals):** Only critical overlays (menus, dialogs) use a subtle, 4px blur shadow with 5% opacity to provide just enough separation from the UI beneath. 

Depth is primarily communicated through color shifts: an active sidebar item uses a light blue tint (#EFF6FF) rather than an inner shadow.

## Shapes

The shape language is disciplined and consistent. A base **8px (0.5rem)** radius is applied to almost all interactive components—buttons, input fields, and cards. 

- **Small elements:** Checkboxes and small tags use a 4px radius.
- **Large containers:** Modals and document thumbnails use the 8px standard.
- **Pill-shapes:** Only used for "Status" indicators (e.g., 'Signed', 'Draft') to distinguish them from functional buttons.

## Components

### Buttons
- **Primary:** Solid #2563EB with white text. No gradient. 8px corner radius.
- **Secondary:** White background with a #E2E8F0 border and #475569 text.
- **Ghost:** No background or border. Primary color text. Used for toolbar icons.

### Input Fields
Inputs feature a 1px border (#E2E8F0). On focus, the border changes to Primary Blue and adds a 2px soft outer glow (accent color at 20% opacity). Labels are always positioned above the input in `label-md`.

### Toolbars
Horizontal containers with a fixed 56px height. Use a single bottom border to separate from the content. Icons should be 20px in size, centered within a 36px clickable area.

### Document Thumbnails
Small previews of PDF pages should have an 8px radius and a subtle 1px border. When selected, the border thickness increases to 2px in the Primary Blue.

### Cards & Panels
Panels in the sidebar use `body-md` for content. Use a "Divided List" pattern where each item is separated by a 1px horizontal line, creating a clean, organized vertical stack.