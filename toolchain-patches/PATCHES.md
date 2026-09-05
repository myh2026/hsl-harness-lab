# 工具链补丁说明（运行本复现前必读）

本复现在编写过程中发现 **dhv-ts v0.2.56 的两个真实 bug**，已在本地修复并
通过全量回归（53 个官方 fixtures + 3 个官方示例 + 官方 dsh 示例端到端运行）。
在修复合入上游 [hharness-specification-language](https://github.com/myh2026/harness-specification-language)
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

## 补丁 3：语句边界换行粘调用（parser.ts，v0.2.57）

**现象**：块型表达式语句（`if` / `match` / 原生块）之后的下一行若以
`(` 开头（最典型：函数末尾的元组返回值 `(docs, versions)`），运行期报
`不可调用的值：unit`。

**根因**：`parsePostfix` 的后缀调用链对 `(` 无行界判定——表达式结束后
新行上的 `(...)` 被贪婪粘成「对前一表达式结果的调用」：

```hsl
if r.ok { ... }      // 语句（自终结）
(docs, versions)     // ← 被误解析为 if结果(docs, versions)
```

if 表达式求值为 unit（无 else），调用 unit → 崩溃。等价于 JS
「没有 ASI 的换行陷阱」。本复现 FranxAgent 的 `load_sidecar()`
（元组返回 + 前置 if 语句）最小复现：

```hsl
fn f() -> (u32, u32) {
    if true { let x = 1; }
    (1, 2)   // ← 粘调用
}
```

**修复**（`parser.ts` `parsePostfix` 裸 `(` 后缀分支）：

```diff
       if (this.atP('(')) {
+        // v0.2.57（Bug #3 换行粘调用）：`(` 位于新行 → 不粘接前一表达式
+        const prevTok = this.i > 0 ? this.toks[this.i - 1]! : null;
+        if (prevTok && this.peek().line > prevTok.line) return expr;
         this.next();
```

合法多行调用不受影响：`(` 与被调者同行（`foo(\n  arg\n)`）依旧成立；
以 `.` 开头的新行方法链不受影响。

**回归**：53 官方 fixtures + 3 官方示例 + 三复现全量（check/run/emit）。

## 补丁 4：内置 Option/Result 缺 `clone` 方法（builtins.ts，v0.2.57）

**现象**：`let b = a.clone()`（a 为 `Option<u32>`）运行期报
`Option 没有方法 "clone"`；而自定义 `#[derive(Clone)]` 枚举可 clone。

**根因**：方法解析表里用户枚举走通用 `clone`（cloneValue 深拷贝），
但 `OPTION_METHODS` / `RESULT_METHODS` 只登记了 `cloned()`（Rust 里
那是 `Option<&T>` 的另一方法）而没有 `clone`。Rust 语义：
`Option<T: Clone>` 实现 `Clone`——内置枚举反而比用户枚举弱，属不一致。

本复现 StanzaWeaver 词库命中路径的 `hit.matched.clone()`
（`Option<u32>`）最小复现：

```hsl
let a: Option<u32> = Option::Some(1);
let b = a.clone();   // ← Option 没有方法 "clone"
```

**修复**（`builtins.ts` 两个方法表各加一行）：

```diff
 export const OPTION_METHODS: Record<string, BuiltinMethod> = {
   ...
   cloned: { ... },
+  // v0.2.57（Bug #4）：Option 缺 clone（与用户枚举对齐）
+  clone: { fn: (r) => cloneValue(r) },
 };
```

（`RESULT_METHODS` 同补。）

## 语言设计观察（补充）

6. **尾表达式分号语义静默吞返回值**：`fn f() -> T { ...; X; }`（尾表达式
   带分号）把 T 返回变成 unit，而 **check 不校验尾表达式与声明返回类型
   的一致性**——本复现 StanzaWeaver 的 refine_line 被拒分支因此静默返回
   unit（运行期在 `.draft` 解引用处才爆）。建议 check 增加
   「路径返回类型 vs 声明返回类型」穷尽校验（Rust 的 E0308 等价物）；
7. **emit 的退出码把顾问性 X-1 警告当硬失败**（exit 1）：混合语言
   project 声明（python graph + ts 模型 + rust 规则）下跨语言引用
   是固有形态，X-1 只应是诊断；建议区分 `--strict-warnings` 才转非零；
8. **fixture faults 是回路能力的天然测试钩子**：上下文超限压缩
   （FranxAgent memory()）经 `faults: [{target: "fixture.next:acts",
   nth: N, kind: "error"}]` 注入即可确定性触发——建议在 guide 的
   测试章节收录此模式。

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
