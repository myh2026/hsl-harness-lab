# 工具链补丁说明（运行本复现前必读）

本复现在编写过程中发现 **dhv-ts v0.2.56 的两个真实 bug**，已在本地修复并
通过全量回归（53 个官方 fixtures + 3 个官方示例 + 官方 dsh 示例端到端运行）。
在修复合入上游 [harness-specification-language](https://github.com/myh2026/harness-specification-language)
之前，运行本复现需先给 dhv-ts 打以下两个补丁。

## 补丁 1：`mut self` SelfParam 未识别（parser.ts）

**现象**：实现链式构建器风格（`fn add(mut self, ...) -> Self`）的方法时，
运行期报 `函数 add 参数不足`。

**根因**：BNF v1.5 已定义 `SelfParam ::= "&" "mut"? "self" | "mut"? "self"`，
但 `dhv-ts/src/parser.ts` 的 `parseFnDef` 只识别 `self` / `&self` /
`&mut self` 三种形态——**无引用符前缀的 `mut self` 漏识别**，被误入常规
参数分支（`mut` 修饰 + `self` 绑定模式），于是 receiver 不再自动传入，
参数计数错位。上游 nova 示例虽使用 `mut self`
（`types/state.hsl` 的 `complete_task`），但因 nova 无 `fn main()`，
`run` 路径从未执行，bug 一直潜伏。

**修复**（`parser.ts` `parseFnDef` 内，原 L453 一行）：

```diff
-      const isSelfHere = peekText(0) === 'self';
+      // BUGFIX: BNF v1.5 SelfParam ::= "&" "mut"? "self" | "mut"? "self"
+      // 此前未识别无引用符前缀的 `mut self`（nova 示例潜伏 bug）
+      const isSelfHere = peekText(0) === 'self'
+        || (peekText(0) === 'mut' && peekText(1) === 'self');
```

## 补丁 2：native 块扫描器对 TS 正则字面量盲（lexer.ts）

**现象**：native typescript 块内含带引号的正则（如
`/<a[^>]*class="result__a"[^>]*href="([^"]+)"/g`）时，报
`error[E-0]: 原始代码区未闭合`。

**根因**：`dhv-ts/src/lexer.ts` 的 `scanRawBody` 对目标语言做
「字符串/注释感知 + 大括号深度计数」，但不感知正则字面量——正则内的
`"` 被误配对为字符串边界，级联吞掉后续 `}`，深度计数永不归零。
任何想在 native 块里用正则做文本抽取的 harness（本复现 FranxAgent 的
DuckDuckGo 检索即真实用例）都会撞上。

**修复**：为 TS/JS 增加正则字面量扫描（JS 词法启发式：`/` 前的最后一个
非空白字符为运算符/分隔符语境 → 正则起始；为值语境 → 除法）。完整补丁
见仓库 `hsl-projects/.toolchain/dhv-ts/src/lexer.ts` 的
`scanRawBody`（含 `isRegexStart` 辅助方法），带 BUGFIX 注释标记。

## 应用方式

```bash
git clone https://github.com/myh2026/harness-specification-language.git
cd harness-specification-language/toolchain
# 按上述补丁修改 dhv-ts/src/parser.ts 与 dhv-ts/src/lexer.ts
# 然后即可运行本复现：
bun dhv-ts/src/main.ts run <本项目的入口 .hsl> --model scripted --fixture <fixtures/*.json> ...
```

## 语言设计观察（复现过程中的其他体会）

1. **S6 穷尽 match 在 harness 场景是净收益**：三处工具词汇表
   （ToolCall / WeaveCall / SessionEvent）新增变体时，分发臂、schema
   渲染、事件渲染全部编译期报错——这是把「忘了同步」从运行期事故
   提前到处决期提示；
2. **`?` + From 的错误通道**在多层 harness（provider → guard →
   顶层）里表达力刚好，但 `From<String>` 略宽（parse 错误与字符串
   业务错误共用一个通道），建议后续提供 `ParseError` 专用变体；
3. **native 块的 N1 纪律**（只做效应）在三项目里都成立，但正则盲
   bug 说明 native 体的词法保真度是刚需（见补丁 2）；
4. **graph 的 node/edge** 对「物理依赖 + 消息拓扑」的分离很好用，
   但 G4 孤岛节点警告对「纯状态节点」（如 SessionLog 这种被动写入口）
   略严格，只能靠加注释或补一条边绕过——建议支持 `node passive` 标记；
5. **rules 规则组**（BNF v1.5）批量投射很顺手，但 X-1 警告的
   「显式映射优先于规则」语义需要通读 BNF §3.4 才能理解 R1 遮蔽
   （建议 check 输出里直接解释遮蔽关系）。
