import fs from 'node:fs';
import { Router } from 'express';
import {
  assignAudioSchema,
  audioQuerySchema,
  createClipSchema,
  isAllowedAudioMime,
  updateTranscriptSchema,
  uploadAudioFieldsSchema,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId, sha256 } from '../lib/ids';
import { stringifyJson } from '../lib/json';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { audioUpload, translateUploadError } from '../middleware/upload';
import { queryOf, validateBody, validateQuery } from '../middleware/validate';
import { env } from '../config/env';
import {
  assertAudioRole,
  assertClipRole,
  assertRecipeRole,
  assertWorkspaceRole,
  getMembership,
} from '../services/access';
import { logActivity } from '../services/activity';
import { buildAudioKey, extensionForMime, storage } from '../services/storage';
import { transcriptionProvider } from '../services/transcription';
import { toAudioDto, toClipDto } from '../services/serialize';
import { emitToWorkspace } from '../realtime/hub';

export const audioRouter: Router = Router();

audioRouter.use(requireAuth);

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

/**
 * 上传音频。
 *
 * 两种落法：
 * - 带 recipeId：直接挂在食谱下（整理者在录音工作台）；
 * - 只带 workspaceId：进"语音收件箱"（长辈极简端按住说话），
 *   之后由整理者用 POST /audio/:id/assign 归到具体食谱。
 *
 * 关键点：
 * - 波形峰值由浏览器端用 Web Audio API 预计算后随表单一起提交，
 *   服务端直接入库，因此不依赖服务端 ffmpeg；
 * - 落盘时计算 SHA-256，之后可用于完整性校验；
 * - 音频只增不删，删除是软删除（保留证据链）。
 */
audioRouter.post(
  '/audio',
  (req, res, next) => {
    audioUpload.single('file')(req, res, (error: unknown) => {
      const translated = translateUploadError(error);
      if (translated) return next(translated);
      if (error) return next(error);
      return next();
    });
  },
  validateBody(uploadAudioFieldsSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError('VALIDATION_FAILED', '缺少上传文件字段 file');

    const { recipeId, workspaceId, kind, durationMs, peaks } = req.body as {
      recipeId?: string;
      workspaceId?: string;
      kind: string;
      durationMs: number;
      peaks: number[] | null;
    };

    // 挂食谱需要食谱所在空间的贡献者权限；进收件箱只需要目标空间的贡献者权限。
    // 两个分支拿到的 workspaceId 都以服务端鉴权结果为准，不信任客户端自报。
    const access = recipeId
      ? await assertRecipeRole(req.auth!.userId, recipeId, 'contributor')
      : await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'contributor');
    if (!isAllowedAudioMime(req.file.mimetype)) {
      throw new ApiError('UPLOAD_TYPE_NOT_ALLOWED', `不支持的音频格式：${req.file.mimetype}`);
    }

    const audioId = newId();
    const key = buildAudioKey(access.workspaceId, audioId, extensionForMime(req.file.mimetype));
    await storage().put(key, req.file.buffer);

    const audio = await prisma.audioAttachment.create({
      data: {
        id: audioId,
        workspaceId: access.workspaceId,
        recipeId: recipeId ?? null,
        ownerId: req.auth!.userId,
        kind,
        storagePath: key,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        durationMs,
        peaks: peaks ? stringifyJson(peaks) : null,
        sha256: sha256(req.file.buffer),
        transcriptStatus: 'none',
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.upload',
      entityType: 'audio_attachment',
      entityId: audio.id,
      after: { kind, sizeBytes: audio.sizeBytes, durationMs, inbox: !recipeId },
    });

    emitToWorkspace(access.workspaceId, 'audio:created', { recipeId: recipeId ?? null, audioId: audio.id, kind });
    created(res, toAudioDto(audio));
  }),
);

/**
 * 把收件箱里的语音归到具体食谱 —— 这是整理工作，要求整理者（editor）及以上。
 *
 * 目标食谱必须与音频在同一个家庭空间：否则一次请求就能把语音"搬"到
 * 别人家里，等于跨空间写入。
 */
