/**
 * @doiiarx/dsh-xget —— xget 加速注入插件（host 级）。
 *
 * 参考 @doiiarx/dsh-shell-plugin 的 shellMiddlewareSlot 与 @doiiarx/dsh-user-language
 * 的 settings 命名空间模式：
 *   - 注册 `xget` settings 命名空间（enabled / instance / npm / pypi / git），
 *     配置在设置页持久化，宿主在每次 shell 执行时按当前配置注入代理环境变量。
 *   - 通过 cmd 插件的 `shellMiddlewareSlot` 注册 middleware（owner = 'xget'，
 *     set 模式同源覆盖 + disposer 自清理，升级不残留旧版本）。
 *   - 注册模型工具 `xget_set`：模型可在 session 级查询/开启/关闭加速。
 *
 * 注入原理：cmd 插件的 bash 工具用 `ctx.subprocess.spawn` 执行命令，middleware
 * 无法改写已冻结的 `args.command`，因此本插件在 middleware 内**替换执行**——
 * 自建 spawn 并把代理环境变量（NPM_CONFIG_REGISTRY / PIP_INDEX_URL /
 * GIT_CONFIG_*）合并进子进程 env，与 scrubbedParentEnv 天然合并。
 *
 * 失败隔离：本文件保持零外部依赖，schemastery 在 apply() 里动态 import，
 * 任何失败降级为诊断日志，不拖垮整个 profile。
 */

export const name = 'pn-xget'
export const inject = ['settings', 'tools', 'shellMiddlewareSlot']

import { defineTool } from '@deepseek-ai/dsh-tools'

const SETTINGS_NS = 'xget'
const DEFAULT_CONFIG = {
  enabled: true,
  instance: 'https://xget.doiiars.com',
  npm: true,
  pypi: true,
  git: true,
  go: true,
  huggingface: true,
}
const OWNER = 'xget'

// git insteadOf 规则：host -> xget 前缀（子域名在前，git 按最长匹配）
// 与 xget 官方 "Git Global Acceleration Configuration" 6 条一致
const GIT_RULES = [
  ['gist.github.com', 'gist'],
  ['github.com', 'gh'],
  ['gitlab.com', 'gl'],
  ['gitea.com', 'gitea'],
  ['codeberg.org', 'codeberg'],
  ['sourceforge.net', 'sf'],
  ['android.googlesource.com', 'aosp'],
  ['huggingface.co', 'hf'],
]

function report(ctx, scope, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const message = `[pn-xget] ${scope} unavailable: ${detail}`
  const logger = ctx.root?.logger?.('pn-xget')
  if (logger?.error) logger.error('%s', message)
  console.error(message)
}

