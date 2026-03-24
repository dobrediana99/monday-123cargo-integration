const PUBLISH_TRIGGER_LABEL = "de publicat";

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
  isPublishTrigger(statusLabel: string): boolean {
    const key = normalizeLabel(statusLabel);
    if (!key) return false;
    return key === PUBLISH_TRIGGER_LABEL;
  }
}
