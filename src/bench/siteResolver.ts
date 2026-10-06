import { readConfig, writeConfig } from '../workspace/structure';

export interface ShellResult {
  success: boolean;
  output: string;
}

export interface SiteResolution {
  site: string | null;
  /** Why no site could be chosen, or how it was found. */
  note: string;
}

/** Lists the bench's site facts from inside the bench (works for Docker
 *  benches, whose sites/ folder isn't visible on the host). */
const PROBE = [
  'echo "CURRENT:$(cat sites/currentsite.txt 2>/dev/null)"',
  `echo "DEFAULT:$(python3 -c "import json;print(json.load(open('sites/common_site_config.json')).get('default_site') or '')" 2>/dev/null)"`,
  'for s in sites/*/; do [ -f "$s/site_config.json" ] && echo "SITE:${s#sites/}"; done',
].join('; ');

/** Picks the site tools should run against when the model doesn't name one:
 *  the saved default, else what the bench itself says (currentsite.txt, then
 *  common_site_config's default_site, then its only site). A detected site is
 *  saved as the default so the rest of the extension uses it too. */
export class SiteResolver {
  private detected: string | null = null;

  constructor(private runInBench: (script: string) => Promise<ShellResult>) {}

  async resolve(explicit?: string): Promise<SiteResolution> {
    if (explicit && clean(explicit)) return { site: clean(explicit), note: 'given' };
    const saved = clean(readConfig()?.defaultSite || '');
    if (saved) return { site: saved, note: 'saved default' };
    if (this.detected) return { site: this.detected, note: 'detected' };
    return this.detect();
  }

  /** Forget a cached detection (bench changed). */
  reset(): void {
    this.detected = null;
  }

  private async detect(): Promise<SiteResolution> {
    const res = await this.runInBench(PROBE);
    const lines = res.output.split(/\r?\n/).map(l => l.trim());
    const value = (tag: string) => clean(lines.find(l => l.startsWith(tag + ':'))?.slice(tag.length + 1) || '');
    const sites = lines.filter(l => l.startsWith('SITE:')).map(l => clean(l.slice(5).replace(/\/$/, ''))).filter(Boolean);

    const known = (s: string) => !!s && (sites.length === 0 || sites.includes(s));
    const pick = [value('CURRENT'), value('DEFAULT')].find(known) || (sites.length === 1 ? sites[0] : '');
    if (pick) {
      this.detected = pick;
      saveDefault(pick);
      return { site: pick, note: 'detected' };
    }
    if (sites.length > 1) {
      return { site: null, note: `This bench has several sites (${sites.join(', ')}) and none is marked current. Pass the "site" argument, or set one with: bench use <site>` };
    }
    if (!res.success && sites.length === 0) {
      return { site: null, note: `Couldn't read the bench's sites (is the bench/container running?): ${res.output.slice(0, 300)}` };
    }
    return { site: null, note: 'No sites found in this bench. Create one with: bench new-site <name>' };
  }
}

/** `bench list-sites` marks the current site with "* " — never keep it. */
function clean(site: string): string {
  return site.replace(/^\*+\s*/, '').trim();
}

function saveDefault(site: string): void {
  const config = readConfig();
  if (!config) return;
  config.defaultSite = site;
  writeConfig(config);
}
