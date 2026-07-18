#!/usr/bin/env node
// Mivo(原 bug-doctor)状态看板渲染器(T-Dash)。
// 展示层用 P0-P3 编号;内部字段(state.json 的 sLevel/S*)与 CSS class 不动,仅渲染映射。
// 零依赖:读 state.json / workpacket.json / ledger.csv / logs.md / react-baseline.json
// + `gh` 查 PR/issue(失败降级为本地缓存并标注"数据过期"),输出自包含 HTML(内联 SVG)
// 到 <stateDir>/dashboard/index.html。看板只投影已有状态,不是第二真相源。
//
// 用法: node scripts/loops/dashboard/render.mjs [--state-dir DIR] [--no-gh] [--now ISO]
//   --state-dir  状态目录,默认 <repoRoot>/history/loops/bug-doctor(repoRoot 按脚本位置推导,
//                在 worktree 里执行即读 worktree 侧;T8 入库切主后无需改动)
//   --no-gh      跳过 gh 调用(等价于 gh 不可用,走缓存降级路径)
//   --now        覆盖渲染时刻(测试用)
//
// 六流程状态灯语义(rules.json coreProcesses source 映射,24h 窗口锚定台账最新 lastSeen):
//   红 = 窗口内存在活跃 S0 簇(或静默失败特征)
//   黄 = 窗口内存在活跃 error 级簇(未达 S0)
//   绿 = 无 error(纯 warning 视为已降级兜底路径,不亮黄,但计数仍展示)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const REPO_SLUG = 'xindong/mivo-canvas';
const WINDOW_HOURS = 24;
const ACTIVE_STATUSES = new Set(['new', 'triaged', 'in-progress', 'fix-attempted']);
// 展示层 P 编号 = 内部 S 级一一映射(P3-9;内部字段不动)
const P_LABEL = { S0: 'P0', S1: 'P1', S2: 'P2', S3: 'P3' };
export const pLabel = (s) => P_LABEL[s] || String(s ?? '—');
// issue/PR 标题检索前缀:更名 Mivo 后新档走 [mivo],旧档 [bug-doctor] 仍需认(防失联)
const GH_TITLE_PREFIXES = ['[mivo]', '[bug-doctor]'];

// ---------- CLI ----------
export function parseArgs(argv) {
  const args = { stateDir: join(REPO_ROOT, 'history/loops/bug-doctor'), gh: true, now: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') args.stateDir = resolve(argv[++i]);
    else if (argv[i] === '--no-gh') args.gh = false;
    else if (argv[i] === '--now') args.now = new Date(argv[++i]);
  }
  return args;
}

// ---------- 数据加载(全部容错:缺文件→空态,页面不白屏) ----------
function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function readTextSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function parseLogs(md) {
  const runs = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- (\S+) · mode=(\S+) ·(.*)$/);
    if (!m) continue;
    const rest = m[3];
    const wp = rest.match(/工作包 (\d+) 簇/);
    runs.push({
      ts: m[1],
      mode: m[2],
      idle: /空转跳过|空工作包/.test(rest) || (wp && Number(wp[1]) === 0),
      workpacket: wp ? Number(wp[1]) : 0,
      evolve: /evolve|进化/.test(m[2] + rest),
      raw: line.replace(/^- /, ''),
    });
  }
  return runs;
}

export function parseLedger(csv) {
  const lines = csv.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { rows: [], costTotal: 0 };
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(',');
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
  const costTotal = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  return { rows, costTotal };
}

// ---------- gh 查询 + 缓存降级 ----------
function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) {
    throw new Error(`gh ${args[0]} ${args[1]} failed: ${r.error?.message || r.stderr?.slice(0, 200) || 'exit ' + r.status}`);
  }
  return JSON.parse(r.stdout || '[]');
}

