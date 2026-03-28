# Pip Expression Sheet — Guide

All 8 emotional states for the Pip mascot, mapped to the assistant agent lifecycle.

## Expression Files

| State | File | Core Color | Antenna Color | Key Features |
|-------|------|-----------|--------------|-------------|
| Sleeping | `expressions-sleeping.svg` | Gray (dim) | Gray (dim) | Closed arc eyes, Zzz text, head tilted, drooped arms, muted palette |
| Idle/Ready | `expressions-idle.svg` | Amber (steady) | Blue | Soft open eyes, gentle smile, relaxed arms — the default resting state |
| Listening | `expressions-listening.svg` | Amber (steady) | Blue (bright) | Wide eyes, raised brows, lean forward, perked antenna |
| Thinking | `expressions-thinking.svg` | Amber (bright) | Amber | Half-closed eyes, dots above head, hand to chin, head tilt |
| Responding | `expressions-responding.svg` | Green | Green | Open mouth, extended arm gesturing, speech arcs, bright eyes |
| Celebrating | `expressions-celebrating.svg` | Pink | Pink | Arms up, star eyes, big smile, confetti, bounce offset, smaller shadow |
| Error/Sorry | `expressions-error.svg` | Red (dim) | Gray (dim) | Droopy posture, worried brows, frown, sweat drop, muted palette |
| Permission | `expressions-permission.svg` | Orange | Orange | Hand raised, alert eyes, orange pulse rings, exclamation mark |

## Design Consistency Across States

### What stays constant (Pip's identity):
- **Silhouette**: Round dome head, stubby body, small arms, dot antenna
- **Proportions**: Head ~44px diameter, body 34×28, same viewBox (100×100)
- **Eye structure**: Dark circles with highlight dots (size/openness varies)
- **Blush circles**: Always present, opacity varies with emotional warmth
- **Ground shadow**: Always present, size varies (smaller when bouncing)

### What changes per state:
- **Core glow color**: Maps to emotional state table (amber/green/pink/red/orange/gray)
- **Antenna color**: Matches core color for consistency
- **Eye openness**: Wide (listening) → normal (idle) → half (thinking) → closed (sleeping)
- **Arm position**: Relaxed (idle) → forward (listening) → raised (celebrating/permission)
- **Body posture**: Upright (idle) → lean forward (listening) → drooped (error) → bounced up (celebrating)
- **Head tilt**: Neutral (idle) → slight tilt (thinking/sleeping) → straight (alert states)
- **Overall palette saturation**: Full color (active states) → desaturated (sleeping/error)

## Animation Specs (per state)

### Sleeping
- **Zzz float**: Staggered `animate-pulse` on z characters (0s, 0.3s, 0.6s delays)
- **Breathing**: Gentle `translateY(±1px)` on body group, 4s ease-in-out loop
- **Core pulse**: Very slow opacity 0.2→0.4, 6s loop

### Idle/Ready
- **Blink**: Close eyes to arcs for 150ms every 4s (randomize ±1s)
- **Core glow**: Steady, very subtle brightness pulse (0.8→1.0 opacity, 3s)
- **Antenna dot**: Gentle opacity pulse (0.6→0.8, 2s)

### Listening
- **Bounce anticipation**: Subtle `translateY(±2px)`, 1.5s loop
- **Antenna bright**: Steady bright state
- **Eyes**: No blink while listening (attentive)

### Thinking
- **Dots rotation**: Three dots above head cycle opacity (each visible 0.5s, 1.5s total loop)
- **Head bob**: Gentle `translateY(±1.5px)` + `rotate(±1deg)`, 2s loop
- **Core pulse**: Amber brightness pulse, 1.5s (faster = processing)

### Responding
- **Arm wave**: Right arm gentle `rotate(±5deg)` around shoulder, 2s loop
- **Speech arcs**: Opacity fade in/out, staggered 0.5s
- **Core pulse**: Green pulse, 1s (fast = actively outputting)
- **Typing indicator**: Optional 3-dot sequence below speech arcs

### Celebrating
- **Bounce**: `translateY(-4px)` with ease-out, 0.8s loop
- **Confetti burst**: Particles fade opacity 1→0 + translateY(-20px) + scale(1→0.5), 2s one-shot
- **Star eyes**: Gentle `scale(0.9→1.1)` pulse, 0.5s
- **Shadow**: Scale inversely with bounce height

### Error/Sorry
- **Slow sway**: `rotate(±1.5deg)` around center, 5s loop (heavy, reluctant)
- **Sweat drop**: `translateY(-2px→+2px)` with opacity fade, 2s loop
- **Core flicker**: Red opacity 0.4→0.7 irregular pulse, 3s

### Permission Needed
- **Pulse ring**: Two rings scale 1→1.5 with opacity 0.25→0, staggered 0.3s, 2s loop
- **Hand wave**: Raised hand gentle `translateY(±2px)`, 1.5s
- **Antenna flash**: Orange on/off at 1s interval
- **Core pulse**: Orange, 1.5s, slightly urgent feel

## Reduced Motion Fallbacks

When `prefers-reduced-motion: reduce`:
- All animations stop — show static pose for each state
- Core glow is steady (no pulse)
- Zzz text shown without animation
- Confetti shown in place (no movement)
- Pulse rings shown as static circles
- Thinking dots all visible at once (no rotation)

## Size Variants Needed

| Size | Use Case | Simplification |
|------|---------|---------------|
| 200×200 | Welcome state, onboarding | Full detail as designed |
| 80×80 | Chat welcome header | Remove confetti detail, simplify sparkles |
| 32×32 | Chat message avatar | Head only, no body. Core color as bg tint. |
| 18×18 | ProjectRail icon, inline | Silhouette only — filled dome + dot antenna |