export async function apply(ctx, config = {}) {
  // 1) 注册可持久化的 settings 命名空间（用户在设置页编辑它）。
  let scope = null
  try {
    const { default: Schema } = await import('schemastery')
    const base = { ...DEFAULT_CONFIG, ...config }
    scope = ctx.settings.register(SETTINGS_NS, Schema.object({
      enabled: Schema.boolean().default(base.enabled),
      instance: Schema.string().default(base.instance),
      npm: Schema.boolean().default(base.npm),
      pypi: Schema.boolean().default(base.pypi),
      git: Schema.boolean().default(base.git),
      go: Schema.boolean().default(base.go),
      huggingface: Schema.boolean().default(base.huggingface),
    }), { base })
  } catch (error) {
    report(ctx, 'settings', error)
    scope = null
  }

  const readConfig = () => {
    try {
      if (scope) {
        const value = scope.get()
        if (value && typeof value === 'object') return value
      }
      return ctx.get('settings')?.get(SETTINGS_NS) ?? { ...DEFAULT_CONFIG }
    } catch (error) {
      report(ctx, 'settings-read', error)
      return { ...DEFAULT_CONFIG }
    }
  }

  // session 级覆盖：sessionId -> 是否启用；未记录的 session 跟随全局 config
  const sessionOverrides = new Map()

  // 2) 读取 cmd 插件的 bash 配置（executable / 输出上限 / grace / lang）
  let bashExecutable = undefined
  let bashLang = 'C.UTF-8'
  let maxOutputBytes = 64000
  let maxSpillBytes = 64 * 1024 * 1024
  let graceMs = 3000
  try {
    const shellSettings = ctx.get('settings')?.get('local-shell-tools')
    if (shellSettings && typeof shellSettings === 'object') {
      if (typeof shellSettings.bashExecutable === 'string' && shellSettings.bashExecutable.length > 0) {
        bashExecutable = shellSettings.bashExecutable
      }
      if (typeof shellSettings.bashLang === 'string' && shellSettings.bashLang.length > 0) {
        bashLang = shellSettings.bashLang
      }
      if (typeof shellSettings.maxOutputBytes === 'number') maxOutputBytes = shellSettings.maxOutputBytes
      if (typeof shellSettings.maxSpillBytes === 'number') maxSpillBytes = shellSettings.maxSpillBytes
      if (typeof shellSettings.graceMs === 'number') graceMs = shellSettings.graceMs
    }
  } catch (error) {
    report(ctx, 'shell-settings', error)
  }
  const resolveBash = (configured) => {
    const leaf = configured.split(/[\\/]/).pop().toLowerCase()
    if (leaf === 'git-bash.exe') return configured.replace(/[\\/][^\\/]+$/, '/bin/bash.exe')
    return configured
  }
  const workspaceRoot = ctx.get('sandboxPolicy')?.workspaceRoot

  // 3) 构建代理环境变量
  // skipGit：命令包含 git push 时为 true —— git 的 insteadOf 会同时重写
  // fetch 与 push，导致 push 被劫持到 xget 镜像（自建实例通常无 push 凭据，
  // 会报 401/验证失败）。所以 push 命令不注入 git insteadOf，只加速拉取。
  const buildProxyEnv = (cfg, skipGit = false) => {
    const base = String(cfg.instance ?? DEFAULT_CONFIG.instance).replace(/\/+$/, '')
    const env = {}
    if (cfg.npm !== false) env.NPM_CONFIG_REGISTRY = `${base}/npm/`
    if (cfg.pypi !== false) {
      env.PIP_INDEX_URL = `${base}/pypi/simple/`
      env.PIP_TRUSTED_HOST = base.replace(/^https?:\/\//, '')
    }
    if (cfg.git !== false && !skipGit) {
      env.GIT_CONFIG_COUNT = String(GIT_RULES.length)
      GIT_RULES.forEach(([host, prefix], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = `url.${base}/${prefix}/.insteadOf`
        env[`GIT_CONFIG_VALUE_${index}`] = `https://${host}/`
      })
    }
    // Go modules：GOPROXY 指向 xget 的 golang 前缀（官方推荐格式）；
    // 关闭 checksum 数据库，否则 sum.golang.org 直连会被墙（官方同样如此配置）
    if (cfg.go !== false) {
      env.GOPROXY = `${base}/golang,direct`
      env.GOSUMDB = 'off'
    }
    // Hugging Face：HF_ENDPOINT 指向 xget 的 hf 前缀（官方 HF 镜像配置）
    if (cfg.huggingface !== false) env.HF_ENDPOINT = `${base}/hf`
    return Object.keys(env).length > 0 ? env : undefined
  }

  // 4) middleware：替换执行 bash 命令并注入代理 env
  // inject 声明了 shellMiddlewareSlot，此处直接可用（服务存在才激活插件）
  const slot = ctx.shellMiddlewareSlot
  if (slot !== undefined && typeof slot.use === 'function') {
    const middleware = async (mwCtx, exec, args, next) => {
      try {
        if (exec === undefined || exec.name !== 'bash') return next()
        const cfg = readConfig()
        if (cfg.enabled !== true) return next()
        const sessionId = exec.agent ? exec.agent.session.header.id : undefined
        if (sessionId !== undefined && sessionOverrides.has(sessionId) && sessionOverrides.get(sessionId) !== true) {
          return next()
        }
        // git push 命令跳过 git insteadOf 注入（避免 push 被劫持到镜像）
        // 匹配 "git [全局选项...] push"：独立词 git 后跟长短选项再跟 push 子命令
        const skipGit = /\bgit\b(?:\s+(?:--[a-z0-9-]+(?:=[^\s]*)?|-[A-Za-z](?:\s+[^\s]+)?|\s*))+\s*push\b/.test(args.command)
        const proxyEnv = buildProxyEnv(cfg, skipGit)
        if (proxyEnv === undefined) return next()
        if (bashExecutable === undefined) return next()
        const exe = resolveBash(bashExecutable)
        const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
          ? Math.min(args.timeoutMs, 600000)
          : 120000
        const collect = { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } }
        const workspace = exec.agent ? exec.agent.session.header.cwd : undefined
        let cwd = workspace ?? workspaceRoot
        if (typeof args.workdir === 'string' && args.workdir.length > 0) {
          cwd = args.workdir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(args.workdir)
            ? args.workdir
            : (cwd ? cwd + '/' + args.workdir : args.workdir)
        }
        const env = { LANG: bashLang, LC_ALL: bashLang, ...proxyEnv }
        const timer = mwCtx.get('timer')
        let timedOut = false
        let timeoutDispose = undefined
        const spawnWithTimeout = () => {
          const running = mwCtx.subprocess.spawn({
            argv: [exe, '--noprofile', '--norc', '-lc', args.command],
            cwd: cwd ?? workspaceRoot ?? process.cwd(),
            stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
            graceMs,
            signal: exec.signal,
            env,
          })
          if (timer !== undefined) {
            timeoutDispose = timer.timeout(() => {
              timedOut = true
              running.terminate()
            }, timeoutMs)
          }
          return running
        }
        if (args.run_in_background === true) {
          const jobs = mwCtx.get('jobs')
          if (jobs === undefined) return next()
          const running = spawnWithTimeout()
          const jobId = jobs.start({
            kind: 'bash',
            label: args.command,
            ...exec.agent ? { owner: exec.agent } : {},
            run: () => ({
              cancel: () => { if (timeoutDispose !== undefined) timeoutDispose(); running.terminate() },
              done: running.done.then((outcome) => {
                if (timeoutDispose !== undefined) timeoutDispose()
                running.outcome = outcome
                return outcome.signal !== undefined && outcome.signal !== null
                  ? { status: 'killed', detail: `signal: ${outcome.signal}` }
                  : { status: 'completed', detail: `exit code: ${outcome.exitCode ?? 0}` }
              }),
              readOutput: () => {
                const stdout = running.collected.stdout.readFrom(0).text ?? ''
                const stderr = running.collected.stderr.readFrom(0).text ?? ''
                let text = stdout
                if (stderr.length > 0) {
                  if (text.length > 0 && !text.endsWith('\n')) text += '\n'
                  text += `[stderr]\n${stderr}`
                }
                return text.length === 0 ? '(no output)' : text
              },
            }),
          })
          return { text: `started background job ${jobId}`, outcome: { exitCode: 0 } }
        }
        const running = spawnWithTimeout()
        const outcome = await running.done
        if (timeoutDispose !== undefined) timeoutDispose()
        const stdout = running.collected.stdout.readFrom(0).text ?? ''
        const stderr = running.collected.stderr.readFrom(0).text ?? ''
        let text = stdout
        if (stderr.length > 0) {
          if (text.length > 0 && !text.endsWith('\n')) text += '\n'
          text += `[stderr]\n${stderr}`
        }
        if (timedOut) {
          if (text.length > 0 && !text.endsWith('\n')) text += '\n'
          text += `[timed out after ${timeoutMs}ms]\n`
        }
        if (outcome.exitCode !== 0) {
          if (text.length > 0 && !text.endsWith('\n')) text += '\n'
          text += `[exit code: ${outcome.exitCode ?? 1}]`
        }
        if (text.length === 0) text = '(no output)'
        return { text: text.replace(/\n+$/, ''), outcome }
      } catch (error) {
        report(ctx, 'middleware', error)
        return next()
      }
    }
    // set 模式：同 owner 覆盖旧版；disposer 随插件卸载自动清理
    try {
      const dispose = slot.use(OWNER, middleware)
      if (typeof dispose === 'function') {
        ctx.effect(() => dispose, 'pn-xget: middleware self-cleanup')
      }
    } catch (error) {
      report(ctx, 'middleware-register', error)
    }
  } else {
    report(ctx, 'slot', new Error('shellMiddlewareSlot unavailable (cmd plugin not loaded?)'))
  }

  // 5) 模型工具：session 级查询/开启/关闭
  try {
    ctx.tools.register(defineTool({
      name: 'xget_set',
      description:
        '查询或设置当前会话的 xget 加速状态（session 级覆盖，优先于全局开关，仅影响当前会话）。'
        + '不带参数调用返回当前会话状态；传 enabled=true 启用、enabled=false 关闭。'
        + '全局开关由设置页 Xget 配置控制。',
      parameters: {
        enabled: {
          type: 'boolean',
          description: 'true=当前会话启用 xget 加速；false=当前会话关闭；省略=仅查询。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) {
          return JSON.stringify({ ok: false, error: 'xget_set requires an Agent-backed session' })
        }
        const sessionId = agent.session.header.id
        if (typeof args.enabled === 'boolean') {
          sessionOverrides.set(sessionId, args.enabled)
        }
        const cfg = readConfig()
        const effective = sessionOverrides.has(sessionId)
          ? sessionOverrides.get(sessionId)
          : cfg.enabled === true
        return JSON.stringify({
          ok: true,
          sessionId,
          enabled: effective,
          overridden: sessionOverrides.has(sessionId),
          globalEnabled: cfg.enabled === true,
          instance: cfg.instance,
        })
      },
    }))
  } catch (error) {
    report(ctx, 'xget_set tool', error)
  }

  console.log('[pn-xget] active, instance =', readConfig().instance,
    'enabled =', readConfig().enabled, 'bashExe =', bashExecutable)
  return undefined
}
