import { debugLogger } from '../store/debugLogStore'

/**
 * 内核模式开关契约（T0.3 建立；双轨契约见 docs/decisions/kernel-dualtrack-contract.md）。
 *
 * 解析 `?kernel=` 查询参数 + `VITE_MIVO_KERNEL` 构建期 env 覆盖，决定运行内核。
 * 与 rendererMode（view 层模块常量）不同：kernel 影响 store 初始化 / persist adapter /
 * 缓存命名空间 / command 出口。本任务只建开关与契约，**不实现 new 路径**——默认 legacy
 * 下所有代码路径与 main 一致，生产零感知。
 *
 * - 默认（无参数 / 非法值 / 非浏览器环境）`legacy`；非法值回退默认并 warn。
 * - `?kernel=new` / `VITE_MIVO_KERNEL=new` 切到新内核（迁移期藏身开关）。
 * - `?kernel=legacy` 显式与缺省等价。
 *
 * 优先级：env(VITE_MIVO_KERNEL) > URL(?kernel=) > 默认 legacy。env 用于 CI/构建期强制
 * kernel 而不污染 URL；URL 用于本地手切。
 *
 * 解析在模块加载时执行一次（kernel 在页面生命周期内不变，与 rendererMode 同构）。
 * `getKernelMode()` 返回该一次性解析结果，供 store 初始化等单点读取。
 */

export type KernelMode = 'new' | 'legacy'

const DEFAULT_MODE: KernelMode = 'legacy'

const VALID_MODES: ReadonlySet<string> = new Set(['new', 'legacy'])

const KERNEL_ENV_KEY = 'VITE_MIVO_KERNEL'

const normalize = (raw: string): string => raw.trim().toLowerCase()

// import.meta.env 经 Vite(vite/client)注入；SSR/纯 Node 不可用时为 undefined。
// 动态索引 env[KERNEL_ENV_KEY] 避免 Vite 构建期静态替换，保证 vi.stubEnv 在单测生效。
const readEnvKernel = (): string | null => {
  const env = import.meta.env as unknown as Record<string, unknown> | undefined
  const raw = env?.[KERNEL_ENV_KEY]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null
}

const resolveKernel = (raw: string, source: 'env' | 'url'): KernelMode => {
  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Kernel', `未知 kernel mode "${raw}"（来源 ${source}），回退默认 ${DEFAULT_MODE}`)
    return DEFAULT_MODE
  }
  if (normalized === 'new') {
    debugLogger.log('Kernel', `new kernel requested（来源 ${source}；双轨契约见 docs/decisions/kernel-dualtrack-contract.md）`)
    return 'new'
  }
  // 显式 legacy 与缺省等价，同记一条身份 log。
  debugLogger.log('Kernel', `kernel identity: legacy (${source} explicit)`)
  return 'legacy'
}

const parseKernelModeFromUrlOrEnv = (): KernelMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    // 非浏览器环境（SSR/单测/Node）→ 默认 legacy，不打身份 log（与 rendererMode 同：
    // 此路径在 module-load 时执行，Node/SSR 无 kernel 场景无需身份日志，且避免污染
    // 未 mock debugLogger 的测试）。
    return DEFAULT_MODE
  }

  // env 覆盖（最高优先级）：CI/构建期通过 VITE_MIVO_KERNEL 强制 kernel，无需 URL。
  const envRaw = readEnvKernel()
  if (envRaw) {
    return resolveKernel(envRaw, 'env')
  }

  const raw = new URLSearchParams(window.location.search).get('kernel')
  if (!raw) {
    // 缺省（无 ?kernel=）启动记一条内核身份 Debug Log，便于运行时确认默认轨。
    debugLogger.log('Kernel', `kernel identity: ${DEFAULT_MODE} (default)`)
    return DEFAULT_MODE
  }

  return resolveKernel(raw, 'url')
}

export const kernelMode: KernelMode = parseKernelModeFromUrlOrEnv()

// T0.3 显式要求的可调用出口：返回一次性解析结果（kernel 在页面生命周期内不变）。
export function getKernelMode(): KernelMode {
  return kernelMode
}

export const isLegacyKernel = kernelMode === 'legacy'
export const isNewKernel = kernelMode === 'new'
