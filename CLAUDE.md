# RetirementLeague

## Site design target: iPhone Pro Max first, desktop second

The public site in `docs/` is viewed mainly on iPhone Pro Max phones. Desktop
matters too, but when the two conflict, the phone layout wins.

- **Primary viewport:** iPhone Pro Max portrait, 430–440 CSS px wide
  (15 Pro Max is 430×932, 16/17 Pro Max is 440×956). Design and check layouts
  at this width first.
- **Secondary viewport:** desktop. The content column caps at `.wrap`
  (`max-width: 980px` in `docs/theme.css`), so check about 1280px wide as well.
- **Every layout or CSS change** gets rendered and checked at both widths
  before it is called done. At phone width, look for horizontal overflow
  (`scrollWidth > clientWidth`), wrapped or clipped labels, and overlapping
  elements. Tap targets should be at least 44px.

## Presenting design options: phone/desktop slider mockup

When a visual decision is open (layout, palette, component treatment), build
an HTML mockup artifact before writing production code. Show the candidate
inside an iPhone Pro Max frame and a desktop frame, with a slider or toggle
to switch between them, using real league content and the site's real colors
and backgrounds. Seeing both form factors side by side has made design
choices much easier than describing options in text.
