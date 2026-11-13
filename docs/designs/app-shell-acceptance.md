---
id: "app-shell-acceptance"
path: "docs/designs/app-shell-acceptance.md"
title: "AppShell v0.3.0 Acceptance Checklist"
kind: "design"
status: "proposed"
owner: "product"
tags: ["acceptance", "accessibility", "app-shell", "history", "intake", "validation"]
evidence: ["design-receipt:appshell-prototype-1-attempt-3"]
revisit: "after contract review and for every changed installation candidate"
rollback: "restore the prior shell candidate while retaining user files, source grants and recoverable history data"
x-priority: "P1"
x-baseline-revision: "cd8c429323fb3b474d23212a0c3d3f82e393dee6"
x-target-branch: "feature/appshell-v0.3.0"
---
# AppShell v0.3.0 验收清单

配套计划：[AppShell v0.3.0 Milestone Plan](app-shell-milestone.md)。布局方向已选定；新增状态展示、协议和持久化策略仍需评审。基线字段记录已合并的冻结版本，新开发在独立分支推进。以下项目均未验收，不代表已安装产品。

使用合成 JSONL/NDJSON，不读取真实会话。至少覆盖一个大于 1 MiB 的原文件场景，例如 6.9 MiB 合成数据，以及符合现有 inline 限额的粘贴样本。

## 1. 候选身份与验收前提

- [ ] 记录合并基线、目标分支、干净候选 commit/tree 和关键输入哈希。
- [ ] 在实现持久写入前，评审并记录协议、存储事务/恢复、quota、保留/删除、重复导入与原文件变化策略；未定数字不作为已生效契约。
- [ ] 对精确候选运行当前 AGENTS.md 的必需检查、专项失败/恢复测试、托管 required checks 和 CodeQL；候选变化后重新建立证据。
- [ ] 记录 VSIX 哈希、来源与 installed execution identity；安装后 reload 目标 VS Code 窗口，核实实际加载的是该候选。
- [ ] 分别记录源码/测试、真实 DOM、安装/reload、真实宿主交互与人工验收。原型的 43 项浏览器检查只支持设计评审。

## 2. Rail、抽屉与阅读画布

- [ ] 首次进入为 40px rail、抽屉关闭，主画布占满剩余空间。
- [ ] History、Sessions、Import 均为 260px 受控抽屉；同时最多打开一个；同图标、Close、非输入法组合状态下的受控 Escape 可关闭。
- [ ] 关闭后焦点回到仍可见且可用的实际入口，包括正文 History 和 reader query 按钮；入口隐藏、禁用或销毁时回到对应可见 rail。
- [ ] Escape 尊重现有更高优先级 overlay、detail 和 query cancellation 行为，不取消其他 owner 的操作或抢走新焦点。
- [ ] 在 800x600、800x800 和 1280x800 检查内部滚动、右侧 detail 与 tab/toolbar 可达性，无意外外层横向溢出。
- [ ] 深浅及高对比主题使用宿主 token；focus 可见，键盘操作完整，reduced-motion 生效。
- [ ] Table、Timeline、Schema、Problems、Insights、search、Query Studio、filter、sort、columns、follow、lineage 和精确记录 detail 保持既有语义。
- [ ] 单纯打开/切换抽屉不提交 query、不授权、不扫描或轮询、不创建历史记录。

## 3. Import 原文件与 inline 预览分离

- [ ] 打开 Import 后拖入一个合法本地原文件，reader 直接打开原文件；不要求先复制成临时文件。
- [ ] reader 显示临时 Import 上下文、原文件身份、Save As 和 History 引导；不把磁盘原文件称为“未保存文件”。
- [ ] 切换 reader 视图、关闭/重开抽屉及复用已打开编辑器，provenance 始终绑定正确 document/generation/epoch。
- [ ] 普通文件/会话打开不因时序或同名文件继承其他 Import banner。
- [ ] 大于 1 MiB 的本地 URI 原文件按现有 Host bounded-read/index 路径打开；不套用 inline 的 1 MiB 或 10,000-record 总量限制，Webview 不读取/缓存完整原文件。
- [ ] 含 malformed JSONL、blank lines、invalid UTF-8 的原文件沿用现有 reader/Problems 契约：保留该契约支持的物理行和有限诊断；不套用 inline 严格校验而笼统拒绝整文件，也不宣称所有无效输入必定可读。
- [ ] 粘贴/浏览器 File 预览遵守现有 strict UTF-8、JSONL 校验、1,048,576 UTF-8 bytes 和 10,000 records 上限；边界内、边界值及越界均有测试。
- [ ] 超限 inline 内容在全量分配前拒绝或提供明确的 Host 文件选择/打开动作；不静默改成无关 picker。
- [ ] message version/shape、URI 长度、scheme、canonical path、trust 和 source access 按现有 guard 判定；无授权或无效请求在副作用前失败，不产生虚假历史。
- [ ] 支持的 Webview 全画布 drop 只发出一个操作；nested drag enter/leave、blur、dispose 清理 overlay。多文件沿用明确的 Choose files 路由。
- [ ] 在已安装 VS Code 验证 OS/Explorer 实际 drop 路由与支持的恢复入口；浏览器 mock 不证明 native interception。
- [ ] picker/read/open 取消、来源替换与 panel 关闭后，迟到完成不切换其他文档、不发布过期事实。