// 多前缀检索结果合并去重(按 number,新旧前缀都认;导出供回归测试)
export function mergeGhItems(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || item.number == null || seen.has(item.number)) continue;
      seen.add(item.number);
      out.push(item);
    }
  }
  out.sort((a, b) => b.number - a.number);
  return out;
}

export function fetchGithub({ enabled, cachePath, now }) {
  if (enabled) {
    try {
      const prs = mergeGhItems(GH_TITLE_PREFIXES.map((prefix) =>
        runGh(['pr', 'list', '--repo', REPO_SLUG, '--state', 'all', '--limit', '50',
          '--search', `${prefix} in:title`,
          '--json', 'number,title,state,isDraft,mergedAt,url,createdAt,labels'])));
      const issues = mergeGhItems(GH_TITLE_PREFIXES.map((prefix) =>
        runGh(['issue', 'list', '--repo', REPO_SLUG, '--state', 'all', '--limit', '50',
          '--search', `${prefix} in:title`,
          '--json', 'number,title,state,url,createdAt,labels'])));
      const data = { fetchedAt: now.toISOString(), prs, issues };
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(data, null, 2));
      return { ...data, stale: false, error: null };
    } catch (e) {
      const cached = readJsonSafe(cachePath);
      if (cached) return { ...cached, stale: true, error: String(e.message || e) };
      return { fetchedAt: null, prs: [], issues: [], stale: true, error: String(e.message || e) };
    }
  }
  const cached = readJsonSafe(cachePath);
  if (cached) return { ...cached, stale: true, error: 'gh 调用被禁用(--no-gh)' };
  return { fetchedAt: null, prs: [], issues: [], stale: true, error: 'gh 调用被禁用(--no-gh),且无本地缓存' };
}

// ---------- 领域计算 ----------
export function activeClusters(state) {
  return Object.entries(state?.clusters || {})
    .map(([fp, c]) => ({ fp, ...c }))
    .filter((c) => ACTIVE_STATUSES.has(c.status));
}

export function queueCounts(clusters) {
  const q = { S0: 0, S1: 0, S2: 0, S3: 0 };
  for (const c of clusters) if (q[c.sLevel] !== undefined) q[c.sLevel]++;
  return q;
}

export function dataAnchor(clusters, fallback) {
  let max = 0;
  for (const c of clusters) {
    const t = Date.parse(c.lastSeen || 0);
    if (t > max) max = t;
  }
  return max ? new Date(max) : fallback;
}

// 六流程状态灯。返回 [{id,label,color,s0,err,warn,clusters}]
export function computeLights(clusters, rules, anchor) {
  const windowStart = anchor.getTime() - WINDOW_HOURS * 3600 * 1000;
  return (rules?.coreProcesses || []).map((p) => {
    const regs = (p.sourcePatterns || []).map((s) => new RegExp(s));
    const hits = clusters.filter((c) =>
      regs.some((r) => r.test(c.source || '')) && Date.parse(c.lastSeen || 0) >= windowStart);
    const s0 = hits.filter((c) => c.sLevel === 'S0' || c.silentFailure);
    const err = hits.filter((c) => c.sLevel !== 'S0' && !c.silentFailure && (c.levels || []).includes('error'));
    const warn = hits.filter((c) => !s0.includes(c) && !err.includes(c));
    const color = s0.length ? 'red' : err.length ? 'yellow' : 'green';
    return { id: p.id, label: p.label, color, s0: s0.length, err: err.length, warn: warn.length, hits };
  });
}

// ---------- HTML 工具 ----------
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const fmtTs = (iso) => (iso ? String(iso).replace('T', ' ').replace(/(\.\d+)?(\+08:00|Z)$/, '') : '—');

