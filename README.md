# @local/dsh-xget

Xget 加速注入插件（host 级）。在设置页配置 xget 镜像实例，自动为 npm/npx、
pip、git 命令注入加速代理环境变量。

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，
> 完整的自研插件索引见该仓库。

## 原理

[xget](https://github.com/xixu-me/xget) 是开发者资源加速引擎——把原始 URL
重写为镜像前缀（如 `registry.npmjs.org/...` → `<instance>/npm/...`）。本插件
通过 cmd 插件（`@local/dsh-cmd-plugin`）的 `shellMiddlewareSlot` 注册
middleware（owner = `xget`，set 模式同源覆盖 + disposer 自清理），在每次
bash 执行时替换执行并注入代理环境变量：

| 工具 | 环境变量 | 效果 |
| --- | --- | --- |
| npm / npx / yarn / pnpm | `NPM_CONFIG_REGISTRY=<instance>/npm/` | 包安装/下载走 xget 镜像 |
| pip | `PIP_INDEX_URL=<instance>/pypi/simple/` | pip 走 xget PyPI 镜像 |
| git | `GIT_CONFIG_*`（`url.<instance>/gh/.insteadOf` 等 8 条） | `git clone https://github.com/...` 等自动重写到 xget |
| Go | `GOPROXY=<instance>/golang,direct` + `GOSUMDB=off` | `go get` / `go mod download` 走 xget |
| Hugging Face | `HF_ENDPOINT=<instance>/hf` | huggingface_hub 下载模型/数据集走 xget |

## 配置（设置页 Xget 加速）

- `enabled`：全局开关（默认 true）
- `instance`：xget 实例地址（默认 `https://xget.doiiars.com`）
- `npm` / `pypi` / `git` / `go` / `huggingface`：按平台开关

## 模型工具

- `xget_set`：模型可在当前会话查询/开启/关闭 xget 加速（session 级覆盖，
  优先于全局开关）。

## 依赖

- `@local/dsh-cmd-plugin`（提供 `shellMiddlewareSlot` 与 bash 工具）
- 宿主 `settings` 服务

## 说明

- middleware 无法改写已冻结的 `args.command`（tools 注册表 deepFreeze），
  因此采用替换执行：自建 spawn 并把代理 env 合并进子进程。
- 插件升级时，set 模式同 owner 覆盖旧 middleware，disposer 随插件卸载
  自动清理，不残留旧版本。
- **git push 豁免**：git 的 `insteadOf` 会同时重写 fetch 与 push，导致
  `git push` 被劫持到 xget 镜像（自建实例通常无 push 凭据，会验证失败）。
  因此本插件对 `git push` 命令跳过 git insteadOf 注入，只加速 clone/pull/
  fetch/ls-remote 等拉取操作；npm/pip/go/hf 的注入不受影响。
