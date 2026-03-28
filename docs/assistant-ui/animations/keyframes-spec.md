# Animation Keyframes Spec

CSS keyframes and Tailwind classes for all Pip mascot state transitions
and assistant UI animations. All animations respect `prefers-reduced-motion`.

---

## Global Reduced Motion

Add to the app's global CSS (or Tailwind config):

```css
@media (prefers-reduced-motion: reduce) {
  .pip-animate,
  .pip-animate * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Mascot State Animations

### Sleeping — Breathing + Zzz

```css
@keyframes pip-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1px); }
}

@keyframes pip-core-dim-pulse {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 0.4; }
}

/* Apply to mascot body group */
.pip-sleeping .pip-body {
  animation: pip-breathe 4s ease-in-out infinite;
}

.pip-sleeping .pip-core {
  animation: pip-core-dim-pulse 6s ease-in-out infinite;
}

/* Zzz uses existing SleepingZzz animate-pulse pattern */
```

### Idle — Blink + Core Glow

```css
@keyframes pip-blink {
  0%, 92%, 100% { d: path("...open-eyes..."); }
  95%, 97% { d: path("...closed-arcs..."); }
}

/* Simpler approach: toggle visibility of eye overlays */
@keyframes pip-blink-overlay {
  0%, 92%, 100% { opacity: 0; }
  94%, 98% { opacity: 1; }
}

@keyframes pip-core-steady {
  0%, 100% { opacity: 0.8; }
  50% { opacity: 1; }
}

@keyframes pip-antenna-glow {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 0.8; }
}

.pip-idle .pip-blink-lid {
  animation: pip-blink-overlay 4s ease-in-out infinite;
}

.pip-idle .pip-core {
  animation: pip-core-steady 3s ease-in-out infinite;
}

.pip-idle .pip-antenna-dot {
  animation: pip-antenna-glow 2s ease-in-out infinite;
}
```

### Listening — Bounce Anticipation

```css
@keyframes pip-listen-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

.pip-listening .pip-body {
  animation: pip-listen-bounce 1.5s ease-in-out infinite;
}

/* No blink while listening (attentive) */
.pip-listening .pip-blink-lid {
  animation: none;
  opacity: 0;
}
```

### Thinking — Dots Rotation + Head Bob

```css
@keyframes pip-think-dots {
  0%, 100% { opacity: 0.3; }
  33% { opacity: 1; }
}

@keyframes pip-think-bob {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-1.5px) rotate(1deg); }
  75% { transform: translateY(1.5px) rotate(-1deg); }
}

@keyframes pip-core-think {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

.pip-thinking .pip-think-dot-1 {
  animation: pip-think-dots 1.5s ease-in-out infinite;
}
.pip-thinking .pip-think-dot-2 {
  animation: pip-think-dots 1.5s ease-in-out 0.5s infinite;
}
.pip-thinking .pip-think-dot-3 {
  animation: pip-think-dots 1.5s ease-in-out 1s infinite;
}

.pip-thinking .pip-head {
  animation: pip-think-bob 2s ease-in-out infinite;
}

.pip-thinking .pip-core {
  animation: pip-core-think 1.5s ease-in-out infinite;
}
```

### Responding — Arm Wave + Speech Arcs

```css
@keyframes pip-arm-wave {
  0%, 100% { transform: rotate(0deg); }
  50% { transform: rotate(-5deg); }
}

@keyframes pip-speech-arc {
  0% { opacity: 0; transform: translateX(0); }
  30% { opacity: 0.5; }
  100% { opacity: 0; transform: translateX(4px); }
}

@keyframes pip-core-respond {
  0%, 100% { opacity: 0.8; }
  50% { opacity: 1; }
}

.pip-responding .pip-arm-right {
  transform-origin: 67px 55px; /* shoulder pivot */
  animation: pip-arm-wave 2s ease-in-out infinite;
}

.pip-responding .pip-speech-arc-1 {
  animation: pip-speech-arc 1.5s ease-out infinite;
}
.pip-responding .pip-speech-arc-2 {
  animation: pip-speech-arc 1.5s ease-out 0.3s infinite;
}

.pip-responding .pip-core {
  animation: pip-core-respond 1s ease-in-out infinite;
}
```

### Celebrating — Bounce + Confetti

```css
@keyframes pip-celebrate-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

@keyframes pip-confetti-fall {
  0% { opacity: 1; transform: translateY(0) scale(1) rotate(0deg); }
  100% { opacity: 0; transform: translateY(20px) scale(0.5) rotate(180deg); }
}

@keyframes pip-star-pulse {
  0%, 100% { transform: scale(0.9); }
  50% { transform: scale(1.1); }
}

@keyframes pip-shadow-shrink {
  0%, 100% { rx: 18; ry: 3.5; }
  50% { rx: 14; ry: 2.5; }
}

.pip-celebrating .pip-body {
  animation: pip-celebrate-bounce 0.8s ease-out infinite;
}

.pip-celebrating .pip-confetti > * {
  animation: pip-confetti-fall 2s ease-out forwards;
}

.pip-celebrating .pip-star-eye {
  animation: pip-star-pulse 0.5s ease-in-out infinite;
}

.pip-celebrating .pip-shadow {
  animation: pip-shadow-shrink 0.8s ease-out infinite;
}
```

### Error — Slow Sway + Sweat Drop

```css
@keyframes pip-error-sway {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(1.5deg); }
  75% { transform: rotate(-1.5deg); }
}

