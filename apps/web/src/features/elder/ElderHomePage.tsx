import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AudioAttachmentDto,
  ElderQuestionDto,
  ElderRecipeDto,
  ElderRecipeGroupDto,
} from '@froa/shared';
import { audioApi, elderApi, vagueItemApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { useAuthStore } from '../../store/auth';
import { HoldToTalk } from '../../components/HoldToTalk';
import type { RecordedAudio } from '../../components/AudioRecorder';
import { formatMs } from '../../components/Waveform';

/**
 * 长辈极简端首页 —— 整个页面只有一种动作：按住说话。
 *
 * 两块内容：
 *  1. 家人等着问的问题：听一遍问题，按住回答，松手自动发出去；
 *  2. 想录哪道菜：按住说做法，松手自动存好。
 *
 * 转写、框选模糊句、归纳规格、发布版本全部由整理者在整理端完成，
 * 这里不出现任何编辑入口（权限上长辈是 contributor，服务端也会挡住整理操作）。
 */
export function ElderHomePage() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const overview = useQuery({
    queryKey: ['elder-overview'],
    queryFn: elderApi.overview,
    refetchInterval: 30_000,
  });

  const groups = overview.data?.recipes ?? [];
  // 后端已把"专门问我的"排在最前，公开问题随后；两类都要给长辈看到
  const questions = overview.data?.questions ?? [];
  const isViewer = overview.data?.workspaces.every((space) => space.role === 'viewer') ?? false;

  return (
    <div className="froa-elder">
      <header className="froa-elder-header">
        <div>
          <h1 className="froa-elder-greeting">{user ? `${user.displayName}，您好` : '您好'}</h1>
          <p className="froa-elder-date-tip">想说什么，按住下面的大按钮就行</p>
        </div>
        <button
          type="button"
          className="froa-elder-logout"
          onClick={() => {
            logout();
            navigate('/elder/login', { replace: true });
          }}
        >
          退出
        </button>
      </header>

      {overview.isLoading && <p className="froa-elder-loading">正在打开…</p>}

      {overview.error && (
        <p className="froa-elder-error">打不开了，请家人帮忙看看网络：{errorMessage(overview.error)}</p>
      )}

      {overview.data && overview.data.workspaces.length === 0 && (
        <div className="froa-elder-card froa-elder-empty">
          <p>家里人还没把您拉进家庭空间。</p>
          <p>请家人用邀请码把您加进来，就能开始说话了。</p>
        </div>
      )}

      {isViewer && (
        <div className="froa-elder-card froa-elder-empty">
          您在这个家里是「旁观者」，只能听，不能录。想录音的话，请家里的整理者把您的身份改成「家里人」。
        </div>
      )}

      {!isViewer && questions.length > 0 && (
        <section className="froa-elder-section">
          <h2 className="froa-elder-section-title">
            家人等着您回答<span className="froa-elder-section-count">{questions.length}</span>
          </h2>
          {questions.map((question) => (
            <QuestionCard
              key={question.itemId}
              question={question}
              onDone={() => void queryClient.invalidateQueries({ queryKey: ['elder-overview'] })}
            />
          ))}
        </section>
      )}

      {!isViewer && groups.length > 0 && (
        <section className="froa-elder-section">
          <h2 className="froa-elder-section-title">想说说哪道菜</h2>
          {groups.map((group) => (
            <RecipeGroup key={group.workspaceId} group={group} showGroupName={groups.length > 1} />
          ))}
        </section>
      )}

      <footer className="froa-elder-footer">
        您说的每一句话都会原原本本存下来，家里整理的人会把它变成菜谱。
      </footer>
    </div>
  );
}

/* ---------------- 回答家人问题 ---------------- */

