# StanzaWeaver — HSL 复现版

> 用 HSL（Harness Specification Language）复现 [StanzaWeaver](https://github.com/xhdlphzr/StanzaWeaver)
> 的**神经-符号四步流水线**：描述生成 → 初稿（仅验行数/字数）→ ReAct 炼句
> 循环（四工具）→ 检查 AI 终审（不过打回）。符号层（格律判定）全部纯 HSL，
> 零 AI 开销；神经层（诗意）经 LLM 网关；两层只通过结构化工具通信。

## 原架构 → HSL 投影对照

| StanzaWeaver（原，Python） | 本复现（HSL） | 模块 |
|:---|:---|:---|
| pipeline.py 四步流水线 + 打回循环 | `graph Stanza`（条件环 G3） | `stanzaweaver.hsl` |
| tools/__init__.py WRITER_TOOLS 四工具 | `WeaveCall` 封闭枚举 + `WeaveKit` | `tools/weave.hsl` |
| prosody/（meter_validator 等） | `validate_full` / `validate_line` 纯 HSL | `prosody/validator.hsl` |
| templates/（五绝/七绝/十四行…） | `get_template` 注册表 | `prosody/templates.hsl` |
| knowledge/（SQLite 词汇库+向量重排） | `Lexicon`（三元组重叠排序） | `prosody/lexicon.hsl` |
| writer_ai / checker_ai 双代理 | `PoetModel` trait 双实例（双轨道） | `providers/poet.hsl` |

## 拓扑

```
  writer ──DraftReady──> validator          （初稿形状校验）
  writer ──ToolCall──> weaver               （四工具执行）
  weaver ──LineChanged──> validator         （改动即校验）
  writer ──SubmitReady──> checker           （定稿终审）
  checker ──CheckRevise──> writer           （打回回环）
```

## 四工具（tools-as-interface：AI 不能输出自由文本冒充完成）

1. `search_words`：按平仄/韵组过滤 + 语义重叠排序，查候选词；
2. `refine_line`：整句替换 → **立即单行校验**（音节数 + 逐位平仄 +
   三平尾/孤平），不通过则拒绝修改并回传具体错误；
3. `rewrite`：声明整体重写方向；
4. `submit`：提交定稿 → **全量格律校验**（行数/字数/逐字平仄/韵脚/
   三平尾/孤平），通过才送终审，否则拒绝并回传全部违规。

## 符号层判定（全部纯 HSL，确定性）

- 行数 = 模板行数；
- 每行字数 = 模板字数（zh）或元音组音节数（en，CMUdict 的符号化简化）；
- 逐字平仄：`tone_pattern` 逐位比对（词汇表查声调；查无此字记 "?" 不误报）；
- 韵脚：押韵行尾字韵组一致；
- 三平尾：句尾连用三平声 → 违规；
- 孤平：全行仅一个平声 → 违规。

## 运行（dhv-ts 解释器）

```bash
mkdir -p /tmp/stanza-ws
bun ../.toolchain/dhv-ts/src/main.ts run stanzaweaver.hsl \
  --workspace /tmp/stanza-ws \
  --task "月夜江天" \
  --model scripted \
  --fixture fixtures/weave-moon.json \
  --out /tmp/stanza-run
```

实测（剧本模式）：✅ 4 tool_calls / meter_valid: true / checker_pass: true。
剧本含一次**被符号层拒绝**的 refine_line（平仄违规：第 3 行第 1 字
「月」应平实仄）与一次被受理的修正——符号层铁律真实生效：

```
《江夜》
月夜江天远    仄仄平平仄
云山落日舟    平平仄仄平   ← 韵脚：舟（ou）
烟江寒对月    平平平仄仄
夜雪静寒楼    仄仄仄平平   ← 韵脚：楼（ou）与舟同韵
```

## 目录结构（9 个 HSL 模块）

```
stanzaweaver/
├── stanzaweaver.hsl            入口：Stanza 四步流水线 graph + main + project
├── types/
│   ├── poem.hsl                PoemState / MeterTemplate / PoemResult / Phase
│   └── errors.hsl              ModelError / WeaverError + From×2
├── prosody/
│   ├── lexicon.hsl             内置词汇表（平仄/韵组/语义）+ search
│   ├── validator.hsl           全量/单行/初稿三级校验（纯 HSL）
│   └── templates.hsl           模板注册表（zh-wujue / zh-qijue / en-couplet）
├── tools/weave.hsl             四工具：search_words / refine_line / rewrite / submit
├── providers/poet.hsl          PoetModel trait + LlmPoet + ScriptedPoet（双轨道）
├── config/resources.hsl        WRITER_GUIDE / CHECKER_GUIDE / WEAVER_CONFIG
└── fixtures/weave-moon.json    确定性剧本（含符号层拒绝场景）
```

## 已知简化（诚实披露）

- 词汇表为内置种子（30 条示例词目），真实系统由 CC-CEDICT 等导入；
- 语义相似度用字符三元组重叠替代 sentence-transformers 向量重排；
- 炼句循环无上限 → 预算化近似（`MAX_REFINE_ROUNDS = 12`，终审打回
  上限 4 次——原版打回无上限）；
- en 音节计数用元音组启发式替代 CMUdict；
- 流式 token 推送与前端 UI 不在 HSL 契约层。

## BNF 特性覆盖

graph 双参数 + 条件环（G3）+ 五条 guard 边 / S6 穷尽 match（WeaveCall /
Phase）/ `?` + From×2 / 嵌套 loop + break / Vec.remove/insert/append/
take/skip / String chars/rev/collect / const / native typescript（llm/
json/fixture/config）/ block 资源 + 跨文件 `{{}}` 插值（MAX_REFINE_ROUNDS
从入口模块 import 进 config 模块插值）/ project + rules + scale。

## License

MIT（与上游 StanzaWeaver 同许可）
