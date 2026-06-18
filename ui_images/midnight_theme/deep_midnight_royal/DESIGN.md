---
name: Deep Midnight Royal
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#c6c5d5'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#908f9e'
  outline-variant: '#454653'
  surface-tint: '#bdc2ff'
  primary: '#bdc2ff'
  on-primary: '#131e8c'
  primary-container: '#818cf8'
  on-primary-container: '#101b8a'
  inverse-primary: '#4953bc'
  secondary: '#b9c8de'
  on-secondary: '#233143'
  secondary-container: '#39485a'
  on-secondary-container: '#a7b6cc'
  tertiary: '#c0c1ff'
  on-tertiary: '#1000a9'
  tertiary-container: '#8689ff'
  on-tertiary-container: '#0f00a2'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e0e0ff'
  primary-fixed-dim: '#bdc2ff'
  on-primary-fixed: '#000767'
  on-primary-fixed-variant: '#2f3aa3'
  secondary-fixed: '#d4e4fa'
  secondary-fixed-dim: '#b9c8de'
  on-secondary-fixed: '#0d1c2d'
  on-secondary-fixed-variant: '#39485a'
  tertiary-fixed: '#e1e0ff'
  tertiary-fixed-dim: '#c0c1ff'
  on-tertiary-fixed: '#07006c'
  on-tertiary-fixed-variant: '#2f2ebe'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  title-lg:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
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
  label-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  mono-label:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
    letterSpacing: 0.02em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
  sidebar-width: 280px
  toolbar-height: 64px
---

## Brand & Style
The design system is engineered for a premium, high-focus PDF desktop experience. It targets professional users who require a sophisticated, low-strain environment for long-form reading and document management. 

The aesthetic identity is **Modern Corporate with Glassmorphic accents**. It utilizes a deep "Midnight" foundation to reduce eye fatigue, contrasted by neon-adjacent Indigo highlights that guide the user's attention to primary actions. The emotional response is one of calm authority, precision, and technological sophistication. 

Key visual principles:
- **Depth through layering:** Utilizing translucent surfaces to create a sense of physical space.
- **Luminescent accents:** Using vibrant indigos to simulate a "glow" against the dark background.
- **Refined density:** High information density balanced by generous negative space and clear typographic hierarchy.

## Colors
The palette is built on a "Deep Midnight" foundation, optimizing the interface for deep work.

- **Primary (#818CF8):** A soft indigo used for primary actions, active states, and focus indicators. It provides a "neon-adjacent" pop without being jarring.
- **Secondary (#94A3B8):** A cool slate intended for meta-data, secondary icons, and de-emphasized text to maintain a clean hierarchy.
- **Accent (#6366F1):** A more saturated indigo used sparingly for high-priority alerts, progress bars, and interactive highlights.
- **Surface (#0F172A):** The base application canvas.
- **Surface Variant (#1E293B):** Used for sidebars, toolbars, and card backgrounds to create subtle structural separation.

## Typography
The system relies exclusively on **Inter** to achieve a technical, highly legible, and sophisticated look. 

- **Headlines:** Use tighter letter spacing and semi-bold weights to command attention.
- **Body:** Standardized at 14px and 16px for optimal readability of document metadata and application controls.
- **Labels:** Small caps or increased letter spacing are used for navigational labels to distinguish them from content.
- **Readability:** For the actual PDF content viewing area, ensure a high-contrast ratio against the midnight background, typically using a slightly off-white (#F8FAFC) for maximum comfort.

## Layout & Spacing
This system uses a **fixed-fluid hybrid layout** tailored for desktop productivity. 

- **Sidebars:** Fixed at 280px to house document thumbnails, annotations, and navigation trees.
- **Main Canvas:** A fluid area that centers the PDF document, utilizing "Dead Space" (Surface color) to focus the eye on the document page.
- **Spacing Rhythm:** Based on a 4px baseline grid. Use 16px (md) for standard padding and 24px (lg) for section margins.
- **Margins:** 24px outer margins for all window content to prevent a cramped "edge-to-edge" feel.

## Elevation & Depth
Depth is communicated through **Tonal Layering** and **Glassmorphism**, rather than traditional heavy shadows.

- **Level 0 (Base):** #0F172A — The background.
- **Level 1 (Navigation):** #1E293B — Sidebars and footers, visually "sunk" or flat.
- **Level 2 (Floating Elements):** Glassmorphic surfaces using a 10% opacity white fill, a 1px border (#FFFFFF15), and a 20px backdrop blur. This is reserved for context menus, modals, and floating toolbars.
- **Level 3 (Pop-overs):** Same as Level 2 but with a subtle Indigo-tinted outer glow (primary color at 10% opacity) to signify extreme prominence.

## Shapes
The design system adopts a **"Soft Precision"** geometry.

- **Components:** Standard buttons, input fields, and chips use a 12px (0.75rem) corner radius.
- **Containers:** Main cards and the PDF viewer container use 16px (1rem) for a more pronounced "premium" feel.
- **Selection States:** Use the same 12px radius for hover states in lists and menus to maintain consistency.

## Components
Consistent implementation of the following components ensures the premium feel of the application:

- **Primary Buttons:** Solid #818CF8 background with #0F172A text. 12px radius. On hover, apply a subtle outer glow using the primary color.
- **Secondary Buttons:** Ghost style with a 1px border of #94A3B8 and #94A3B8 text.
- **Glass Cards:** Used for "Inspector" panels or floating properties. Use `backdrop-filter: blur(20px)` and a thin internal stroke to catch the light.
- **Input Fields:** #1E293B background, no border, 12px radius. On focus, a 1px solid #818CF8 border.
- **PDF Page Thumbs:** Minimal 2px border radius, with a #818CF8 2px border indicating the active page.
- **Context Menus:** Fully glassmorphic with 8px padding between menu items and 12px radius on hover highlights.
- **Scrollbars:** Custom-styled to be thin (6px), with a #94A3B8 thumb and no track background to minimize visual noise.