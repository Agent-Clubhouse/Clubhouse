// TC-H12: Removed conditional no-op tests that silently passed with zero assertions.
// These tests wrapped all assertions in `if (element.isVisible())` guards, meaning
// they would pass even when the UI was completely broken. This gave false confidence
// in CI results. Proper E2E agent lifecycle tests should be written with guaranteed
// preconditions and unconditional assertions.
