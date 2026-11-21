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
  setCloudAccess(enabled: boolean): boolean;
  recovery(): RecoveryController;
  saveRecovery(): void;
  newTask(): void;
}
const subcommands = {
  "scope active": "Explicitly authorize execution/resume",
  "scope paused": "Stop new work; reminders cannot resume it",
  "scope analysis": "Inspection only, no shell/edit/delegation",
  "scope closure": "Wrap up current scope",
  "recovery observe": "Notify on repeated failures (default)",
  "recovery enforce": "Require a decision before equivalent retries",
  "recovery disabled": "Disable recovery detection and blocking",
  "recovery override": "One retry: add episode ID and an abstract reason",
  "recovery new-task": "Retire recovery state for unrelated work",
  "settings": "Open interactive settings",
  "mode balanced": "Plan, consequential decisions, final abstract review (default)",
  "mode local-led": "Plan then execute locally",
  "mode cloud-led": "Cloud proposes one step at a time",
  "planning on": "Require abstract cloud planning before execution tools",
  "planning off": "Disable planning enforcement",
  "on": "Enable advisor nudge for this session",
  "off": "Disable advisor nudge for this session",
  "status": "Show gate state + resolved advisor model",
  "model omp": "Choose from OMP instance models",
  "source omp": "Use OMP model registry and credentials",
  "source config": "Use configured endpoints",
  "model": "Select advisor model (model clear resets)",
};

export function registerAdvisorCommand(
  pi: ExtensionAPI,
  forContext: (ctx: ExtensionCommandContext) => AdvisorCommandActions,
  modelOptions: () => Array<{ label: string; description: string }>,
): void {
  pi.registerCommand("omni-advisor", {
    description:
      "Open advisor settings (or use on/off/status/model/mode commands)",
    getArgumentCompletions(arg: string) {
      const text = arg || "";
      const modelWord = text.match(/^model[ \t]+(\S*)$/i);
      if (modelWord) {
        const prefix = modelWord[1].toLowerCase();
        const items = modelOptions().filter(({ label }) => {
          const value = label.toLowerCase();
          return value.startsWith(prefix) || value.slice(value.indexOf("/") + 1).startsWith(prefix);
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
      const matches = Object.entries(subcommands)
        .filter(([label]) => label.startsWith(p))
        .map(([label, description]) => ({
          label,
          value: label === "recovery override" ? label + " " : label,
          description,
        }));
      return matches.length ? matches : null;
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
        const noticeQueued = actions.setCloudAccess(command === "on");
        ctx.ui.notify(
          `omni-advisor: cloud advisor nudge ${command === "on" ? "ENABLED" : "DISABLED"} for this session (persisted across restarts).${noticeQueued ? " The agent will be notified on your next prompt." : ""}`,
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
