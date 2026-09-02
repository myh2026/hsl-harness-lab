# ArmorLab — 红蓝对抗（破甲）harness

> 毕业论文方向二：**网安破甲 harness** —— 测试 AI / 网站 / 软件防火墙的
> 红蓝对抗演练场。红队按 `Attack / Probe / Done` 协议提交载荷，蓝方防火墙
> 裁决，harness 计量**规避率**（漏攻）与**误报率**（误伤），输出装甲评级。

## 核心设计：攻击面与误报面同时计量

只测"拦得住攻击"的 firewall 测试是片面的 —— 拦截一切的白名单也拿满分。
ArmorLab 同时送入两类载荷：

- **Attack**：红队载荷（SQLi / XSS / 路径穿越 / 提示注入 / 编码绕过 /
  碎片拼接 / 双重编码），穿透 = 装甲失守；
- **Probe**：良性请求（含易混淆语料，如 "union of two sets"、路径规范化），
  被拦 = 误报，误报率是可用性指标。

```
规避率 = 穿透攻击数 / 攻击总数        （越低越防）
误报率 = 被拦良性数 / 良性总数        （越低越可用）
评级   = FAIL-evasion / FAIL-false-positive / PASS-with-warnings / PASS
```

## 可替换靶标（破甲 harness 的分层意义）

蓝方 `defense.hsl` 是**纯 HSL 的规则引擎**（18 条签名 + 归一化器）——
这是"剧本靶标"。把它换成对真实目标的适配（`native` 块走 HTTP / 命令行 /
`$host.llm`），图拓扑、协议、计分、报告完全不变。红队同样经
`Box<dyn RedTeamModel>` 注入：剧本红队（CI）或真实 LLM 红队（论文实验）。

## 项目结构

```
armorlab/
├── types.hsl        契约层（Move/Verdict/FirewallRule/RoundLog/ScoreReport）
├── defense.hsl      蓝方防火墙引擎（可替换靶标；纯 HSL，18 条规则）
├── main.hsl         入口：红队协议 + AgentLoop + 计分 + 投射
├── fixtures/fix-redblue.json   剧本（7 攻击 + 4 探针）
└── run-tests.sh     CI 脚本
```

## 运行

```bash
bash run-tests.sh
```

剧本故事线（7 攻击 + 4 探针）：

| 战术 | 载荷 | 蓝方 |
|:---|:---|:---|
| plain | `' OR 1=1 --` | ✓ 拦截（sqli-quote-or） |
| plain | `1 UNION SELECT password FROM users` | ✓ 拦截 |
| plain | `<img src=x onerror=alert(1)>` | ✓ 拦截（xss-onerror） |
| encoding | `%27%20OR%201%3D1--` | ✓ 拦截（enc-quote） |
| fragmentation | `UN/**/ION SE/**/LECT` | ✓ 拦截（注释剥离归一化后命中） |
| semantic | `Ignore all previous instructions…` | ✓ 拦截（inject-ignore-all） |
| **double-encoding** | `%2527%2520OR…` | ✗ **穿透**（单遍解码盲区） |
| probe | "union of two sets was discussed…" | ✓ 放行（无误报） |
| probe | `…/docs/../notes.md` 路径规范化 | ✗ **误报**（traversal 规则误伤） |

计分：规避率 0.143 · 误报率 0.250 → **PASS-with-warnings**，报告附
可执行改进备忘（递归解码归一化 / 上下文白名单）—— 这就是破甲 harness
的产出：不是"防火墙好坏"的标签，而是**具体的薄弱面定位**。

## 拓扑与观测

`graph ArmorLab`：`red（Box<dyn RedTeamModel> 注入位）→ blue（防火墙
注入位）→ scorer`，四条 Guard 边（Attack/Probe/Blocked/Passed）。
`events.jsonl` 的 G6 边事件按回合记录红蓝交互轨迹。

## 物理层投射

`project {}` 规则组：Python 平铺 + trait → TypeScript + 配置块 → YAML。
`inspect_payload` 是**活体翻译**（filter + first + match 函数式风格直译），
生成 Python 经 exec 语义级验证：五类载荷的 Blocked/Passed 判定与解释器
逐项一致。

## 已知边界（诚实清单）

- 判定函数（`judge_attack/judge_probe`）含多早退 return → python 回退
  contract（围栏保源）；`inspect_payload`/`normalize`/`verdict_text` 活体；
- 提示注入语义变体（空格混淆 `i g n o r e`）在签名引擎下天然穿透 ——
  这正是"规则防火墙 vs 语义防火墙"的论文对照实验素材；
- 函数名避开 Python 标准库模块名（`inspect.py` 会遮蔽 stdlib `inspect`
  导致 dataclasses 循环导入）—— 命名纪律：HSL 侧用 `inspect_payload`。
