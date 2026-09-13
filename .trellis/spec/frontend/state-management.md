# 前端状态管理

## 1. 适用范围与触发条件

- 适用于组件状态（本地状态、跨组件共享、服务端数据）的存放位置与读写约定。
- 新增全局 store、把数据源从 server 移到 client、或改变轮询/缓存方式前，必须先读本规范。

## 2. 现状（真实模式）

- **不使用任何全局状态库**（无 zustand / redux / jotai / react-query）。依赖只有 React 自带能力 + Next.js server 能力。
- 状态分三层：
  1. **服务端数据**（事实来源）——Server Components 直接查 `@/lib/db`（Prisma），`serialize` 成纯 JSON 后作为初始 props 传给 client 组件。
  2. **本地 UI 状态**——`useState`，只在组件内可见。
  3. **客户端刷新数据**——client 组件经 `/api/*` 轮询/提交后更新本地状态。

## 3. 服务端数据 → 客户端传递

- Server Components 负责初始数据，禁止在 client 侧重复查询全量：

```tsx
// src/app/works/page.tsx（server）
const [initialPage, counts, myVideos] = await Promise.all([
  listUserWorksPage({ userId: user.id, limit: 24 }),
  getUserWorksCounts(user.id),
  db.generatedVideo.findMany({ ... }),
]);
const currentUser = serializeUser(user);
return <MyWorksBoard currentUser={currentUser} ... />;
```

- 传递前必须 `serialize`（见 `src/lib/prisma-mappers.ts`），把 Date/枚举转成纯 JSON 类型，禁止把 Prisma 实体直接传 client。

## 4. 客户端状态与刷新

- 交互后需要刷新列表/结果时，client 调 `/api/*` 拿到结果后更新本地 `useState`，或触发轮询 hook。
- 长任务（图片/视频生成）用轮询 hook（`useImagePoller`）消费 `GET /api/me/generations/{id}`，命中终态停止；刷新数据不从数据库直连。
- 需要在多个子组件间共享的派生状态由**容器组件**（如 `create/generator-studio.tsx`）持有，经 props 下发，不引入全局 store。

## 5. 服务端 props → 本地状态：同步边界

**核心约定**：server props 是**首屏初始值**，不是运行期的持续真相。`router.refresh()` 每次都会下发**新引用的数组/对象**，即使数据内容没变。

### 5.1 同步 effect 必须加挂载守卫

把 server props 同步进 `useState` 的 effect，必须只跑一次，否则每次 `router.refresh()` 都会重跑并覆盖用户的本地操作。

```tsx
// src/components/create/generator-studio.tsx
// Good：只在挂载时用初始 props 决定会话视图，之后以本地状态为准
const didInitSessionRef = useRef(false);
useEffect(() => {
  if (didInitSessionRef.current) return;
  didInitSessionRef.current = true;
  const target = initialConversations.find((s) => s.id === readLastActive()) ?? initialConversations[0] ?? null;
  if (!target) return;
  setActiveSessionId(target.id);
  setSessionGenerations(resolveGenerations(target, initialGenerations));
  // 依赖仍需列出（eslint exhaustive-deps），守卫负责阻止重跑
}, [initialGenerations, initialConversations]);
```

```tsx
// Bad：依赖是 props 数组，每次 refresh 都会重跑，把用户操作覆盖回服务端旧快照
useEffect(() => {
  const target = initialConversations[0];
  if (target) { setActiveSessionId(target.id); setSessionGenerations(...); }
}, [initialGenerations, initialConversations]);
```

**Why**：典型症状是「删除会话后内容又冒出来」「点新建对话后被拉回旧会话」——都是服务端旧快照覆盖了本地状态。

### 5.2 不要在渲染期读 localStorage

`localStorage` 只能在挂载后读取，**不能**放进 `useState` 惰性初始化器：client 组件同样经历 SSR，服务端拿到 `null`、客户端拿到真实值，会造成 hydration 不一致。这正是 §5.1 用 effect（而非惰性初始化）的原因；effect 内 setState 可用 `// eslint-disable-next-line react-hooks/set-state-in-effect` 抑制（项目既有写法）。

### 5.3 全局列表不能当作"兜底展示"数据源

页面级查询（如 `create/page.tsx` 取用户最近 50 条 generation）是**跨会话的全局列表**，只能喂给「历史图片栏 / 作品页」这类全局视图；中间业务视图展示什么，必须由**当前活跃会话**决定。

**反例（已修复的 bug）**：会话列表为空时，把 `initialGenerations` 中 `conversationId` 为 NULL 的"孤儿"generation 全部倒进中间对话流。由于删除会话的后端语义是 `onDelete: SetNull`（图保留、归属置空），"删光会话"会触发该兜底，把**此前所有会话的图聚合在同一屏**，看起来像删除失效。

```tsx
// Bad：会话为空就把全局列表当兜底
if (stored.length === 0 && orphans.length > 0) {
  setSessionGenerations(orphans);
  return;
}
// Good：会话为空就展示空状态；历史图仍由右侧历史栏 / 作品页承载
```

**回归测试**：`src/tests/unit/generator-studio-session-history.test.tsx`。

## 6. 表单状态

- 表单输入用受控 `useState` 或 FormData；提交前用 zod schema（`src/lib/validators.ts`）校验，错误消息中文。
- 提交结果错误用 `Alert` 组件（`variant` 区分 error/warning/success/info）展示，不写裸 `alert()`。

## 7. 禁止与常见错误

- 禁止为了"省事"引入全局 store——先评估是否能用 server 初始数据 + 容器组件 props 解决。
- 禁止 client 组件直接 `import { db } from "@/lib/db"` 或查 Prisma——数据只能来自 props 或 `/api/*`。
- 禁止把可复用业务数据缓存在组件外部模块级变量（跨请求泄漏）。
- 禁止在 server 与 client 间传递非序列化值（Date 实例、Buffer、函数）。
- 禁止写无守卫的"server props → 本地 state"同步 effect（见 §5.1），也禁止用全局列表给局部视图做兜底展示（见 §5.3）。
