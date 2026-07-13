// MivoCanvas codemap — 模块级仓库地图，供 SessionStart hook 注入。
// 零第三方依赖：自写 import 扫描（相对路径 + 路径补全）。
// 设计见 docs/decisions 与 TECH_DEBT_AUDIT.md "Architectural mental model" 段。
// 两种模式：--compact（默认，硬上限 3KB）/ --full（完整 markdown 至 stdout）。
// 性能门：全流程 <5s，耗时打印至 stderr（不污染 stdout 注入流）。
//
// 健壮性约定（防静默漏边）：
// - 正则覆盖 import/export...from、动态 import()、import type 三种形态
// - 启动读 tsconfig，若发现 path alias 则 stderr 显著 warning（防未来失真）
// - 相对路径按 .ts/.tsx → /index.ts(x) 序补全；解析不到的不丢弃，尾部报 unresolved 计数
// - 循环依赖 DFS 计数

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve, sep, posix, extname } from "node:path";
import { fileURLToPath } from "node:url";

const COMPACT_CAP_BYTES = 3072; // 3KB 硬上限
const ROOT = process.cwd();

// ── 模块职责映射表（手写，参考 TECH_DEBT_AUDIT.md mental model 措辞） ──
const RESPONSIBILITY = {
  "src": "应用入口壳 (main.tsx 根装配 + App.tsx)",
  "src/app": "UI 壳 — 顶栏/侧栏/库工作台/Inspector/聊天面板",
  "src/canvas": "画布组件 + 单一职责交互 hook + 节点注册",
  "src/lib": "客户端/资产/校验/快照/IndexedDB 存储适配",
  "src/model": "纯领域模型 (documentModelV2/anchorModel)",
  "src/render": "投影/命中/视口契约 (P3-0b 冻结资产，生产零接线)",
  "src/store": "Zustand 状态根 + 5 slice + 持久化迁移",
  "src/types": "跨层共享类型 (generation/mivoCanvas)",
  "server": "BFF 入口装配 (hono)",
  "server/routes": "HTTP 路由 — generate/edit/enhance/tasks/eagle/local-assets/proxy-image/debug-logs",
  "server/platform": "平台适配 — job 轮询/状态机",
  "server/tasks": "异步任务 — registry/runner",
  "server/lib": "服务端工具 — config/assets/proxyImageSecurity/debug-records",
  "server/contracts": "契约快照 + capture 工具 (JSON schema)",
};

const NAV_LINES = [
  "[导航规范] 查引用/定义必须优先用 LSP findReferences/goToDefinition，grep 只做文本兜底。",
  "[导航规范] 文本搜索必须覆盖全仓（src/ + server/ + scripts/），禁止只搜单目录。",
];

// ── 扫描根目录与排除规则 ──
const SCAN_ROOTS = ["src", "server"];
const EXCLUDE_DIRS = new Set(["__tests__", "__captures__", "node_modules", "dist", "build"]);
const EXCLUDE_FILE = /(\.test\.|\.spec\.)/; // 测试文件不进生产依赖图
const SOURCE_EXT = new Set([".ts", ".tsx"]);

// ── import 扫描正则 ──
// 静态 import/export ... from '相对路径'（含 import type / export * / re-export）
const RE_FROM = /\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g;
// 动态 import('相对路径')
const RE_DYNAMIC = /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

// ── 工具函数 ──
function toPosix(p) {
  return p.split(sep).join("/");
}

function moduleOf(posixPath) {
  const parts = posixPath.split("/");
  if (parts.length < 2) return parts[0] || "(root)";
  if (parts[0] === "src" || parts[0] === "server") {
    if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
    return parts[0];
  }
  return parts.slice(0, 2).join("/");
}

function countLines(absPath) {
  try {
    const buf = readFileSync(absPath);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf.length > 0 && buf[buf.length - 1] !== 10) n++;
    return n;
  } catch {
    return 0;
  }
}

