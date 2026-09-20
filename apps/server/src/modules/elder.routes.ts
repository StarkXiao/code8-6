import { Router } from 'express';
import type { ElderOverviewDto } from '@froa/shared';
import { prisma } from '../db/client';
import { asyncHandler, send } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { toAudioDto, toClipDto } from '../services/serialize';

/**
 * 长辈极简端专用接口。
 *
 * 极简端界面只有"按住说话"，但它需要一次拿到：
 *   - 我在哪些家庭空间里
 *   - 家人等着我回答的问题（跨空间）
 *   - 每道菜 + 最近录过的语音
 *
 * 若让浏览器分别调十几个现有接口，长辈端就会和整理端的数据形状耦合，
 * 以后整理端改个字段就可能把极简端搞坏。这里单独做一个聚合视图，
 * 所有数据都沿 membership 限定在"我参与的空间"内。
 */
export const elderRouter: Router = Router();

elderRouter.use(requireAuth);

elderRouter.get(
  '/elder/overview',
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { joinedAt: 'asc' },
    });

    const workspaceIds = memberships.map((member) => member.workspaceId);

    if (!workspaceIds.length) {
      const empty: ElderOverviewDto = { workspaces: [], questions: [], recipes: [] };
      send(res, empty);
      return;
    }

    const [askedItems, recipes, recentAudio, audioCountGroups] = await Promise.all([
      // 家人"问出口"的问题。open 状态是整理者还没去问的内部待办，不给长辈看
      prisma.vagueItem.findMany({
        where: { status: 'asked', recipe: { workspaceId: { in: workspaceIds } } },
        include: {
          recipe: { select: { id: true, title: true, workspaceId: true, workspace: { select: { name: true } } } },
          clip: { include: { audio: true } },
        },
        orderBy: { questionAskedAt: 'desc' },
        take: 100,
      }),
      prisma.recipe.findMany({
        where: { workspaceId: { in: workspaceIds }, status: 'active' },
        orderBy: { updatedAt: 'desc' },
      }),
      // 每个空间最近的语音在内存里截，避免按食谱 N+1
      prisma.audioAttachment.findMany({
        where: { workspaceId: { in: workspaceIds }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      prisma.audioAttachment.groupBy({
        by: ['recipeId'],
        where: { workspaceId: { in: workspaceIds }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const audioByRecipe = new Map<string, typeof recentAudio>();
    for (const audio of recentAudio) {
      const list = audioByRecipe.get(audio.recipeId) ?? [];
      list.push(audio);
      audioByRecipe.set(audio.recipeId, list);
    }

    const questions: ElderOverviewDto['questions'] = askedItems
      .map((item) => ({
        itemId: item.id,
        recipeId: item.recipe.id,
        recipeTitle: item.recipe.title,
        workspaceId: item.recipe.workspaceId,
        workspaceName: item.recipe.workspace.name,
        question: item.question ?? '',
        rawPhrase: item.rawPhrase,
        assignedToMe: item.assigneeId === userId,
        clip: item.clip ? toClipDto(item.clip) : null,
        clipAudio: item.clip ? toAudioDto(item.clip.audio) : null,
      }))
      // 专门问我的排最前面；组内保持提问时间倒序（Array.prototype.sort 是稳定排序）
      .sort((a, b) => Number(b.assignedToMe) - Number(a.assignedToMe));

    const audioCountByRecipe = new Map<string, number>(
      audioCountGroups.map((group) => [group.recipeId, group._count._all]),
    );

    const groups = new Map<string, ElderOverviewDto['recipes'][number]>();
    for (const member of memberships) {
      groups.set(member.workspaceId, {
        workspaceId: member.workspaceId,
        workspaceName: member.workspace.name,
        recipes: [],
      });
    }

    for (const recipe of recipes) {
      const group = groups.get(recipe.workspaceId);
      if (!group) continue;
      group.recipes.push({
        id: recipe.id,
        title: recipe.title,
        dishCategory: recipe.dishCategory,
        audioCount: audioCountByRecipe.get(recipe.id) ?? 0,
        recentAudio: (audioByRecipe.get(recipe.id) ?? []).slice(0, 3).map(toAudioDto),
      });
    }

    const overview: ElderOverviewDto = {
      workspaces: memberships.map((member) => ({
        id: member.workspaceId,
        name: member.workspace.name,
        role: member.role as ElderOverviewDto['workspaces'][number]['role'],
      })),
      questions,
      recipes: [...groups.values()].filter((group) => group.recipes.length > 0),
    };

    send(res, overview);
  }),
);
