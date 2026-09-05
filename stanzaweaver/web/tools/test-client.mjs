// ============================================================================
// stanzaweaver/web/tools/test-client.mjs — Socket.IO 全链路测试客户端
// ----------------------------------------------------------------------------
// 用法（需先 bun install，并另开终端启动 `bun web/server.ts`）：
//   cd hsl-projects/stanzaweaver/web
//   node tools/test-client.mjs            # 全链路（generate + feedback + 错误路径）
//
// 验证内容：
//   1. 连接后收到 llm_status {writer:"ok", checker:"ok"}；
//   2. emit generate → 收到 progress 事件序列（步序 1→2→3→4、
//      step_details 去重 seq、草稿行、last_tool 工具链、stream_text）；
//   3. done 事件载荷与 weave-moon 剧本产物一致（标题/诗行/终审/格式化）；
//   4. emit feedback → 打回 Step 3 重炼 → 第二次 done；
//   5. 错误路径：空参数 error / 未知模板 error / 无会话 feedback error。
// ============================================================================

import { io } from "socket.io-client";

const URL = process.env.STANZA_WEB_URL ?? "ws://127.0.0.1:5020";

const EXPECTED_POEM = ["月夜江天远", "云山落日舟", "烟江寒对月", "夜雪静寒楼"];
const EXPECTED_TITLE = "江夜";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

const PROGRESS_KEYS = [
  "step",
  "description",
  "draft",
  "title",
  "refine_rounds",
  "checker_pass",
  "checker_suggestions",
  "step_details",
  "last_tool",
  "last_tool_result",
  "stream_text",
  "current_detail_step",
  "current_detail",
];

