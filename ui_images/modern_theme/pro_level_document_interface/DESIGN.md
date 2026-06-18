---
name: Pro-Level Document Interface
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#c0c7d4'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#8a919e'
  outline-variant: '#414752'
  surface-tint: '#a4c9ff'
  primary: '#a4c9ff'
  on-primary: '#00315d'
  primary-container: '#4a9eff'
  on-primary-container: '#003463'
  inverse-primary: '#005fad'
  secondary: '#c8c6c5'
  on-secondary: '#303030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#ffb869'
  on-tertiary: '#482900'
  tertiary-container: '#de8800'
  on-tertiary-container: '#4d2c00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d4e3ff'
  primary-fixed-dim: '#a4c9ff'
  on-primary-fixed: '#001c39'
  on-primary-fixed-variant: '#004884'
  secondary-fixed: '#e4e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1b1c1c'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#ffdcbb'
  tertiary-fixed-dim: '#ffb869'
  on-tertiary-fixed: '#2c1700'
  on-tertiary-fixed-variant: '#683d00'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  title-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.4'
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.6'
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.05em
  mono-label:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  sidebar-width: 280px
  gutter: 24px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
  container-padding: 40px
---

## Brand & Style

The design system is engineered for high-performance desktop productivity. It targets professionals who manage high volumes of technical documentation, requiring a UI that recedes to prioritize content while maintaining a premium, "pro-tool" aesthetic.

The style is **Corporate / Modern** with a lean toward **Minimalism**. It utilizes a sophisticated dark-mode palette to reduce eye strain during prolonged sessions. Visual interest is generated through high-contrast accent points and crisp, functional geometry rather than decorative flourishes. The emotional response should be one of precision, reliability, and technical mastery.

## Colors

This design system utilizes a deep-space monochromatic base to create a sense of infinite canvas depth. 

- **Core Palette**: The primary `#4A9EFF` (Electric Blue) is reserved for high-intent actions and critical status indicators.
- **Surface Strategy**: We use a tiered dark approach. The base background is absolute, while surfaces at `#1A1A1A` define the primary working containers. 
- **Interactions**: State changes (hover/active) move through subtle grey increments rather than shifts in hue, keeping the interface stable and predictable.
- **Semantic Badges**: Success, Warning, and Info colors are used with reduced opacity backgrounds (15%) and full-saturation text to ensure legibility without breaking the dark-mode harmony.

## Typography

The typography system relies on **Inter** for its exceptional legibility in data-dense environments. 

- **Hierarchy**: Large display sizes use tighter letter spacing and heavier weights to feel "anchored." 
- **Functional Labels**: Small labels use uppercase with increased tracking to ensure they remain readable against dark backgrounds. 
- **Readability**: Body text is set at 14px to maximize the amount of information visible on screen without sacrificing comfort. For metadata or file paths, a monospaced font may be used as a secondary support.

## Layout & Spacing

The layout is a **Fixed-Fluid Hybrid**. A permanent 280px left sidebar handles navigation and global filters, while the main content area utilizes a fluid grid to maximize the workspace for document viewing and processing.

- **Grid**: A standard 12-column grid is used within the main content area.
- **Sidebars**: Right-hand contextual sidebars (for file properties or rule configuration) should be 320px when toggled.
- **Rhythm**: All spacing follows an 8px base unit. Component internal padding is typically 12px or 16px to maintain a compact, professional feel.

## Elevation & Depth

Depth is communicated through **Tonal Layering** and **Low-Contrast Outlines** rather than heavy shadows.

- **Layer 0 (Base)**: `#0F0F0F` - The application backdrop.
- **Layer 1 (Cards/Sidebar)**: `#1A1A1A` with a 1px border of `#2A2A2A`.
- **Layer 2 (Modals/Popovers)**: `#242424` with a subtle 16px blur ambient shadow (Black, 40% opacity) and a `#333333` border.
- **Interaction**: Hovering over interactive elements should lift them slightly by changing the background to `#242424` or brightening the border to `#4A9EFF`.

## Shapes

The shape language is modern and consistent. 
- **Standard Radius**: 12px (`rounded-lg`) is used for primary cards, modals, and drag-and-drop zones to soften the professional aesthetic.
- **Component Radius**: Buttons and input fields use a slightly smaller 8px radius for a more precise, functional look.
- **Pill**: Used exclusively for status badges and tags to distinguish them from actionable buttons.

## Components

- **Buttons**: Primary buttons are high-impact, using the Electric Blue background with white or high-contrast black text. They span the full width of their container in sidebars or utility panels.
- **Inputs**: Use the `#242424` background. The focus state is defined by a 2px solid `#4A9EFF` border.
- **Drag & Drop Zones**: Large containers with a 2px dashed border in `#2A2A2A`. On "drag hover," the border color shifts to Electric Blue and the background gains a 5% blue tint.
- **Sidebar**: Icons should be 20px, stroke-based, and utilize the primary accent color only for the "active" state indicator (typically a vertical 4px bar on the left edge).
- **Progress Bars**: Track color is `#2A2A2A`, with a solid `#4A9EFF` fill. No gradients.
- **Toast Notifications**: Positioned at bottom-right. Solid `#1A1A1A` background with a colored left-edge accent corresponding to the message type (Success/Error/Info).
- **Modals**: Used for complex rule configurations. They must feature a clear header with a close action and a "sticky" footer for primary actions.