import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// 长辈极简端（/talk）：整个页面只有"按住说话"。
// 这里用真实鼠标按下/松开模拟长辈的操作，并用虚拟麦克风产生真实音频，
// 最后通过 API 确认语音进了"语音收件箱"（还没归到任何食谱）。

const API = '/api';

async function api<T>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'patch',
  path: string,
  options: { token?: string; data?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  const response = await request[method](`${API}${path}`, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    data: options.data,
    params: options.params,
  });
  expect(response.ok(), `${method.toUpperCase()} ${path} -> ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = await response.json();
  return body.data as T;
}

async function authenticate(page: Page, tokens: { accessToken: string; refreshToken: string }) {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('froa.accessToken', access as string);
      localStorage.setItem('froa.refreshToken', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken],
  );
}

interface ElderSeed {
  workspaceId: string;
  elderTokens: { accessToken: string; refreshToken: string };
  viewerTokens: { accessToken: string; refreshToken: string };
}

/** 造一个家：整理者 + 长辈（贡献者）+ 旁观者 */
async function seed(request: APIRequestContext): Promise<ElderSeed> {
  const stamp = Date.now();
  const register = (tag: string, name: string) =>
    api<{ tokens: ElderSeed['elderTokens']; user: { id: string } }>(request, 'post', '/auth/register', {
      data: { email: `elder-${tag}-${stamp}@e2e.test`, password: 'froa12345', displayName: name },
    });

  const organizer = await register('org', '整理者');
  const elder = await register('elder', '奶奶');
  const viewer = await register('viewer', '旁观者');

  const workspace = await api<{ id: string; inviteCode: string }>(request, 'post', '/workspaces', {
    token: organizer.tokens.accessToken,
    data: { name: '极简端测试厨房' },
  });
  await api(request, 'post', '/workspaces/join', {
    token: elder.tokens.accessToken,
    data: { inviteCode: workspace.inviteCode },
  });
  await api(request, 'post', '/workspaces/join', {
    token: viewer.tokens.accessToken,
    data: { inviteCode: workspace.inviteCode },
  });
  await api(request, 'patch', `/workspaces/${workspace.id}/members/${viewer.user.id}`, {
    token: organizer.tokens.accessToken,
    data: { role: 'viewer' },
  });
  // 食谱由整理者建，长辈全程不需要知道它的存在
  await api(request, 'post', '/recipes', {
    token: organizer.tokens.accessToken,
    data: { workspaceId: workspace.id, title: '极简端红烧肉' },
  });

  return { workspaceId: workspace.id, elderTokens: elder.tokens, viewerTokens: viewer.tokens };
}

/** 在按钮中心做一次真实的"按住 → 松开"，holdMs 从真正开始录音起算 */
async function holdAndRelease(page: Page, holdMs: number) {
  const button = page.getByRole('button', { name: /按住说话/ });
  const box = await button.boundingBox();
  if (!box) throw new Error('找不到录音按钮');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // getUserMedia 是异步的：等界面确认"正在录"再计时，快慢机器上都稳定
  await expect(page.getByText(/正在录/)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

test('长辈按住说话，松手即存好，语音先进收件箱', async ({ page, request }) => {
  const data = await seed(request);
  await authenticate(page, data.elderTokens);

  await page.goto('/talk');
  await expect(page.getByRole('heading', { name: /按住下面这个圆钮/ })).toBeVisible();
  // 极简约束：页面上没有导航、没有列表、没有输入框
  await expect(page.locator('nav')).toHaveCount(0);
  await expect(page.locator('input, textarea')).toHaveCount(0);

  await holdAndRelease(page, 1500);
  await expect(page.getByText('✓ 已存好')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/已存好 1 段/)).toBeVisible();

  // 语音进了收件箱：没归到任何食谱，等整理者处理
  const inbox = await api<{ id: string; recipeId: string | null; durationMs: number }[]>(
    request,
    'get',
    '/audio',
    { token: data.elderTokens.accessToken, params: { workspaceId: data.workspaceId, unassigned: '1' } },
  );
  expect(inbox).toHaveLength(1);
  expect(inbox[0]!.recipeId).toBeNull();
  expect(inbox[0]!.durationMs).toBeGreaterThan(0);
});

test('按得太短不算录音，不会往收件箱里存垃圾', async ({ page, request }) => {
  const data = await seed(request);
  await authenticate(page, data.elderTokens);

  await page.goto('/talk');
  await expect(page.getByRole('button', { name: /按住说话/ })).toBeVisible();

  await holdAndRelease(page, 100);
  await expect(page.getByText(/按得太短/)).toBeVisible({ timeout: 10_000 });

  const inbox = await api<unknown[]>(request, 'get', '/audio', {
    token: data.elderTokens.accessToken,
    params: { workspaceId: data.workspaceId, unassigned: '1' },
  });
  expect(inbox).toHaveLength(0);
});

test('旁观者打开极简页：不显示录音按钮', async ({ page, request }) => {
  const data = await seed(request);
  await authenticate(page, data.viewerTokens);

  await page.goto('/talk');
  await expect(page.getByRole('heading', { name: /旁观者/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /按住说话/ })).toHaveCount(0);
});
