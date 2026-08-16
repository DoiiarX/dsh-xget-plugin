/**
 * @doiiarx/dsh-xget —— 浏览器设置页（Xget 加速配置）。
 * 与 @doiiarx/dsh-user-language 的 client.js 同一套加载模式：
 * `window.__ModuleLoader__.load` 注册浏览器端插件，绑定 `xget` settings
 * 命名空间，渲染设置在 sidebar 的「Xget 加速」小节。
 * 保存后宿主端 middleware 会在下一次 shell 执行按新配置注入代理环境变量。
 */
window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-xget",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "settingsScope", "connection", "remote"];
    const h = React.createElement;

    const NAMESPACE = "xget";
    const DEFAULT_INSTANCE = "https://xget.doiiars.com";

    function XgetSettings({ scope }) {
      const snapshot = React.useSyncExternalStore(
        (fn) => scope.subscribe(fn),
        () => scope.getSnapshot(),
      );
      const value = snapshot.value;
      const busy = snapshot.status !== "ready" || value === undefined;
      const enabled = busy ? true : value.enabled === true;
      const instance = busy || typeof value.instance !== "string" || !value.instance.trim()
        ? DEFAULT_INSTANCE
        : value.instance;
      const npm = busy ? true : value.npm !== false;
      const pypi = busy ? true : value.pypi !== false;
      const git = busy ? true : value.git !== false;
      const go = busy ? true : value.go !== false;
      const huggingface = busy ? true : value.huggingface !== false;

      const row = (title, desc, control) =>
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "14px 16px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)" } },
          h("div", { style: { display: "grid", gap: "3px" } },
            h("strong", null, title),
            h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, desc),
          ),
          control,
        );

      const toggle = (checked, onChange) =>
        h("input", {
          type: "checkbox",
          checked,
          disabled: !snapshot.writable,
          onChange: (event) => { void onChange(event.target.checked); },
        });

      return h("div", { style: { display: "grid", gap: "14px", color: "var(--dsw-alias-label-primary)" } },
        h("div", null,
          h("h2", { style: { margin: "0 0 6px" } }, "Xget 加速"),
          h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } },
            "为 npm/npx、pip、git 命令自动注入 xget 镜像代理（https://github.com/xixu-me/xget）。模型可通过 xget_set 工具按会话关闭/查询。"),
        ),
        row("启用", "全局开关：默认开启，所有 shell 命令自动携带加速环境变量",
          toggle(enabled, (v) => { void scope.set("enabled", v); })),
        h("label", { "data-settings-item": "instance", style: { display: "grid", gap: "8px", padding: "14px 16px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)" } },
          h("strong", null, "实例地址"),
          h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } },
            "xget 实例，如 https://xget.doiiars.com"),
          h("input", {
            value: instance,
            disabled: !snapshot.writable,
            placeholder: DEFAULT_INSTANCE,
            style: { height: "38px", padding: "0 11px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)", font: "inherit" },
            onChange: (event) => { void scope.set("instance", event.target.value); },
          }),
        ),
        row("npm / npx", "NPM_CONFIG_REGISTRY -> 实例 /npm/",
          toggle(npm, (v) => { void scope.set("npm", v); })),
        row("pip", "PIP_INDEX_URL -> 实例 /pypi/simple/",
          toggle(pypi, (v) => { void scope.set("pypi", v); })),
        row("git", "GIT_CONFIG insteadOf 重写 github/gitlab 等",
          toggle(git, (v) => { void scope.set("git", v); })),
        row("Go modules", "GOPROXY -> 实例 /golang/（go get / go mod download）",
          toggle(go, (v) => { void scope.set("go", v); })),
        row("Hugging Face", "HF_ENDPOINT -> 实例 /hf/（huggingface_hub 下载模型/数据集）",
          toggle(huggingface, (v) => { void scope.set("huggingface", v); })),
      );
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: NAMESPACE,
          order: 40,
          label: "Xget 加速",
          inject: () => ({ scope }),
        }, XgetSettings),
      );
      const search = (globalThis.__DSH_SETTINGS_SEARCH__ ??= {
        sections: new Map(),
        register(sectionId, spec) {
          this.sections.set(sectionId, spec);
          return () => { this.sections.delete(sectionId) };
        },
      });
      search.register(NAMESPACE, {
        label: "Xget 加速",
        keywords: "xget 代理 镜像 加速 npm pip git go huggingface 网络",
        items: [
          { id: "enabled", label: "启用", desc: "全局开关", keywords: "xget 加速 代理 启用 enabled" },
          { id: "instance", label: "实例地址", desc: "xget 实例域名", keywords: "实例 地址 instance 域名 镜像" },
          { id: "npm", label: "npm / npx", desc: "npm registry 加速", keywords: "npm npx registry 包" },
          { id: "pypi", label: "pip", desc: "PyPI 加速", keywords: "pip pypi python 包" },
          { id: "git", label: "git", desc: "git URL 重写", keywords: "git github gitlab 克隆 重写" },
          { id: "go", label: "Go modules", desc: "GOPROXY 加速", keywords: "go golang goproxy 模块" },
          { id: "huggingface", label: "Hugging Face", desc: "HF_ENDPOINT 加速", keywords: "huggingface hf 模型 数据集 镜像" },
        ],
      });
    }

    return { inject, apply };
  },
});
