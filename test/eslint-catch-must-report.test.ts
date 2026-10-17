import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { catchMustReport } from '../eslint-rules/catch-must-report.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

tester.run('catch-must-report', catchMustReport as never, {
  valid: [
    'try { a(); } catch (e) { throw e; }',
    'function f() { try { a(); } catch (e) { tel.exception(e, { handled: true }); return null; } }',
    'try { a(); } catch (e) { tel?.event("x"); }',
    'try { a(); } catch (e) { reportMainProcessError(e, "uncaught"); }',
    'function f() { try { a(); } catch { /* telemetry-exempt: probing for an optional file */ return false; } }',
    'try { a(); } catch {\n  // telemetry-exempt: best-effort cleanup\n}',
    'try { a(); } catch (e) { if (bad(e)) throw new Error("wrapped"); }',
  ],
  invalid: [
    { code: 'try { a(); } catch {}', errors: [{ messageId: 'report' }] },
    { code: 'try { a(); } catch (e) { console.error(e); }', errors: [{ messageId: 'report' }] },
    { code: 'try { a(); } catch (e) { toast(e.message); }', errors: [{ messageId: 'report' }] },
    // A throw inside a nested function does not run when the catch does.
    { code: 'try { a(); } catch (e) { later(() => { throw e; }); }', errors: [{ messageId: 'report' }] },
    { code: 'try { a(); } catch (e) { /* telemetry-exempt: */ }', errors: [{ messageId: 'report' }] },
  ],
});
