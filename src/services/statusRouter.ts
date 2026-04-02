const PUBLISH_TRIGGER_LABEL = "de publicat";
const SITE_TO_INTEGRATION: Record<string, string> = {
  cargopedia: "cargopedia",
  "bursa(123cargo)": "123cargo",
  "123cargo": "123cargo",
  timocom: "timocom",
  "trans.eu": "transeu",
  "trans eu": "transeu",
  transeu: "transeu",
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
  isPublishTrigger(statusLabel: string): boolean {
    const key = normalizeLabel(statusLabel);
    if (!key) return false;
    return key === PUBLISH_TRIGGER_LABEL;
  }

  resolveIntegrationsFromSite(siteText: string): string[] {
    const rawSiteText = String(siteText ?? "");
    const tokens = rawSiteText
      .split(/[;,|]/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (!tokens.length && rawSiteText.trim()) {
      tokens.push(rawSiteText.trim());
    }

    const integrations = tokens
      .map((token) => SITE_TO_INTEGRATION[normalizeLabel(token)] ?? null)
      .filter((value): value is string => Boolean(value));

    return Array.from(new Set(integrations));
  }
}
