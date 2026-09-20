import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeAudio, type RecordedAudio } from './AudioRecorder';
import { formatMs } from './Waveform';

interface HoldToTalkProps {
  /** 松手后回调；抛错会被本组件接住并展示，不会让页面崩 */
  onCaptured: (audio: RecordedAudio) => Promise<void> | void;
  /** 按钮上的大字提示 */
  label?: string;
  /** 圆形（答题用，默认）或长条（首页录菜用） */
  shape?: 'circle' | 'bar';
  disabled?: boolean;
  /** 短于此时长视为误触，不保存（默认 800ms） */
  minMs?: number;
}

/**
 * 长辈端唯一的交互原语：**按住说话，松开发送**。
 *
 * 与整理端 AudioRecorder 的区别：
 * - 没有"开始/停止/重录/保存"四个动作，按下就录、松手就传；
 * - pointer 事件统一处理鼠标与触摸，并在按下时 setPointerCapture，
 *   手指滑出按钮也能收到松手事件，不会"卡住一直录"；
 * - 太短（误触）直接丢弃并给出大字提示；
 * - 上传期间按钮锁定，防止连按产生并发上传。
 */
export function HoldToTalk({
  onCaptured,
  label = '按住 说话',
  shape = 'circle',
  disabled = false,
  minMs = 800,
}: HoldToTalkProps) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  /** getUserMedia 权限弹窗期间手指已松开：权限到手后立即放弃这次录制 */
  const cancelledRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    return () => {
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state === 'recording') recorder.stop();
      cleanupStream();
    };
  }, []);

  const pickMimeType = (): string => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
    }
    return '';
  };

  const start = useCallback(
    async (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled || phase !== 'idle' || savingRef.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setHint(null);
      cancelledRef.current = false;

      if (!navigator.mediaDevices?.getUserMedia) {
        setHint('这个浏览器不能录音，请家人帮忙换 Chrome 或 Safari');
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (caught) {
        setHint(
          caught instanceof Error && caught.name === 'NotAllowedError'
            ? '还没允许使用麦克风，请家人点一下地址栏里的麦克风图标'
            : '麦克风打不开，请家人帮忙检查一下',
        );
        return;
      }

      // 权限弹窗期间手指已经松开：别再开始录，释放麦克风直接结束
      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        cancelledRef.current = false;
        return;
      }

      const mimeType = pickMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch {
        cleanupStream();
        setHint('这个浏览器不能录音，请家人帮忙换一个');
        return;
      }

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (dataEvent) => {
        if (dataEvent.data.size > 0) chunksRef.current.push(dataEvent.data);
      };
      startedAtRef.current = Date.now();
      recorder.start(1000);
      setPhase('recording');
      setElapsed(0);
      clearTimer();
      timerRef.current = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 100);
    },
    [disabled, phase],
  );

  const stop = useCallback(
    async (event?: React.PointerEvent<HTMLButtonElement>) => {
      if (event) event.preventDefault();
      const recorder = recorderRef.current;
      if (phase !== 'recording' || !recorder || recorder.state !== 'recording') {
        // 可能在 getUserMedia 的权限弹窗期间松手：记下取消标志，麦克风到手后立即释放
        cancelledRef.current = true;
        cleanupStream();
        return;
      }

      clearTimer();
      const durationMs = Date.now() - startedAtRef.current;
      savingRef.current = true;
      setPhase('saving');

      recorder.onstop = async () => {
        cleanupStream();
        const mimeType = recorder.mimeType || 'audio/webm';

        if (durationMs < minMs) {
          savingRef.current = false;
          setPhase('idle');
          setHint('说得太短啦，按住按钮慢慢说，说完再松手');
          return;
        }

        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        try {
          // 解码失败也不影响保存：没有波形而已，整理端照样能听
          const analysis = await analyzeAudio(blob).catch(() => null);
          const extension = mimeType.includes('mp4') ? 'm4a' : 'webm';
          await onCaptured({
            blob,
            durationMs: analysis?.durationMs ?? durationMs,
            peaks: analysis?.peaks ?? null,
            filename: `voice-${Date.now()}.${extension}`,
          });
          setHint('已经存好啦，放心。');
        } catch (caught) {
          setHint(caught instanceof Error ? caught.message : '没存上，请再说一遍');
        } finally {
          savingRef.current = false;
          setPhase('idle');
        }
      };

      recorder.stop();
    },
    [minMs, onCaptured, phase],
  );

  // 录音中切走页面 / 来电导致页面隐藏：自动停止保存，避免一直占着麦克风
  useEffect(() => {
    if (phase !== 'recording') return;
    const handleVisibility = () => {
      if (document.hidden) void stop();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [phase, stop]);

  const busy = phase !== 'idle';

  return (
    <div className={`froa-hold froa-hold-${shape}`}>
      <button
        type="button"
        className={`froa-hold-btn ${busy ? 'is-active' : ''} ${shape === 'bar' ? 'is-bar' : 'is-circle'}`}
        disabled={disabled || phase === 'saving'}
        aria-label={phase === 'recording' ? '正在录音，松开发送' : label}
        data-testid="hold-to-talk"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerCancel={stop}
        // 阻止浏览器把长按当成选中文本 / 右键菜单 / 触摸滚动
        onContextMenu={(event) => event.preventDefault()}
      >
        {phase === 'recording' ? (
          <span className="froa-hold-inner">
            <span className="froa-hold-timer" data-testid="hold-timer">
              {formatMs(elapsed)}
            </span>
            <span className="froa-hold-main">松手 就发出去</span>
          </span>
        ) : phase === 'saving' ? (
          <span className="froa-hold-inner">
            <span className="froa-hold-main">正在存…</span>
          </span>
        ) : (
          <span className="froa-hold-inner">
            <span className="froa-hold-main">{label}</span>
            <span className="froa-hold-sub">说完松手，自动存好</span>
          </span>
        )}
      </button>
      {hint && (
        <div className="froa-hold-hint" data-testid="hold-hint" role="status">
          {hint}
        </div>
      )}
    </div>
  );
}