function fmtLines(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}kL`;
  return `${n}L`;
}

function truncateBytes(str, cap) {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= cap) return str;
  let cut = cap;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.slice(0, cut).toString("utf8");
}

// 递归收集源文件（posix 相对路径）
function collectFiles() {
  const out = [];
  function walk(dirAbs, dirPosix) {
    let entries;
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dirAbs, name);
      const px = dirPosix ? `${dirPosix}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDE_DIRS.has(name)) continue;
        walk(abs, px);
      } else if (st.isFile()) {
        if (!SOURCE_EXT.has(extname(name))) continue;
        if (EXCLUDE_FILE.test(name)) continue;
        out.push(px);
      }
    }
  }
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    if (existsSync(abs)) walk(abs, root);
  }
  return out;
}

// 相对路径补全：基于 fromFile 的目录，解析 specifier 到 posix 相对路径。
// 按 .ts/.tsx → /index.ts(x) 序；带扩展名直接用。解析不到返回 null。
const TRY_EXTS = [".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"];
function resolveImport(specifier, fromFilePosix) {
  const fromAbs = join(ROOT, fromFilePosix);
  const base = resolve(dirname(fromAbs), specifier); // 绝对路径
  const baseRel = relative(ROOT, base); // 回到 posix 相对
  const basePx = toPosix(baseRel);
  // 带源扩展名直接判定
  const ext = extname(specifier);
  if (SOURCE_EXT.has(ext) || ext === ".js") {
    return existsSync(join(ROOT, basePx)) ? basePx : null;
  }
  for (const e of TRY_EXTS) {
    const cand = basePx + e;
    if (existsSync(join(ROOT, cand))) return cand;
  }
  return null;
}

// 从源码文本提取相对 import specifier(先剔 // 与 /* */ 注释,防 `from '...'` 出现在
// 注释里被误判为 import edge —— A7a-4 假阳性:canvasStore.ts 自环注释 / canvasStateTypes
// 注释把 27 报成 29)。纯函数(不碰文件系统),便于 fixture 测试。
export function extractSpecs(content) {
  const stripped = stripJsonComments(content);
  const specs = new Set();
  RE_FROM.lastIndex = 0;
  RE_DYNAMIC.lastIndex = 0;
  let m;
  while ((m = RE_FROM.exec(stripped)) !== null) specs.add(m[1]);
  while ((m = RE_DYNAMIC.exec(stripped)) !== null) specs.add(m[1]);
  return specs;
}

// 扫描单文件的相对 import，返回 { resolved: string[], unresolved: number }
export function scanFileImports(filePx, content) {
  const specs = extractSpecs(content);
  const resolved = new Set();
  let unresolved = 0;
  for (const spec of specs) {
    const target = resolveImport(spec, filePx);
    if (target) resolved.add(target);
    else unresolved++;
  }
  return { resolved: [...resolved], unresolved };
}

// ── path alias 守卫：读 tsconfig，paths 非空则 warning ──
function checkPathAlias() {
  const tscFiles = [
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "tsconfig.server.json",
  ];
  for (const f of tscFiles) {
    try {
      const raw = readFileSync(join(ROOT, f), "utf8");
      // tsconfig 允许注释，简单提取 paths 段
      const json = JSON.parse(stripJsonComments(raw));
      const paths = json?.compilerOptions?.paths;
      if (paths && Object.keys(paths).length > 0) {
        process.stderr.write(
          `[codemap WARNING] ${f} 检测到 compilerOptions.paths（path alias），` +
            `相对路径扫描会漏边，需升级解析器（如接回 madge/tsconfig-paths）。\n`
        );
        return;
      }
    } catch {
      // 忽略读不到/解析失败
    }
  }
}

