/**
 * 客户端半边：把插件配置渲染成「插件」页里的一页。
 *
 * 依据 = 官方文档与官方实现（都已从 asar 抽出核对，见 plugins/_reference/dsh-docs/）：
 *   - `dsh-client-ui-settings/README.md`
 *       · `ctx.configForms.get(entryId)`：该 Host 条目的表单（快照含 value/base/user/revision/writable/mode；
 *         写操作 set/unset/mutate 走共享写队列）
 *       · `ctx.configForms.whileServed(namespaces, register)`：命名空间被 Host 服务时注册，返回 disposer
 *   - `dsh-client-ui-plugin-manager/README.md`
 *       · `plugins.item`：官方插件列表（按 label 进 Official 组）
 *       · `plugins.bundle.config`（key = **bundle 包名**）：显示在 **bundle 详情页**、描述与组件行之间
 *       · `plugins.row.config`（key = `<包名>#<行 id>`）：给该行一个 Configure 入口
 *   - `dsh-client-ui-settings-shell/lib/client.js`：现成范例（官方四页之一）
 *   - `dsh-client-ui-primitives/README.md`：SettingsForm / SettingsValueField / SettingsFormModel +
 *     settingsTextField / settingsNumberField（**只有文本与数字两种字段**）
 *
 * ⚠️ 三条铁律（都踩过）：
 *   1) factory 里必须自己声明 `var module = { exports: {} }; var exports = module.exports;`
 *      —— 否则报 `import failed: exports is not defined`，entry 激活失败、整个 app 起不来（crash 原文）。
 *   2) `exports.inject` 只能写**确定存在**的服务名（0.1.7 实有：slots / locale / configForms）。
 *      写错一个 → entry 永久 pending →「web boot: 1 entry did not activate」。
 *   3) 加载期与 apply 期都不能抛：先给安全默认（空 inject + 空 apply），再用 try 包住实现。
 */
