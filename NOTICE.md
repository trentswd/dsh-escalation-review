# NOTICE / 来源与致谢

本插件的代码为独立实现。分档口径、授权评分思路与提示词结构参考了以下项目（均为其各自许可）：

1. **OpenAI Codex** —— guardian 策略模板（`codex-rs/prompts/templates/guardian/policy_template.md`），
   Apache License 2.0：<https://github.com/openai/codex>
   参考内容：风险分档、用户授权评分、"缺失记录不等于许可"、事后批准视为高风险、
   有更不危险的替代方案则降档等判据。**未复制其文本**（逐字重合度实测为 0）。
2. **DeepSeek Harness 官方 auto-review 插件**（`@deepseek-ai/dsh-experimental-auto-review`），MIT License：
   参考内容：五分区评审输入、结构化 JSON 决策（`{risk, authorization, outcome, reason?}`）、
   "证据有歧义即失败"的 fail-closed 姿态、`tools/pre-execute` 三态契约。
   逐字重合度实测为 1 处短句，已在本仓库改写为自有措辞。
3. **DeepSeek Harness** 本体（MIT License）：本插件通过其公开扩展点工作
   （`tools/pre-execute`、`approval/request`、`sessionProjections`、`conversation.chat.node` 等），
   并在运行时使用宿主自带的 `@deepseek-ai/dsh-client-ui-primitives` 图标组件（属运行时依赖，不随本包分发）。

策略文本里的中文/英文示例是通用示意句，用来示范"什么算授权、什么不算"，不是任何一次真实会话的引用。