function QuestionCard({ question, onDone }: { question: ElderQuestionDto; onDone: () => void }) {
  const { playAudio } = useAudioPlayback();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 上传 answer_voice → 建整段片段 → 提交答复，全程不需要长辈做任何选择
  const handleAnswer = async (recorded: RecordedAudio) => {
    setBusy(true);
    setError(null);
    try {
      const audio = await audioApi.upload({
        file: recorded.blob,
        filename: recorded.filename,
        recipeId: question.recipeId,
        kind: 'answer_voice',
        durationMs: recorded.durationMs,
        peaks: recorded.peaks,
      });
      const clip = await audioApi.createClip(audio.id, { startMs: 0, endMs: Math.max(1, recorded.durationMs) });
      await vagueItemApi.answer(question.itemId, { answerClipId: clip.id });
      setSent(true);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught; // 让 HoldToTalk 也复位并展示提示
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="froa-elder-card froa-elder-question">
      <div className="froa-elder-card-head">
        <span className="froa-elder-dishname">{question.recipeTitle}</span>
        {!question.assignedToMe && <span className="froa-elder-badge">谁方便谁答</span>}
      </div>

      {sent ? (
        <div className="froa-elder-thanks" data-testid="answer-sent">
          回答已经发给家里人了，谢谢您！
        </div>
      ) : (
        <>
          <p className="froa-elder-question-text">
            家人问您：<strong>{question.question}</strong>
          </p>
          <p className="froa-elder-quote">您当时说的是：「{question.rawPhrase}」</p>

          {question.clipAudio && (
            <button
              type="button"
              className="froa-elder-replay"
              onClick={() =>
                playAudio(question.clipAudio, {
                  startMs: question.clip?.startMs,
                  endMs: question.clip?.endMs,
                  label: `当时说的那句 · ${question.recipeTitle}`,
                })
              }
            >
              ▶ 再听一遍我当时说的
            </button>
          )}

          <HoldToTalk shape="bar" label="按住 回答家人" onCaptured={handleAnswer} disabled={busy} />
          {error && <div className="froa-elder-error">{error}</div>}
        </>
      )}
    </article>
  );
}

/* ---------------- 录一道菜 ---------------- */

function RecipeGroup({ group, showGroupName }: { group: ElderRecipeGroupDto; showGroupName: boolean }) {
  return (
    <div className="froa-elder-group">
      {showGroupName && <h3 className="froa-elder-group-title">{group.workspaceName}</h3>}
      {group.recipes.map((recipe) => (
        <RecipeCard key={recipe.id} recipe={recipe} />
      ))}
    </div>
  );
}

function RecipeCard({ recipe }: { recipe: ElderRecipeDto }) {
  const { playAudio } = useAudioPlayback();
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (recorded: RecordedAudio) => {
      await audioApi.upload({
        file: recorded.blob,
        filename: recorded.filename,
        recipeId: recipe.id,
        kind: 'recipe_voice',
        durationMs: recorded.durationMs,
        peaks: recorded.peaks,
      });
      // manual 转写模式下不自动转写：状态保持 none，会在整理端"待转写"里等着家人代录文字
    },
    onSuccess: () => {
      setJustSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['elder-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['audio', recipe.id] });
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <article className="froa-elder-card froa-elder-recipe">
      <div className="froa-elder-card-head">
        <span className="froa-elder-dishname">{recipe.title}</span>
        <span className="froa-elder-audio-count">
          已经存了 <strong data-testid="audio-count">{recipe.audioCount}</strong> 段
        </span>
      </div>

      <HoldToTalk
        shape="bar"
        label={`按住 说说「${recipe.title}」`}
        onCaptured={async (recorded) => {
          setJustSaved(false);
          await saveMutation.mutateAsync(recorded);
        }}
        disabled={saveMutation.isPending}
      />

      {recipe.recentAudio.length > 0 && (
        <div className="froa-elder-past">
          <span className="froa-elder-past-label">听听自己以前说的：</span>
          {recipe.recentAudio.map((audio: AudioAttachmentDto, index) => (
            <button
              key={audio.id}
              type="button"
              className="froa-elder-past-btn"
              onClick={() =>
                playAudio(audio, { label: `${recipe.title} · 第 ${recipe.recentAudio.length - index} 段` })
              }
            >
              ▶ {formatMs(audio.durationMs)}
            </button>
          ))}
        </div>
      )}

      {error && <div className="froa-elder-error">{error}</div>}
      {justSaved && !saveMutation.isPending && !error && (
        <div className="froa-elder-saved" role="status">
          存好啦，家里整理的人会听到的。
        </div>
      )}
    </article>
  );
}
