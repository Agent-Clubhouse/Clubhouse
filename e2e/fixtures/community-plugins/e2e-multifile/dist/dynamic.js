export async function loadDynamicMarker() {
  const module = await import('./lib/dynamic-nested.js');
  return module.DYNAMIC;
}
