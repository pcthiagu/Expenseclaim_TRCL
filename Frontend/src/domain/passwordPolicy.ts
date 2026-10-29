/** Mirrors the backend's utils/passwordPolicy.js for instant feedback. The server is authoritative and re-checks. */
export const MIN_PASSWORD_LENGTH = 10;
export function passwordProblems(p: string): string[] {
  const e: string[] = [];
  if (!p || p.length < MIN_PASSWORD_LENGTH) e.push(`Must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  if (!/[a-z]/.test(p || '')) e.push('Must include a lowercase letter.');
  if (!/[A-Z]/.test(p || '')) e.push('Must include an uppercase letter.');
  if (!/[0-9]/.test(p || '')) e.push('Must include a digit.');
  if (!/[^A-Za-z0-9]/.test(p || '')) e.push('Must include a special character.');
  return e;
}