## 4. Host 持久历史

- [ ] pending 只显示等待；Host 确认 bytes/metadata commit 后才显示 durable，不使用 localStorage 或乐观 UI 充当持久化证明。
- [ ] bounded paste/browser input 的 managed copy 在重启 VS Code 后仍可从 History 验证并重开。
- [ ] 本地路径保留为 reference，界面明确其依赖原文件；持久 metadata 不等于保留原始 bytes。
- [ ] 删除、移动、修改合成原文件后，History 按已评审策略显示 unavailable/changed 并重新检查授权；不假装存在 snapshot、不静默 rebind。
- [ ] 同 basename 不作为唯一身份；重复用户导入遵守已评审策略；同 operation identity 重试返回同一 receipt，变更 payload 冲突。
- [ ] durable 状态不会因后续取消、失败的 open 或 review 状态切换回退；重新打开 History 项仍保留已确认 Save As copy 事实。
- [ ] History 采用已评审的有限分页和状态投影；Webview retained state 不含整份源内容、原始 grant 或任意 Host locator。
- [ ] 在已评审 budget 边界测试 managed bytes、metadata 和并发操作；capacity failure 不静默删旧记录或回收 pending/corrupt recovery 状态。
- [ ] 注入 disk full、DB failure、blob flush/metadata commit 前后 crash，重启后能够区分未提交、已提交与待恢复操作，显示真实结果。
- [ ] 删除历史记录不删除原文件或 Save As 目标；回收 managed blob 前校验 ownership、identity 和 references。
- [ ] 现有 session-only previews 只有经过明确且可验证的 adoption 才获得 restart-durable 语义。

## 5. Save As

- [ ] Save As 针对所选 material 执行 Host 解析及 identity recheck，创建 exact-byte、exclusive copy；不覆盖已有目标。
- [ ] saving 只表示等待 Host；picker cancel 不创建新文件或成功 receipt，保留先前 durable history 和已确认 copy。
- [ ] 保存非 active History 项时，实际保存选中的 material，不误用当前文档。
- [ ] 目标存在、源变化、写入失败、epoch 过期、panel 关闭和取消均保持既有安全边界，不删除无关文件。
- [ ] copy 已确认而编辑器 open 失败时，保留 saved-copy receipt，单独报告 open 错误。
- [ ] 之后一次 cancelled/failed save 不抹去先前 confirmed copy；从 History 重开后事实一致。
- [ ] Add Source / Add to Collection 仍为显式后续操作，保留授权、CAS/journal 和无隐式扫描语义。

## 6. Navigator、Sessions 与 Collections

- [ ] header Navigator 和既有 open command 直达 Sessions 抽屉；未注册或空数据时也不弹出 Add Source quick pick。
- [ ] disabled/unavailable/empty 情况可导航，并区分 enablement、source authorization 与 refresh。
- [ ] source、query、navigation、authorization、sort、paste、connect、refresh、continuation、recovery 均有左侧可发现入口。
- [ ] 点击真实 session/registered JSONL 项直接进入 reader；secondary metadata 不替代直开。
- [ ] History/Import 不启动 Sessions 扫描或轮询；Sessions polling 保留 visibility、window focus、enablement、authorization 和 disposal gates。
- [ ] Collections CRUD、archive、rebind 和 journal recovery 仍经过原 owner；recent History 不自动创建 Collection membership。
- [ ] 移除原 native sidebar/menu contribution 前完成 action parity、source-grant 兼容、实际宿主验收及可恢复 rollback。

## 7. 关闭里程碑

- [ ] 独立审查最终已迁入产品的计划/契约与精确实现候选；记录尚未解决的策略和限制。
- [ ] 用上方已安装且 reload 的候选完成真实交互验收，再请求人工确认；不能以源码或 mock 通过代替。
- [ ] 记录更改文件、证据级别、最终候选/包哈希和 rollback revision；保留原文件、saved copies、permissions、Collections 和可恢复历史数据。
- [ ] 任何验收修复后重新冻结候选并执行相应完整门禁；未验收项目不标完成。
