/**
 * Sign-in.
 *
 * Renders outside the shell, like the server console does, because there is no project to show a
 * navigation rail for until someone has signed in. The design language is the console's own: the
 * same wordmark as the top bar, a `Card` at `--spacing-card` padding on the `--color-canvas`
 * ground, `TextField`'s floating labels, and the primary red button whose disabled state stays red
 * rather than going grey.
 *
 * The credential goes to this console's own origin and is exchanged for a server-side session
 * there. The browser receives an opaque httpOnly cookie and never holds a token.
 */
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button, Callout, Card, TextField } from '../components/primitives';
import { Spinner } from '../components/overlays';
import { problemMessage, type Problem } from '../data/problem';
import { useIntendedPath, useSession } from '../data/session';

export function Login() {
  const { session, signIn } = useSession();
  const navigate = useNavigate();
  const intended = useIntendedPath();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in: a bookmarked /login should not be a dead end.
  if (session) return <Navigate to={intended} replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setSubmitting(true);
    try {
      const result = await signIn({ username: username.trim(), password });
      if (result.ok) {
        await navigate(intended, { replace: true });
      } else {
        setProblem(result.problem);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <div className="w-full max-w-[26rem]">
        <div className="flex items-center justify-center gap-3">
          <span className="text-2xl font-extrabold tracking-[0.12em] text-primary">CONTROL</span>
          <span className="text-2xl font-normal text-text">Console</span>
        </div>

        <Card className="mt-8">
          <h1 className="text-[1.75rem] font-semibold leading-tight text-text">Sign in</h1>
          <p className="mt-2 text-[0.9375rem] leading-6 text-text-muted">
            Use the credentials for your project.
          </p>

          {problem ? (
            <div className="mt-5">
              <Callout tone="error" title="Sign-in failed">
                {problemMessage(problem)}
              </Callout>
            </div>
          ) : null}

          <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-5">
            <TextField
              label="Username"
              required
              autoFocus
              autoComplete="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <TextField
              label="Password"
              required
              type="password"
              autoComplete="current-password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              type="submit"
              className="h-12 w-full gap-2.5 text-base"
              disabled={submitting || username.trim() === '' || password === ''}
            >
              {submitting ? <Spinner /> : null}
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm leading-6 text-text-muted">
          This console manages virtual machines through the control plane. Sessions are held on the
          server; your browser never stores an access token.
        </p>
      </div>
    </main>
  );
}
