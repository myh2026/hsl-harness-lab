# StanzaWeaver — HSL 全能力复现版

> 用 HSL（Harness Specification Language）复现 [StanzaWeaver](https://github.com/xhdlphzr/StanzaWeaver)
> 的**神经-符号四步流水线**（16 个 HSL 模块）：描述生成 → 初稿（仅验行数/
> 字数）→ ReAct 炼句循环（四工具）→ 检查 AI 终审（不过打回）。符号层
> （格律判定）全部纯 HSL，零 AI 开销；神经层（诗意）经 LLM 网关；两层只
> 通过结构化工具通信。**全能力版**：五语言模板全量（zh/en/fr/it/la 十二种
> 体式）、vocabulary 词库存储层（约束检索 + 重排 + 增量幂等导入）、
> CC-CEDICT/Lexique382 数据集导入器。

## 原架构 → HSL 投影对照

| StanzaWeaver（原，Python） | 本复现（HSL） | 模块 |
|:---|:---|:---|
| pipeline.py 四步流水线 + 打回循环 | `graph Stanza`（条件环 G3） | `stanzaweaver.hsl` |
| tools/__init__.py WRITER_TOOLS 四工具 | `WeaveCall` 封闭枚举 + `WeaveKit` | `tools/weave.hsl` |
| prosody/（meter_validator 等） | `validate_full` / `validate_line` 纯 HSL | `prosody/validator.hsl` |
| templates/（五绝/七绝/十四行…） | `get_template` 注册表 | `prosody/templates.hsl` |
| knowledge/vocabulary.py（SQLite 词库 + 约束检索） | `WordVault`（词条 + meta + 工作区 TSV 镜像） | `knowledge/vocab.hsl` |
| knowledge/importer.py（数据集导入 + 幂等 meta） | `import_all`（CC-CEDICT/Lexique382 样例级全语义） | `knowledge/importer.hsl` |
| knowledge/embeddings.py（向量重排） | `rerank`（字符 n-gram 相似度降级重排） | `knowledge/embeddings.hsl` |
| knowledge/（SQLite 词汇库+向量重排）的内建回退 | `Lexicon`（三元组重叠排序；词库无果时回退） | `prosody/lexicon.hsl` |
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
# 全量回归（check + 词库导入/幂等 + 2 剧本 + emit）
bash run-tests.sh

# core 剧本（含词库优先检索：先部署样例数据集到工作区）
mkdir -p /tmp/stanza-ws/datasets && cp fixtures/datasets/* /tmp/stanza-ws/datasets/
bun ../.toolchain/dhv-ts/src/main.ts run stanzaweaver.hsl \
  --workspace /tmp/stanza-ws --task "月夜江天" \
  --model scripted --fixture fixtures/weave-moon.json --out /tmp/stanza-run

# 新模板路径（la-hexameter 经 config 轨道选择）
mkdir -p /tmp/stanza-la/datasets && cp fixtures/datasets/* /tmp/stanza-la/datasets/
bun ../.toolchain/dhv-ts/src/main.ts run stanzaweaver.hsl \
  --workspace /tmp/stanza-la --task "arma virumque" \
  --model scripted --fixture fixtures/fix-lexicon.json --out /tmp/stanza-la-run
```

实测汇总：weave-moon ✅ 4 tool_calls / meter_valid / checker_pass /
search_words 命中词库（source=vocab，8 词）/ 符号层拒绝违规 refine；
fix-lexicon ✅ la-hexameter 模板 + 拉丁元音组音节 + 提交受理；
词库 ✅ zh 20 + fr 10 词条导入 / vocabulary.tsv 落盘 / 二次运行幂等跳过。
weave-moon 剧本含一次**被符号层拒绝**的 refine_line（平仄违规：第 3 行
第 1 字「月」应平实仄）与一次被受理的修正——符号层铁律真实生效：

```
《江夜》
月夜江天远    仄仄平平仄
云山落日舟    平平仄仄平   ← 韵脚：舟（ou）
烟江寒对月    平平平仄仄
夜雪静寒楼    仄仄仄平平   ← 韵脚：楼（ou）与舟同韵
```

## 目录结构（16 个 HSL 模块）

```
stanzaweaver/
├── stanzaweaver.hsl            入口：Stanza 四步流水线 graph + config 轨道模板选择
├── types/
│   ├── poem.hsl                PoemState / MeterTemplate（syl_spec/韵组/叠句组）/ PoemResult
│   ├── word.hsl                Word / WordHit / Syllable（词库词条模型）
│   └── errors.hsl              ModelError / WeaverError + From×2
├── prosody/
│   ├── lexicon.hsl             内置词汇表（平仄/韵组/语义）+ search（词库回退层）
│   ├── validator.hsl           全量/单行/初稿三级校验（纯 HSL，五语言）
│   ├── templates.hsl           模板注册表（zh-wujue/zh-qijue/en-couplet/fr-rondeau/
│   │                           fr-triolet/fr-ballade/it-terza-rima/it-ottava-rima/
│   │                           it-canzone/la-hexameter/la-distichon/la-hendecasyllabus）
│   ├── chinese.hsl             拼音解析（声母/韵腹/韵尾/平仄，CEDICT 共享表）
│   └── french.hsl              法语音节切分（Lexique382 对齐）
├── knowledge/
│   ├── vocab.hsl               WordVault（词条 + meta + 约束检索 + TSV 镜像落盘）
│   ├── importer.hsl            import_all（CC-CEDICT/Lexique382 样例级全语义 + 幂等）
│   └── embeddings.hsl          rerank（字符 n-gram 相似度重排）
├── tools/weave.hsl             四工具（search_words 优先词库，词库无果回退 lexicon）
├── providers/poet.hsl          PoetModel trait + LlmPoet + ScriptedPoet（双轨道）
├── config/resources.hsl        WRITER_GUIDE / CHECKER_GUIDE / WEAVER_CONFIG
├── fixtures/
│   ├── weave-moon.json         core 剧本（符号层拒绝场景 + 词库检索）
│   ├── fix-lexicon.json        la-hexameter 剧本（config 轨道模板选择）
│   └── datasets/               cedict-sample.txt（20 词）/ lexique-sample.tsv（10 词）
├── run-tests.sh                全量回归（check + 词库幂等 + 2 剧本 + emit）
└── web/                        原版 Web UI（逐字节拷贝）+ REST/SocketIO 适配服务器
```

## 已知简化（诚实披露）

- **数据集**：CC-CEDICT / Lexique382 为样例级解析器（格式全语义），
  捆绑样例 20+10 词；全量数据集原版经网络下载，HSL 剑本离线运行
  （样例缺失时镜像原版网络失败的降级路径：记日志、返回、不置 meta）；
  en@CMUdict / it@GLAW-IT / la@Lewis & Short 三个数据集未捆绑样例
  （import_all 镜像跳过日志）；
- **持久层**：vocabulary.tsv 为 SQLite 词库的工作区镜像（W/M 行 ≈
  words/meta 表）；SQLite 本身披露为基建；
- 语义相似度用字符 n-gram 重排替代 sentence-transformers 向量重排；
- 炼句循环无上限 → 预算化近似（`MAX_REFINE_ROUNDS = 12`，终审打回
  上限 4 次——原版打回无上限）；
- en/it/la 音节计数用元音组启发式（原版 en 有 CMUdict；it/la 原版
  韵脚分析未移植 → 空串软放行，validator 模块头披露）；
- 流式 token 推送与前端 UI 不在 HSL 契约层。

## BNF 特性覆盖

graph 双参数 + 条件环（G3）+ 五条 guard 边 / S6 穷尽 match（WeaveCall /
Phase）/ `?` + From×2 / 嵌套 loop + break / Vec.remove/insert/append/
take/skip / String chars/rev/collect / const / native typescript（llm/
json/fixture/config）/ block 资源 + 跨文件 `{{}}` 插值（MAX_REFINE_ROUNDS
从入口模块 import 进 config 模块插值）/ project + rules + scale。

## License

MIT（与上游 StanzaWeaver 同许可）