audioRouter.post(
  '/audio/:audioId/assign',
  validateBody(assignAudioSchema),
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const { recipeId } = req.body as { recipeId: string };

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    // 音频所在空间的整理者权限 + 目标食谱的访问校验（同一空间才会通过）
    await assertWorkspaceRole(req.auth!.userId, audio.workspaceId, 'editor');
    const target = await assertRecipeRole(req.auth!.userId, recipeId, 'viewer');
    if (target.workspaceId !== audio.workspaceId) {
      throw new ApiError('VALIDATION_FAILED', '只能归到同一个家庭空间里的食谱');
    }

    const updated = await prisma.audioAttachment.update({
      where: { id: audio.id },
      data: { recipeId },
    });

    await logActivity({
      workspaceId: audio.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.assign',
      entityType: 'audio_attachment',
      entityId: audio.id,
      before: { recipeId: audio.recipeId },
      after: { recipeId },
    });

    emitToWorkspace(audio.workspaceId, 'audio:created', { recipeId, audioId: audio.id, kind: audio.kind });
    send(res, toAudioDto(updated));
  }),
);

/* ------------------------------------------------------------------ */
/* 列表与元数据                                                        */
/* ------------------------------------------------------------------ */

audioRouter.get(
  '/audio',
  validateQuery(audioQuerySchema),
  asyncHandler(async (req, res) => {
    // 一定要用校验后的值：includeDeleted 在 query string 里是字符串，
    // 直接读 req.query 会把 "false" 当成真值
    const { recipeId, workspaceId, kind, transcriptStatus, unassigned, includeDeleted } = queryOf(
      req,
      audioQuerySchema,
    );

    // 没指定食谱时，必须把范围限制在"我参与的空间"内。
    // 否则同一条接口会把所有家庭的音频都吐出来（跨空间泄漏）。
    let scopedWorkspaceIds: string[] | null = null;
    if (recipeId) {
      await assertRecipeRole(req.auth!.userId, recipeId, 'viewer');
    } else if (workspaceId) {
      await assertWorkspaceRole(req.auth!.userId, workspaceId, 'viewer');
      scopedWorkspaceIds = [workspaceId];
    } else {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId: req.auth!.userId },
        select: { workspaceId: true },
      });
      scopedWorkspaceIds = memberships.map((member) => member.workspaceId);
      if (!scopedWorkspaceIds.length) {
        send(res, []);
        return;
      }
    }

    const audios = await prisma.audioAttachment.findMany({
      where: {
        ...(recipeId
          ? { recipeId }
          : unassigned
            ? { recipeId: null, workspaceId: { in: scopedWorkspaceIds ?? [] } }
            : { workspaceId: { in: scopedWorkspaceIds ?? [] } }),
        ...(kind ? { kind } : {}),
        ...(transcriptStatus ? { transcriptStatus } : {}),
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    send(res, audios.map(toAudioDto));
  }),
);

audioRouter.get(
  '/audio/:audioId',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'viewer');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');
    send(res, toAudioDto(audio));
  }),
);

/* ------------------------------------------------------------------ */
/* 流式播放（支持 Range，长音频可拖动定位）                            */
/* ------------------------------------------------------------------ */

audioRouter.get(
  '/audio/:audioId/stream',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'viewer');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(audio.mimeType);

    const absolute = storage().absolutePath(audio.storagePath);
    if (absolute && fs.existsSync(absolute)) {
      res.sendFile(absolute, (error) => {
        if (error && !res.headersSent) {
          logger.warn({ err: error, audioId }, '音频流发送失败');
          res.status(500).end();
        }
      });
      return;
    }

    // 远端存储回退：整段读入后发送（无 Range 优化）
    try {
      const buffer = await storage().read(audio.storagePath);
      res.send(buffer);
    } catch {
      throw new ApiError('AUDIO_NOT_FOUND', '音频文件已丢失，请从备份恢复');
    }
  }),
);

/* ------------------------------------------------------------------ */
/* 转写                                                                */
/* ------------------------------------------------------------------ */