function svgLine(series, { w = 560, h = 140, pad = 28, colors = ['#4cc38a', '#e5484d'], labels = [] }) {
  const all = series.flatMap((s) => s.map((p) => p.y));
  if (!all.length) return `<div class="empty">暂无数据</div>`;
  const ymax = Math.max(...all, 1), ymin = Math.min(...all, 0);
  const n = Math.max(...series.map((s) => s.length));
  const x = (i) => pad + (n <= 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (n - 1));
  const y = (v) => h - pad - ((v - ymin) / (ymax - ymin || 1)) * (h - 2 * pad);
  let out = `<svg viewBox="0 0 ${w} ${h}" class="chart">`;
  out += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="axis"/>`;
  out += `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" class="axis"/>`;
  out += `<text x="${pad - 4}" y="${y(ymax) + 4}" class="tick" text-anchor="end">${ymax}</text>`;
  out += `<text x="${pad - 4}" y="${y(ymin) + 4}" class="tick" text-anchor="end">${ymin}</text>`;
  series.forEach((s, si) => {
    const pts = s.map((p, i) => `${x(i)},${y(p.y)}`).join(' ');
    if (s.length > 1) out += `<polyline points="${pts}" fill="none" stroke="${colors[si]}" stroke-width="2"/>`;
    s.forEach((p, i) => { out += `<circle cx="${x(i)}" cy="${y(p.y)}" r="3" fill="${colors[si]}"><title>${esc(p.t ?? '')} · ${p.y}</title></circle>`; });
    if (labels[si]) out += `<text x="${w - pad}" y="${pad + si * 14}" text-anchor="end" class="legend" fill="${colors[si]}">${esc(labels[si])}</text>`;
  });
  return out + '</svg>';
}

function runSquares(runs) {
  const recent = runs.slice(-60);
  if (!recent.length) return '<div class="empty">暂无运行记录</div>';
  const cells = recent.map((r) => {
    const cls = r.evolve ? 'sq evolve' : r.idle ? 'sq idle' : 'sq work';
    return `<span class="${cls}" title="${esc(r.raw)}">${r.evolve ? '<i class="dot"></i>' : ''}</span>`;
  }).join('');
  return `<div class="squares">${cells}</div>
  <div class="sq-legend"><span class="sq work"></span>有活轮 <span class="sq idle"></span>空转/静默 <span class="sq evolve"><i class="dot"></i></span>进化轮</div>`;
}

// ---------- 三区渲染 ----------
function sectionAgent({ runs, q, costTotal, state, gh }) {
  const last = runs[runs.length - 1];
  const openPRs = (state?.openPRs || []).length;
  return `
<section class="card" id="agent">
  <h2>① Agent 状态</h2>
  <div class="grid4">
    <div class="stat"><div class="k">最近一轮</div><div class="v small">${esc(fmtTs(last?.ts))}</div>
      <div class="sub">${last ? esc(last.idle ? '空转/静默' : `工作包 ${last.workpacket} 簇`) : '尚未运行'}</div></div>
    <div class="stat"><div class="k">下一班车</div><div class="v" id="next-train">—</div><div class="sub" id="countdown">主轮 02:30 · 补轮 13:00</div></div>
    <div class="stat"><div class="k">队列(活跃簇)</div><div class="v queue">
      <span class="badge s0">P0 ${q.S0}</span><span class="badge s1">P1 ${q.S1}</span>
      <span class="badge s2">P2 ${q.S2}</span><span class="badge s3">P3 ${q.S3}</span></div>
      <div class="sub">open loop PR:${openPRs}</div></div>
    <div class="stat"><div class="k">成本合计</div><div class="v">${costTotal}</div><div class="sub">ledger.csv 累计(${esc(String(runs.length))} 轮)</div></div>
  </div>
  <div class="k" style="margin-top:10px">运行方块行(近 60 轮)</div>
  ${runSquares(runs)}
  ${gh.stale ? `<div class="warnbar">⚠ GitHub 数据过期:${esc(gh.error || '')} — 显示${gh.fetchedAt ? `缓存(抓取于 ${esc(fmtTs(gh.fetchedAt))})` : '空数据(无缓存)'}</div>` : ''}
</section>`;
}

