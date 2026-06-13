# Test Plan: Extract Pattern Label → Extract Persona

## Objective
Rename the "extract pattern" label/term to "extract persona" throughout the codebase to match new nomenclature.

## Scope
- UI labels and context menu text
- Component and file names
- State management (Zustand store)
- IPC channels
- Service functions
- Comments and documentation

## Test Cases

### 1. UI / Context Menu
- [ ] Right-click on a durable local agent in the agent list
- [ ] Verify context menu shows "Extract persona…" (not "Extract pattern…")
- [ ] Click "Extract persona…" to open the dialog
- [ ] Verify dialog title reads "Extract persona from [agent name]"

### 2. Dialog Functionality
- [ ] Dialog opens correctly after clicking "Extract persona…"
- [ ] Instructions (persona body) load correctly
- [ ] Settings checkboxes function as expected
- [ ] Persona id field populated with slugified agent name
- [ ] Save button saves to user or project scope correctly
- [ ] Cancel button closes dialog without saving

### 3. No Regressions
- [ ] Apply persona functionality still works
- [ ] Other agent context menu items still work (Settings, Delete, Pop Out, etc.)
- [ ] Right-click context menu displays all actions properly
- [ ] Agent list rendering is unaffected
- [ ] Quick agent spawning unaffected
- [ ] Remote agents (Annex) unaffected

### 4. Code References
- [ ] All "extract-pattern" identifiers renamed to "extract-persona"
- [ ] All function names updated (extractAgentPattern → extractAgentPersona)
- [ ] All store actions renamed (openExtractPatternDialog → openExtractPersonaDialog)
- [ ] IPC channel renamed (EXTRACT_AGENT_PATTERN → EXTRACT_AGENT_PERSONA)
- [ ] Comments and docstrings reference "persona" not "pattern"

### 5. Tests
- [ ] ExtractPersonaDialog tests pass
- [ ] AgentListItem tests pass
- [ ] Store tests pass
- [ ] No test files reference "extract-pattern" or "extractPattern" (except migrations)

## Acceptance Criteria
- ✅ All references updated (UI, code, docs)
- ✅ Tests pass
- ✅ No regressions in persona context menu
