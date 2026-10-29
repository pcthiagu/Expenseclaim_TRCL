import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button } from '../../components/common/ui';
import { Field } from '../../components/forms/Field';
import { passwordProblems } from '../../domain/passwordPolicy';
import type { AuthApi } from '../../services/authApi';
import { ApiError } from '../../services/apiClient';

const msg = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

/** Minimal chrome for signed-out screens (same brand bar and card styles as the app). */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    // <div className="tc-shell">
    <div
        className="tc-shell"
        style={{
          backgroundImage: `url('${import.meta.env.BASE_URL}assets/login-bg.png')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          minHeight: '107vh',
        }}
      >
      <div className="tc-main">
        <header className="tc-topbar" style={{ backgroundColor: '#d5e9fc' }}><div className="tc-topbar__inner">
          <span className="tc-brand">
            <img className="tc-brand__logo" src={import.meta.env.BASE_URL + 'assets/trcl-logo.svg'} alt="" width={41} height={44} />
            <span className="tc-brand__divider" aria-hidden="true" />
            <span><span className="tc-brand__name">Travel Claim</span><br /><span className="tc-brand__sub">
              {/* <b>Employee Services </b> */}
               <b>Your Gateway to Seamless Travel Reimbursements</b>
              </span></span>
          </span>
        </div></header>
        {/* <main className="tc-content" id="main"> */}
        <main
            className="tc-content"
            id="main"
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              minHeight: 'calc(100vh - 80px)',
              height:100,
              // padding: '0px 1%',
              boxSizing: 'border-box',
              background: 'transparent',
            }}
          >
          <section
            className="tc-card"
            style={{
              width: '100%',
              maxWidth: 400,
              minHeight: 390, // increase card height
              margin: 0,
              background: 'rgba(151, 200, 255, 0.96)',
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.18)',
            }}
            data-testid="auth-card"
          >

          {/* <section className="tc-card" style={{ maxWidth: 440, margin: '48px auto' }} data-testid="auth-card"> */}
            <div className="tc-card__header"><div><h1 className="tc-card__title" style={{ fontSize: 20 }}>{title}</h1>{subtitle ? <p className="tc-card__subtitle">{subtitle}</p> : null}</div></div>
            {children}
          </section>
        </main>
      </div>
    </div>
  );
}

export function LoginPage({ auth, notice, onSignedIn, onForgot }: { auth: AuthApi; notice?: string; onSignedIn: () => void; onForgot: () => void }) {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (busy) return;
    if (!id.trim() || !pw) { setErr('Enter your employee ID and password.'); return; }
    setBusy(true); setErr(null);
    try { await auth.login(id.trim(), pw); onSignedIn(); }
    catch (e) { setErr(msg(e, 'Sign-in failed. Please try again.')); setPw(''); }
    finally { setBusy(false); }
  };
  return (
    <AuthLayout title="Sign in" subtitle="Use your employee ID and password.">
      <div className="tc-stack tc-stack--16" onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}>
        {notice ? <Alert tone="info">{notice}</Alert> : null}
        {err ? <Alert tone="error" title="Could not sign in"><span data-testid="login-error">{err}</span></Alert> : null}
        <Field label="Employee ID" required value={id} autoFocus testId="login-id" onChange={(v) => setId(String(v))} />
        <Field label="Password" required type={show ? 'text' : 'password'} value={pw} testId="login-password" onChange={(v) => setPw(String(v))} />
        <div className="tc-row">
          <Button variant="primary" label={busy ? 'Signing in…' : 'Sign in'} disabled={busy} onClick={() => void submit()} data-testid="login-submit" />
          <Button variant="ghost" label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)} />
          <span className="tc-chrome__fill" />
          <Button variant="ghost" label="Forgot password?" onClick={onForgot} data-testid="forgot-link" />
        </div>
      </div>
    </AuthLayout>
  );
}

export function ForgotPasswordPage({ auth, onBack }: { auth: AuthApi; onBack: () => void }) {
  const [id, setId] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (busy || !id.trim()) { if (!id.trim()) setErr('Enter your employee ID.'); return; }
    setBusy(true); setErr(null);
    try { setDone(await auth.forgotPassword(id.trim())); } catch (e) { setErr(msg(e, 'Could not send the reset link. Try again.')); } finally { setBusy(false); }
  };
  return (
    <AuthLayout title="Forgot password" subtitle="We will email a reset link to the address on your account.">
      <div className="tc-stack tc-stack--16">
        {done ? <Alert tone="success"><span data-testid="forgot-done">{done}</span></Alert> : <>
          {err ? <Alert tone="error">{err}</Alert> : null}
          <Field label="Employee ID" required value={id} testId="forgot-id" onChange={(v) => setId(String(v))} />
          <div className="tc-row"><Button variant="primary" label={busy ? 'Sending…' : 'Send reset link'} disabled={busy} onClick={() => void submit()} data-testid="forgot-submit" /></div>
        </>}
        <div><Button variant="ghost" label="Back to sign in" onClick={onBack} /></div>
      </div>
    </AuthLayout>
  );
}

function NewPasswordFields({ value, confirm, onValue, onConfirm, error }: { value: string; confirm: string; onValue: (v: string) => void; onConfirm: (v: string) => void; error?: string }) {
  const problems = value ? passwordProblems(value) : [];
  return (
    <>
      <Field label="New password" required value={value} testId="new-password" onChange={(v) => onValue(String(v))} type="password"
        {...(problems.length ? { helper: problems.join(' '), helperTone: 'warning' as const } : { helper: 'At least 10 characters with upper and lower case, a digit and a special character.' })} />
      <Field label="Confirm new password" required value={confirm} testId="confirm-password" onChange={(v) => onConfirm(String(v))} type="password" {...(error ? { error } : {})} />
    </>
  );
}

export function ResetPasswordPage({ auth, token, onDone }: { auth: AuthApi; token: string; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (busy) return;
    if (passwordProblems(pw).length) { setErr(passwordProblems(pw).join(' ')); return; }
    if (pw !== cf) { setErr('The two passwords do not match.'); return; }
    setBusy(true); setErr(null);
    try { setDone(await auth.resetPassword(token, pw)); } catch (e) { setErr(msg(e, 'Could not reset the password.')); } finally { setBusy(false); }
  };
  return (
    <AuthLayout title="Reset password">
      <div className="tc-stack tc-stack--16">
        {done ? <Alert tone="success"><span data-testid="reset-done">{done}</span></Alert> : <>
          {err ? <Alert tone="error"><span data-testid="reset-error">{err}</span></Alert> : null}
          <NewPasswordFields value={pw} confirm={cf} onValue={setPw} onConfirm={setCf} />
          <div className="tc-row"><Button variant="primary" label={busy ? 'Saving…' : 'Reset password'} disabled={busy} onClick={() => void submit()} data-testid="reset-submit" /></div>
        </>}
        <div><Button variant="ghost" label="Go to sign in" onClick={onDone} data-testid="reset-signin" /></div>
      </div>
    </AuthLayout>
  );
}

/** Used both in the account menu (modal) and as the forced screen when the account must change its password. */
export function ChangePasswordForm({ auth, onDone, onCancel }: { auth: AuthApi; onDone: () => void; onCancel?: () => void }) {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (busy) return;
    if (!cur) { setErr('Enter your current password.'); return; }
    if (passwordProblems(pw).length) { setErr(passwordProblems(pw).join(' ')); return; }
    if (pw !== cf) { setErr('The two passwords do not match.'); return; }
    setBusy(true); setErr(null);
    try { await auth.changePassword(cur, pw); onDone(); } catch (e) { setErr(msg(e, 'Could not change the password.')); } finally { setBusy(false); }
  };
  return (
    <div className="tc-stack tc-stack--16">
      {err ? <Alert tone="error"><span data-testid="change-error">{err}</span></Alert> : null}
      <Field label="Current password" required value={cur} testId="current-password" onChange={(v) => setCur(String(v))} type="password" />
      <NewPasswordFields value={pw} confirm={cf} onValue={setPw} onConfirm={setCf} />
      <div className="tc-row">
        <Button variant="primary" label={busy ? 'Saving…' : 'Change password'} disabled={busy} onClick={() => void submit()} data-testid="change-submit" />
        {onCancel ? <Button variant="ghost" label="Cancel" onClick={onCancel} /> : null}
      </div>
    </div>
  );
}

export const MustChangePasswordPage = ({ auth, onDone }: { auth: AuthApi; onDone: () => void }) => (
  <AuthLayout title="Choose a new password" subtitle="Your account requires a new password before you continue.">
    <ChangePasswordForm auth={auth} onDone={onDone} />
  </AuthLayout>
);
