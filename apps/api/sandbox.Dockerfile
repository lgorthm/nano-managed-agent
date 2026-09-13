# 会话工具沙箱的运行时镜像(docs/session/runtime.md §4.5)。
# 官方要求镜像 tag 与 @cloudflare/sandbox npm 包版本保持同步(当前 0.12.9);
# 升级包时同步改这里。选 python 变体:更接近 GLM 沙箱的预装形态(3.11 +
# numpy/pandas 等),environment 快照的 pip 安装也依赖它。
FROM docker.io/cloudflare/sandbox:0.12.9-python
