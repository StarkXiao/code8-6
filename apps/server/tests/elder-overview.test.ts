/**
 * 长辈极简端聚合接口 /api/elder/overview 的测试。
 *
 * 极简端的承诺是"长辈只负责说，其余整理者代劳"，因此这里重点验证：
 *  - 只看得到自己参与的空间（跨空间隔离）；
 *  - 只看得到家人真正"问出口"（asked）的问题，内部 open 待办不暴露；
 *  - 专门指派给我的问题排在公开问题之前；
 *  - 菜的语音计数正确、软删除音频不计入；
 *  - 未登录 401。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

function fakeWav(seconds = 1): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function uploadAudio(session: Session, recipeId: string, kind: string): Promise<string> {
  const response = await request(app)
    .post('/api/audio')
    .set(auth(session))
    .field('recipeId', recipeId)
    .field('kind', kind)
    .field('durationMs', '1000')
    .field('peaks', JSON.stringify([0.1, 0.6, 0.9]))
    .attach('file', fakeWav(), { filename: 'voice.wav', contentType: 'audio/wav' })
    .expect(201);
  return response.body.data.id as string;
}

describe('长辈极简端聚合视图', () => {
  let grandma: Session;
  let organizer: Session;
  let outsider: Session;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let recipeId: string;
  let otherRecipeId: string;
  let assignedItemId: string;
  let openItemId: string;
  let publicItemId: string;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeAll(async () => {
    const stamp = Date.now();
    grandma = await register(`grandma-${stamp}@elder.test`, '外婆');
    organizer = await register(`organizer-${stamp}@elder.test`, '整理者');
    outsider = await register(`outsider-${stamp}@elder.test`, '外人');

    // 整理者建空间，外婆加入（默认 contributor）
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '外婆家厨房' })
      .expect(201);
    workspaceId = ws.body.data.id as string;

    await request(app)
      .post('/api/workspaces/join')
      .set(auth(grandma))
      .send({ inviteCode: ws.body.data.inviteCode })
      .expect(201);

    // 外人的另一个空间
    const otherWs = await request(app)
      .post('/api/workspaces')
      .set(auth(outsider))
      .send({ name: '别人家厨房' })
      .expect(201);
    otherWorkspaceId = otherWs.body.data.id as string;

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '外婆的红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id as string;

    const otherRecipe = await request(app)
      .post('/api/recipes')
      .set(auth(outsider))
      .send({ workspaceId: otherWorkspaceId, title: '别人家的菜' })
      .expect(201);
    otherRecipeId = otherRecipe.body.data.id as string;

    // 两条 open：整理者还没问出口，不应出现在长辈端
    const open1 = await request(app)
      .post(`/api/recipes/${recipeId}/vague-items`)
      .set(auth(organizer))
      .send({ category: 'amount', rawPhrase: '放一点点糖' })
      .expect(201);
    openItemId = open1.body.data.id as string;

    // 一条 asked 且指派给外婆
    const assigned = await request(app)
      .post(`/api/recipes/${recipeId}/vague-items`)
      .set(auth(organizer))
      .send({ category: 'heat', rawPhrase: '中火炒到冒泡' })
      .expect(201);
    assignedItemId = assigned.body.data.id as string;
    await request(app)
      .post(`/api/vague-items/${assignedItemId}/ask`)
      .set(auth(organizer))
      .send({ question: '火苗大概多高？', assigneeId: grandma.userId })
      .expect(200);

    // 一条 asked 但没指派（公开问题）
    const publicItem = await request(app)
      .post(`/api/recipes/${recipeId}/vague-items`)
      .set(auth(organizer))
      .send({ category: 'feel', rawPhrase: '揉到不粘手' })
      .expect(201);
    publicItemId = publicItem.body.data.id as string;
    await request(app)
      .post(`/api/vague-items/${publicItemId}/ask`)
      .set(auth(organizer))
      .send({ question: '手感像什么？' })
      .expect(200);

    // 外婆给菜录两段语音，外人空间也录一段（用来验证隔离）
    await uploadAudio(grandma, recipeId, 'recipe_voice');
    await uploadAudio(grandma, recipeId, 'recipe_voice');
    await uploadAudio(outsider, otherRecipeId, 'recipe_voice');
  });

  it('未登录返回 401', async () => {
    await request(app).get('/api/elder/overview').expect(401);
  });

  it('只返回我参与的空间、菜和问题', async () => {
    const response = await request(app).get('/api/elder/overview').set(auth(grandma)).expect(200);
    const overview = response.body.data;

    expect(overview.workspaces).toHaveLength(1);
    expect(overview.workspaces[0].id).toBe(workspaceId);
    expect(overview.workspaces[0].role).toBe('contributor');

    const recipeIds = overview.recipes.flatMap((group: { recipes: { id: string }[] }) =>
      group.recipes.map((recipe) => recipe.id),
    );
    expect(recipeIds).toContain(recipeId);
    expect(recipeIds).not.toContain(otherRecipeId);

    const itemIds = overview.questions.map((question: { itemId: string }) => question.itemId);
    expect(itemIds).toContain(assignedItemId);
    expect(itemIds).toContain(publicItemId);
    expect(itemIds).not.toContain(openItemId);
  });

  it('指派给我的问题排在公开问题之前', async () => {
    const response = await request(app).get('/api/elder/overview').set(auth(grandma)).expect(200);
    const questions = response.body.data.questions as { itemId: string; assignedToMe: boolean }[];

    expect(questions[0]!.itemId).toBe(assignedItemId);
    expect(questions[0]!.assignedToMe).toBe(true);
    expect(questions.find((question) => question.itemId === publicItemId)?.assignedToMe).toBe(false);
  });

  it('菜卡片带上正确的语音段数，软删除后段数减少', async () => {
    const before = await request(app).get('/api/elder/overview').set(auth(grandma)).expect(200);
    const group = before.body.data.recipes[0];
    const recipe = group.recipes.find((item: { id: string }) => item.id === recipeId);
    expect(recipe.audioCount).toBe(2);
    expect(recipe.recentAudio).toHaveLength(2);

    // 整理者软删除一段（contributor 不能删别人的，所以用 owner）
    const audioId = recipe.recentAudio[0].id as string;
    await request(app).delete(`/api/audio/${audioId}`).set(auth(organizer)).expect(200);

    const after = await request(app).get('/api/elder/overview').set(auth(grandma)).expect(200);
    const recipeAfter = after.body.data.recipes[0].recipes.find(
      (item: { id: string }) => item.id === recipeId,
    );
    expect(recipeAfter.audioCount).toBe(1);
  });

  it('问题里带原话与提问文案，原声为空时 clip 为 null', async () => {
    const response = await request(app).get('/api/elder/overview').set(auth(grandma)).expect(200);
    const assigned = response.body.data.questions.find(
      (question: { itemId: string }) => question.itemId === assignedItemId,
    );
    expect(assigned.question).toBe('火苗大概多高？');
    expect(assigned.rawPhrase).toBe('中火炒到冒泡');
    expect(assigned.recipeTitle).toBe('外婆的红烧肉');
    expect(assigned.clip).toBeNull();
    expect(assigned.clipAudio).toBeNull();
  });
});