audioRouter.post(
  '/audio/:audioId/transcribe',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'contributor');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    await prisma.audioAttachment.update({
      where: { id: audio.id },
      data: { transcriptStatus: 'pending' },
    });

    const provider = transcriptionProvider();
    const absolutePath = storage().absolutePath(audio.storagePath);

    try {
      const result = absolutePath
        ? await provider.transcribe({ path: absolutePath, mimeType: audio.mimeType })
        : { text: '', segments: [], empty: true };

      const updated = await prisma.audioAttachment.update({
        where: { id: audio.id },
        data: {
          transcript: result.empty ? audio.transcript : result.text,
          transcriptStatus: 'done',
        },
      });

      send(res, {
        audio: toAudioDto(updated),
        provider: provider.name,
        segments: result.segments,
        needsManualInput: result.empty,
        hint: result.empty
          ? '当前转写驱动为 manual：请在上方文本框中人工录入这段口述'
          : undefined,
      });
    } catch (error) {
      await prisma.audioAttachment.update({
        where: { id: audio.id },
        data: { transcriptStatus: 'failed' },
      });
      throw error;
    }
  }),
);

audioRouter.patch(
  '/audio/:audioId/transcript',
  validateBody(updateTranscriptSchema),
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'contributor');

    const { transcript, transcriptStatus } = req.body as {
      transcript: string;
      transcriptStatus?: string;
    };

    const audio = await prisma.audioAttachment.update({
      where: { id: audioId! },
      data: { transcript, transcriptStatus: transcriptStatus ?? 'done' },
    });
    send(res, toAudioDto(audio));
  }),
);

/* ------------------------------------------------------------------ */
/* 音频片段                                                            */
/* ------------------------------------------------------------------ */

audioRouter.post(
  '/audio/:audioId/clips',
  validateBody(createClipSchema),
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const access = await assertAudioRole(req.auth!.userId, audioId!, 'contributor');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    const { startMs, endMs, label } = req.body as {
      startMs: number;
      endMs: number;
      label?: string | null;
    };

    if (endMs <= startMs) {
      throw new ApiError('VALIDATION_FAILED', '片段的结束时间必须大于开始时间');
    }
    if (audio.durationMs > 0 && endMs > audio.durationMs + 500) {
      throw new ApiError('VALIDATION_FAILED', '片段超出了音频长度');
    }

    const clip = await prisma.audioClip.create({
      data: {
        id: newId(),
        audioAttachmentId: audio.id,
        startMs,
        endMs,
        label: label ?? null,
        createdBy: req.auth!.userId,
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.clip.create',
      entityType: 'audio_clip',
      entityId: clip.id,
      after: { startMs, endMs, label: clip.label },
    });

    created(res, toClipDto(clip));
  }),
);

audioRouter.get(
  '/clips/:clipId',
  asyncHandler(async (req, res) => {
    const { clipId } = req.params;
    await assertClipRole(req.auth!.userId, clipId!, 'viewer');

    const clip = await prisma.audioClip.findUnique({
      where: { id: clipId! },
      include: { audio: true },
    });
    if (!clip) throw notFound('音频片段');

    send(res, { ...toClipDto(clip), audio: toAudioDto(clip.audio) });
  }),
);

/* ------------------------------------------------------------------ */
/* 软删除                                                              */
/* ------------------------------------------------------------------ */

audioRouter.delete(
  '/audio/:audioId',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const access = await assertAudioRole(req.auth!.userId, audioId!, 'contributor');
    const membership = await getMembership(req.auth!.userId, access.workspaceId);

    // 录制者本人可删；整理者及以上可删任意音频
    if (access.ownerId !== req.auth!.userId && membership.role === 'contributor') {
      throw new ApiError('AUTH_FORBIDDEN', '只有录制者本人或整理者可以删除该音频');
    }

    await prisma.audioAttachment.update({
      where: { id: audioId! },
      data: { deletedAt: new Date() },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.softDelete',
      entityType: 'audio_attachment',
      entityId: audioId!,
    });

    send(res, {
      removed: audioId,
      softDeleted: true,
      // 说清楚语义：只是从语音列表里隐藏，文件与证据链都还在
      retainedAsEvidence: true,
      message: '音频已从语音列表移除，但文件仍保留：引用它的结论依然可以回放原声。',
      maxUploadMb: env.maxUploadMb,
    });
  }),
);