function prRow(p) {
  const st = p.mergedAt ? 'merged' : p.state?.toLowerCase() || 'open';
  return `<tr><td><a href="${esc(p.url)}">#${p.number}</a></td><td>${esc(p.title)}</td>
  <td><span class="pill ${st}">${st}${p.isDraft ? ' · draft' : ''}</span></td><td class="small">${esc(fmtTs(p.mergedAt || p.createdAt))}</td></tr>`;
}

function sectionDelivery({ gh, wp, state }) {
  const isAuto = (p) => (p.labels || []).some((l) => /t1|auto/i.test(l.name || l)) || /\[T1\]/.test(p.title || '');
  const auto = (gh.prs || []).filter(isAuto);
  const manual = (gh.prs || []).filter((p) => !isAuto(p));
  const issues = gh.issues || [];
  const top = [...(wp?.clusters || [])].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8)
    .map((c) => {
      const lc = state?.clusters?.[c.fp || `${c.source}::${c.pattern}`] || {};
      return `<tr><td><span class="badge ${String(c.sLevel).toLowerCase()}">${esc(pLabel(c.sLevel))}</span></td>
      <td class="num">${c.score ?? '—'}</td><td>${esc(c.source)}</td>
      <td class="pattern">${esc((c.pattern || '').slice(0, 90))}</td>
      <td class="num">${lc.count ?? '—'}</td><td class="small">${esc(lc.status || '—')}</td></tr>`;
    }).join('');
  const tbl = (rows, empty) => rows.length
    ? `<table><thead><tr><th>#</th><th>标题</th><th>状态</th><th>时间</th></tr></thead><tbody>${rows.map(prRow).join('')}</tbody></table>`
    : `<div class="empty">${empty}</div>`;
  return `
<section class="card" id="delivery">
  <h2>② 交付</h2>
  <div class="cols2">
    <div><h3>PR · 自动合并(机械档 T1)</h3>${tbl(auto, '暂无自动合并 PR')}</div>
    <div><h3>PR · 人审档(T2)</h3>${tbl(manual, '暂无待人审 PR')}</div>
  </div>
  <h3>Issue(T3 建档)</h3>
  ${issues.length ? `<table><thead><tr><th>#</th><th>标题</th><th>状态</th><th>时间</th></tr></thead><tbody>${issues.map((i) =>
    `<tr><td><a href="${esc(i.url)}">#${i.number}</a></td><td>${esc(i.title)}</td><td><span class="pill ${esc(i.state?.toLowerCase())}">${esc(i.state)}</span></td><td class="small">${esc(fmtTs(i.createdAt))}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">暂无 issue</div>'}
  <h3>Top 簇台账(按 score)</h3>
  <table><thead><tr><th>P级</th><th>score</th><th>source</th><th>pattern</th><th>次数</th><th>状态</th></tr></thead>
  <tbody>${top || '<tr><td colspan="6" class="empty">工作包为空</td></tr>'}</tbody></table>
</section>`;
}

