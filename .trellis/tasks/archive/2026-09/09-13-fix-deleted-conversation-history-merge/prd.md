# 修复删除会话后创作台中间区域聚合展示历史 generation

## Goal

删除会话后，创作台中间对话流不应再展示已删除会话的 generation，也不应在页面刷新后被"打回"到旧会话。中间区域的展示必须严格跟随当前活跃会话。

## 背景与根因

**现象**：用户在左侧删光所有会话（侧边栏显示"暂无会话记录"），中间区域仍然显示旧内容，且把此前所有会话的 generation 聚在一起。

**根因**（`src/components/create/generator-studio.tsx:172-198` 的初始化 effect）：

1. `src/app/create/page.tsx:27-37` 把该用户最近 50 条 generation（**不含会话归属**）作为 `initialGenerations` 传给前端。
2. 删除会话时后端是 `onDelete: SetNull`（`prisma/schema.prisma:453`），generation 保留、`conversationId` 置 NULL，于是全部变成"孤儿"。
3. 初始化 effect 的孤儿兜底分支 `if (stored.length === 0 && orphans.length > 0)` 会把**全部孤儿 generation** 一次性写入 `sessionGenerations` —— 这正是"所有会话聚在一起"。
4. 该 effect 的依赖是 `[initialGenerations, initialConversations]`，而这两个数组在每次 `router.refresh()` 后都是新引用（生成完成、轮询到终态都会触发），导致 effect 反复重跑：
   - 点「新建对话」清空后，只要发生一次 refresh，`stored[0]` 就会把视图拉回最近一个会话；
   - 删除会话后本地已清空的状态会被服务端旧 props 覆盖回来。

## Requirements

### R1 移除孤儿兜底展示

- 删除 `generator-studio.tsx` 中 `stored.length === 0 && orphans.length > 0` 的分支：会话列表为空时，中间区域显示空状态（"你好，你想创作什么？"），不再展示任何历史 generation。
- 已删除会话的 generation 仍然保留在数据库，并继续出现在右侧「历史图片」栏与 `/works` 页面。

### R2 初始化 effect 只在挂载时生效

- 该 effect 增加挂载守卫（ref），只在首次挂载时依据服务端初始 props 决定 `activeSessionId` 与 `sessionGenerations`。
- 挂载之后，`activeSessionId` / `sessionGenerations` 以本地状态为准，不再被 `router.refresh()` 的服务端 props 覆盖。
- 移除因该分支删除而不再使用的 `orphans` 计算与相关注释。

### R3 保持既有正确行为

- 刷新页面时，仍能通过 `localStorage` 的 `narra_active_conversation_id` 恢复到上次活跃会话。
- 切换会话、删除活跃会话、新建对话、生成后追加/替换 generation 的现有行为不变。
- 右侧「历史图片」栏的数据来源不变（合并 `initialGenerations` 与 `sessionGenerations`）。

## Constraints

- 只改前端：不改 Prisma schema、不改 `/api/me/conversations` 的删除语义（保持 `SetNull`，删除会话不删图）。
- 不改动后端与数据库，不新增依赖。
- 遵循 `src/tests/unit/generator-studio-*.test.tsx` 既有测试写法。

## 语义变化（重要）

- **孤儿 generation（`conversationId` 为 NULL）不再出现在中间对话流**。刷新页面后，中间区域只展示「活跃会话内」的 generation。
- 受影响的三类孤儿：① 被删除会话遗留的 generation（本次要修的 bug）；② 会话功能上线前的历史遗留数据；③ `createSession` 调用失败的兜底路径。后两类在新语义下只保留在右侧「历史图片」栏与 `/works` 页面。
- **会话内新产生的 generation 不受影响**：`handleGenerate` 会先建会话再提交，且本地状态不再被 refresh 覆盖，所以当次页面会话内始终可见。

## 已适配的既有用例

以下 4 个测试文件的 9 个用例原本在**不传 `initialConversations`** 的情况下渲染 generation，依赖「孤儿兜底」才显示。它们描述的是「用户已有一张结果图，中间提供操作入口」，而真实流程中每张图必然属于某个会话（`handleGenerate` 先 `createSession`，`/api/generate` 再绑定 `conversationId`），因此为其补上会话归属，属忠实建模而非迁就实现：

- `src/tests/unit/generator-studio-edit.test.tsx`（2 例）
- `src/tests/unit/generator-studio-ratio.test.tsx`（2 例）
- `src/tests/unit/generator-studio-feedback.test.tsx`（2 例）
- `src/tests/unit/generator-studio-retry-cancel.test.tsx`（3 例）

## Acceptance Criteria

- [x] `initialConversations = []`、`initialGenerations = [孤儿 generation]` 时，中间区域显示空状态文案，且不出现该 generation 的 prompt。
- [x] 会话为空时不再渲染任何历史 generation 气泡（气泡数量为 0）。
- [x] 有活跃会话时，其 generation 正常展示（原有行为不回归）。
- [x] 删除活跃会话后中间区域立即清空；此后传入新的 `initialGenerations` / `initialConversations` props（模拟 `router.refresh()`）不会让已删除内容重新出现。
- [x] 点击「新建对话」后，传入新 props（模拟 `router.refresh()`）不会把视图拉回旧会话。
- [x] 刷新页面时仍能恢复 `localStorage` 中记录的上次活跃会话。
- [x] `pnpm exec vitest run` 全量通过，`pnpm exec tsc --noEmit` 与 `pnpm lint` 无新增错误。

## 验证记录

- 新增 `src/tests/unit/generator-studio-session-history.test.tsx`（5 例）。回滚 `generator-studio.tsx` 到修改前跑该文件：3 例失败（孤儿展示、删除后复活、新建对话被打回），修改后 5 例全通过 —— 用例确实覆盖本次 bug。
- 全量 `vitest run --testTimeout=30000`：401 passed / 80 文件中仅 `worker-contracts-db.test.ts` 因缺少 `WORKER_CONTRACTS_REQUIRE_DB=1` 哨兵未能收集（spec 规定全量时应排除，与本次改动无关）。
- `pnpm exec tsc --noEmit` 无输出；改动文件 eslint 0 error。
- `set-state-in-effect` 规则：`readLastActive()` 读 localStorage 只能在挂载后执行（SSR 期间拿不到），故保留 effect 同步并沿用原文件既有的抑制注释写法，未改为惰性 `useState` 初始化（那会造成 hydration 不一致）。

## Notes

- 轻量任务，PRD-only。
- 改动文件：`src/components/create/generator-studio.tsx`（唯一生产代码改动点）、5 个测试文件。

