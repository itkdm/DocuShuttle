function normalizePackagePath(value: string): string | undefined {
  const parts: string[] = [];
  if (value.includes("\\") || value.includes("?") || value.includes("#")) return undefined;
  for (const encodedPart of value.split("/")) {
    let part: string;
    try { part = decodeURIComponent(encodedPart); } catch { return undefined; }
    if (!part || part === ".") continue;
    if (part.includes("/") || part.includes("\\") || /[\u0000-\u001f\u007f]/.test(part)) return undefined;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function relationshipBase(relsPath: string): string | undefined {
  if (relsPath === "_rels/.rels") return "";
  const match = /^(.*)\/_rels\/[^/]+\.rels$/.exec(relsPath);
  return match ? match[1] : undefined;
}

export function relationshipSource(relsPath: string): string | undefined {
  if (relsPath === "_rels/.rels") return undefined;
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(relsPath);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function resolveRelationshipTarget(relsPath: string, target: string): string | undefined {
  const base = relationshipBase(relsPath);
  if (base === undefined) return undefined;
  return normalizePackagePath(target.startsWith("/") ? target.slice(1) : `${base}/${target}`);
}
