# Mascot Character Design — Rationale

## Context

The Clubhouse Assistant needs a mascot that serves as its visual identity across
three modalities: interactive chat, structured views, and headless background
operation. It must feel like a natural member of the existing mascot family
(Claude Code's blocky cat, Copilot's helmeted bot, Codex's smooth oval,
Generic's classic robot) while being clearly "the help agent."

## Design Lineage

All existing sleeping mascots share:
- 100×100 viewBox, rendered at 200×200
- Rounded, chunky forms — soft rectangles, domes
- Minimal facial features — arc eyes (sleep), dot eyes (awake), blush circles
- Ground shadow ellipse for depth
- Catppuccin-adjacent color palettes
- `SleepingZzz` animation with staggered pulse

The assistant mascot continues this lineage with a "help" identity layer.

---

## Three Directions

### Comp A: "Beacon"
**File:** `comp-a-beacon.svg`

**Concept:** A blocky robot with a lightbulb antenna — the literal "bright idea"
helper. Warm amber glow on top signals "I have answers."

**Silhouette:** Rectangular body and head (closest to Claude Code mascot),
lightbulb finial on a short stalk.

**Distinguishing feature:** Glowing lightbulb antenna. Chest panel has a subtle
bulb emblem. The glow can animate (pulse when thinking, steady when idle,
off when sleeping).

**Tradeoffs:**
- (+) Strongest "help" metaphor — immediately reads as "illumination/guidance"
- (+) Lightbulb glow is a rich animation surface (pulse, flicker, dim/bright)
- (+) Most structurally similar to existing mascots (blocky body)
- (-) Lightbulb metaphor is common/expected — less distinctive
- (-) Tallest silhouette due to antenna — may feel less compact at 32px

### Comp B: "Ori"
**File:** `comp-b-ori.svg`

**Concept:** A dome-headed robot with a question-mark crest and large curious
eyes — the inquisitive explorer who wants to understand your problem.

**Silhouette:** Egg/dome head (larger than body), ear nubs, question mark
drawn as a flourish on top of the head.

**Distinguishing feature:** Question-mark crest in amber. Wide curious eyes
with raised eyebrows. Small open "o" mouth. Arms slightly splayed outward
in a "tell me more" pose.

**Tradeoffs:**
- (+) Most personality — the curious tilt and wide eyes feel alive
- (+) Question mark is the most direct "help/assistant" symbol
- (+) Dome head gives a distinctive silhouette even at small sizes
- (-) Question mark may feel too literal or "confused" — could undermine confidence
- (-) Ear nubs add width; may not compress as well to 32px avatar
- (-) Most departure from existing blocky mascot style

### Comp C: "Pip"
**File:** `comp-c-pip.svg`

**Concept:** A compact, very round bot with a glowing core (heart/power center)
and a tiny dot antenna — earnest, small but mighty, all heart.

**Silhouette:** Nearly circular head that's oversized relative to a stubby body.
Minimal antenna (just a dot). Defining feature is the warm core glow in the
chest.

**Distinguishing feature:** Radial gradient core that glows amber/gold —
represents warmth, helpfulness, and energy. Can pulse with activity, dim when
sleeping, brighten when celebrating.

**Tradeoffs:**
- (+) Most compact and round — compresses beautifully to 32px and 18px
- (+) Glowing core is emotionally warm — "this bot cares about you"
- (+) Simplest silhouette = most versatile across contexts
- (+) Core glow animates naturally for all states (dim→bright→pulse→off)
- (-) Less immediately "help-coded" — the core doesn't scream "assistant"
- (-) Very round shape is furthest from the existing blocky style
- (-) Fewer unique silhouette features at small sizes (just a round blob)

---

## Recommendation

**Pip (Comp C)** is my current favorite for the primary direction, with elements
borrowed from Beacon:

1. Pip's compact roundness works best at the sizes we need (32px chat avatar,
   18px icon). The assistant appears in more cramped contexts than the sleeping
   mascots (which render at 200px).

2. The glowing core maps perfectly to our emotional state table — it's the
   single richest animation surface across all 8 states.

3. We can add a subtle "?" or lightbulb motif to the core glow or antenna
   to strengthen the "help" read without adding bulk.

However, I'd like owner feedback before committing. The question-mark crest
from Ori could be combined with Pip's body for a hybrid that's both compact
and clearly "help-coded."

## Next Steps

- [ ] Get owner/coordinator feedback on direction preference
- [ ] Create expression sheet (all 8 emotional states) for chosen direction
- [ ] Create sleeping variant that integrates with existing `SleepingMascots.tsx`
- [ ] Design 32px and 18px size-optimized variants
- [ ] Define animation keyframes for each state transition
