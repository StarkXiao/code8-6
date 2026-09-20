import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// 长辈极简端（/elder）：整个界面只有"按住说话"。
// 这里用虚拟麦克风走真实 MediaRecorder，验证完整主路径：
//   登录 → 看见家人的问题与菜 → 按住录一段口述 → 松手自动保存
//   → 按住回答家人问题 → 自动上传 + 建片段 + 提交答复
//   → 再听听自己刚录的语音。
//
// 整理/转写/框选等动作全部由整理者在另一套界面完成，
// 极简端任何时候都不应该出现这些入口。

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function api<T>(
  request: APIRequestContext,
  method: 'get' | 'post',
  path: string,
  options: { token?: string; data?: unknown } = {},
): Promise<T> {
  const response = await request[method](`/api${path}`, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    data: options.data,
  });
  expect(response.ok(), `${method.toUpperCase()} ${path} -> ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()).data as T;
}

async function authenticate(page: Page, tokens: Tokens) {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('froa.accessToken', access as string);
      localStorage.setItem('froa.refreshToken', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken],
  );
}

test('长辈极简端：按住说话完成口述与回答，全程不出现整理入口', async ({ page, request }) => {
  const stamp = Date.now();

  const organizer = await api<{ tokens: Tokens; user: { id: string } }>(request, 'post', '/auth/register', {
    data: { email: `elder-org-${stamp}@e2e.test`, password: 'froa12345', displayName: '整理者' },
  });
  const elder = await api<{ tokens: Tokens; user: { id: string } }>(request, 'post', '/auth/register', {
    data: { email: `elder-me-${stamp}@e2e.test`, password: 'froa12345', displayName: '外婆' },
  });

  const workspace = await api<{ id: string; inviteCode: string }>(request, 'post', '/workspaces', {
    token: organizer.tokens.accessToken,
    data: { name: '长辈端测试厨房' },
  });
  await api(request, 'post', '/workspaces/join', {
    token: elder.tokens.accessToken,
    data: { inviteCode: workspace.inviteCode },
  });

  const recipe = await api<{ id: string }>(request, 'post', '/recipes', {
    token: organizer.tokens.accessToken,
    data: { workspaceId: workspace.id, title: '梅菜扣肉' },
  });

  // 整理者向外婆提问
  const item = await api<{ id: string }>(request, 'post', `/recipes/${recipe.id}/vague-items`, {
    token: organizer.tokens.accessToken,
    data: { category: 'time', rawPhrase: '蒸一会儿就好' },
  });
  await api(request, 'post', `/vague-items/${item.id}/ask`, {
    token: organizer.tokens.accessToken,
    data: { question: '要蒸多长时间呀？', assigneeId: elder.user.id },
  });

  await authenticate(page, elder.tokens);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`崩溃: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/antd v5 support React is 16/.test(message.text())) {
      problems.push(`控制台错误: ${message.text()}`);
    }
  });

  await page.goto('/elder');

  // 1. 问候、问题卡片、菜卡片都在
  await expect(page.getByRole('heading', { name: '外婆，您好' })).toBeVisible();
  await expect(page.getByText('要蒸多长时间呀？', { exact: false })).toBeVisible();
  await expect(page.getByText('梅菜扣肉', { exact: true })).toBeVisible();

  // 2. 极简端绝不能出现整理端入口
  for (const forbidden of ['追问台', '编辑草稿', '发布版本', '待澄清', '转写']) {
    await expect(page.getByText(forbidden)).toHaveCount(0);
  }

  // 3. 给菜录一段口述：pointerdown 按住 → 等两秒 → pointerup 松手
  const recordButton = page.getByRole('button', { name: /按住 说说/ }).first();
  await recordButton.hover();
  await page.mouse.down();
  await expect(page.getByText('松手 就发出去')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2000);
  await page.mouse.up();

  // 4. 自动保存成功（轮询期间按钮显示"正在存…"）
  await expect(page.getByText('存好啦，家里整理的人会听到的。')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="audio-count"]')).toHaveText('1');

  // 语音确实落库
  const audios = await request.get(`/api/audio?recipeId=${recipe.id}`, {
    headers: { Authorization: `Bearer ${elder.tokens.accessToken}` },
  });
  const audioList = (await audios.json()).data as { durationMs: number; kind: string; peaks: number[] | null }[];
  expect(audioList).toHaveLength(1);
  expect(audioList[0]!.kind).toBe('recipe_voice');
  expect(audioList[0]!.durationMs).toBeGreaterThan(0);

  // 5. 回答家人问题：按住回答 → 松手 → 自动走完 上传→建片段→答复
  const answerButton = page.getByRole('button', { name: /按住 回答家人/ });
  await answerButton.hover();
  await page.mouse.down();
  await expect(page.getByText('松手 就发出去').first()).toBeVisible();
  await page.waitForTimeout(2000);
  await page.mouse.up();

  await expect(page.getByTestId('answer-sent')).toBeVisible({ timeout: 20_000 });

  // 条目进入 answered，且答复带语音片段
  const items = await request.get(`/api/recipes/${recipe.id}/vague-items`, {
    headers: { Authorization: `Bearer ${organizer.tokens.accessToken}` },
  });
  const answered = (await items.json()).data[0] as {
    status: string;
    answerClipId: string | null;
  };
  expect(answered.status).toBe('answered');
  expect(answered.answerClipId).toBeTruthy();

  expect(problems, `长辈端报错：\n${problems.join('\n')}`).toEqual([]);
});

test('长辈极简端：未登录访问 /elder 会进大字登录页', async ({ page }) => {
  await page.goto('/elder');
  await expect(page.getByRole('heading', { name: '家里的菜谱' })).toBeVisible();
  await expect(page.getByRole('button', { name: '进 去' })).toBeVisible();
});