window.__ModuleLoader__.load({
  id: 'dsh-escalation-review',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // 兜底：即使下面任何一步抛错，这个 entry 仍然"可激活且无事发生"，绝不拖垮启动。
    exports.inject = []
    exports.apply = () => {}

    try {
      const React = require('react')
      const createElement = React.createElement
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

      /** 本插件在宿主侧的条目 id —— 同时就是它的设置命名空间。 */
      const ENTRY = 'escalation-review'
      /** 本包（bundle）名 —— `plugins.bundle.config` 的 key。 */
      const BUNDLE = 'dsh-escalation-review'
      /** 字典命名空间（本页面自己的文案）。 */
      const NS = 'settings.escalationReview'
      /** discoverModels 需要一个 settings 命名空间（本插件自己的条目 id 即可）。 */
      const NAMESPACE_FOR_DISCOVERY = 'escalation-review'

      // ── 词典（中英双语）
      const zh = {
        summary: '只审需要越界的调用；其余按沙箱默认走。',
        mode: '运行模式',
        modeHint: '由上面的开关决定是否介入（与权限预设无关）。观察：只评审记录，照旧弹窗问你；自动批准：评审 allow 就直接放行、deny 就直接拒绝，理由回传模型。本项是调试项，默认不显示。',
        enabledText: '介入越界审批',
      enabledTextHint: '打开后接管**所有**沙箱越界调用的审批（与权限预设无关）。关闭 = 零介入、零模型调用。',
      selfTestText: '策略自检',
        selfTestTextHint: '填 true 会在第一次越界后用一批「伪造动作」跑一遍评审策略（绝不执行工具）；留空不改动',
        allowedHostsText: '低风险主机白名单',
        allowedHostsTextHint: '逗号或换行分隔；填了就以它为准，留空沿用文件配置',
        policyExtra: '附加策略',
        policyExtraHint: '追加到评审策略末尾的自定义规则（自然语言）',
        provider: '评审用 provider',
        reviewerModel: '评审用模型',
        reviewerModelHint: '点开可选 provider / model / 思考强度；「跟随会话（留空）」表示三项都不覆盖',
        cellModel: '模型',
        effortDefault: '跟随模型默认',
        effortNeedsModel: '「跟随会话」时不指定档位；先在上面选一个模型，才有具体档位可选',
        paneEffort: '推理等级',
        back: '‹ 返回',
        reasoningEffort: '思考强度',
        model: '评审用 model',
        timeoutMs: '单次命令总超时（毫秒）',
        timeoutMsHint: '整个评审的总预算（含重试）；用完即按「评审失败」处理',
        failMode: '评审失败时',
        failModeHint: 'deny：直接拒绝（fail-closed）；ask：交回人工',
    probeRunner: '只读探针执行方式',
    probeRunnerHint: 'shell：沙箱内只读命令（默认，事实来自动作所在的世界）| inproc：进程内（仅 filesystem 类探针）',
    attemptTimeoutMs: '每一轮超时（毫秒：1 次模型调用 + 该轮工具）',
    retryDelayMs: '重试间隔（毫秒）',
    attemptTimeoutMsHint: '每一轮的上限（1 次模型调用 + 该轮工具）；超时后会按下面的重试间隔再试',
    retryDelayMsHint: '两次尝试之间的等待（生产评审与策略自检共用）',
    minAttemptMs: '最小重试预算（毫秒）',
    minAttemptMsHint: '扣掉等待后剩余预算低于此值就不再重试（避免白打一次注定失败的请求）',
        denyMode: '判为拒绝时',
        denyModeHint: 'deny：直接拒绝；ask：交回人工',
        optVerifyOff: '关闭',
        optVerifyOn: '打开（默认）',
        reviewConcurrency: '并行评审上限',
        reviewConcurrencyHint: '同时进行的评审数（1–4）。默认 1＝与从前一致（一个接一个）；调大后多个越界调用并行评审，超出上限的排队等待（不丢弃、也不越过上限），排队时间会从这次评审的总预算里扣掉。',
        verifyMode: '评审时可用只读工具',
        verifyModeHint: '评审默认一步给判定；缺关键事实时才一次请求多个只读工具（读文件、列目录、看路径类型），最多 4 步 / 3 批 / 8 次。工具只在只读沙箱内执行；read_file 只读本次动作涉及的路径。',
        overridden: '已覆盖',
        reset: '恢复默认',
        autoSaveNote: '改动约 0.4 秒后自动保存、约 2 秒后生效，无需手动保存，也不用重启。',
        optGateOff: '关闭',
        optGateOn: '打开',
        optObserve: '观察',
        optEnforce: '自动批准',
        optProbeInproc: '进程内（默认）',
        optProbeShell: '沙箱内命令',
        followSession: '跟随会话（留空）',
        dropdownUnavailable: '（下拉数据源不可用，已退回手填）',
        loading: '加载中…',
        noOptions: '没有可选项（可直接手填）',
        optDeny: '直接拒绝',
        optAsk: '交回人工',
        readOnly: '本部署的设置为只读。',
        unavailable: '该插件当前未加载，暂时无法配置。',
        save: '保存',
        saveFailed: '本部署没有接受这些值，已保留供你修改。',
        invalidNumber: '请填数字；留空表示使用默认值。',
      }
      const en = {
        autoSaveNote: 'Changes save automatically (about 0.4s) and apply within a couple of seconds — no manual save, no restart.',
        summary: 'Reviews sandbox escalations only; everything else keeps the sandbox default.',
        mode: 'Mode',
        modeHint: 'Only meaningful once the switch above is on (it is independent of any permission preset). Observe: review and log only, you are still asked. Auto-approve: an allow verdict proceeds, a deny verdict refuses and returns the reason to the model. A debugging field, hidden unless devMode is on.',
        enabledText: 'Take over escalations',
      enabledTextHint: 'When on, this plugin answers every sandbox-escalation approval (independent of permission presets). Off = zero intervention, zero model calls.',
      selfTestText: 'Policy self-test',
        selfTestTextHint: 'Set "true" to run the fabricated-action self-test once; blank leaves it unchanged',
        allowedHostsText: 'Low-risk host allowlist',
        allowedHostsTextHint: 'Comma or newline separated; blank keeps the file configuration',
        policyExtra: 'Extra policy',
        policyExtraHint: 'Free-form rules appended to the reviewer policy',
        provider: 'Reviewer provider',
        reviewerModel: 'Reviewer model',
        reviewerModelHint: 'Opens a picker for provider / model / reasoning effort; "Follow the session" leaves all three unset',
        cellModel: 'Model',
        effortDefault: 'Model default',
        effortNeedsModel: 'While following the session no explicit reasoning level applies; pick a model first to choose one',
        paneEffort: 'Reasoning effort',
        back: '‹ Back',
        reasoningEffort: 'Reasoning effort',
        model: 'Reviewer model',
        timeoutMs: 'Total timeout for one command (ms)',
        timeoutMsHint: 'Overall budget for one review (retries included); exhausting it counts as review failure',
        attemptTimeoutMs: 'Per-round timeout (ms: one model call plus that round\'s tools)',
        attemptTimeoutMsHint: 'Cap for one round (one model call plus that round\'s tools); a timeout retries after the delay below',
        retryDelayMs: 'Retry delay (ms)',
        retryDelayMsHint: 'Wait between attempts (shared by reviews and the policy self-test)',
        minAttemptMs: 'Minimum retry budget (ms)',
        minAttemptMsHint: 'Skip the retry when the remaining budget after the delay is below this (avoids a doomed request)',
        probeRunner: 'Probe runner',
        probeRunnerHint: 'shell: a read-only command in the pending action world (default) | inproc: filesystem-class probes only',
        failMode: 'On review failure',
        failModeHint: 'deny: refuse (fail-closed); ask: hand back to the user',
        denyMode: 'On a deny verdict',
        denyModeHint: 'deny: refuse outright; ask: hand back to the user',
        reviewConcurrency: 'Reviews at once',
        reviewConcurrencyHint: 'How many reviews may run at once (1–4). Default 1 keeps the old one-after-another behaviour; above it, escalations review in parallel and calls beyond the limit queue (nothing is dropped, the limit is never exceeded). Queue time is charged against that review\'s total budget.',
        verifyMode: 'Read-only tools during review',
        verifyModeHint: 'A review normally decides in one step; only when a key fact is missing does it ask for several read-only tools at once (read a file, list a directory, stat a path) — at most 4 steps / 3 batches / 8 calls. Tools run only inside the read-only sandbox, and read_file is limited to paths this action names.',
        overridden: 'Overridden',
        reset: 'Reset to default',
        optGateOff: 'Off',
        optGateOn: 'On',
        optObserve: 'Observe',
        optEnforce: 'Auto-approve',
        followSession: 'Follow the session (empty)',
        dropdownUnavailable: ' (model list unavailable — typing instead)',
        loading: 'Loading…',
        noOptions: 'No choices available (type it instead)',
        optDeny: 'Deny',
    optProbeInproc: 'In-process',
    optProbeShell: 'Sandboxed command',
        optAsk: 'Ask the user',
        optVerifyOff: 'Off',
        optVerifyOn: 'On (default)',
        readOnly: 'This deployment stores settings read-only.',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        save: 'Save',
        saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
        invalidNumber: 'Enter a number, or leave blank to use the default.',
      }

      /**
       * 字段 → 控件形态。
       * 官方的字段辅助只有 `settingsTextField` / `settingsNumberField`，且 `SettingsValueField`
       * 内部就是单行 `<input>`（不支持多行），所以：
       *   · 互斥选择（观察/强制、拒绝/交回人工）→ `SegmentedControl`（官方 Models 页 همین 用它）
       *   · 布尔（自检）→ `Switch`
       *   · 长文本（附加策略、主机白名单）→ 自写多行框，视觉与官方字段框一致
       *   · 其余 → `SettingsValueField`（文本 / 数字）
       * 暂存值仍走同一个 `SettingsFormModel`（文本/数字字段），控件只负责把选中值 `edit()` 进去。
       */
      const FIELDS = [
        // 总开关置顶：它是这张卡上唯一决定"插件介不介入"的字段
        {
          key: 'enabledText',
          kind: 'segment',
          prominent: true,
          fallback: 'false',
          options: [
            { value: 'false', label: 'optGateOff' },
            { value: 'true', label: 'optGateOn' },
          ],
        },
        // ── 最常动的一项：用哪个模型评审
        // ── 最常动的两项：用哪个模型评审、给评审追加什么策略
        // provider / model / 思考强度 合成一个选择按钮（ModelPicker，内部写三个配置键）
        { key: 'reviewerModel', kind: 'reviewerModel' },
        // ── 并行评审上限（用户可见的技术项）：默认 1 = 与从前一致（一个接一个）
        { key: 'reviewConcurrency', kind: 'number', numeric: true },
        // ── 评审时的只读工具（可见）：默认打开；关掉后 prompt 里不含工具协议
        {
          key: 'verifyMode',
          kind: 'segment',
          fallback: 'on',
          options: [
            { value: 'off', label: 'optVerifyOff' },
            { value: 'on', label: 'optVerifyOn' },
          ],
        },
        // ── 处置口径：评审失败/超时怎么办、政策判定拒绝怎么办
        // ── 处置口径：评审失败/超时怎么办、政策判定拒绝怎么办
        {
          key: 'failMode',
          kind: 'segment',
          fallback: 'deny',
          options: [
            { value: 'deny', label: 'optDeny' },
            { value: 'ask', label: 'optAsk' },
          ],
        },
        {
          key: 'denyMode',
          kind: 'segment',
          fallback: 'deny',
          options: [
            { value: 'deny', label: 'optDeny' },
            { value: 'ask', label: 'optAsk' },
          ],
        },
        // ── 技术项：只读探针在哪儿跑（默认进程内）
        // ── 只读探针的执行方式（技术项，默认进程内）
        {
          key: 'probeRunner',
          kind: 'segment',
          fallback: 'shell',
          options: [
            { value: 'inproc', label: 'optProbeInproc' },
            { value: 'shell', label: 'optProbeShell' },
          ],
        },
        // ── 评审策略：附加规则 + 低风险主机白名单
        { key: 'policyExtra', kind: 'textarea', rows: 6 },
        { key: 'allowedHostsText', kind: 'textarea', rows: 4 },
        // ── 超时与重试（默认值一般够用）
        // ── 超时与重试（默认值一般够用）
        { key: 'timeoutMs', kind: 'number', numeric: true },
        { key: 'attemptTimeoutMs', kind: 'number', numeric: true },
        { key: 'retryDelayMs', kind: 'number', numeric: true },
        { key: 'minAttemptMs', kind: 'number', numeric: true },
        // ── 调试项（advanced）：默认不渲染，配置里写 devMode=true 才显示
        {
          key: 'mode',
          kind: 'segment',
          advanced: true,
          fallback: 'enforce',
          options: [
            { value: 'observe', label: 'optObserve' },
            { value: 'enforce', label: 'optEnforce' },
          ],
        },
        { key: 'selfTestText', kind: 'switch', advanced: true },
      ]

      /** 渲染一页：summary 视图给一行说明，否则给完整表单。 */
      /** 自写控件用的行内样式（与官方字段框的视觉语言对齐：小号标签、淡色提示、淡色徽标）。 */
      // ── 内联样式
      const styles = {
        field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0 14px' },
        fieldFirst: { display: 'flex', flexDirection: 'column', gap: 6, padding: '0 0 14px' },
        divider: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.22))' },
        masterCard: {
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28))',
          borderRadius: 10,
          padding: '12px 14px 14px',
          background: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.06))',
        },
        labelStrong: { fontSize: 14, fontWeight: 600 },
        head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
        label: { fontSize: 13, fontWeight: 500 },
        hint: { margin: 0, fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
        badges: { display: 'inline-flex', alignItems: 'center', gap: 8 },
        badge: {
          fontSize: 11,
          padding: '1px 6px',
          borderRadius: 999,
          border: '1px solid currentColor',
          opacity: 0.7,
        },
        reset: {
          fontSize: 12,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'inherit',
          textDecoration: 'underline',
          opacity: 0.8,
        },
        textarea: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid currentColor',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 13,
          lineHeight: 1.6,
          resize: 'vertical',
        },
        form: { display: 'flex', flexDirection: 'column' },
        hintNote: { margin: '0 0 10px', fontSize: 12, lineHeight: '18px', opacity: 0.7 },
        notice: {
          margin: '0 0 12px',
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid #e5484d',
          background: 'rgba(229, 72, 77, 0.08)',
          color: '#e5484d',
          fontSize: 12.5,
          lineHeight: 1.6,
        },
      }

      /** 自写控件的字段框：标签 + 已覆盖徽标 + 恢复默认 + 控件 + 提示。 */
      /**
       * 表单**管理**的字段 = 界面渲染字段（去掉合并后的 reviewerModel 行）+ 被合并进去的三个真实键。
       * ⚠️ SettingsFormModel 只认 spec 里声明的字段：漏掉谁，edit('谁', …) 就会抛
       *   "plugin card has no field 谁"，同时 dirty 不会置上、保存按钮不亮（本次踩的坑）。
       */
      const FORM_FIELDS = [
        ...FIELDS.filter((field) => field.kind !== 'reviewerModel'),
        { key: 'provider', kind: 'text' },
        { key: 'model', kind: 'text' },
        { key: 'reasoningEffort', kind: 'text' },
        // devMode：只进表单清单、不进渲染清单。用户在自己的配置文件里写 "devMode": true
        // 就能看到调试项（mode / selfTestText）；普通用户看不到。
        { key: 'devMode', kind: 'text' },
      ]

      /**
       * 安全的 useRef：真实 React 一定有 useRef；取不到时退化为普通对象。
       * 工厂作用域只判断一次，不涉及 hooks 规则问题。
       */
      const useRefSafe = (initial) => (typeof React.useRef === 'function' ? React.useRef(initial) : { current: initial })

      // ── 字段容器
      function FieldShell(props) {
        const shellStyle = props.prominent
          ? { ...(props.first ? styles.fieldFirst : styles.field), ...styles.masterCard }
          : { ...(props.first ? styles.fieldFirst : styles.field), ...(props.first ? {} : styles.divider) }
        return createElement('div', { style: shellStyle }, [
          createElement('div', { key: 'head', style: styles.head }, [
            createElement('label', { key: 'label', htmlFor: props.id, style: props.prominent ? styles.labelStrong : styles.label }, props.label),
            props.overridden
              ? createElement('span', { key: 'badges', style: styles.badges }, [
                  createElement('span', { key: 'badge', style: styles.badge }, props.overriddenLabel),
                  createElement(
                    'button',
                    { key: 'reset', type: 'button', style: styles.reset, disabled: props.disabled, onClick: props.onReset },
                    props.resetLabel,
                  ),
                ])
              : null,
          ]),
          createElement('div', { key: 'control' }, props.children),
          props.hint === undefined ? null : createElement('p', { key: 'hint', style: styles.hint }, props.hint),
        ])
      }

      /** 样式：逐条照抄官方 ModelSelect.module.css（同一个哈希模块的规则与主题变量）。 */
      const CHOICE_STYLE_ID = 'dsh-escalation-review-choice-style'
      const ensureStyle = () => {
        try {
          const doc = globalThis.document
          if (doc === undefined || typeof doc.createElement !== 'function') return
          if (typeof doc.querySelector === 'function' && doc.querySelector('style[data-plugin-css="dsh-escalation-review"]') !== null) return
          const tag = doc.createElement('style')
          tag.dataset.plugin = 'dsh-escalation-review'
          tag.dataset.pluginCss = CHOICE_STYLE_ID
          tag.textContent = [
            // 触发器按"设置表单控件"来（与同页的 Switch / 分段控件同一套 token），
            // 不再用 Composer 工具栏那套透明小尺寸样式（放表单里看不出是下拉 ✗）
            '.er-root{min-width:0;width:100%;position:relative}',
            '.er-trigger{box-sizing:border-box;width:auto;min-width:220px;max-width:100%;min-height:36px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer;outline:none;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;display:flex}',
            '.er-trigger:hover:not(:disabled){border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover)}',
            '.er-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
            '.er-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
            '.er-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
            '.er-triggerEffort{color:var(--dsw-alias-label-caption);flex:none}',
            '.er-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}',
            '.er-chevronOpen{transform:rotate(180deg)}',
            '.er-menu{--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);color:var(--dsw-alias-label-primary);border:0;flex-direction:column;padding:4px;display:flex;overflow:hidden}',
            '.er-status{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}',
            '.er-groups{min-height:0;overflow-y:auto}',
            '.er-group+.er-group{margin-top:3px}',
            '.er-groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:4px 7px 2px;font-size:11px;font-weight:500;line-height:16px;position:sticky;top:0}',
            '.er-option{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;display:flex}',
            '.er-option:hover:not(:disabled),.er-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
            '.er-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
            '.er-optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}',
            '.er-modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:18px;overflow:hidden}',
            '.er-check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}',
            '.er-cell{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;align-items:center;gap:6px;padding:0 8px;font-size:13px;line-height:20px;display:flex}',
            '.er-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.er-cellLabel{white-space:nowrap;flex:none}',
            '.er-cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}',
          ].join('')
          doc.head.appendChild(tag)
        } catch {
          /* 宿主环境可能没有 document */
        }
      }

      /**
       * 评审模型选择器：**两层菜单**，完全照官方 Composer 那个选择器。
       *   第一层：模型 ›   推理等级 ›（各带当前值）
       *   第二层：模型列表（provider 分组标题 + 模型行 + 勾）/ 推理等级列表（+ 勾），顶部有返回行
       * 外层用官方 `Menu`（锚定/portal/定位/键盘），行样式照抄官方 ModelSelect 的类规则。
       */
      /**
       * 评审模型选择器：全部走官方 `Menu` 的**数据行 API**（items/selectedId/onSelect）。
       * 之前自己写行 → 点击无效（Menu 在 pointerdown/mousedown 阶段就把浮层关了，行在 click 前被卸载 ✗）；
       * 现在点击完全由 Menu 派发，稳。
       * 层级：root（模型 › / 推理等级 › / 跟随会话）→ providers → models → efforts。
       * 档位：选了模型就用该模型的档位；没选模型则用所有模型档位的**并集**（否则这里是空的 ✗）。
       */
      /**
       * 评审模型选择器：**照官方 ModelSelect 的做法**。
       *   · 浮层只有 MenuSurface；位置自己给（绝对定位挂在相对容器下）
       *   · 行是普通 <button role="menuitem"> + onClick（官方同款）
       *   · document 上监听 **click 冒泡**，用 closest('.er-root,.er-menu,.er-trigger') 判内外：
       *     MenuSurface 可能把内容 portal 到 body（ref.contains 会失效 ✗），而 pointerdown 阶段关闭会
       *     在行收到 click 之前就卸载它 ✗ —— 这两点合起来曾让"菜单行永远点不动"
       * 两层：root（模型 › / 推理等级 › / 跟随会话）→ providers → models（分组标题）→ efforts。
       */
      // ── 官方 MenuSurface 选择器：provider / model / 思考强度
      function ModelPicker(props) {
        const tr = typeof props.t === 'function' ? props.t : (key) => key
        const [open, setOpen] = React.useState(false)
        const [pane, setPane] = React.useState('root')
        const [paneProvider, setPaneProvider] = React.useState('')
        const [groups, setGroups] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const rootRef = useRefSafe(null)
        const panelRef = useRefSafe(null)
        const catalog = props.catalog
        const provider = typeof props.provider === 'string' ? props.provider : ''
        const model = typeof props.model === 'string' ? props.model : ''
        const effort = typeof props.effort === 'string' ? props.effort : ''

        // 外面点击才关闭，且**只在 click 冒泡阶段**判定：
        //   · 行的 onClick 先执行 → 不可能被"提前关闭"吞掉（pointerdown 阶段关就会吞掉 ✗）
        //   · 内外判定用 closest(...) 而不是 ref.contains(...) → MenuSurface 走 portal 也成立
        React.useEffect(() => {
          if (!open) return undefined
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onDocumentClick = (event) => {
            const target = event?.target
            // 行/触发器都是本插件自己的元素（data-er 标记在行上、.er-trigger 在触发器上），
            // 不依赖 MenuSurface 是否转发 className/ref（它走 portal，class 可能丢 ✗）
            const canClosest = target !== null && target !== undefined && typeof target.closest === 'function'
            const inside = !canClosest || target.closest('[data-er="1"], .er-trigger, .er-menu, .er-root') !== null
            if (inside) return
            setOpen(false)
          }
          document.addEventListener('click', onDocumentClick)
          return () => document.removeEventListener('click', onDocumentClick)
        }, [open])

        const load = () => {
          if (catalog === undefined || catalog === null) return
          setBusy(true)
          // 有的数据源只有 listProviders/listModels（remote.llm 那一路）→ 自建分组，
          // 否则「模型 ›」进去是空的（"没有新项目" 就是这个 ✗）
          const all =
            typeof catalog.listAllModels === 'function'
              ? catalog.listAllModels()
              : Promise.resolve()
                  .then(() => (typeof catalog.listProviders === 'function' ? catalog.listProviders() : []))
                  .then(async (providers) => {
                    const groups = []
                    for (const item of Array.isArray(providers) ? providers : []) {
                      let models = []
                      try {
                        models = typeof catalog.listModels === 'function' ? await catalog.listModels(String(item.value)) : []
                      } catch {
                        models = []
                      }
                      groups.push({
                        provider: String(item.value),
                        label: String(item.label ?? item.value),
                        models: (Array.isArray(models) ? models : []).map((entry) => ({
                          value: String(entry.value),
                          label: String(entry.label ?? entry.value),
                          efforts: [],
                        })),
                      })
                    }
                    return groups
                  })
          Promise.resolve(all)
            .then((list) => setGroups(Array.isArray(list) ? list : []))
            .catch(() => setGroups([]))
            .finally(() => setBusy(false))
        }
        const toggle = () => {
          if (open) {
            setOpen(false)
            return
          }
          setOpen(true)
          setPane('root')
          if (groups === null) load()
        }
        const choose = (patch) => {
          // ⚠️ 写回可能抛（那就只写了前几个字段、并且菜单因为没走到 setOpen 而不关闭 ✗）
          // 所以：整体 try/finally —— 无论成败，菜单一定收起；失败原因交给上面的 writeField 探针记录。
          const nextProvider = patch.provider === undefined ? provider : patch.provider
          const nextModel = patch.model === undefined ? model : patch.model
          // 「跟随会话」不该带具体档位（语义矛盾 ✗）→ 只要 provider/model 都空，就强制清空 effort
          const nextEffort = nextProvider === '' && nextModel === '' ? '' : patch.effort === undefined ? effort : patch.effort
          try {
            props.onPick({ provider: nextProvider, model: nextModel, effort: nextEffort })
          } catch {
            /* 写回失败由 writeField 的调用方与表单提示负责 */
          } finally {
            setOpen(false)
          }
        }

        const list = groups ?? []
        const currentGroup = list.find((group) => String(group.provider) === provider)
        const currentModel = (Array.isArray(currentGroup?.models) ? currentGroup.models : []).find(
          (entry) => String(entry.value) === model,
        )
        const modelLabel = String(currentModel?.label ?? model)
        const levels = (() => {
          const source =
            model !== '' && Array.isArray(currentModel?.efforts) && currentModel.efforts.length > 0
              ? currentModel.efforts
              : list.flatMap((group) =>
                  (Array.isArray(group.models) ? group.models : []).flatMap((entry) => (Array.isArray(entry.efforts) ? entry.efforts : [])),
                )
          const seen = new Set()
          return source.filter((level) => {
            const id = String(level?.value ?? '')
            if (id === '' || seen.has(id)) return false
            seen.add(id)
            return true
          })
        })()
        const effortLabel = (() => {
          const found = levels.find((level) => String(level.value) === effort)
          return found === undefined ? effort : String(found.label ?? effort)
        })()

        const cell = (key, label, value, onClick) =>
          createElement('button', {
            key,
            type: 'button',
            role: 'menuitem',
            className: 'er-cell',
            'data-er': '1',
            onClick,
          }, [
            createElement('span', { key: 'label', className: 'er-cellLabel' }, label),
            createElement('span', { key: 'value', className: 'er-cellValue' }, value),
            createElement(
              'span',
              { key: 'chevron', className: 'er-chevron' },
              primitives.IconChevronRightOutlineRegular !== undefined && primitives.IconChevronRightOutlineRegular !== null
                ? createElement(primitives.IconChevronRightOutlineRegular, { size: 12 })
                : '›',
            ),
          ])
        const option = (key, label, selected, onClick) =>
          createElement('button', {
            key,
            type: 'button',
            role: 'menuitem',
            className: 'er-option',
            'data-er': '1',
            onClick,
          }, [
            createElement('span', { key: 'name', className: 'er-modelName' }, label),
            selected && primitives.IconCheckOutlineRegular !== undefined && primitives.IconCheckOutlineRegular !== null
              ? createElement('span', { key: 'check', className: 'er-check' }, createElement(primitives.IconCheckOutlineRegular, { size: 14 }))
              : null,
          ])
        const groupTitle = (key, label) => createElement('div', { key, className: 'er-groupTitle' }, label)

        let body
        if (pane === 'root') {
          body = [
            cell('__model__', tr('cellModel'), model === '' ? tr('followSession') : modelLabel, () => {
              setPane('providers')
              if (groups === null) load()
            }),
            cell('__effort__', tr('paneEffort'), effort === '' ? tr('effortDefault') : effortLabel, () => setPane('efforts')),
            option('__follow__', tr('followSession'), provider === '' && model === '' && effort === '', () =>
              choose({ provider: '', model: '', effort: '' }),
            ),
          ]
        } else if (pane === 'providers') {
          body = [
            option('__back__', tr('back'), false, () => setPane('root')),
            busy ? createElement('div', { key: '__busy__', className: 'er-status' }, tr('loading')) : null,
            !busy && list.length === 0 ? createElement('div', { key: '__empty__', className: 'er-status' }, tr('noOptions')) : null,
            createElement(
              'div',
              { key: '__groups__', className: 'er-groups' },
              list.map((group) =>
                createElement('div', { key: 'g:' + String(group.provider), className: 'er-group' }, [
                  groupTitle('t:' + String(group.provider), String(group.label ?? group.provider)),
                  ...(Array.isArray(group.models) ? group.models : []).map((entry) =>
                    option(
                      'm:' + String(group.provider) + ':' + String(entry.value),
                      String(entry.label ?? entry.value),
                      String(entry.value) === model && String(group.provider) === provider,
                      () => choose({ provider: String(group.provider), model: String(entry.value), effort: '' }),
                    ),
                  ),
                ]),
              ),
            ),
          ]
        } else {
          const followingSession = provider === '' && model === ''
          body = [
            option('__back__', tr('back'), false, () => setPane('root')),
            option('__default__', tr('effortDefault'), effort === '', () => choose({ effort: '' })),
            followingSession
              ? createElement('div', { key: '__need_model__', className: 'er-status' }, tr('effortNeedsModel'))
              : null,
            followingSession
              ? null
              : busy
                ? createElement('div', { key: '__busy__', className: 'er-status' }, tr('loading'))
                : null,
            ...(followingSession
              ? []
              : levels.map((level) =>
                  option('e:' + String(level.value), String(level.label ?? level.value), String(level.value) === effort, () =>
                    choose({ effort: String(level.value) }),
                  ),
                )),
          ]
        }

        const trigger = createElement(
          'button',
          { type: 'button', className: 'er-trigger', 'data-er': '1', disabled: props.disabled, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: toggle },
          [
            createElement(
              'span',
              { key: 'label', className: 'er-triggerLabel' },
              provider === '' && model === '' ? tr('followSession') : modelLabel,
            ),
            effort === '' ? null : createElement('span', { key: 'effort', className: 'er-triggerEffort' }, effortLabel),
            primitives.IconChevronDownOutlineRegular !== undefined && primitives.IconChevronDownOutlineRegular !== null
              ? createElement(primitives.IconChevronDownOutlineRegular, {
                  key: 'chevron',
                  className: open ? 'er-chevron er-chevronOpen' : 'er-chevron',
                })
              : null,
          ],
        )
        const surface =
          primitives.MenuSurface !== undefined && primitives.MenuSurface !== null
            ? createElement(
                primitives.MenuSurface,
                {
                  ref: panelRef,
                  className: 'er-menu',
                  role: 'menu',
                  style: { position: 'absolute', top: '100%', left: 0, zIndex: 1100 },
                },
                body,
              )
            : createElement(
                'div',
                {
                  ref: panelRef,
                  className: 'er-menu',
                  role: 'menu',
                  style: { position: 'absolute', top: '100%', left: 0, zIndex: 1100, background: 'Canvas' },
                },
                body,
              )

        return createElement(
          FieldShell,
          {
            id: props.id,
            label: props.label,
            hint: props.hint,
            overridden: props.overridden === true,
            overriddenLabel: tr('overridden'),
            resetLabel: tr('reset'),
            disabled: props.disabled,
            onReset: props.onReset,
          },
          createElement('div', { ref: rootRef, className: 'er-root' }, [trigger, open ? surface : null]),
        )
      }

      /** 下拉数据源的诊断轨迹（显示在字段说明里，便于一次定位）。 */
      /**
       * 模型目录（provider / model 下拉的数据源）。
       *
       * ⚠️ 教训：数据源是**异步**到手的（作用域注入回调、catalog.load()），而 Card 首次渲染时若
       * catalog 仍是 undefined 就会把字段渲染成输入框，之后数据到了**不会自动重渲染** ✗
       * → 用户永远看到输入框。所以：写入即通知订阅者，且 Card 挂载时再 ensureCatalog() 一次。
       */
      let pluginCtx = null
      let activeStore = null
      /** `configForms.get(ENTRY)` 的快照作用域：卡片用它读"总开关当前是否开着"（`value.enabled`）。 */
      let activeScope = null
      const catalogDiag = []
      const catalogListeners = new Set()
      /** 诊断已收敛为空实现（保留调用点，避免大面积改动带来行为风险）。 */
      const diag = () => {}
      const notifyCatalog = () => {
        for (const listener of [...catalogListeners]) {
          try {
            listener()
          } catch {
            /* 订阅者出错不影响其它订阅者 */
          }
        }
      }
      const subscribeCatalog = (listener) => {
        catalogListeners.add(listener)
        return () => catalogListeners.delete(listener)
      }
      const setCatalog = (catalog) => {
        if (activeStore === null) return
        activeStore.catalog = catalog
        notifyCatalog()
      }
      let catalogRequested = false

      /**
       * 安全取服务。⚠️ cordis 里访问**未声明**的服务属性会**抛异常**
       *（实测：cannot get property "remote" without inject），所以：
       * 先试 get()（不存在时返回 undefined），再退化到属性访问；两次都各自 try。
       */
      const readService = (holder, name) => {
        if (holder === undefined || holder === null) return undefined
        try {
          if (typeof holder.get === 'function') {
            const viaGet = holder.get(name)
            if (viaGet !== undefined && viaGet !== null) return viaGet
          }
        } catch {
          /* get 也可能抛（服务不可用） */
        }
        try {
          return name
            .split('.')
            .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), holder)
        } catch {
          return undefined
        }
      }

      /** 官方菜单的 provider 排序：deepseek-account → deepseek-official → 其余按 id。 */
      const orderProviderGroups = (groups) => {
        const priority = { 'deepseek-account': 0, 'deepseek-official': 1 }
        return [...groups].sort((left, right) => {
          const a = priority[String(left?.id ?? '')] ?? 2
          const b = priority[String(right?.id ?? '')] ?? 2
          if (a !== b) return a - b
          return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
        })
      }

      /** 数据源 ①：官方模型目录（modelDirectories.catalog），形状与 Composer 菜单一致。 */
      const adoptCatalogFromDirectories = (service) => {
        const catalog = service === undefined || service === null ? undefined : service.catalog
        if (catalog === undefined || catalog === null || typeof catalog.store?.getSnapshot !== 'function') return false
        const readGroups = async () => {
          let value = catalog.store.getSnapshot()?.value
          if (value === undefined || !Array.isArray(value?.groups)) {
            try {
              await catalog.load()
            } catch (error) {
              diag('catalog.load 失败: ' + String(error?.message ?? error))
            }
            value = catalog.store.getSnapshot()?.value
          }
          return orderProviderGroups(Array.isArray(value?.groups) ? value.groups : [])
        }
        setCatalog({
          listProviders: async () =>
            (await readGroups()).map((group) => ({
              value: String(group?.id ?? ''),
              label: String(group?.name ?? group?.id ?? ''),
            })),
          listModels: async (provider) => {
            if (provider === '') return []
            const group = (await readGroups()).find((item) => String(item?.id ?? '') === provider)
            const models = Array.isArray(group?.models) ? group.models : []
            return models
              .map((model) => ({ value: String(model?.id ?? ''), label: String(model?.name ?? model?.id ?? '') }))
              .filter((item) => item.value !== '')
          },
          /** 思考强度档位来自模型自带的元数据：model.reasoning.efforts = [{ id, name }] */
          listEfforts: async (provider, model) => {
            if (provider === '' || model === '') return []
            const group = (await readGroups()).find((item) => String(item?.id ?? '') === provider)
            const found = (Array.isArray(group?.models) ? group.models : []).find((item) => String(item?.id ?? '') === model)
            const efforts = Array.isArray(found?.reasoning?.efforts) ? found.reasoning.efforts : []
            return efforts
              .map((effort) => ({ value: String(effort?.id ?? ''), label: String(effort?.name ?? effort?.id ?? '') }))
              .filter((item) => item.value !== '')
          },
          /** 一次返回所有分组与组内模型（同一份快照，避免逐 provider 往返）。 */
          listAllModels: async () =>
            (await readGroups()).map((group) => ({
              provider: String(group?.id ?? ''),
              label: String(group?.name ?? group?.id ?? ''),
              models: (Array.isArray(group?.models) ? group.models : [])
                .map((item) => ({
                  value: String(item?.id ?? ''),
                  label: String(item?.name ?? item?.id ?? ''),
                  // 档位元数据随模型一起带出来（选模型后推理等级用它；没选模型时取并集）
                  efforts: (Array.isArray(item?.reasoning?.efforts) ? item.reasoning.efforts : [])
                    .map((level) => ({ value: String(level?.id ?? ''), label: String(level?.name ?? level?.id ?? '') }))
                    .filter((level) => level.value !== ''),
                }))
                .filter((item) => item.value !== ''),
            })),
        })
        return true
      }

      /** 数据源 ②（兜底）：remote.llm 的 listProviders / discoverModels。 */
      const adoptCatalogFromRemote = (llmRemote) => {
        if (llmRemote === undefined || llmRemote === null) return false
        try {
          setCatalog({
            listProviders: async () => {
              const rawList = await llmRemote.listProviders()
              const list =
                rawList !== null && typeof rawList === 'object' && rawList.ok === false ? [] : (rawList?.value ?? rawList)
              return (Array.isArray(list) ? list : []).map((item) => ({
                value: String(item?.id ?? ''),
                label: String(item?.name ?? item?.id ?? ''),
              }))
            },
            listModels: async (provider) => {
              if (provider === '') return []
              const rawResult = await llmRemote.discoverModels(NAMESPACE_FOR_DISCOVERY, { provider })
              const result =
                rawResult !== null && typeof rawResult === 'object' && rawResult.ok === false
                  ? undefined
                  : (rawResult?.value ?? rawResult)
              const models = Array.isArray(result?.models) ? result.models : Array.isArray(result) ? result : []
              return models
                .map((item) =>
                  typeof item === 'string'
                    ? { value: item, label: item }
                    : {
                        value: String(item?.id ?? item?.model ?? ''),
                        label: String(item?.name ?? item?.id ?? item?.model ?? ''),
                      },
                )
                .filter((item) => item.value !== '')
            },
          })
          return true
        } catch (error) {
          diag('构建 remote.llm 目录失败: ' + String(error?.message ?? error))
          return false
        }
      }

      /**
       * 确保有数据源：先用 ctx 上现成的，再注册作用域注入（不阻塞 entry 激活）。
       * apply 时调一次、Card 挂载时再调一次（那时服务一定就绪）。
       */
      /**
       * 确保有数据源：先读 ctx 上现成的服务，再注册作用域注入（不阻塞 entry 激活）。
       * 三段各自 try：任何一段失败都不能影响后面（曾经因为第一段抛异常导致后面从未执行 ✗）。
       */
      const ensureCatalog = () => {
        if (activeStore === null || activeStore.catalog !== undefined) return
        const ctx = pluginCtx
        if (ctx === null) return

        try {
          const directories = readService(ctx, 'modelDirectories')
          if (adoptCatalogFromDirectories(directories)) {
            diag('数据源: modelDirectories（ctx 直读）')
            return
          }
        } catch (error) {
          diag('直读 modelDirectories 失败: ' + String(error?.message ?? error))
        }

        try {
          const llmRemote = readService(readService(ctx, 'remote'), 'llm')
          if (adoptCatalogFromRemote(llmRemote)) {
            diag('数据源: remote.llm（ctx 直读）')
            return
          }
        } catch (error) {
          diag('直读 remote.llm 失败: ' + String(error?.message ?? error))
        }

        if (typeof ctx.inject !== 'function') {
          diag('ctx.inject 不可用')
          return
        }
        if (catalogRequested) return
        catalogRequested = true
        try {
          diag('已注册作用域注入 modelDirectories')
          ctx.inject(['modelDirectories'], (scope) => {
            try {
              const service = readService(scope, 'modelDirectories')
              const adopted = adoptCatalogFromDirectories(service)
              diag('modelDirectories 回调: ' + (adopted ? '拿到' : service === undefined || service === null ? '服务为空' : '形状不符'))
              if (!adopted) {
                const got = readService(readService(scope, 'remote'), 'llm')
                diag('remote.llm 兜底: ' + (got === undefined || got === null ? '仍为空' : '拿到'))
                adoptCatalogFromRemote(got)
              }
            } catch (error) {
              diag('作用域回调异常: ' + String(error?.message ?? error))
            }
          })
        } catch (error) {
          diag('注册作用域注入失败: ' + String(error?.message ?? error))
        }
      }

      // ── 配置卡：字段渲染 + 自动保存
      function Card(props) {
        const t = props.t
        const store = props.formStore
        // ① 组件自己持有"乐观本地状态"：不管宿主 store 通不通知，点击/输入都立刻可见。
        const [local, setLocal] = React.useState({})
        const [, forceRender] = React.useReducer((n) => n + 1, 0)
        // ② 同时订阅宿主 store：外部改动（保存/冲突刷新）也能反映进来。
        React.useEffect(() => {
          if (store === undefined || typeof store.subscribe !== 'function') return undefined
          try {
            const dispose = store.subscribe(() => forceRender())
            return typeof dispose === 'function' ? dispose : undefined
          } catch {
            return undefined
          }
        }, [store])

        // 模型目录是异步到手的：挂载时再试一次，并订阅它到达的事件（否则字段会永远停在输入框）
        // ⚠️ effect 里**绝不能抛**：一旦抛出，React 会把整块设置面板卸载 → 表现为"界面没了" ✗
        React.useEffect(() => {
          try {
            ensureCatalog()
            return subscribeCatalog(() => forceRender())
          } catch (error) {
            return undefined
          }
        }, [])

        if (props.view === 'summary') return t('summary')

        const state = (store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined) ?? {}
        const readOnly = state.writable === false
        const readField = (key) => {
          if (Object.hasOwn(local, key)) return local[key]
          const own = state[key]
          // ⚠️ SettingsFormModel.field(field) 返回的是 `{ text, overridden, invalid }`
          // —— 字段文本叫 **text**，不是 value（读错就会"保存后弹回兜底默认值"）。
          return own === undefined || own === null ? '' : String(own.text ?? '')
        }
        // 自动保存：编辑后防抖 400ms 再 save()（连续输入合并成一次写入；卸载时清掉定时器）
        const saveTimer = useRefSafe(null)
        const scheduleSave = () => {
          try {
            if (saveTimer.current !== null && saveTimer.current !== undefined) clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null
              try {
                if (typeof props.save === 'function') props.save()
              } catch {
                /* 保存失败由表单自身提示（saveFailed） */
              }
            }, 400)
            if (typeof saveTimer.current?.unref === 'function') saveTimer.current.unref()
          } catch {
            /* 没有定时器就算了（不应发生） */
          }
        }
        React.useEffect(
          () => () => {
            try {
              if (saveTimer.current) clearTimeout(saveTimer.current)
            } catch {
              /* 忽略 */
            }
          },
          [],
        )

        const writeField = (key, value) => {
          setLocal((previous) => ({ ...previous, [key]: value }))
          props.edit(key, value)
          scheduleSave()
        }
        const clearField = (key) => {
          setLocal((previous) => {
            if (!Object.hasOwn(previous, key)) return previous
            const next = { ...previous }
            delete next[key]
            return next
          })
          props.resetField(key)
          scheduleSave()
        }
        // 调试项（advanced: true）默认不渲染：只有用户自己的配置里写了 devMode=true 才显示。
        // devMode 只在 FORM_FIELDS（表单清单）里，不在 FIELDS（渲染清单）里 —— 它本身不是一个可调项。
        const devModeOn = state.devMode?.text === 'true'
        const children = FIELDS.filter((field) => field.advanced !== true || devModeOn).map((field, fieldIndex) => {
          const own = state[field.key] ?? {}
          const common = {
            key: field.key,
            id: `escalation-review-${field.key}`,
            label: t(field.key),
            hint: t(`${field.key}Hint`),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled: readOnly,
            first: fieldIndex === 0,
            prominent: field.prominent === true,
            ...own,
          }
          const staged = readField(field.key)

          if (field.kind === 'segment') {
            return createElement(
              FieldShell,
              {
                ...common,
                overridden: own.overridden === true,
                onReset: () => clearField(field.key),
              },
              createElement(primitives.SegmentedControl, {
                id: `escalation-review-${field.key}-seg`,
                label: t(field.key),
                value: staged.trim() || field.fallback || field.options[0].value,
                options: field.options.map((option) => ({ value: option.value, label: t(option.label) })),
                disabled: readOnly,
                onChange: (value) => writeField(field.key, value),
              }),
            )
          }

          if (field.kind === 'switch') {
            return createElement(
              FieldShell,
              {
                ...common,
                overridden: own.overridden === true,
                onReset: () => clearField(field.key),
              },
              createElement(primitives.Switch, {
                checked: (staged.trim() || field.fallback || '').toLowerCase() === 'true',
                label: t(field.key),
                disabled: readOnly,
                onChange: (next) => writeField(field.key, next ? 'true' : 'false'),
              }),
            )
          }

          if (field.kind === 'textarea') {
            return createElement(
              FieldShell,
              {
                ...common,
                overridden: own.overridden === true,
                onReset: () => clearField(field.key),
              },
              createElement('textarea', {
                id: `escalation-review-${field.key}`,
                rows: field.rows ?? 4,
                style: styles.textarea,
                disabled: readOnly,
                value: staged,
                onChange: (event) => writeField(field.key, event.target.value),
              }),
            )
          }

          if (field.kind === 'reviewerModel') {
            // ⚠️ 整段包 try：任何异常都退回输入框，绝不让一个字段把设置面板拖垮（曾经如此 ✗）
            try {
              const catalog = props.formStore?.catalog
              return createElement(ModelPicker, {
                ...common,
                t,
                catalog,
                provider: String(readField('provider') ?? '').trim(),
                model: String(readField('model') ?? '').trim(),
                effort: String(readField('reasoningEffort') ?? '').trim(),
                onPick: ({ provider: nextProvider, model: nextModel, effort: nextEffort }) => {
                  // 跟随会话（provider/model 都空）时不允许带档位 —— 双保险，防止历史遗留值残留
                  const safeEffort = nextProvider === '' && nextModel === '' ? '' : nextEffort
                  writeField('provider', nextProvider)
                  writeField('model', nextModel)
                  writeField('reasoningEffort', safeEffort)
                },
              })
            } catch (error) {
              return createElement(primitives.SettingsValueField, {
                ...common,
                hint: (common.hint === undefined ? '' : String(common.hint)) + t('dropdownUnavailable'),
                numeric: false,
                onEdit: (text) => writeField('model', text),
                onReset: () => clearField('model'),
              })
            }
          }

          return createElement(primitives.SettingsValueField, {
            ...common,
            numeric: field.numeric === true,
            onEdit: (text) => writeField(field.key, text),
            onReset: () => props.resetField(field.key),
          })
        })
        // 自己搭框（不再用 SettingsForm）：所有字段自动保存，保留"保存"按钮只会让人困惑。
        // 保留两种真正有用的提示：只读部署、以及保存被拒（saveFailed）。
        return createElement('div', { key: 'frame', style: styles.form }, [
          state.writable === false
            ? createElement('p', { key: 'readonly', style: styles.hintNote }, t('readOnly'))
            : null,
          state.failed === true
            ? createElement('p', { key: 'save-failed', role: 'status', style: styles.notice }, t('saveFailed'))
            : null,
          createElement('p', { key: 'autosave-note', style: styles.hintNote }, t('autoSaveNote')),
          ...children,
        ])
      }

      /**
       * 挂载配置页：Host 服务该命名空间时，往「插件」页的 bundle 配置槽位注册一页。
       * @param ctx - 浏览器插件上下文。
       */
      // ── 插件入口：词典 / 表单 / 槽位注册
    // ── 审核卡片（官方扩展路径：ConversationNodeDefinition + conversation.chat.node）────────
    // 数据只从**已有事件**推导（tool/call 的 sandbox_permissions）。第三方插件无法给自定义事件打
    // ignorable 标记（append 第三个参数只对 surface 事件开放），写进去会让别的构建拒收整份会话，
    // 所以这里绝不写事件。判定与理由需要宿主→客户端通道。
    const REVIEW_CARD_KIND = 'escalation-review'
    /**
     * 取 `tool/call` 的命令参数。
     * ⚠️ 会话日志里 `data.arguments` 是 **JSON 字符串**（2026-09-28 实测 session.v4.jsonl：
     * `typeof data.arguments === "string"`），不是对象 —— 当对象读会永远匹配不上，卡片永不出现。
     */
    function reviewCardArguments(data) {
      const raw = data?.arguments
      if (raw !== null && raw !== undefined && typeof raw === 'object') return raw
      if (typeof raw !== 'string') return undefined
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
      } catch {
        return undefined
      }
    }

    /** 卡片状态文案（协议值 → 中文短语）。 */
    const REVIEW_CARD_STATUS = {
      // 投影还没到、开关也读不到 → **只敢说事实**：这次是越界提权请求（第四轮 P2-E）
      provisional: '越界提权请求',
      // 开关明确开着 = 插件正在做审批决定 → 这个长窗口就是「审批中」
      running: '审批中',
      // 开关未知/关闭时，宿主真的在等人 → 「待审批」（插件代答时不会走到这里）
      approval: '待审批',
      ran: '已放行',
      denied: '已拒绝',
      ranFailed: '已执行（工具报错）',
    }

    /**
     * 状态语义色（官方 ui-theme 的 token，design-platform.css）：
     * ran=绿(success) / denied=红(error，官方叫 error 不叫 danger) / ranFailed=黄(warn) / 其余中性。
     * 一律写 `var(--token, inherit)` —— token 万一不存在也不会变成透明。
     */
    const REVIEW_CARD_STATUS_COLOR = {
      provisional: 'var(--dsw-alias-label-tertiary, inherit)',
      running: 'var(--dsw-alias-state-idle-primary, inherit)',
      approval: 'var(--dsw-alias-state-idle-primary, inherit)',
      ran: 'var(--dsw-alias-state-success-primary, inherit)',
      denied: 'var(--dsw-alias-state-error-primary, inherit)',
      ranFailed: 'var(--dsw-alias-state-warn-primary, inherit)',
    }

    /**
     * 从审批请求的 reason 里只取**评审自己那段**理由。
     * 宿主记录的 reason 形如：`<工具话术> | escalation-review: risk=low decision=allow — <rationale>`，
     * 卡片只需要最后那段 rationale（把工具话术糊上去正是上一版难看的原因）。
     */
    function reviewCardReviewNote(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return ''
      const marker = raw.indexOf('escalation-review:')
      // 没有标记就**不是**评审写的理由（实测：approval/asked.reason 里只有工具那句
      // "escalate sandbox to danger-full-access: ..."）→ 宁可不显示，也不能冒充评审理由
      if (marker < 0) return ''
      const tail = raw.slice(marker + 'escalation-review:'.length)
      const dash = tail.indexOf(' — ')
      const body = dash >= 0 ? tail.slice(dash + 3) : tail
      return reviewCardReason(body)
    }

    /**
     * 取这条调用对应的评审判定（投影送来的）。
     * 客户端拿到 `projectionValues` 的合法来源不止一个（官方槽位给的是会话对象，
     * 而 summary/管理器才带 projectionValues），所以依次探测、拿不到就返回 undefined：
     *   1) props.session.projectionValues（有些视图直接给会话）
     *   2) props.useSession().projectionValues（standing seat）
     *   3) props.sessions.projectionValues(sessionId)（客户端 session 管理器的方法）
     *   4) props.session.summary.projectionValues / props.sessionSummary.projectionValues
     */
    /**
     * 取这条调用对应的评审判定（宿主用 sessionProjections 送来的）。
     *
     * 来源顺序按**实测形状**排定（客户端探针结论）：useSessions() 返回
     * { ids, byId, phase, projectionsBySession }；useProjection('escalation-review') 返回判定表。
     * ⚠️ 必须严格按 callId 取。曾经用"在 props 里随便找一个带 rationale 的对象"当兜底，
     *    结果把别的调用的理由贴到了评审中的卡片上。
     * ⚠️ 本函数会提前 return，绝不能在这里调用 hook（seat 值由视图顶层传入）。
     */
    /**
     * 从**所有已知形状**里取出本插件的投影桶（`{ [callId]: 判定 }`）。
     * 抽出来是为了让"单次判定"与"总开关状态（哨兵条目）"用**同一份**来源解析，避免两处漂移。
     */
    function reviewCardProjectionBucket(props, seats) {
      const KEY = 'escalation-review'
      const sessionId = props?.sessionId ?? props?.session?.id ?? props?.session?.sessionId
      const bucketOf = (values) => {
        if (values === null || values === undefined || typeof values !== 'object') return undefined
        const inner = values[KEY]
        return inner !== undefined && inner !== null && typeof inner === 'object' ? inner : undefined
      }
      // `projectionsBySession[sessionId]` 既可能是 `{ [KEY]: bucket }`，也可能**直接就是** bucket
      const bucketOrSelf = (values) => {
        if (values === null || values === undefined || typeof values !== 'object') return undefined
        return bucketOf(values) ?? values
      }
      const sources = [
        () => {
          const bySession = seats?.sessionsState?.projectionsBySession
          if (bySession === null || bySession === undefined || sessionId === undefined) return undefined
          return bucketOrSelf(bySession[sessionId])
        },
        // 会话对象上的投影值（useSession() 在这版宿主上实测会抛错，但若将来可用，这里就能直接吃）
        () => bucketOf(seats?.sessionValue?.projectionValues),
        () => bucketOf(seats?.sessionValue?.summary?.projectionValues),
        // state.byId[sessionId] 形状（诊断显示 state 里确实有 byId）
        () => bucketOf(seats?.sessionsState?.byId?.[sessionId]?.projectionValues),
        () => bucketOf(props?.sessionSummary?.projectionValues),
        () => bucketOf(props?.session?.projectionValues),
        () => bucketOf(props?.session?.summary?.projectionValues),
        () => bucketOrSelf(seats?.projectionValues),
        () => bucketOf(seats?.sessionsState?.projectionValues),
        () => bucketOf(seats?.sessionsState?.summary?.projectionValues),
        // 客户端 sessions 管理器（当前版本实测不是方法，保留为未来形状的兜底）
        () => {
          const manager = props?.sessions
          if (manager === null || manager === undefined || typeof manager.projectionValues !== 'function') return undefined
          return sessionId === undefined ? undefined : bucketOf(manager.projectionValues(sessionId))
        },
      ]
      for (const source of sources) {
        try {
          const hit = source()
          if (hit !== undefined) return hit
        } catch {
          /* 单个来源失败不影响其他来源 */
        }
      }
      return undefined
    }

    function reviewCardProjectedVerdict(props, callId, seats) {
      if (typeof callId !== 'string' || callId.length === 0) return undefined
      const bucket = reviewCardProjectionBucket(props, seats)
      if (bucket === null || bucket === undefined || typeof bucket !== 'object') return undefined
      const entry = bucket[callId]
      return entry !== undefined && entry !== null && typeof entry === 'object' ? entry : undefined
    }

    /** 投影里的**保留哨兵键**：宿主用它把"总开关状态"送来（见 lib/projection.js）。 */
    const REVIEW_CARD_GATE_KEY = '$gate'

    /**
     * 宿主送来的总开关状态（**正解**：不靠客户端猜）。返回 `true` / `false` / `null`（未知）。
     * 宿主在 `tool/call` 之前就把哨兵写进投影，所以评审长窗口一开头就能读到。
     */
    function reviewCardProjectedGate(props, seats) {
      const bucket = reviewCardProjectionBucket(props, seats)
      if (bucket === null || bucket === undefined || typeof bucket !== 'object') return null
      const entry = bucket[REVIEW_CARD_GATE_KEY]
      if (entry === null || entry === undefined || typeof entry !== 'object') return null
      if (entry.status === 'on') return true
      if (entry.status === 'off') return false
      return null
    }

    /** 盾牌图标（官方 `ui-primitives` 的 IconShieldOutlineRegular）；假模块表里可能没有 → 能力判断。 */
    const REVIEW_CARD_SHIELD =
      primitives !== null && primitives !== undefined && typeof primitives.IconShieldOutlineRegular === 'function'
        ? primitives.IconShieldOutlineRegular
        : null

    /** useState 的安全取用：调用方的 React 实现可能没有 hooks。 */
    const useStateSafe = (initial) => (typeof React.useState === 'function' ? React.useState(initial) : [initial, () => {}])

    /** 把工具结果（内容块 / 错误）拍平成文本。 */
    function reviewCardResultText(data) {
      const blocks = Array.isArray(data?.content) ? data.content : []
      const parts = []
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
      }
      if (typeof data?.error?.message === 'string') parts.push(data.error.message)
      else if (typeof data?.error === 'string') parts.push(data.error)
      return parts.join('\n')
    }

    /** 从结果文本里抽理由：优先取插件拒绝文案里的 "-- reason:" 之后那段。 */
    function reviewCardReason(text) {
      if (typeof text !== 'string' || text.length === 0) return ''
      const marker = text.indexOf('-- reason:')
      const raw = marker >= 0 ? text.slice(marker + '-- reason:'.length) : text
      const oneLine = raw.replace(/\s+/g, ' ').trim()
      return oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine
    }

    /** 卡片候选：任何**请求了某个沙箱权限**的调用。是不是"真越界"由插件的投影标记裁决（见下）。 */
    /**
     * 卡片的渲染锚点：**步起点之后** 0.1（目标：思考下面、运行命令上面）。
     *
     * 实测约束：运行中的工具节点锚在**步起点**（与思考同一个锚点），落地后才回到 `tool/call`；
     * 所以"在思考下面"与"在运行中命令上面"能否同时成立，取决于工具节点运行期究竟锚在哪 ——
     * 这一版按"步起点之后"取值，用真实界面判定。
     */
    function anchorBeforeStep(context) {
      const start = context.start ?? context.matches[0]
      const location = start?.location
      const stepStart = typeof location?.step?.start?.seq === 'number' ? location.step.start.seq : undefined
      const turnStart = typeof location?.turn?.start?.seq === 'number' ? location.turn.start.seq : undefined
      const eventSeq = typeof start?.event?.seq === 'number' ? start.event.seq : undefined
      return (stepStart ?? turnStart ?? eventSeq ?? 1) + 0.1
    }

    function makeReviewCardDefinition() {
      // `approval/asked` 带 `{ id, toolName, callId?, reason? }`，而 `approval/decided` **只有** `{ id, outcome }`
      // （官方类型 `user-approval/src/types.ts:44-58`）。所以必须先把 ask 的 `id` 映射到 `callId`，
      // 否则"审批答完"永远对不上卡片 → 卡片一直停在"待审批"（实测踩过：用户看到 待审批 → 已放行）。
      const approvalCallIds = new Map()
      return {
        kind: REVIEW_CARD_KIND,
        target: 'chat',
        match: (event) => {
          if (event === null || event === undefined) return null
          const data = event.data ?? {}
          if (event.type === 'tool/call') {
            const callId = typeof data.callId === 'string' && data.callId.length > 0 ? data.callId : undefined
            if (callId === undefined) return null
            const args = reviewCardArguments(data)
            // ⚠️ 不再硬编码某个权限值：只要这次调用**请求了沙箱权限**就是候选。
            //    真正"算不算越界"由 host 决定 —— 它只评审越界调用，并把「本次调用确实被评审了」
            //    的标记写进本会话的投影（`verdictStore.mark`）；卡片只渲染投影里有条目的 callId，
            //    所以非越界调用不会出卡片（详见 ReviewCardView）。
            const requested = args?.sandbox_permissions
            if (typeof requested !== 'string' || requested.length === 0) return null
            return { id: callId, role: 'start' }
          }
          // 结果与审批只作 update；引擎对"只有 update、还没看到 start"的记录会挂起，不会乱画。
          // ⚠️ tool/result **没有** data.callId（实测类型：{ turn, step, message, error? }），
          //    关联键在 data.message.toolCallId。
          if (event.type === 'tool/result') {
            const id = data.message?.toolCallId
            return typeof id === 'string' && id.length > 0 ? { id, role: 'update' } : null
          }
          if (event.type === 'approval/asked') {
            const callId = typeof data.callId === 'string' && data.callId.length > 0 ? data.callId : undefined
            if (callId === undefined) return null
            if (typeof data.id === 'string' && data.id.length > 0) {
              approvalCallIds.set(data.id, callId)
              // 只保留最近 64 条（第六轮 P3-10）：ask 没有对应 decided 时表会涨；Map 保序，删最旧即可
              while (approvalCallIds.size > 64) {
                const oldest = approvalCallIds.keys().next()
                if (oldest.done === true) break
                approvalCallIds.delete(oldest.value)
              }
            }
            return { id: callId, role: 'update' }
          }
          // ⚠️ 审批**答完**也要更新：否则卡片会一直停在"待审批"直到工具跑完。
          //    关联键是 `data.id`（**不是** callId）—— 用上面那张表换回 callId。
          if (event.type === 'approval/decided') {
            const callId = typeof data.id === 'string' ? approvalCallIds.get(data.id) : undefined
            // 用完就删（第六轮 P3-10）：长生命周期客户端否则会一直涨；id 万一复用还会留下错关联。
            if (typeof data.id === 'string') approvalCallIds.delete(data.id)
            return typeof callId === 'string' && callId.length > 0 ? { id: callId, role: 'update' } : null
          }
          return null
        },
        start: (_context, match) => {
          const data = match.event.data ?? {}
          const args = reviewCardArguments(data)
          return {
            tool: typeof data.name === 'string' ? data.name : 'tool',
            requested: typeof args?.sandbox_permissions === 'string' ? args.sandbox_permissions : 'danger-full-access',
            status: 'running',
            reason: undefined,
          }
        },
        update: (context, match) => {
          const state = context.state
          const type = match?.event?.type
          const data = match?.event?.data ?? {}
          if (state === undefined || state === null) return state
          if (type === 'approval/asked') {
            // 宿主把"评审结论 + 理由"并进了审批请求的 reason（放行路径）
            const note = reviewCardReviewNote(data.reason)
            // ⚠️ 这里**只记事实**（status=approval）；要不要显示「待审批」由**视图**决定 ——
            //    只有视图同时拿得到 gate 事实（投影哨兵 / 开关 / 本会话历史条目），update 拿不到。
            // ⚠️ `engaged`：reason 里有**本插件写的理由** ⇒ 这次确实是本插件接管的（不是别人答的）。
            //    卡片据此在"投影条目还没到"时也敢继续画 —— 实测踩过：审批一完卡片整张消失
            //    （投影条目晚一拍到达，而 status 已变 ran，旧门槛直接 return null）。
            return {
              ...state,
              status: state.status === 'running' || state.status === undefined ? 'approval' : state.status,
              approvalReason: note.length > 0 ? note : state.approvalReason,
              ...(note.length > 0 ? { engaged: true } : {}),
            }
          }
          if (type === 'approval/decided') {
            // ⚠️ 放行**不再单独占一档**（用户明确说过"已批准多余"）：插件代答时这个窗口只有 ~1ms，
            //    紧接着就是工具结果，多一档只会闪一下灰字。所以 allowed-once 保持当前状态，
            //    等 `tool/result` 给最终结论；只有**拒绝**才需要自己的一档 —— 那时工具根本不会跑。
            const outcome = typeof data.outcome === 'string' ? data.outcome : ''
            if (outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable') {
              return { ...state, status: 'denied' }
            }
            return state
          }
          if (type === 'tool/result') {
            const isError = data.message?.isError === true || (data.error !== undefined && data.error !== null)
            // 只有**本插件的拒绝**才算"已拒绝"；工具自己执行失败不能冤枉评审
            const errorName = typeof data.error?.name === 'string' ? data.error.name : ''
            const errorCode = typeof data.error?.code === 'string' ? data.error.code : ''
            const deniedByPlugin = errorName === 'EscalationReviewDeniedError' || errorCode === 'ESCALATION_REVIEW_DENIED'
            // 拒绝理由：优先取 error.reason（宿主把插件返回的 info.reason 放在这里），
            // 其次才从结果文本里抠 "-- reason:"
            const fromError = typeof data.error?.reason === 'string' && data.error.reason.length > 0
              ? reviewCardReason(data.error.reason)
              : ''
            const reason = fromError.length > 0 ? fromError : reviewCardReason(reviewCardResultText(data))
            const status = isError ? (deniedByPlugin ? 'denied' : 'ranFailed') : 'ran'
            return { ...state, status, reason }
          }
          return state
        },
        buildViewNode: (context) => {
          const state = context.state
          if (state === undefined || state === null) return null
          return {
            key: context.key,
            kind: REVIEW_CARD_KIND,
            id: context.id,
            target: 'chat',
            // ⚠️ 位置：卡片必须**始终排在命令上面**。实测（截图 + 锚点诊断）：
            //    我们的锚点两阶段都是 `tool/call seq - 0.1`（23689.9），而**工具节点**运行中锚在**步起点**
            //    （23686）、落地后锚在 `tool/call`（23690）→ 卡片于是从"命令下"翻到"命令上"。
            //    修法：锚到**步起点之前** —— 两个阶段都排在命令前。
            //    官方同款约定：要排在某条事件之前就写 `seq - 0.1`（`ui-goal/src/client/goal-command-input.ts`
            //    的 `anchorSeq: context.state.seq - 0.1`；排序见 `ui-chat/.../chat-snapshot-builder.ts`）。
            anchorSeq: anchorBeforeStep(context),
            location: (context.start ?? context.matches[0])?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: {
              callId: typeof context.id === 'string' ? context.id : '',
              tool: state.tool,
              requested: state.requested,
              status: state.status,
              reason: state.reason ?? state.approvalReason,
            },
          }
        },
      }
    }

    /**
     * 取会话相关的两个 standing seat。
     * ⚠️ 必须在**组件顶层**调用：两处调用顺序恒定，次数不随数据变化（hooks 规则）。
     */
    /**
     * 取会话相关的 seat。只调用**实测可用**的两个，顺序固定。
     * 实测（客户端探针）：useSession() 在这版宿主上会抛错（"l is not a function"），而渲染期任何抛错
     * 都会打断整个组件（卡片消失），所以绝不调用它。
     */
    function useReviewCardSeats(props) {
      const projectionValues = typeof props?.useProjection === 'function'
        ? props.useProjection('escalation-review')
        : undefined
      const sessionsState = typeof props?.useSessions === 'function' ? props.useSessions((state) => state) : undefined
      return { projectionValues, sessionsState }
    }

    /**
     * 本会话里是否**已经**出现过本插件的评审条目 —— 这是客户端唯一**有证据**的"插件确实在接管"判据。
     *
     * 为什么需要它：`enabled` 是 `.hidden()` 的，实测 `activeStore.field('enabledText')` 与
     * `configForms` 的三层**都读不到**（`sw=null`），于是长窗口只能显示中性文案。
     * 但"投影里已经有本插件的条目"本身就证明插件开着（那些条目只可能是本插件写的）。
     */
    function reviewCardSawAnyReview(props, seats) {
      try {
        const bucket = reviewCardProjectionBucket(props, seats)
        if (bucket === null || bucket === undefined || typeof bucket !== 'object') return false
        // 哨兵条目（$gate）不算"评审过" —— 它只表示开关状态
        return Object.keys(bucket).some((key) => key !== REVIEW_CARD_GATE_KEY)
      } catch {
        return false
      }
    }

    /**
     * 总开关当前是否开着。
     *
     * ⚠️ `enabled` 是 `.hidden()` 的（不进 EDITABLE/表单），所以**只读 `value` 常常读不到** ——
     * 实测用户明明开着开关，卡片却只能显示中性文案。因此三层都看：生效值 / base / user
     * （用户配置文件写的是规范化键 `enabled`，profile patch 里则可能只有 `enabledText`）。
     * 返回 `null` = 读不到（未知）。调用方按 `!== false` 理解：只有明确读到 `false` 才算关着；
     * 未知时不许声称「评审中」（只能用中性文案）—— 见 ReviewCardView。
     */
    function reviewCardSwitchOn() {
      try {
        // 字段快照可能是裸值、也可能是 `{ text, overridden, invalid }`（SettingsFormModel 的形状）
        const read = (candidate) => {
          if (candidate === undefined || candidate === null) return undefined
          if (typeof candidate === 'boolean') return candidate
          const text = typeof candidate === 'string' ? candidate : (typeof candidate.text === 'string' ? candidate.text : undefined)
          if (typeof text === 'string' && text.trim().length > 0) return /^(true|1|yes|on|开|是)$/i.test(text.trim())
          return undefined
        }
        // ① **官方同源**：设置表单模型 —— GUI 的分段控件就是从它渲染的，所以它最可信
        if (activeStore !== null && activeStore !== undefined && typeof activeStore.field === 'function') {
          for (const key of ['enabledText', 'enabled']) {
            const value = read(activeStore.field(key))
            if (value !== undefined) return value
          }
        }
        // ② 配置表单快照的三层（生效值 / base / user）
        if (activeScope !== null && activeScope !== undefined) {
          for (const layer of [activeScope.value, activeScope.base, activeScope.user]) {
            if (layer === null || layer === undefined || typeof layer !== 'object') continue
            for (const key of ['enabled', 'enabledText']) {
              const value = read(layer[key])
              if (value !== undefined) return value
            }
          }
        }
        return null
      } catch {
        return null
      }
    }

    /**
     * 开关状态的**兜底**：读不到开关（`sw=null`）时，只要本会话里已经出现过本插件的评审条目，
     * 就足以判定"插件正在接管"（那些条目只可能是本插件写的）→ 长窗口可以诚实地说「审批中」。
     */
    /**
     * 开关状态的判定，按可信度从高到低：
     *   ① **宿主通过投影送来的哨兵**（正解：事实由知道它的那一方提供，客户端不用猜）；
     *   ② 设置表单模型 / 配置三层（实测常读不到，保留为兜底）；
     *   ③ 本会话里已出现过本插件的评审条目（有证据 ⇒ 插件确实在接管）。
     */
    function reviewCardGateOn(props, seats) {
      const projected = reviewCardProjectedGate(props, seats)
      if (projected !== null) return projected
      const direct = reviewCardSwitchOn()
      if (direct !== null) return direct
      // 有证据才敢说：本会话里出现过本插件的评审条目 ⇒ 插件确实在接管（**每次渲染重算，不粘**，
      // 否则别的会话/别的用例的证据会泄漏过来）
      return reviewCardSawAnyReview(props, seats) ? true : null
    }

    /** 提权卡片视图：一行摘要，"状态：理由"可折叠。 */
    function ReviewCardView(props) {
      const [open, setOpen] = useStateSafe(false)
      const seats = useReviewCardSeats(props)
      const data = props?.node?.data ?? {}
      const projectedVerdict = reviewCardProjectedVerdict(props, data.callId, seats)
      const status = typeof data.status === 'string' ? data.status : 'running'
      // ⚠️ 两个来源**任一**成立就画卡片：
      //   ① 投影里已有这个 callId（host 确实评审过 → 带真实判定）；
      //   ② 评审**还在进行中**且**没有明确读到"开关关着"** —— 此时投影必然是空的，
      //      因为投影只在**会话事件**提交时重算，而评审期间一个事件都没有
      //      （实测：用了工具的那次评审，100 秒里没有任何事件 → 卡片整段消失）。
      //      判据用 `tool/call` 里已有的事实，不重推导越界定义。
      //      ⚠️ 两处踩过的坑：`data.status` 必须**显式**是 'running'（缺省不能当成运行中，
      //      否则任何没有状态的节点都会被画出来）；`enabled` 是 `.hidden()` 的（不进 EDITABLE/表单），
      //      **读不到是常态** —— 所以只有**明确读到 false** 才不画，绝不能要求"必须读到 true"。
      //   调用已结束却仍无投影条目 → 说明插件没介入 → 依旧整张不画。
      const switchOn = reviewCardGateOn(props, seats)
      const provisional = projectedVerdict === undefined || projectedVerdict === null
      // "调用还没结束"要同时认 `running` 与 `approval`：后者是审批请求已发出、结果还没回来的那一段
      //（插件代答时只有 ~1ms，但真实人工审批时可能很久）——只认 `running` 会让卡片在这段整张消失。
      const inFlight = data.status === 'running' || data.status === 'approval'
      // `engaged`：审批理由里有**本插件写的那段** ⇒ 这次确实是本插件接管的。
      // ⚠️ 实测：**自动代答**路径上，审批请求的 reason 里只有宿主那句越界说明，**没有**我们的理由
      //    → `engaged` 在这条路径上永远是 false（我上一版就是因此没修好）。
      const engaged = data.engaged === true
      // **gate 明确开着 = 插件接管所有越界调用** ⇒ 这次调用一定会被评审 ⇒ 卡片从开始到结束都该在。
      // 这是宿主给的事实（投影哨兵），不再依赖"投影条目到达时机"或"审批理由里有没有我们那段"。
      const gateOn = switchOn === true
      if (provisional) {
        if (!(gateOn || ((inFlight || engaged) && switchOn !== false))) return null
      }
      const tool = typeof data.tool === 'string' ? data.tool : 'tool'
      const requested = typeof data.requested === 'string' ? data.requested : 'sandbox'
      // 插件代答时「待审批」只存在 ~1ms（用户根本不会被问）→ gate 明确开着就显示「审批中」，
      // 别让一档没意义的灰字闪过去（与"已批准多余"同理）。
      const effectiveStatus = status === 'approval' && switchOn === true ? 'running' : status
      // 文案：**还在飞**且投影没到时只说中性事实（或 gate 明确开着时的「审批中」）；
      // 已经落地（ran/denied/…）就直接按状态给结论 —— 不依赖投影条目是否已经到达。
      const label = provisional && inFlight
        ? (switchOn === true ? REVIEW_CARD_STATUS.running : REVIEW_CARD_STATUS.provisional)
        : (REVIEW_CARD_STATUS[effectiveStatus] ?? effectiveStatus)
      const statusColor = REVIEW_CARD_STATUS_COLOR[effectiveStatus] ?? 'inherit'
      // ⚠️ 临时位置诊断（定位完就删）：把锚点与位置形状画出来 —— 用于确定"永远排在命令上面"该锚在哪。
      const where = props?.node?.location
      const anchorDiag = ` [a=${String(props?.node?.anchorSeq)} loc=${String(where?.kind)}@${String(where?.step?.start?.seq ?? where?.turn?.start?.seq ?? '')}]`
      const projected = typeof projectedVerdict?.rationale === 'string' && projectedVerdict.rationale.length > 0
        ? projectedVerdict.rationale
        : typeof projectedVerdict?.reason === 'string' ? projectedVerdict.reason : ''
      const direct = typeof data.reason === 'string' ? data.reason : ''
      const reason = direct.length > 0 ? direct : projected
      const short = reason.length > 32 ? reason.slice(0, 32) + '…' : reason
      // 字号/行高/颜色放在外层：行与展开正文共用同一套排版
      const outerStyle = {
        minWidth: 0,
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
        color: 'var(--dsw-alias-label-tertiary)',
      }
      const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }
      const headStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: reason === '' ? 'default' : 'pointer',
        userSelect: 'none',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const titleStyle = { fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }
      // 状态（上色 + 加粗）与理由分开；外层不设 gap，避免 "已放行 ：理由" 多出空隙
      const statusItem = createElement('span', { key: 'st', style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } }, [
        createElement('span', { key: 'label', style: { fontWeight: 600, color: statusColor } }, label),
        createElement('span', { key: 'anchorDiag', style: { color: 'var(--dsw-alias-label-caption)', fontWeight: 400 } }, anchorDiag),
        reason === '' ? null : createElement('span', { key: 'reason' }, '：' + (open ? '' : short) + (open ? '' : ' ▸')),
      ])
      const body = open
        ? [
            createElement('div', { key: 'why', style: { paddingTop: 2, whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' } }, reason),
            createElement('div', { key: 'meta', style: { paddingTop: 2, color: 'var(--dsw-alias-label-caption)' } }, tool + ' → ' + requested),
          ]
        : []
      try {
        // 外层必须是块级容器：rowStyle 是 flex，若把展开正文塞进它会变成并排的 flex 项
        return createElement('div', { style: outerStyle }, [
          createElement('div', { key: 'row', style: rowStyle }, [
            createElement('span', { key: 'head', style: headStyle, onClick: reason === '' ? undefined : () => setOpen(!open) }, [
              REVIEW_CARD_SHIELD === null ? null : createElement(REVIEW_CARD_SHIELD, { key: 'icon', size: 14 }),
              createElement('span', { key: 'title', style: titleStyle }, '越界提权审查'),
              createElement('span', { key: 'a', style: { color: 'var(--dsw-alias-label-caption)' } }, '→'),
              statusItem,
            ]),
          ]),
        ].concat(open ? body : []))
      } catch {
        // 兜底：宁可退化成一行纯文字，也不能让卡片整张消失
        return createElement('div', { style: outerStyle }, [
          createElement('span', { key: 'fallback', style: { fontWeight: 500 } }, '越界提权审查'),
          createElement('span', { key: 'st' }, ' → ' + label),
        ])
      }
    }

      function apply(ctx) {
        ensureStyle()
        pluginCtx = ctx
        try {
          const t = ctx.locale.bind(NS)
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'escalation-review: dictionaries')

          const scope = ctx.configForms.get(ENTRY)
          activeScope = scope
          const spec = FORM_FIELDS.map((field) =>
            field.numeric ? primitives.settingsNumberField(field.key) : primitives.settingsTextField(field.key),
          )
          const form = new primitives.SettingsFormModel(scope, spec)
          const project = () => {
            const frame = typeof form.shell === 'function' ? form.shell() : {}
            const fields = {}
            for (const field of FORM_FIELDS) fields[field.key] = form.field(field.key)
            return { ...frame, ...fields }
          }
          const inner = form.bind(project)
          // ⚠️ 自己的稳定 store：**不依赖槽位的 hooks 约定**（那个槽位不一定转发 hooks，
          // 转发了组件也拿不到 → 表现为"点了内部有改动、界面不动"）。直接作为普通 prop 传进去，
          // 组件用 React.useSyncExternalStore 订阅（props.formStore 的引用在 apply 里固定，稳定 ✓）。
          const formStore = {
            getSnapshot: () => {
              try {
                return typeof inner?.getSnapshot === 'function' ? inner.getSnapshot() : project()
              } catch {
                return project()
              }
            },
            subscribe: (listener) => {
              try {
                return typeof inner?.subscribe === 'function' ? inner.subscribe(listener) : () => {}
              } catch {
                return () => {}
              }
            },
          }
          // 模型目录：只登记 store；**探测放在页面注册完成之后**（避免探测异常影响页面注册）
          activeStore = formStore

          ctx.effect(
            () => () => {
              try {
                form.dispose()
              } catch {
                /* 释放失败不影响卸载 */
              }
            },
            'escalation-review: form subscription',
          )

          // 槽位选型（官方 ui-plugin-manager README）：
          //   plugins.item        —— **官方插件**列表（安装自带的那批，按 label 进 Official 组）
          //   plugins.bundle.config —— 按 **bundle 包名**，显示在 bundle 详情页描述与组件行之间（bundle 自己的配置）
          //   plugins.row.config  —— 按 `<包名>#<行 id>`，**给那一行一个 Configure 入口** → 正是本插件的情形
          //     （配置命名空间属于 bundle 里的那一行 `escalation-review`，不是 bundle 自身）
          // 三个都注册：页面按 subject/key 只渲染匹配的那个，注册本身不冲突。
          const ROW_KEY = `${BUNDLE}#${ENTRY}`
          ctx.effect(
            () =>
              ctx.configForms.whileServed([ENTRY], () => {
                return ctx.slots.inject('plugins.row.config', () =>
                  ctx.slots.register(
                    {
                      name: 'plugins.row.config',
                      key: ROW_KEY,
                      locale: NS,
                      inject: () => ({
                        formStore,
                        ...form.actions(),
                      }),
                    },
                    Card,
                  ),
                )
              }),
            'escalation-review: row configuration page',
          )
          // 再注册一份到 **bundle 详情页**（key = bundle 包名）：那里正是"描述与组件行之间"，
          // 也是用户最自然的寻找位置。两处都注册 → 页面按 subject 只渲染匹配的那个，不冲突。
          ctx.effect(
            () =>
              ctx.configForms.whileServed([ENTRY], () =>
                ctx.slots.inject('plugins.bundle.config', () =>
                  ctx.slots.register(
                    {
                      name: 'plugins.bundle.config',
                      key: BUNDLE,
                      locale: NS,
                      inject: () => ({
                        formStore,
                        ...form.actions(),
                      }),
                    },
                    Card,
                  ),
                ),
              ),
            'escalation-review: bundle configuration page',
          )
          console.info(`[escalation-review] 配置页已注册（plugins.row.config key=${ROW_KEY} + plugins.bundle.config key=${BUNDLE}）`)
          void t
          // 页面已注册完毕，这时再探测模型目录（出问题也只会退回手填）
          try {
            ensureCatalog()
          } catch (error) {
            diag('ensureCatalog 异常: ' + String(error?.message ?? error))
          }
        } catch (error) {
          console.error('[escalation-review] 客户端 apply 失败', error)
        }
      // 一次性清理：删掉早期定位客户端形状时写进 localStorage 的诊断键
      try {
        if (typeof localStorage !== 'undefined') {
          for (const staleKey of ['er-diag', 'er-diag2', 'er-diag3', 'er-diag4']) localStorage.removeItem(staleKey)
        }
      } catch {
        /* 清理失败无所谓 */
      }
      // ── 审核卡片：把"这次调用是越界提权"作为会话里的一行 ──────────────────────
      // ⚠️ uiConversation 用运行时 ctx.get 取，不写进声明式 inject：服务缺席时声明式注入会让整个
      //    客户端 entry 永久 pending（GUI 不挂载），这个坑踩过两次。
      // ⚠️ 用**作用域注入**等 uiConversation（官方做法：ctx.inject([...], scope => …)）：
      //   · 不能用 ctx.get —— 服务由 ui-conversation 包提供，可能在本 entry apply 之后才就绪，
      //     取不到就永久跳过（第一版就是这个毛病）；
      //   · 不能写进声明式 inject —— 服务缺席时 entry 永久 pending，整个 GUI 不挂载。
      //   作用域注入两者都避开：服务到达即回调，且不阻塞本 entry 激活。
      try {
        ctx.inject(['uiConversation'], (scope) => {
          try {
            // 取值走 get(name)：cordis 里访问未声明属性会抛，property proxy 又对装配顺序敏感
            const uiConversation = typeof scope.get === 'function' ? scope.get('uiConversation') : undefined
            if (uiConversation === undefined || uiConversation === null
              || uiConversation.events === undefined || uiConversation.events === null
              || typeof uiConversation.events.register !== 'function') {
              console.info('[escalation-review] uiConversation 已就绪但没有 events.register，跳过审核卡片')
              return
            }
            scope.effect(
              () => uiConversation.events.register(makeReviewCardDefinition()),
              'escalation-review: conversation node',
            )
            // 把客户端 sessions 服务通过 inject 面交给视图（官方规矩：inject 返回纯数据与回调）
            let clientSessions
            try {
              clientSessions = typeof scope.get === 'function' ? scope.get('sessions') : undefined
            } catch {
              clientSessions = undefined
            }
            scope.slots.inject('conversation.chat.node', () =>
              scope.slots.register({
                name: 'conversation.chat.node',
                key: REVIEW_CARD_KIND,
                inject: () => ({ sessions: clientSessions }),
                locale: NS,
              }, ReviewCardView),
            )
            console.info('[escalation-review] 审核卡片已注册（conversation.chat.node key=' + REVIEW_CARD_KIND + '）')
          } catch (error) {
            console.info('[escalation-review] 审核卡片注册失败（不影响配置页）: ' + String(error?.message ?? error))
          }
        })
      } catch (error) {
        console.info('[escalation-review] 审核卡片作用域注入失败（不影响配置页）: ' + String(error?.message ?? error))
      }

      }

      // 覆盖兜底值（服务名必须是 0.1.7 实有的：slots / locale / configForms）
      exports.NS = NS
      exports.ENTRY = ENTRY
      exports.apply = apply
      // ⚠️ 定论（实测两次）：声明式 inject 里写 'remote' / 'remote.llm' 会让本 entry **永久 pending**
      //   → 客户端界面（配置页）整个不注册。其它插件能这么写，不代表本插件可以
      //   （激活顺序 / 远程连接时机不同）。命名空间一律走**作用域注入**（不阻塞 entry 激活）。
      exports.inject = ['slots', 'locale', 'configForms']
      // 诊断钩子：验证"数据源晚到 → 通知订阅者"
      try {
        exports.__diagnostics = {
          ensureCatalog,
          subscribeCatalog,
          catalogDiag: () => [...catalogDiag],
          makeReviewCardDefinition,
          ReviewCardView,
          reviewCardProjectedVerdict,
          REVIEW_CARD_STATUS_COLOR,
          REVIEW_CARD_STATUS,
        }
      } catch {
        /* 诊断钩子失败不影响插件 */
      }
    } catch (error) {
      console.error('[escalation-review] 客户端模块加载失败（已降级为无事发生的插件）', error)
    }

    return module.exports
  },
})
