import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { workspaceApi, audioApi } from '../../api/endpoints';
import { analyzeAudio } from '../../components/AudioRecorder';
import { errorMessage } from '../../api/client';
import { useAuthStore } from '../../store/auth';

/**
 * 长辈极简端 —— 整个页面只有一件事：按住说话。
 *
 * 设计约束（每一条都对应长辈真实会遇到的坎）：
 * - 不选食谱、不填任何字、不看任何列表。录好的语音先进"语音收件箱"，
 *   归到哪道菜、转写、整理，全部由家里的整理者完成；
 * - 按住就录、松手就存，没有"开始/停止/保存"三步操作；
 * - 所有反馈都用大字：正在录（红色+计时）→ 正在保存 → 已存好；
 * - 误触保护：按得太短不算录音；长按弹出的系统菜单要禁掉；
 * - 只记"今天存了几段"，让长辈确定"我说的话真的存下来了"。
 */

type Phase =
  | { name: 'idle' }
  | { name: 'recording'; startedAt: number }
  | { name: 'saving' }
  | { name: 'saved' }
  | { name: 'error'; message: string };

/** 短于这个时长视为误触，不上传 */
const MIN_RECORD_MS = 800;
const WORKSPACE_CACHE_KEY = 'froa.talk.workspaceId';

const pickMimeType = (): string => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return '';
};