function waitFor(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时（${timeoutMs}ms）`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

const socket = io(URL, { transports: ["websocket"] });

// llm_status 在连接建立瞬间即由服务端推送——监听器必须在 connect 完成前注册
const llmStatusPromise = waitFor(socket, "llm_status", 8000).catch((e) => {
  check("连接收到 llm_status", false, e.message);
  return null;
});

console.log(`[test-client] 连接 ${URL} …`);
try {
  await new Promise((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
    setTimeout(() => reject(new Error("连接超时")), 8000);
  });
  console.log("[test-client] 已连接", socket.id);
} catch (e) {
  console.error("[test-client] 连接失败:", e.message);
  process.exit(1);
}

// ── 1. 连接即收到 llm_status ────────────────────────────────────────────────
try {
  const st = await llmStatusPromise;
  if (st) {
    check("连接收到 llm_status 且 writer/checker=ok（scripted 可用）", st.writer === "ok" && st.checker === "ok", JSON.stringify(st));
  }
} catch (e) {
  check("连接收到 llm_status", false, e.message);
}

// ── 2/3. generate 全链路 ────────────────────────────────────────────────────
console.log("\n[test-client] emit generate {topic:'月夜江天', template_key:'zh-wujue'}");
const progressEvents = [];
let doneData = null;
let errorData = null;
socket.on("progress", (d) => progressEvents.push(d));
socket.on("done", (d) => (doneData = d));
socket.on("error", (d) => (errorData = d));

socket.emit("generate", { topic: "月夜江天", template_key: "zh-wujue" });

const t0 = Date.now();
while (!doneData && !errorData && Date.now() - t0 < 120000) {
  await new Promise((r) => setTimeout(r, 200));
}
check("generate 以 done 结束（无 error）", doneData !== null && errorData === null, errorData ? JSON.stringify(errorData) : "done 超时");

if (doneData) {
  const steps = progressEvents.map((p) => p.step);
  check(
    "progress 步序覆盖 1→2→3→4",
    [1, 2, 3, 4].every((n) => steps.includes(n)),
    `实际步序: ${[...new Set(steps)].join(",")}`,
  );
  check("progress 载荷含原版全部 13 个字段", progressEvents.every((p) => PROGRESS_KEYS.every((k) => k in p)));
  const lastStep3 = progressEvents.filter((p) => p.step === 3);
  const tools = [...new Set(lastStep3.map((p) => p.last_tool))];
  check(
    "Step 3 工具链含 search_words / refine_line / submit / _thinking",
    ["search_words", "refine_line", "submit", "_thinking"].every((t) => tools.includes(t)),
    `实际: ${tools.join(",")}`,
  );
  const refineRejected = progressEvents.some(
    (p) => p.last_tool === "refine_line" && /refused|violations/.test(String(p.last_tool_result)),
  );
  const refineAccepted = progressEvents.some(
    (p) => p.last_tool === "refine_line" && /line meter valid/.test(String(p.last_tool_result)),
  );
  check("剧本中含一次被符号层拒绝的 refine_line（refused — violations）", refineRejected);
  check("剧本中含一次被受理的 refine_line（line meter valid）", refineAccepted);
  const seqs = progressEvents.at(-1).step_details.map((d) => d.seq);
  check("step_details 的 seq 从 0 连续递增", seqs.every((v, i) => v === i), JSON.stringify(seqs));
  const streamTexts = progressEvents.filter((p) => p.stream_text).map((p) => p.stream_text);
  check("Step 1/2 存在流式片段（stream_text 非空）", streamTexts.length >= 4, `片段数 ${streamTexts.length}`);
  const draftEvent = progressEvents.find((p) => p.draft && p.draft.length === 4);
  check("progress 中出现 4 行草稿", Boolean(draftEvent));

  check("done.title 为剧本标题", doneData.title === EXPECTED_TITLE, JSON.stringify(doneData.title));
  check(
    "done.final_poem = [标题, ...4 行]（weave-moon 产物）",
    JSON.stringify(doneData.final_poem) === JSON.stringify([EXPECTED_TITLE, ...EXPECTED_POEM]),
    JSON.stringify(doneData.final_poem),
  );
  check("done.draft 为 4 行诗稿", JSON.stringify(doneData.draft) === JSON.stringify(EXPECTED_POEM));
  check("done.checker_pass === true", doneData.checker_pass === true);
  check("done.formatted_poem 绝句格式（含句号）", /\n/.test(doneData.formatted_poem) && doneData.formatted_poem.includes("。"), doneData.formatted_poem?.slice(0, 40));
  check("done.step_details 覆盖 4 步", [1, 2, 3, 4].every((n) => doneData.step_details.some((d) => d.step === n)));
  const step4 = doneData.step_details.find((d) => d.step === 4);
  check("Step 4 详情含 HSL 事件轨迹（events.jsonl 映射）", /run_start/.test(step4.content) && /node\(writer\)/.test(step4.content) && /run_end/.test(step4.content));
  const step3 = doneData.step_details.find((d) => d.step === 3);
  check("Step 3 详情含 rounds 与失败轮次记录", step3.rounds === 4 && /失败/.test(step3.content));
  console.log(`[test-client] 事件统计：progress=${progressEvents.length}（${Math.round((Date.now() - t0) / 1000)}s）`);
}

// ── 4. feedback 续跑 ────────────────────────────────────────────────────────
console.log("\n[test-client] emit feedback {feedback:'第二句换一个更有画面感的词'}");
progressEvents.length = 0;
doneData = null;
errorData = null;
socket.emit("feedback", { feedback: "第二句换一个更有画面感的词" });
const t1 = Date.now();
while (!doneData && !errorData && Date.now() - t1 < 120000) {
  await new Promise((r) => setTimeout(r, 200));
}
check("feedback 以 done 结束", doneData !== null && errorData === null, errorData ? JSON.stringify(errorData) : "done 超时");
if (doneData) {
  const steps = [...new Set(progressEvents.map((p) => p.step))];
  check("feedback 续跑从 Step 3 重入（步序 ⊆ {3,4}）", steps.every((s) => s === 3 || s === 4) && steps.includes(3), steps.join(","));
  check("feedback done.checker_pass === true", doneData.checker_pass === true);
  check("feedback done 诗稿一致（剧本确定性）", JSON.stringify(doneData.final_poem) === JSON.stringify([EXPECTED_TITLE, ...EXPECTED_POEM]));
  const fbStep3 = doneData.step_details.filter((d) => d.step === 3);
  check("feedback Step 3 详情注入用户反馈文案", fbStep3.some((d) => d.content.includes("用户反馈已注入")));
  check("feedback step_details seq 续接不重复", new Set(doneData.step_details.map((d) => d.seq)).size === doneData.step_details.length);
}

// ── 5. 错误路径 ─────────────────────────────────────────────────────────────
console.log("\n[test-client] 错误路径验证");
errorData = null;
socket.emit("generate", { topic: "", template_key: "zh-wujue" });
try {
  errorData = await waitFor(socket, "error", 5000);
} catch {
  /* fallthrough */
}
check("空主题 → error {message:'主题和模板不能为空'}", errorData?.message === "主题和模板不能为空", JSON.stringify(errorData));

errorData = null;
socket.emit("generate", { topic: "月", template_key: "zh-nonexistent" });
try {
  errorData = await waitFor(socket, "error", 5000);
} catch {
  /* fallthrough */
}
check("未知模板 → error（含 未知模板）", /未知模板/.test(String(errorData?.message)), JSON.stringify(errorData));

socket.disconnect();
await new Promise((r) => setTimeout(r, 300));

// 无会话 feedback（新连接）
const socket2 = io(URL, { transports: ["websocket"] });
await new Promise((resolve, reject) => {
  socket2.on("connect", resolve);
  socket2.on("connect_error", reject);
  setTimeout(() => reject(new Error("连接超时")), 8000);
});
socket2.emit("feedback", { feedback: "随便改改" });
let err2 = null;
try {
  err2 = await waitFor(socket2, "error", 5000);
} catch {
  /* fallthrough */
}
check("新会话 feedback → error（无活跃会话）", /没有活跃的生成会话/.test(String(err2?.message)), JSON.stringify(err2));
socket2.disconnect();

console.log(`\n[test-client] 结果：${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
