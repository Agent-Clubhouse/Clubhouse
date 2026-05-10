import { useState, useCallback, useRef } from 'react';

export function useFormDirtyState<T>(initialValue: T) {
  const original = useRef(JSON.stringify(initialValue));
  const [current, setCurrent] = useState(initialValue);

  const isDirty = JSON.stringify(current) !== original.current;

  const reset = useCallback((newValue?: T) => {
    const v = newValue ?? initialValue;
    original.current = JSON.stringify(v);
    setCurrent(v);
  }, [initialValue]);

  return { value: current, setValue: setCurrent, isDirty, reset };
}
