<!--
 PR 模板:提交前请确认下列三项。冲突态 PR 不会触发任何 pull_request CI
 (GitHub 不为 CONFLICTING PR 构建 merge ref),第三条专防此坑静默埋雷。
-->

## 变更说明

<!-- 这个 PR 做了什么、为什么。简短即可。 -->

## 提交前自检

- [ ] 本地 `npm run preflight` 已通过(tsc / lint / logging 守卫 / 结构守卫 / 单测)
- [ ] 若删除了功能/符号:已全仓 grep 确认无残留引用(含 tests 与 scripts/e2e)
- [ ] PR 页面 checks 已实际触发(数量正常,无"冲突导致静默跳过")

## 备注

<!-- 关联 issue / 截图 / 依赖的另一 PR 等。无则删掉本节。 -->
