import { FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { homePath } from '../components/Layout';
import { Alert, Button, Field, Input } from '../components/ui';
import { errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/app" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const u = await login(username.trim(), password);
      navigate(homePath(u.role), { replace: true });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-900 to-brand-600 p-5">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-xl">
        <div className="text-center">
          <h1 className="text-2xl font-extrabold text-brand-900">Login</h1>
          <p className="text-sm text-slate-500">SMC-FaceAttend · Pos Parkir Mal SMC</p>
        </div>
        {error && <Alert>{error}</Alert>}
        <Field label="Username">
          <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full py-3" loading={loading}>
          Masuk
        </Button>
        <Link to="/" className="block text-center text-sm text-brand-600 hover:underline">
          ← Kembali ke halaman utama
        </Link>
      </form>
    </div>
  );
}