export function stripJsonComments(s) {
  // 极简：去 // 行注释与 /* */ 块注释（tsconfig 用得到）
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  while (i < s.length) {
    const c = s[i];
    const nx = s[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += nx || "";
        i += 2;
        continue;
      }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && nx === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && nx === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── 图构建 ──
function buildGraph(files) {
  const adj = new Map(); // file → [resolved files]
  let totalUnresolved = 0;
  for (const file of files) {
    const abs = join(ROOT, file);
    let content = "";
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      content = "";
    }
    const { resolved, unresolved } = scanFileImports(file, content);
    adj.set(file, resolved);
    totalUnresolved += unresolved;
  }
  const circular = findCircles(adj);
  return { adj, circular, totalUnresolved };
}

// 循环依赖检测：DFS 维护递归栈
function findCircles(adj) {
  const nodes = [...adj.keys()];
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const state = new Uint8Array(nodes.length); // 0=未访 1=栈中 2=完成
  const stack = [];
  const circles = [];
  function dfs(u) {
    state[u] = 1;
    stack.push(u);
    for (const v of adj.get(nodes[u]) || []) {
      const j = idx.get(v);
      if (j === undefined) continue; // 目标不在扫描集（被排除或外部）
      if (state[j] === 0) {
        dfs(j);
      } else if (state[j] === 1) {
        // 找到环：从 j 到 u 的栈片段
        const start = stack.indexOf(j);
        const ring = stack.slice(start).concat([j]).map((n) => nodes[n]);
        circles.push(ring);
      }
    }
    stack.pop();
    state[u] = 2;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (state[i] === 0) dfs(i);
  }
  // 去重（同一环可能被多次记录）
  const seen = new Set();
  const uniq = [];
  for (const ring of circles) {
    const key = [...ring].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(ring);
  }
  return uniq;
}

function collectStats(adj, files) {
  const modules = new Map();
  const fileLines = [];
  for (const file of files) {
    const mod = moduleOf(file);
    if (!modules.has(mod)) {
      modules.set(mod, { files: 0, lines: 0, deps: new Set(), rdeps: new Set() });
    }
    const m = modules.get(mod);
    m.files += 1;
    m.lines += countLines(join(ROOT, file));
    fileLines.push({ path: file, lines: m.lines ? countLines(join(ROOT, file)) : 0 });
  }
  // 单独算行数（上面 m.lines 已累加，fileLines 重新读一次避免闭包问题）
  fileLines.length = 0;
  for (const file of files) {
    fileLines.push({ path: file, lines: countLines(join(ROOT, file)) });
  }
  // 依赖边 → 模块级
  for (const [file, deps] of adj) {
    const mod = moduleOf(file);
    for (const dep of deps) {
      const dmod = moduleOf(dep);
      if (dmod !== mod) {
        modules.get(mod).deps.add(dmod);
        if (!modules.has(dmod)) {
          modules.set(dmod, { files: 0, lines: 0, deps: new Set(), rdeps: new Set() });
        }
        modules.get(dmod).rdeps.add(mod);
      }
    }
  }
  const order = (k) => (k.startsWith("src") ? 0 : k.startsWith("server") ? 1 : 2);
  const sortedKeys = [...modules.keys()].sort((a, b) => {
    const oa = order(a),
      ob = order(b);
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
  return { modules, sortedKeys, fileLines };
}

function buildFull({ modules, sortedKeys, fileLines, circular, totalUnresolved, elapsedMs }) {
  const out = [];
  out.push("# MivoCanvas Codemap");
  out.push(...NAV_LINES);
  out.push("");
  const totalFiles = [...modules.values()].reduce((s, m) => s + m.files, 0);
  const totalLines = [...modules.values()].reduce((s, m) => s + m.lines, 0);
  out.push(
    `modules: ${sortedKeys.length} | files: ${totalFiles} | lines: ${totalLines} | circ: ${circular.length} | unresolved: ${totalUnresolved} | gen: ${(elapsedMs / 1000).toFixed(2)}s`
  );
  out.push("");
  out.push("## 模块（文件数 / 行数 / 职责 / 依赖 / 被依赖）");
  for (const key of sortedKeys) {
    const m = modules.get(key);
    const resp = RESPONSIBILITY[key] || "(未登记)";
    const deps = [...m.deps].sort().join(", ") || "—";
    const rdeps = [...m.rdeps].sort().join(", ") || "—";
    out.push(`- **${key}** — ${m.files}f ${fmtLines(m.lines)} — ${resp}`);
    out.push(`  - → ${deps}`);
    out.push(`  - ← ${rdeps}`);
  }
  out.push("");
  out.push("## 最大的 10 个源文件（路径:行数）");
  const top = [...fileLines].sort((a, b) => b.lines - a.lines).slice(0, 10);
  for (const f of top) out.push(`- ${f.path}:${f.lines}`);
  if (circular.length) {
    out.push("");
    out.push(`## 循环依赖（${circular.length} 处，前 5 处）`);
    for (const ring of circular.slice(0, 5)) out.push(`- ${ring.join(" → ")}`);
  }
  out.push("");
  return out.join("\n");
}

function buildCompact({ modules, sortedKeys, fileLines, circular, totalUnresolved, elapsedMs }) {
  const totalFiles = [...modules.values()].reduce((s, m) => s + m.files, 0);
  const totalLines = [...modules.values()].reduce((s, m) => s + m.lines, 0);
  const out = [];
  out.push("# MivoCanvas Codemap");
  out.push(...NAV_LINES);
  out.push(
    `modules: ${sortedKeys.length} | files: ${totalFiles} | lines: ${totalLines} | circ: ${circular.length} | unresolved: ${totalUnresolved} | gen: ${(elapsedMs / 1000).toFixed(2)}s`
  );
  out.push("");
  out.push("## 模块");
  for (const key of sortedKeys) {
    const m = modules.get(key);
    const resp = RESPONSIBILITY[key] || "(未登记)";
    const deps = [...m.deps].sort().join(",") || "—";
    const rdeps = [...m.rdeps].sort().join(",") || "—";
    out.push(`- ${key} — ${m.files}f ${fmtLines(m.lines)} ${resp} → ${deps} | ← ${rdeps}`);
  }
  out.push("");
  out.push("## Top10 文件");
  const top = [...fileLines].sort((a, b) => b.lines - a.lines).slice(0, 10);
  for (const f of top) out.push(`- ${f.path}:${f.lines}`);
  return out.join("\n") + "\n";
}

function trimToCap(text, cap) {
  let t = text;
  if (Buffer.byteLength(t, "utf8") > cap) {
    const idx = t.indexOf("## Top10");
    if (idx >= 0) t = t.slice(0, idx).trimEnd() + "\n[裁剪: 已省略 Top10]\n";
  }
  if (Buffer.byteLength(t, "utf8") > cap) {
    const notice = "\n[裁剪: 超过 3KB 上限，已硬截断]";
    const body = truncateBytes(t, cap - Buffer.byteLength(notice, "utf8"));
    t = body + notice;
  }
  return t;
}

async function main() {
  const t0 = process.hrtime.bigint();
  const args = process.argv.slice(2);
  const full = args.includes("--full");

  checkPathAlias();
  const files = collectFiles();
  const { adj, circular, totalUnresolved } = buildGraph(files);
  const stats = collectStats(adj, files);

  const t1 = process.hrtime.bigint();
  const elapsedMs = Number(t1 - t0) / 1e6;

  const payload = { ...stats, circular, totalUnresolved, elapsedMs };
  let output = full ? buildFull(payload) : buildCompact(payload);

  if (!full) {
    output = trimToCap(output, COMPACT_CAP_BYTES);
    const bytes = Buffer.byteLength(output, "utf8");
    if (bytes > COMPACT_CAP_BYTES) {
      console.error(`codemap: compact 输出 ${bytes}B 超过 ${COMPACT_CAP_BYTES}B 上限`);
      process.exit(1);
    }
  }

  process.stdout.write(output.endsWith("\n") ? output : output + "\n");
  process.stderr.write(
    `codemap: ${(elapsedMs / 1000).toFixed(2)}s (${full ? "full" : "compact"}, ${stats.sortedKeys.length} modules, ${files.length} files, unresolved ${totalUnresolved})\n`
  );

  if (elapsedMs > 5000) {
    console.error(`codemap: 性能门失败 (${(elapsedMs / 1000).toFixed(2)}s > 5s)`);
    process.exit(1);
  }
}

// 仅在直接运行时跑(被 import 做 fixture 测试时不执行,避免污染 stdout / 触发性能门 exit)
const __isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (__isMain) {
  main().catch((e) => {
    console.error("codemap: 失败 -", e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
