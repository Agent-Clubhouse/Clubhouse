/**
 * A start failure that means "log in first": the probe can't see it (Copilot
 * advertises its login method whether or not you're logged in), so it shows
 * up as the session request failing.
 */
export function isLoginRequiredError(message: string): boolean {
  return /authentication required|not logged in|not authenticated|unauthori[sz]ed|please (run )?\S*\s*login/i.test(message);
}
