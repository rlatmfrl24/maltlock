import type { TargetSite } from "../types/contracts";

export const targetSites: TargetSite[] = [
  {
    id: "kissjav-most-popular-week",
    name: "KissJAV",
    url: "https://kissjav.com/most-popular/?sort_by=video_viewed_week",
    matchPatterns: ["https://kissjav.com/*"],
    parserId: "kissjav-most-popular-week",
  },
  {
    id: "missav-weekly-views",
    name: "MissAV",
    url: "https://missav123.to/ko/all?sort=weekly_views",
    matchPatterns: ["https://missav123.to/*"],
    parserId: "missav-weekly-views",
  },
  {
    id: "twidouga-ranking-t1",
    name: "TwiDouga",
    url: "https://www.twidouga.net/ko/ranking_t1.php",
    matchPatterns: ["https://www.twidouga.net/*"],
    parserId: "twidouga-ranking-t1",
  },
  {
    id: "torrentbot-topic-top20",
    name: "TorrentBot",
    url: "https://torrentbot230.site/topic/index?top=20",
    matchPatterns: ["https://torrentbot230.site/*"],
    parserId: "torrentbot-topic-top20",
  },
  {
    id: "kone-pornvideo-hot",
    name: "Kone",
    url: "https://kone.gg/s/pornvideo?mode=hot",
    matchPatterns: ["https://kone.gg/*"],
    parserId: "kone-pornvideo-hot",
  },
  {
    id: "tcafe-d2001-hot-best",
    name: "Tcafe",
    url: "https://tcafe21.com/bbs/board.php?bo_table=D2001",
    matchPatterns: ["https://tcafe21.com/*"],
    parserId: "tcafe-d2001-hot-best",
  },
];

export const hostMatchPatterns = Array.from(
  new Set(targetSites.flatMap((site) => site.matchPatterns)),
);

export function getTargetSiteById(siteId: string): TargetSite | undefined {
  return targetSites.find((site) => site.id === siteId);
}

function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPatternRegex(pattern: string): RegExp {
  const escaped = escapeForRegex(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const patternRegexCache = new Map<string, RegExp>();

function getPatternRegex(pattern: string): RegExp {
  const cached = patternRegexCache.get(pattern);
  if (cached) {
    return cached;
  }

  const compiled = toPatternRegex(pattern);
  patternRegexCache.set(pattern, compiled);
  return compiled;
}

function sameOrigin(first: string, second: string): boolean {
  try {
    return new URL(first).origin === new URL(second).origin;
  } catch {
    return false;
  }
}

export function siteMatchesUrl(
  site: TargetSite,
  url: string,
  configuredUrl?: string,
): boolean {
  if (
    configuredUrl &&
    configuredUrl.trim() &&
    sameOrigin(configuredUrl, url)
  ) {
    return true;
  }

  return site.matchPatterns.some((pattern) =>
    getPatternRegex(pattern).test(url),
  );
}