function sectionHealth({ lights, baseline, ledger, anchor }) {
  const lightsHtml = lights.map((l) => `
    <div class="light ${l.color}" title="P0:${l.s0} error:${l.err} warn:${l.warn}">
      <span class="lamp"></span><div class="pname">${esc(l.label)}</div>
      <div class="sub">${l.s0 ? `P0×${l.s0} ` : ''}${l.err ? `err×${l.err} ` : ''}${l.warn ? `warn×${l.warn}` : l.s0 || l.err ? '' : '正常'}</div>
    </div>`).join('');
  const healthSeries = baseline?.healthScore?.value != null
    ? [[{ y: baseline.healthScore.value, t: baseline.generatedAt }]] : [[]];
  const trend = ledger.rows.map((r) => ({ y: Number(r.activeClusters) || 0, t: r.runAt }));
  const trendS0 = ledger.rows.map((r) => ({ y: Number(r.s0) || 0, t: r.runAt }));
  const hygiene = baseline?.categoryCounts
    ? Object.entries(baseline.categoryCounts).map(([k, v]) => `<span class="badge s3">${esc(k)} ${v}</span>`).join(' ')
    : '<span class="empty">无基线</span>';
  return `
<section class="card" id="health">
  <h2>③ 工作仓健康</h2>
  <div class="k">六项核心流程状态灯(24h 窗口,锚定台账最新记录 ${esc(fmtTs(anchor.toISOString()))};红=活跃 P0/静默失败,黄=error 级,绿=无 error——warning 为已降级路径)</div>
  <div class="lights">${lightsHtml}</div>
  <div class="cols2">
    <div><h3>React 健康分${baseline ? ` · 当前 ${baseline.healthScore?.value}` : ''}</h3>
      ${svgLine(healthSeries, { colors: ['#4cc38a'], labels: ['healthScore'] })}
      <div class="sub">${baseline ? `react-doctor ${esc(baseline.toolVersion || '')} · ${esc(fmtTs(baseline.generatedAt))} · ${esc(baseline.gitRef?.sha?.slice(0, 7) || '')}` : '缺 react-baseline.json'}</div></div>
    <div><h3>错误簇趋势(每轮)</h3>
      ${svgLine([trend, trendS0], { labels: ['活跃簇', 'P0'] })}</div>
  </div>
  <h3>代码卫生指标(react-doctor 分类)</h3>
  <div>${hygiene}</div>
</section>`;
}

