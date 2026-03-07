PRODUCT DESIGN SPECIFICATION
Project: Video Redaction Tool Redesign
Design Goal: Clean, modern, professional, premium. Dark mode first. Confident, minimal, Apple-level restraint.

BRAND AND VISUAL PRINCIPLES

Tone:
Precise. Calm. Trustworthy. Technically sophisticated without being flashy.

Avoid:
Neon cyberpunk aesthetics
Overly saturated gradients
Excessive glow
Heavy borders
Busy illustrations

Design philosophy:
Use restraint. Use space as structure. Use magenta as a signal, not decoration.

COLOR SYSTEM

Primary Accent (Magenta)

Primary Action Magenta:
#D81B60

Hover State:
#E91E63

Pressed State:
#AD1457

Focus Ring:
rgba(216, 27, 96, 0.45)

Magenta is used for:
Primary buttons
Active states
Selected items
Progress indicators
Toggle ON state
Critical highlights

It must never dominate large surfaces.

Neutrals

App Background:
#0F0F14

Primary Surface:
#15151C

Secondary Surface:
#1C1C24

Elevated Surface (glass base):
rgba(255, 255, 255, 0.06)

Border:
rgba(255, 255, 255, 0.08)

Hairline Divider:
rgba(255, 255, 255, 0.05)

Primary Text:
#EAEAF0

Secondary Text:
#A9A9B6

Disabled Text:
#6E6E7A

Supporting Accent Colors

Subtle Violet:
#7B61FF

Deep Indigo:
#3A3F9F

Use only in:
Subtle gradients
Status highlights
Secondary UI moments

Never mix multiple accents in one component.

TYPOGRAPHY

Font:
Use a modern sans serif with wide apertures and strong legibility.
Recommended:
Inter
SF Pro (if platform allows)
Satoshi or similar geometric sans

Hierarchy:

Page Title:
28px, SemiBold, tracking 0

Section Header:
18px, Medium

Body:
14–15px, Regular

Small UI Labels:
12px, Medium

Use minimal bold. Avoid over-emphasis. Use weight sparingly.

Line height:
1.4 to 1.6 depending on size.

LAYOUT STRUCTURE

Overall Grid:
8px spacing system.

Primary layout:
Left sidebar navigation
Top bar utility row
Main central canvas
Bottom timeline controls

Padding:
Outer container padding: 24px
Panel internal padding: 16px or 20px

No heavy outlines. Use spacing for structure.

GLASS EFFECT SPECIFICATION

Use selectively on:
Sidebar
Floating panels
Modals
Dropdowns

Glass properties:

Background:
rgba(255, 255, 255, 0.06)

Backdrop blur:
20px

Border:
1px solid rgba(255, 255, 255, 0.08)

Shadow:
0 8px 32px rgba(0, 0, 0, 0.35)

Optional subtle inner highlight:
Inset 0 1px 0 rgba(255, 255, 255, 0.05)

Do not stack multiple glass layers.

BUTTON SYSTEM

Primary Button

Background:
#D81B60

Text:
#FFFFFF

Border radius:
10px

Padding:
Vertical 12px
Horizontal 20px

Shadow:
0 6px 16px rgba(216, 27, 96, 0.35)

Hover:
Slight brightness increase
Scale to 1.02
Shadow slightly stronger

Transition:
150ms ease-out

Secondary Button

Background:
rgba(255, 255, 255, 0.06)

Border:
1px solid rgba(255, 255, 255, 0.08)

Hover:
Background rgba(255,255,255,0.09)

No glow.

Ghost Button

Text only
Hover underline or subtle background tint

SIDEBAR DESIGN

Glass panel
Soft rounded corners, 16px

Increase vertical spacing between sections
Remove heavy separators
Use subtle text weight changes instead of boxes

Active item:
Left 3px magenta indicator line
Text color becomes primary text
Background tint rgba(216, 27, 96, 0.08)

VIDEO CANVAS AREA

The center should feel calm.

Remove decorative sparkles.
Replace illustration with one of these options:

Option A:
Minimal abstract soft blur gradient behind player

Option B:
Simple line illustration in low opacity

Option C:
No illustration, just centered empty state

Video player:
Rounded corners 14px
Subtle drop shadow
Magenta progress bar

Play button:
Magenta fill
Soft glow at 20 percent opacity

TIMELINE AND CONTROLS

Timeline track:
Background rgba(255,255,255,0.08)

Progress:
#D81B60

Handle:
Circular, 12px
Magenta fill
White center dot optional

Hover increases size slightly.

ICONOGRAPHY

Style:
Minimal
1.5px stroke
Rounded corners

Avoid filled icons unless active.

Active icons:
Magenta
Inactive icons:
#A9A9B6

MOTION DESIGN

All transitions:
150–250ms
Ease-out curve

Hover:
Subtle scale
Subtle elevation

Modal open:
Fade + slight upward motion 8px

Never bounce. Never overshoot.

DEPTH SYSTEM

Layer 0:
Background

Layer 1:
Primary surfaces

Layer 2:
Elevated glass panels

Layer 3:
Modals

Shadow progression increases subtly per layer.

No dramatic drop shadows.

MICROINTERACTIONS

On successful scan:
Subtle magenta shimmer across progress bar

On export success:
Small checkmark animation, 200ms scale in

On toggle enable:
Smooth color transition, not instant snap

EMPTY STATES

Keep simple.

Centered icon
One line headline
One supporting sentence
Primary button

No decorative clutter.

ACCESSIBILITY

Contrast ratio:
Minimum 4.5:1 for text

Focus indicators:
Visible magenta outline
2px thickness

Interactive areas:
Minimum 40px height

WHAT TO AVOID

Neon glow everywhere
Heavy gradients
Thick borders
Drop shadows on everything
Overcrowded toolbar
Too many visible controls

OVERALL FEEL CHECK

When someone opens the app, they should feel:

Calm
In control
Capable
Trusted

It should feel like a precision instrument, not a flashy security toy.