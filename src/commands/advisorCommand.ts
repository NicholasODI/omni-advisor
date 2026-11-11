import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { openSettings, type SettingsState } from "../ui/settingsMenu.ts";
import type { RecoveryController, RecoveryMode } from "../workflow/recovery.ts";
import type { ExecutionScope } from "../workflow/executionScope.ts";

/** User command policy; state ownership stays with the extension/session coordinator. */
export interface AdvisorCommandActions {
  state(): SettingsState;
  defaultsEnabled(): boolean;
  change(patch: Partial<SettingsState>): void;
  clearModel(): void;
  recordModel(model: string): void;
  modelOverride(): string | undefined;
  ompModels(): string[];
  provider(): Promise<void>;
  save(): void;
  saveGate(): void;
  recovery(): RecoveryController;
  saveRecovery(): void;
  newTask(): void;
}
export function registerAdvisorCommand(
  pi: ExtensionAPI,
  forContext: (ctx: ExtensionCommandContext) => AdvisorCommandActions,
): void {
  pi.registerCommand("omni-advisor", {
    description:
      "Open advisor settings (or use on/off/status/model/mode commands)",
    getArgumentCompletions(arg: string) {
      const text = arg || "";
      const modelWord = text.match(/^model[ \t]+(\S*)$/i);
      if (modelWord) {
        refreshModelOptions();
        const prefix = modelWord[1].toLowerCase();
        const items = advisorModelOptions().filter((o) => {
          const l = o.label.toLowerCase();
          const bare = o.label.includes("/")
            ? o.label.slice(o.label.indexOf("/") + 1)
            : l;
          return l.startsWith(prefix) || bare.startsWith(prefix);
        });
        return items.length
          ? items.map((o) => ({
              label: o.label,
              value: `model ${o.label}`,
              description: o.description,
            }))
          : null;
      }
      const p = text.trim().toLowerCase();
      if (p.includes(" ")) return null;
      const subs = [
        {
          label: "scope active",
          value: "scope active",
          description: "Explicitly authorize execution/resume",
        },
        {
          label: "scope paused",
          value: "scope paused",
          description: "Stop new work; reminders cannot resume it",
        },
        {
          label: "scope analysis",
          value: "scope analysis",
          description: "Inspection only, no shell/edit/delegation",
        },
        {
          label: "scope closure",
          value: "scope closure",
          description: "Wrap up current scope",
        },
        {
          label: "recovery observe",
          value: "recovery observe",
          description: "Notify on repeated failures (default)",
        },
        {
          label: "recovery enforce",
          value: "recovery enforce",
          description: "Require a decision before equivalent retries",
        },
        {
          label: "recovery disabled",
          value: "recovery disabled",
          description: "Disable recovery detection and blocking",
        },
        {
          label: "recovery override",
          value: "recovery override ",
          description: "One retry: add episode ID and an abstract reason",
        },
        {
          label: "recovery new-task",
          value: "recovery new-task",
          description: "Retire recovery state for unrelated work",
        },
        {
          label: "settings",
          value: "settings",
          description: "Open interactive settings",
        },
        {
          label: "mode balanced",
          value: "mode balanced",
          description:
            "Plan, consequential decisions, final abstract review (default)",
        },
        {
          label: "mode local-led",
          value: "mode local-led",
          description: "Plan then execute locally",
        },
        {
          label: "mode cloud-led",
          value: "mode cloud-led",
          description: "Cloud selects bounded execution batches",
        },
        {
          label: "planning on",
          value: "planning on",
          description: "Require abstract cloud planning before execution tools",
        },
        {
          label: "planning off",
          value: "planning off",
          description: "Disable planning enforcement",
        },
        {
          label: "on",
          value: "on",
          description: "Enable advisor nudge for this session",
        },
        {
          label: "off",
          value: "off",
          description: "Disable advisor nudge for this session",
        },
        {
          label: "status",
          value: "status",
          description: "Show gate state + resolved advisor model",
        },
        {
          label: "model omp",
          value: "model omp",
          description: "Choose from OMP instance models",
        },
        {
          label: "source omp",
          value: "source omp",
          description: "Use OMP model registry and credentials",
        },
        {
          label: "source config",
          value: "source config",
          description: "Use configured endpoints",
        },
        {
          label: "model",
          value: "model",
          description: "Select advisor model (model clear resets)",
        },
      ];
      const m = subs.filter((s) => s.label.startsWith(p));
      return m.length ? m : null;
    },
    handler: async (arg, ctx) => {
      const actions = forContext(ctx);
      const raw = (arg || "").trim(),
        command = raw.toLowerCase();
      if (/^scope (active|paused|analysis|closure)$/i.test(raw)) {
        actions.change({
          authorization: command.split(" ")[1] as ExecutionScope,
        });
        ctx.ui.notify(
          `Execution authorization: ${actions.state().authorization}`,
          "info",
        );
        return;
      }
      if (/^recovery (disabled|observe|enforce)$/i.test(raw)) {
        actions.change({ recoveryMode: command.split(" ")[1] as RecoveryMode });
        ctx.ui.notify(`Recovery mode: ${actions.state().recoveryMode}`, "info");
        return;
      }
      if (command === "recovery new-task") {
        actions.newTask();
        actions.saveRecovery();
        ctx.ui.notify(
          "Old recovery episodes retired; explicit new task started.",
          "info",
        );
        return;
      }
      if (command.startsWith("recovery override ")) {
        const [, , id, ...words] = raw.split(/\s+/);
        try {
          actions.recovery().override(id, words.join(" "));
          actions.saveRecovery();
          ctx.ui.notify(
            "One retry authorized; override reason recorded.",
            "info",
          );
        } catch {
          ctx.ui.notify(
            "Use recovery override <episode-id> <short abstract reason>.",
            "error",
          );
        }
        return;
      }
      if (!raw || command === "settings") {
        if (ctx.hasUI === false || !ctx.ui?.select || !ctx.ui?.input) {
          ctx.ui.notify(
            "Interactive settings unavailable. Use on/off/status/model/source/mode/planning commands or edit config.",
            "warning",
          );
          return;
        }
        await openSettings(ctx.ui, actions.state, actions);
        return;
      }
      if (
        ["mode local-led", "mode cloud-led", "mode balanced"].includes(command)
      ) {
        actions.change({ mode: command.slice(5) as SettingsState["mode"] });
        ctx.ui.notify(`omni-advisor: workflow=${actions.state().mode}`, "info");
        return;
      }
      if (command === "planning on" || command === "planning off") {
        const enforced = command === "planning on";
        actions.change({ enforced });
        ctx.ui.notify(
          `omni-advisor: enforced planning ${enforced ? "ON (cloud access must also be on)" : "OFF"}`,
          "info",
        );
        return;
      }
      if (command === "source omp" || command === "source config") {
        actions.change({ source: command === "source omp" ? "omp" : "config" });
        ctx.ui.notify(`omni-advisor: source=${actions.state().source}`, "info");
        return;
      }
      if (command === "model omp") {
        const models = actions.ompModels();
        if (!models.length) {
          ctx.ui.notify("omni-advisor: no available OMP models.", "warning");
          return;
        }
        const selected = await ctx.ui.select(
          "Select OMP advisor model",
          models,
        );
        if (selected && models.includes(selected)) {
          actions.change({ model: selected, source: "omp" });
          ctx.ui.notify(`omni-advisor: OMP advisor=${selected}`, "info");
        }
        return;
      }
      if (/^model\b/i.test(raw)) {
        const model = raw.slice(5).trim();
        if (!model)
          ctx.ui.notify(
            `omni-advisor: advisor=${actions.state().model} (override: ${actions.modelOverride() ?? "none"}; chain: override > OMNI_ADVISOR_MODEL > config > default)`,
            "info",
          );
        else if (model.toLowerCase() === "clear") {
          actions.clearModel();
          ctx.ui.notify(
            `omni-advisor: model override cleared; advisor=${actions.state().model}`,
            "info",
          );
        } else if (!model.includes("/"))
          ctx.ui.notify(
            `omni-advisor: expected a provider/model selector, got "${model}"`,
            "error",
          );
        else {
          actions.change({ model });
          actions.recordModel(model);
          ctx.ui.notify(
            `omni-advisor: advisor model = ${model} (process lifetime; edit omni-advisor.config.json to persist)`,
            "info",
          );
        }
        return;
      }
      if (command === "on" || command === "off") {
        actions.change({ enabled: command === "on" });
        actions.saveGate();
        ctx.ui.notify(
          `omni-advisor: cloud advisor nudge ${command === "on" ? "ENABLED" : "DISABLED"} for this session (persisted across restarts).`,
          "info",
        );
        return;
      }
      const state = actions.state();
      ctx.ui.notify(
        `omni-advisor: pipeline ${state.enabled ? "enabled" : "disabled"}; default=${actions.defaultsEnabled() ? "enabled" : "disabled"}; advisor=${state.model} source=${state.source} mode=${state.mode} enforcedPlanning=${state.enforced} (isolated dispatch)`,
        "info",
      );
    },
  });
}