@keyframes pip-sweat-drip {
  0% { transform: translateY(0); opacity: 0.6; }
  50% { transform: translateY(2px); opacity: 0.3; }
  100% { transform: translateY(0); opacity: 0.6; }
}

@keyframes pip-core-error {
  0%, 30%, 100% { opacity: 0.4; }
  15%, 45% { opacity: 0.7; }
}

.pip-error {
  animation: pip-error-sway 5s ease-in-out infinite;
}

.pip-error .pip-sweat {
  animation: pip-sweat-drip 2s ease-in-out infinite;
}

.pip-error .pip-core {
  animation: pip-core-error 3s ease-in-out infinite;
}
```

### Permission — Pulse Ring + Hand Wave

```css
@keyframes pip-pulse-ring {
  0% { transform: scale(1); opacity: 0.25; }
  100% { transform: scale(1.5); opacity: 0; }
}

@keyframes pip-hand-raise {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

@keyframes pip-antenna-flash {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0.3; }
}

.pip-permission .pip-pulse-ring-1 {
  animation: pip-pulse-ring 2s ease-out infinite;
}
.pip-permission .pip-pulse-ring-2 {
  animation: pip-pulse-ring 2s ease-out 0.3s infinite;
}

.pip-permission .pip-arm-right {
  animation: pip-hand-raise 1.5s ease-in-out infinite;
}

.pip-permission .pip-antenna-dot {
  animation: pip-antenna-flash 1s steps(1) infinite;
}
```

---

## UI Animation Keyframes

### Chat Feed

```css
/* Message appear */
@keyframes message-appear {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.assistant-message-enter {
  animation: message-appear 0.2s ease-out;
}

/* Card expand/collapse */
@keyframes card-expand {
  from { max-height: 0; opacity: 0; }
  to { max-height: var(--card-height, 400px); opacity: 1; }
}

.card-body-enter {
  animation: card-expand 0.2s ease-out;
  overflow: hidden;
}

/* Undo toast */
@keyframes toast-slide-up {
  from { opacity: 0; transform: translateX(-50%) translateY(16px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

@keyframes toast-slide-down {
  from { opacity: 1; transform: translateX(-50%) translateY(0); }
  to { opacity: 0; transform: translateX(-50%) translateY(16px); }
}

.undo-toast-enter {
  animation: toast-slide-up 0.2s ease-out;
}

.undo-toast-exit {
  animation: toast-slide-down 0.2s ease-in;
}
```

### Streaming Cursor

```css
/* Matches existing MessageStream cursor pattern */
@keyframes cursor-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.assistant-cursor {
  display: inline-block;
  width: 6px;
  height: 16px;
  background: var(--ctp-accent, #89b4fa);
  animation: cursor-pulse 1s steps(1) infinite;
  vertical-align: text-bottom;
  margin-left: 2px;
}
```

### Welcome State

```css
/* Mascot float-in on welcome */
@keyframes welcome-float-in {
  from { opacity: 0; transform: translateY(16px) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* Suggestion chip stagger */
@keyframes chip-appear {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.welcome-mascot {
  animation: welcome-float-in 0.5s ease-out;
}

.suggestion-chip:nth-child(1) { animation: chip-appear 0.3s ease-out 0.3s both; }
.suggestion-chip:nth-child(2) { animation: chip-appear 0.3s ease-out 0.4s both; }
.suggestion-chip:nth-child(3) { animation: chip-appear 0.3s ease-out 0.5s both; }
.suggestion-chip:nth-child(4) { animation: chip-appear 0.3s ease-out 0.6s both; }
```

### Activity Badge (Headless Mode)

```css
@keyframes badge-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.2); }
}

.assistant-badge-active {
  animation: badge-pulse 2s ease-in-out infinite;
}

/* Dot indicator for background work */
@keyframes badge-dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.assistant-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ctp-accent, #89b4fa);
  animation: badge-dot-blink 1.5s ease-in-out infinite;
}
```

---

## Transition Durations

| Context | Duration | Easing |
|---------|----------|--------|
| Mascot state change | 300ms | ease-in-out |
| Card expand/collapse | 200ms | ease-out |
| Message appear | 200ms | ease-out |
| Toast appear/dismiss | 200ms | ease-out / ease-in |
| Focus ring | 150ms | ease-out |
| Button hover | 150ms | ease-out |
| Mode toggle | 200ms | ease-in-out |
| Welcome mascot float | 500ms | ease-out |
| Suggestion chip stagger | 300ms, +100ms each | ease-out |

---

## Implementation Notes

### State Transitions
When the mascot transitions between states (e.g., idle → thinking):
1. Fade out current animation (150ms, ease-in)
2. Swap SVG elements / classes
3. Fade in new animation (150ms, ease-out)

Total transition: ~300ms. Never jump-cut between states.

### CSS Class Strategy
Each state applies a class to the mascot container:
```html
<div class="pip-mascot pip-thinking">
  <svg><!-- Pip with thinking expression elements --></svg>
</div>
```

Animation classes target child elements with `.pip-` prefixed selectors.
This keeps animations scoped and avoids conflicts.

### Performance
- Use `transform` and `opacity` only (GPU-composited, no layout thrash)
- Avoid animating `width`, `height`, `top`, `left`, `margin`
- `will-change: transform, opacity` on animated mascot elements
- Remove `will-change` when animation completes (idle state = no will-change)