// ---------- 主流程 ----------
export function buildHtml(ctx) {
  const { now } = ctx;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="300">
<title>Mivo 看板</title>
<style>
:root{color-scheme:dark}
body{background:#101216;color:#d7dae0;font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:0;padding:20px}
a{color:#6cb6ff;text-decoration:none}
h1{font-size:18px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 12px;color:#f0f2f5}
h3{font-size:13px;margin:14px 0 6px;color:#aab0bc}
.meta{color:#7d8590;font-size:12px;margin-bottom:16px}
.card{background:#161a20;border:1px solid #262b33;border-radius:10px;padding:16px;margin-bottom:16px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.cols2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.stat .k,.k{font-size:12px;color:#7d8590}
.stat .v{font-size:20px;font-weight:600;margin-top:2px}
.stat .v.small{font-size:14px}
.sub{font-size:12px;color:#7d8590;margin-top:2px}
.badge{display:inline-block;padding:1px 7px;border-radius:9px;font-size:12px;margin-right:4px;background:#262b33}
.badge.s0{background:#5c1e22;color:#ff8589}.badge.s1{background:#5c4a1e;color:#ffd479}
.badge.s2{background:#1e3a5c;color:#79b8ff}.badge.s3{background:#24292f;color:#9da5b0}
.pill{padding:1px 8px;border-radius:9px;font-size:12px}
.pill.merged{background:#3b2a5c;color:#c9a5ff}.pill.open{background:#1e4429;color:#7ee2a8}
.pill.closed{background:#5c1e22;color:#ff8589}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#7d8590;text-align:left;font-weight:500}
td,th{padding:5px 8px;border-bottom:1px solid #21262d}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.pattern{font-family:ui-monospace,monospace;font-size:12px;color:#aab0bc}
.empty{color:#7d8590;font-size:13px;padding:8px 0}
.warnbar{margin-top:12px;padding:8px 12px;border-radius:8px;background:#5c4a1e;color:#ffd479;font-size:13px}
.squares{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.sq{width:14px;height:14px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center}
.sq.work{background:#2ea55f}.sq.idle{background:#2b313b}.sq.evolve{background:#2b313b;outline:1px solid #3b6cff}
.sq .dot{width:6px;height:6px;border-radius:50%;background:#3b6cff}
.sq-legend{font-size:12px;color:#7d8590;margin-top:6px;display:flex;gap:10px;align-items:center}
.lights{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:10px 0 4px}
.light{background:#12151a;border:1px solid #262b33;border-radius:8px;padding:10px;text-align:center}
.light .lamp{display:inline-block;width:16px;height:16px;border-radius:50%}
.light.red .lamp{background:#e5484d;box-shadow:0 0 8px #e5484d}
.light.yellow .lamp{background:#f5c518;box-shadow:0 0 8px #f5c518}
.light.green .lamp{background:#2ea55f;box-shadow:0 0 6px #2ea55f}
.light .pname{font-size:12px;margin-top:6px}
.chart{width:100%;max-width:560px}
.chart .axis{stroke:#333a45}.chart .tick{fill:#7d8590;font-size:10px}.chart .legend{font-size:11px}
</style></head><body>
<h1>Mivo 看板</h1>
<div class="meta">渲染于 ${esc(fmtTs(now.toISOString()))} · 状态目录 ${esc(ctx.stateDirLabel)} · runCount ${esc(String(ctx.state?.runCount ?? 0))} · fp v${esc(String(ctx.state?.fingerprintVersion ?? '—'))}${ctx.gh.stale ? ' · <b style="color:#ffd479">GH 数据过期</b>' : ' · GH 实时'}</div>
${sectionAgent(ctx)}
${sectionDelivery(ctx)}
${sectionHealth(ctx)}
<script>
(function(){
  function next(){
    var now=new Date(), trains=[[2,30],[13,0]], best=null;
    for (var d=0;d<2;d++) for (var i=0;i<trains.length;i++){
      var t=new Date(now); t.setDate(now.getDate()+d); t.setHours(trains[i][0],trains[i][1],0,0);
      if (t>now && (!best||t<best)) best=t;
    }
    var ms=best-now, h=Math.floor(ms/3600000), m=Math.floor(ms%3600000/60000), s=Math.floor(ms%60000/1000);
    document.getElementById('next-train').textContent=(best.getHours()<10?'0':'')+best.getHours()+':'+(best.getMinutes()<10?'0':'')+best.getMinutes()+(best.getHours()===2?' 主轮':' 补轮');
    document.getElementById('countdown').textContent='倒计时 '+h+'h '+m+'m '+s+'s';
  }
  next(); setInterval(next,1000);
})();
</script>
</body></html>`;
}

export function render(args) {
  const now = args.now || new Date();
  const sd = args.stateDir;
  const state = readJsonSafe(join(sd, 'state.json'));
  const wp = readJsonSafe(join(sd, 'workpacket.json'));
  const baseline = readJsonSafe(join(sd, 'react-baseline.json'));
  const rules = readJsonSafe(join(REPO_ROOT, 'scripts/loops/bug-doctor/rules.json'));
  const runs = parseLogs(readTextSafe(join(sd, 'logs.md')));
  const ledger = parseLedger(readTextSafe(join(sd, 'ledger.csv')));
  const gh = fetchGithub({ enabled: args.gh, cachePath: join(sd, 'dashboard', 'gh-cache.json'), now });

  const act = activeClusters(state);
  const anchor = dataAnchor(act, now);
  const ctx = {
    now, state, wp, baseline, runs, ledger, gh,
    stateDirLabel: sd,
    q: queueCounts(act),
    costTotal: ledger.costTotal,
    lights: computeLights(act, rules, anchor),
    anchor,
  };
  const html = buildHtml(ctx);
  const outDir = join(sd, 'dashboard');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'index.html');
  writeFileSync(outFile, html);
  return { outFile, ctx };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const { outFile, ctx } = render(args);
  const lights = ctx.lights.map((l) => `${l.label}=${l.color}`).join(' ');
  console.log(`[dashboard] rendered ${outFile}`);
  console.log(`[dashboard] queue P0=${ctx.q.S0} P1=${ctx.q.S1} P2=${ctx.q.S2} P3=${ctx.q.S3} · gh=${ctx.gh.stale ? 'stale' : 'fresh'} · lights: ${lights}`);
}
