/**
 * config-schema.js —— 插件配置的 schemastery schema（即宿主侧的 `export const Config`）。
 *
 * 为什么字段要标 `.volatile()`：0.1.7 的 `SettingsForms.describe()` 用 `volatileForm(schema)` 过滤，
 * **没有任何 volatile 字段的条目会被整个跳过**（设置页里什么都不显示）。放置规则：
 * list / inner / dict-key 的子节点不能标 volatile（否则 `validateVolatilePlacement` 抛错）。
 *
 * 为什么布尔/数组以**文本字段**暴露：0.1.7 的字段辅助只有 `settingsTextField` / `settingsNumberField`，
 * 且 `SettingsValueField` 内部是单行 input；文本值由 lib/index.js 的 `sanitize()` 解析成规范值。
 */
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_DENY_MODE,
  DEFAULT_FAIL_MODE,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MIN_ATTEMPT_MS,
  DEFAULT_MODE,
  DEFAULT_PROBE_RUNNER,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_TEXT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_LIMIT,
  DEFAULT_VERIFY_MODE,
  MAX_REVIEW_CONCURRENCY,
  MIN_REVIEW_CONCURRENCY,
} from './config.js'

const dual = (zh, en) => ({ zh, en })

/** 卡片里的表单 schema（字段名 = 配置键名）。 */
export function buildSchema(z) {
  const shape = {
    mode: z
      .union([z.const('observe'), z.const('enforce')])
      .default(DEFAULT_MODE)
      .description(
        dual(
          '观察：只评审记录，照旧弹窗问你；自动批准：评审 allow 直接放行、deny 直接拒绝。⚠️ 只在「介入越界审批」开关打开后才有意义（开关关闭时插件完全零介入）。本项是调试项，配置页默认不显示。',
          'observe: review and log only; enforce: auto-approve on pass. Only meaningful while the "Take over escalations" switch is on (off = no intervention at all). A debugging field, hidden on the config page by default.',
        ),
      ),
    selftestModule: z.string().default('').hidden().description(dual('可选：附加自测模块的绝对路径（本包不含自测用例，必须自己提供，否则只记 selftest-unavailable）', 'Optional absolute path to a self-test module; the package ships none, so without it the run only records selftest-unavailable')),
    selfTest: z
      .boolean()
      .default(false)
      .description(
        dual(
          '打开后，第一次越界会用一批「伪造的待审动作」跑一遍策略自检（绝不执行工具）。需要 selftestModule 指向一个可用模块；调用次数由该模块的用例数决定，没有模块时只记 selftest-unavailable，不影响评审',
          'Run the fabricated-action policy self-test once (no tool is ever executed). Requires selftestModule to point at a usable module; the number of calls follows that module, and without one only selftest-unavailable is recorded — reviews are unaffected',
        ),
      ),
    allowedHosts: z
      .array(z.string())
      .default([])
      .description(
        dual(
          '低风险主机白名单：命中这些主机的常规网络操作按 low 放行（把凭据/隐私发往外部仍按 high 拒绝）',
          'Hosts treated as low risk for ordinary network access',
        ),
      ),
    policyExtra: z
      .string()
      .default('')
      .description(dual('追加到评审策略末尾的自定义规则（自然语言，随便写）', 'Extra policy text appended to the reviewer prompt')),
    provider: z
      .string()
      .default('')
      .description(dual('reviewer 使用的 provider；留空则跟随当前会话', 'Reviewer provider; empty = follow the session')),
    model: z
      .string()
      .default('')
      .description(dual('reviewer 使用的 model；留空则跟随当前会话（可指定更便宜快的模型）', 'Reviewer model; empty = follow the session')),
    reasoningEffort: z
      .string()
      .default('')
      .description(
        dual(
          '评审调用的思考强度；留空＝跟随当前会话/模型默认。可选：off / minimal / low / medium / high / xhigh / max（模型支持哪些档位由该模型决定）',
          'Reasoning effort for the reviewer call; empty = follow the session/model default (off/minimal/low/medium/high/xhigh/max)',
        ),
      ),
    timeoutMs: z
      .number()
      .min(1000)
      .max(300000)
      .step(1000)
      // 单一来源：与 lib/config.js 的 DEFAULT_CONFIG 同一个常量，不给第二个默认值（曾不一致：45000 vs 100000）
      .default(DEFAULT_TIMEOUT_MS)
      .description(dual('单次评审超时（毫秒）；超时按「评审失败」处理', 'Review timeout in ms; a timeout counts as review failure')),
    attemptTimeoutMs: z
      .number()
      .default(DEFAULT_ATTEMPT_TIMEOUT_MS)
      .description(dual('单次请求超时（毫秒）；超时后按 retryDelayMs 重试', 'Per-request timeout (ms); a timeout is retried after retryDelayMs')),
    minAttemptMs: z
      .number()
      .default(DEFAULT_MIN_ATTEMPT_MS)
      .description(dual('最小重试预算（毫秒）：扣掉等待后剩余预算低于此值就不再重试', 'Minimum budget for another attempt (ms): skip the retry when the remaining budget after the delay is below this')),
    retryDelayMs: z
      .number()
      .default(DEFAULT_RETRY_DELAY_MS)
      .description(dual('重试间隔（毫秒）；生产评审与策略自检共用', 'Retry delay (ms); shared by reviews and the policy self-test')),
    reviewConcurrency: z
      .number()
      .min(MIN_REVIEW_CONCURRENCY)
      .max(MAX_REVIEW_CONCURRENCY)
      .step(1)
      .default(DEFAULT_REVIEW_CONCURRENCY)
      .description(
        dual(
          '同时进行的评审上限（1–4，默认 1＝与从前一致、一个接一个）；达到上限时后来的调用排队等待，不丢弃也不越过上限。排队时间会从这次评审的总预算里扣掉',
          'How many reviews may run at once (1–4, default 1 = one after another as before). Beyond the limit, calls queue — nothing is dropped and the limit is never exceeded. Queue time is charged against that review\'s total budget',
        ),
      ),
    verifyMode: z
      .union([z.const('off'), z.const('on'), z.const('auto'), z.const('always')])
      .default(DEFAULT_VERIFY_MODE)
      .description(
        dual(
          '评审时可用只读工具：on=模型可先核实事实再判（默认，正常仍一步给判定）；off=不给工具。auto / always 是旧配置的别名，等价于 on',
          'Read-only tools during review: on = the model may check facts before deciding (default; a one-step verdict stays the norm); off = no tools. auto / always are accepted as aliases for on',
        ),
      ),
    // 规范化值 verifyMode 供 YAML/host config 层用，verifyModeText 是配置页文本形态，由 sanitize() 解析成 verifyMode。
    // ⚠️ 两处都必须可写：设置层写入会对每个路径做 isVolatilePath 校验，schema 里没声明、
    //    或没进 EDITABLE（= 没标 volatile）的键会被拒（"Config field … is not volatile"）。
    verifyModeText: z
      .string()
      .default('')
      .description(dual('评审时只读工具的文本形态：off / on（auto / always 作为别名 → on）', 'Form text for verifyMode: off / on (auto / always alias to on)')),
    probeRunner: z
      .string()
      .default(DEFAULT_PROBE_RUNNER)
      .description(dual('只读探针执行方式：inproc=进程内（默认，不 spawn 进程）| shell=沙箱内只读命令', 'Probe runner: inproc (default, no spawn) | shell (read-only command inside the sandbox)')),
    failMode: z
      .union([z.const('deny'), z.const('ask')])
      .default(DEFAULT_FAIL_MODE)
      .description(dual('评审失败/超时怎么办：deny 直接拒绝（fail-closed）；ask 交回人工', 'On review failure: deny (fail-closed) or ask the user')),
    denyMode: z
      .union([z.const('deny'), z.const('ask')])
      .default(DEFAULT_DENY_MODE)
      .description(dual('评审判定为拒绝怎么办：deny 直接拒绝；ask 交回人工', 'On a deny verdict: refuse outright or ask the user')),
    selfTestText: z
      .string()
      .default('')
      .description(
        dual(
          '策略自检：填 true 会在第一次越界后用一批「伪造动作」跑一遍评审策略（绝不执行工具）；留空表示不改动',
          'Policy self-test: "true" runs the fabricated-action self-test once; blank leaves it unchanged',
        ),
      ),
    allowedHostsText: z
      .string()
      .default('')
      .description(
        dual(
          '低风险主机白名单（逗号或换行分隔）。填了就以它为准；留空表示沿用文件配置里的 allowedHosts',
          'Comma-separated low-risk host allowlist; blank keeps the file configuration',
        ),
      ),
    logPath: z
      .string()
      .default('')
      .hidden()
      .description(dual('评审日志路径；留空用 $DSH_HOME/escalation-review.log', 'Review log path')),
    historyLimit: z.number().min(1).default(DEFAULT_HISTORY_LIMIT).hidden().description(dual('喂给 reviewer 的「用户指令」上限条数', 'Retained-instruction budget')),
    transcriptLimit: z.number().min(1).default(DEFAULT_TRANSCRIPT_LIMIT).hidden().description(dual('喂给 reviewer 的 transcript 事件上限', 'Transcript budget')),
    textLimit: z.number().min(100).default(DEFAULT_TEXT_LIMIT).hidden().description(dual('单条证据文本的截断长度', 'Per-item text limit')),
    // 介入开关：enabled 是规范化布尔（供 YAML / host config 层用，不进 UI）；
    // enabledText 是配置页的文本形态（'true'/'false'），由 sanitize() 解析成 enabled。
    // ⚠️ 这两个键必须**同时**出现在 schema 与 EDITABLE 里：设置层写入会对每个路径做
    //    isVolatilePath 校验，schema 里没有的键必然被拒（"Config field … is not volatile"），
    //    表现为"开关选了但存不下去"。
    enabled: z.boolean().default(false).hidden().description(dual('是否接管沙箱越界审批（规范化布尔）', 'Take over sandbox-escalation approvals (normalized boolean)')),
    enabledText: z.string().default('false').description(dual('介入开关（配置页文本形态：true/false）', 'Take-over switch (form text: true/false)')),
    // 只供客户端决定是否渲染调试项；宿主侧零读取方。文本（配置页）或布尔（用户配置文件）都能写，
    // sanitize 统一归一成内部布尔。
    devMode: z.union([z.string(), z.boolean()]).default('').description(dual('开发者模式：配置页是否显示调试项（运行模式 / 策略自检）。只影响界面，不影响评审', 'Developer mode: whether the config page shows the debugging fields (mode / self-test). Interface only; it never affects a review')),
  }

  // ⚠️ 0.1.7 的 SettingsForms 只把 **`meta.volatile`** 的字段投影成可编辑表单：
  //   volatileForm(schema)：`meta.volatile` 直接整棵通过；否则逐字段过滤，非 volatile 的一律丢掉；
  //   一个都没有 → 整个条目被跳过 → 设置页里什么都不显示（这就是"没有设置界面"的原因）。
  // 放置规则：list/inner/dict-key 的子节点不能标 volatile（会抛 "volatile fields require a fixed
  // object path…"），所以只标这几个顶层字段。
  //
  // 设置页（Plugins 页里的配置页）由**客户端半边**渲染，用的官方控件是
  // `SettingsFormModel` + `settingsTextField` / `settingsNumberField`（只有文本与数字两种）。
  // 因此布尔/数组以**文本字段**暴露，由 lib/index.js 的 sanitize() 解析成规范值。
  const EDITABLE = [
    'enabledText',
    'devMode',
    'mode',
    'selfTestText',
    'allowedHostsText',
    'policyExtra',
    'provider',
    'model',
    'reasoningEffort',
    'timeoutMs',
    'failMode',
    'denyMode',
    'reviewConcurrency',
    'verifyMode',
    'verifyModeText',
    'probeRunner',
    'attemptTimeoutMs',
    'retryDelayMs',
    'minAttemptMs',
  ]
  for (const key of EDITABLE) shape[key] = shape[key].volatile()

  return z.object(shape)
}
