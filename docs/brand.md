# Wrangnarok visual identity

Status: **initial direction**. These assets are intentionally simple SVG source files so the eventual UI can use, inspect, and refine them without depending on generated raster artwork.

## Direction

Wrangnarok should feel like **technical mythology**: modern infrastructure software with an abstract-but-recognizable Nordic undertone. The visual language may harmonize with Cloudflare through warm orange/amber light, dark neutral surfaces, generous whitespace, rounded UI geometry, and network/orbit motifs. It must not reproduce Cloudflare's cloud mark, logo geometry, typography, illustrations, or other proprietary brand assets.

The emblem combines three ideas:

- an angular `W` / mountain silhouette for Wrangnarok and the Nordic landscape;
- an ascending four-point spark for motion and orchestration;
- an incomplete orbit for connected infrastructure and Journeys across systems.

The mark is deliberately **not** a cloud silhouette and should stay visually distinct from Cloudflare's logo at favicon and app-icon sizes.

## Assets

- `assets/brand/wrangnarok-mark.svg` — primary two-tone mark; inherits the dark half from `currentColor`.
- `assets/brand/wrangnarok-mark-mono.svg` — one-color mark for constrained contexts.
- `assets/brand/wrangnarok-lockup.svg` — initial horizontal lockup for docs/marketing surfaces.
- `assets/brand/tokens.css` — seed color/radius tokens for the React UI. These are a starting point, not an API contract.

For a dark surface, set the SVG `color` to a warm off-white such as `#f7f7f4`. For a light surface, use `#111820` or another near-black neutral.

## Palette

| Token | Hex | Role |
| --- | --- | --- |
| Obsidian | `#0B0F14` | primary dark surface |
| Slate | `#1F2937` | raised dark surface |
| Cloud | `#F7F7F4` | warm light surface |
| Mist | `#E2E8F0` | borders/subtle surfaces |
| Sunrise | `#F45D0B` | primary accent |
| Amber | `#F59E0B` | secondary accent/gradient |
| Dawn | `#FDE68A` | restrained highlight |

Orange is an accent, not a background default. Prefer dark neutrals or warm off-white for large surfaces so the product does not become visually interchangeable with Cloudflare.

## UI principles

1. **Clarity.** Dense operational information should remain calm and legible.
2. **Focus.** Use orange for action, active state, and important topology—not decoration everywhere.
3. **Momentum.** Thin arcs, paths, and restrained gradients can communicate orchestration and movement.
4. **Real-world infrastructure.** Prefer topology, paths, bounded groups, and abstract landscape geometry over fantasy-Viking imagery.
5. **Cloudflare-adjacent, not derivative.** Borrow broad visual qualities, never recognizable Cloudflare marks or compositions.

## Typography

Use the product's eventual UI sans-serif for the wordmark in application chrome rather than shipping a logo-specific font dependency. The checked-in SVG lockup uses a system/Inter fallback stack for portability. Headings can be wide and geometric; body text should remain conventional and highly readable.

## Generated concept art

The initial concept boards were used as design exploration only. They should not be treated as canonical production assets or traced literally. The SVGs in this directory are the source assets for implementation and can be iterated through normal design/code review.