export function TalkPage() {
  const user = useAuthStore((s) => s.user);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    window.localStorage.getItem(WORKSPACE_CACHE_KEY),
  );
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [savedCount, setSavedCount] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  // 手指可能在 getUserMedia 返回前就松开：记下来，拿到流后立即停止
  const releaseEarlyRef = useRef(false);
  // 等麦克风权限期间再来一次按下：忽略，避免同时挂两个录音器
  const startingRef = useRef(false);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => workspaceApi.list(),
  });

  const list = workspaces.data ?? [];
  // 只有一个空间时不用选；记住的选择失效（被移出空间）时回到选择页
  const activeWorkspace =
    list.length === 1
      ? list[0]!
      : workspaceId
        ? (list.find((w) => w.id === workspaceId) ?? null)
        : null;
  const activeWorkspaceId = activeWorkspace?.id ?? null;

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      const recorder = recorderRef.current;
      if (recorder && recorder.state === 'recording') recorder.stop();
    };
  }, []);

  const chooseWorkspace = (id: string) => {
    window.localStorage.setItem(WORKSPACE_CACHE_KEY, id);
    setWorkspaceId(id);
  };

  const forgetWorkspace = () => {
    window.localStorage.removeItem(WORKSPACE_CACHE_KEY);
    setWorkspaceId(null);
  };

  const stopTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const uploadBlob = useCallback(
    async (blob: Blob, durationMs: number, mimeType: string, targetWorkspaceId: string) => {
      setPhase({ name: 'saving' });
      try {
        const analysis = await analyzeAudio(blob).catch(() => null);
        const extension = mimeType.includes('mp4') ? 'm4a' : 'webm';
        await audioApi.upload({
          file: blob,
          filename: `voice-${Date.now()}.${extension}`,
          workspaceId: targetWorkspaceId,
          kind: 'recipe_voice',
          durationMs: analysis?.durationMs ?? durationMs,
          peaks: analysis?.peaks ?? null,
        });
        setSavedCount((count) => count + 1);
        setPhase({ name: 'saved' });
        window.setTimeout(() => {
          // 只有没人开始下一段录音时才回到初始提示
          if (phaseRef.current.name === 'saved') setPhase({ name: 'idle' });
        }, 2500);
      } catch (caught) {
        setPhase({ name: 'error', message: `没存上：${errorMessage(caught)}。请再按一次试试。` });
      }
    },
    [],
  );

  const startRecording = useCallback(async () => {
    if (!activeWorkspaceId) return;
    if (phaseRef.current.name === 'recording' || phaseRef.current.name === 'saving') return;
    if (startingRef.current) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase({ name: 'error', message: '这个浏览器不能录音，请让家人帮忙换 Chrome 或 Safari。' });
      return;
    }

    releaseEarlyRef.current = false;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 拿到麦克风时手指已经松开了：直接关掉，不录
      if (releaseEarlyRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const startedAt = Date.now();
      const workspaceIdAtStart = activeWorkspaceId;

      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const durationMs = Date.now() - startedAt;
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (durationMs < MIN_RECORD_MS || blob.size === 0) {
          setPhase({ name: 'error', message: '按得太短，没录上。按住别松手，说完再松。' });
          return;
        }
        void uploadBlob(blob, durationMs, mimeType || 'audio/webm', workspaceIdAtStart);
      };

      recorderRef.current = recorder;
      recorder.start(1000);
      navigator.vibrate?.(30);
      setElapsed(0);
      setPhase({ name: 'recording', startedAt });
      timerRef.current = window.setInterval(() => setElapsed(Date.now() - startedAt), 100);
    } catch (caught) {
      const denied = caught instanceof Error && caught.name === 'NotAllowedError';
      setPhase({
        name: 'error',
        message: denied
          ? '麦克风没打开。请让家人在浏览器设置里允许这个网站使用麦克风。'
          : `开不了录音：${(caught as Error).message}`,
      });
    } finally {
      startingRef.current = false;
    }
  }, [activeWorkspaceId, uploadBlob]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      // 还在等麦克风权限：标记"已经松手"，权限下来后直接放弃
      releaseEarlyRef.current = true;
      return;
    }
    stopTimer();
    navigator.vibrate?.(15);
    recorder.stop();
  }, []);

  /* ---------------- 渲染 ---------------- */

  if (workspaces.isLoading) {
    return (
      <div className="froa-talk-page">
        <p className="froa-talk-status">正在打开…</p>
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="froa-talk-page">
        <p className="froa-talk-status">
          还没有加入家庭空间。
          <br />
          请家人先建好空间，把您拉进去，再打开这个页面。
        </p>
      </div>
    );
  }

  if (!activeWorkspaceId) {
    return (
      <div className="froa-talk-page">
        <p className="froa-talk-status">您要给哪个家录？</p>
        <div className="froa-talk-workspaces">
          {list.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="froa-talk-workspace-btn"
              onClick={() => chooseWorkspace(workspace.id)}
            >
              {workspace.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const recording = phase.name === 'recording';
  const busy = recording || phase.name === 'saving';

  // 旁观者是"看"的角色，录了也存不上，干脆不显示按钮
  if (activeWorkspace?.role === 'viewer') {
    return (
      <div className="froa-talk-page">
        <h1 className="froa-talk-hello">这个账号是旁观者，只能看、不能录音。</h1>
        <p className="froa-talk-status">要录音的话，请家人把您的角色改成"贡献者"。</p>
        <footer className="froa-talk-footer">
          <Link to="/" className="froa-talk-footer-link">
            我是整理者，去完整版
          </Link>
        </footer>
      </div>
    );
  }

  return (
    <div className="froa-talk-page">
      <h1 className="froa-talk-hello">
        {user?.displayName ?? ''}，想说什么，按住下面这个圆钮就说。
      </h1>

      <button
        type="button"
        className={`froa-talk-btn${recording ? ' recording' : ''}`}
        disabled={phase.name === 'saving'}
        aria-label={recording ? '松手结束录音' : '按住说话'}
        onPointerDown={(event) => {
          event.preventDefault();
          try {
            // 让手指滑出按钮也能收到 pointerup；个别浏览器/合成事件不支持，忽略即可
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* 不支持指针捕获不影响录音 */
          }
          void startRecording();
        }}
        onPointerUp={(event) => {
          event.preventDefault();
          stopRecording();
        }}
        onPointerCancel={stopRecording}
        onContextMenu={(event) => event.preventDefault()}
      >
        {recording ? (
          <>
            松手
            <br />
            存好
          </>
        ) : (
          <>
            按住
            <br />
            说话
          </>
        )}
      </button>

      <div className="froa-talk-status" aria-live="polite">
        {recording && (
          <>
            <span className="froa-talk-timer">{formatElapsed(elapsed)}</span>
            <br />
            正在录，说完松手
          </>
        )}
        {phase.name === 'saving' && '正在保存…'}
        {phase.name === 'saved' && '✓ 已存好'}
        {phase.name === 'error' && <span className="froa-talk-error">{phase.message}</span>}
        {phase.name === 'idle' && '按住圆钮别松手，说完再松'}
      </div>

      {savedCount > 0 && <p className="froa-talk-count">这次打开以来，已存好 {savedCount} 段</p>}

      <footer className="froa-talk-footer">
        {list.length > 1 && (
          <button
            type="button"
            className="froa-talk-footer-link"
            disabled={busy}
            onClick={forgetWorkspace}
          >
            换个空间
          </button>
        )}
        <Link to="/" className="froa-talk-footer-link">
          我是整理者，去完整版
        </Link>
      </footer>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
