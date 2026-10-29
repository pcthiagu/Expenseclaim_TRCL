// Item 5: password complexity validation. Enforced here (authoritative)
// and mirrored client-side for immediate feedback — never trust the
// client-side check alone since it can be bypassed.

const MIN_LENGTH = 10;

function validatePasswordComplexity(password) {
  const errors = [];
  if (!password || password.length < MIN_LENGTH) {
    errors.push(`Must be at least ${MIN_LENGTH} characters long.`);
  }
  if (!/[a-z]/.test(password || "")) errors.push("Must include a lowercase letter.");
  if (!/[A-Z]/.test(password || "")) errors.push("Must include an uppercase letter.");
  if (!/[0-9]/.test(password || "")) errors.push("Must include a digit.");
  if (!/[^A-Za-z0-9]/.test(password || "")) errors.push("Must include a special character.");

  return { valid: errors.length === 0, errors };
}

module.exports = { validatePasswordComplexity, MIN_LENGTH };
