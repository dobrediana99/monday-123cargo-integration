import { config, type IntegrationAction } from "../utils/config.js";

export type RoutedAction = {
  integration: string;
  action: IntegrationAction;
};

function normalizeLabel(label: string): string {
  return (label ?? "")
    .trim()
    .toLowerCase()
    .replace(/ă/g, "a")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/ș/g, "s")
    .replace(/ş/g, "s")
    .replace(/ț/g, "t")
    .replace(/ţ/g, "t");
}

export class StatusRouter {
  private readonly routes: Map<string, RoutedAction[]>;

  constructor() {
    this.routes = new Map<string, RoutedAction[]>();
    for (const [status, actions] of Object.entries(config.statusActions)) {
      this.routes.set(normalizeLabel(status), actions);
    }
  }

  resolve(statusLabel: string): RoutedAction[] {
    const key = normalizeLabel(statusLabel);
    if (!key) return [];
    return this.routes.get(key) || [];
  }
}
