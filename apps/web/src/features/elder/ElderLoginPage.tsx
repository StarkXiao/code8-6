import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { useAuthStore } from '../../store/auth';

/**
 * 长辈极简端登录页：只有两个大输入框和一个大按钮。
 * 实际场景通常是整理者帮长辈在这台设备上登录一次，之后令牌会一直保留。
 */
export function ElderLoginPage() {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) return <Navigate to="/elder" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate('/elder', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="froa-elder-login">
      <form className="froa-elder-login-card" onSubmit={submit}>
        <h1 className="froa-elder-title">家里的菜谱</h1>
        <p className="froa-elder-subtitle">登录以后，按住按钮说话就行</p>

        {error && <div className="froa-elder-error">{error}</div>}

        <label className="froa-elder-field">
          <span>账号（邮箱）</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="nainai@example.com"
            autoComplete="username"
            inputMode="email"
            required
          />
        </label>

        <label className="froa-elder-field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="froa-elder-submit" disabled={submitting}>
          {submitting ? '正在进…' : '进 去'}
        </button>

        <button
          type="button"
          className="froa-elder-textlink"
          onClick={() => navigate('/login')}
        >
          我是整理者，去整理端
        </button>
      </form>
    </div>
  );
}
