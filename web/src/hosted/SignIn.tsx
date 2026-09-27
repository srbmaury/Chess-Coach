// Email/password sign-in for hosted mode: sign in, create an account, reset a
// forgotten password, and choose a new password after opening a reset link.
import { FormEvent, useState } from 'react'

import { MIN_PASSWORD_LENGTH } from './auth'
import type { HostedServices } from './services'

type SignInMode = 'sign_in' | 'sign_up' | 'forgot'

const SIGN_IN_COPY: Record<SignInMode, { kicker: string; title: string; submit: string; busy: string }> = {
  sign_in: { kicker: 'SIGN IN', title: 'Train on your own games', submit: 'Sign in', busy: 'Signing in…' },
  sign_up: { kicker: 'CREATE ACCOUNT', title: 'Train on your own games', submit: 'Create account', busy: 'Creating…' },
  forgot: { kicker: 'RESET PASSWORD', title: 'Forgot your password?', submit: 'Email me a reset link', busy: 'Sending…' },
}

export function SignIn({ services }: { services: HostedServices }) {
  const [mode, setMode] = useState<SignInMode>('sign_in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const copy = SIGN_IN_COPY[mode]

  function switchTo(next: SignInMode) {
    setMode(next)
    setError('')
    setNotice('')
    setPassword('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'sign_in') {
        await services.signIn(email, password)
      } else if (mode === 'sign_up') {
        const result = await services.signUp(email, password)
        if (result === 'confirm_email') setNotice('Check your email to confirm your account, then sign in.')
      } else {
        await services.requestPasswordReset(email)
        setNotice('If an account exists for that email, a reset link is on its way.')
      }
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel hosted-narrow">
    <p className="kicker">{copy.kicker}</p>
    <h1>{copy.title}</h1>
    {mode === 'forgot' && <p className="muted">We'll email you a link to choose a new password.</p>}
    <form onSubmit={submit} className="hosted-auth-form">
      <label>Email
        <input type="email" autoComplete="email" value={email} required
          onChange={(event) => setEmail(event.target.value)} disabled={busy} />
      </label>
      {mode !== 'forgot' && <label>Password
        <input type="password" value={password} required
          autoComplete={mode === 'sign_up' ? 'new-password' : 'current-password'}
          minLength={mode === 'sign_up' ? MIN_PASSWORD_LENGTH : undefined}
          onChange={(event) => setPassword(event.target.value)} disabled={busy} />
      </label>}
      {mode === 'sign_up' && <p className="muted hosted-small">At least {MIN_PASSWORD_LENGTH} characters.</p>}
      <button type="submit" disabled={busy || !email.trim() || (mode !== 'forgot' && !password)}>
        {busy ? copy.busy : copy.submit}
      </button>
    </form>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="hosted-error" role="alert">{error}</p>}
    <div className="hosted-auth-links">
      {mode === 'sign_in' && <>
        <button type="button" className="link" onClick={() => switchTo('forgot')}>Forgot password?</button>
        <button type="button" className="link" onClick={() => switchTo('sign_up')}>Create an account</button>
      </>}
      {mode !== 'sign_in' && <button type="button" className="link" onClick={() => switchTo('sign_in')}>Back to sign in</button>}
    </div>
  </section>
}

export function NewPassword({ services, onDone }: { services: HostedServices; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password !== confirm) {
      setError('The passwords do not match')
      return
    }
    setBusy(true)
    setError('')
    try {
      await services.updatePassword(password)
      onDone()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel hosted-narrow">
    <p className="kicker">RESET PASSWORD</p>
    <h1>Choose a new password</h1>
    <form onSubmit={submit} className="hosted-auth-form">
      <label>New password
        <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required value={password}
          onChange={(event) => setPassword(event.target.value)} disabled={busy} />
      </label>
      <label>Confirm new password
        <input type="password" autoComplete="new-password" required value={confirm}
          onChange={(event) => setConfirm(event.target.value)} disabled={busy} />
      </label>
      <button type="submit" disabled={busy || !password || !confirm}>{busy ? 'Saving…' : 'Save password'}</button>
    </form>
    {error && <p className="hosted-error" role="alert">{error}</p>}
  </section>
}
