// Re-exports the host's React (set on globalThis by renderer/index.ts) for
// community plugins resolved through the import map in index.html.
// The named-export list must match the installed `react`'s public surface;
// renderer/plugin-shims.test.ts enforces this when React is upgraded.
const R = globalThis.React;
export default R;
export const {
  Activity, Children, Component, Fragment, Profiler, PureComponent,
  StrictMode, Suspense, act, cache, cacheSignal, captureOwnerStack,
  cloneElement, createContext, createElement, createRef, forwardRef,
  isValidElement, lazy, memo, startTransition, unstable_useCacheRefresh,
  use, useActionState, useCallback, useContext, useDebugValue,
  useDeferredValue, useEffect, useEffectEvent, useId, useImperativeHandle,
  useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer,
  useRef, useState, useSyncExternalStore, useTransition, version,
} = R;
