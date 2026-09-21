import { currentVisitorId } from './visitor-context.js';

const visitorMetadataKey = 'cekat_visitor_id';

export function metadataForVisitor(visitorId: string | undefined): Record<string, string> {
  const normalizedVisitorId = validVisitorId(visitorId);
  return normalizedVisitorId === undefined ? {} : { [visitorMetadataKey]: normalizedVisitorId };
}

export function metadataFromCurrentVisitor(): Record<string, string> {
  return metadataForVisitor(currentVisitorId());
}

export function mergeMetadata(metadata: Readonly<Record<string, string>>, visitorId: string | undefined): Record<string, string> {
  const merged = { ...metadata };
  const normalizedVisitorId = validVisitorId(visitorId);
  if (normalizedVisitorId !== undefined) merged[visitorMetadataKey] = normalizedVisitorId;
  return merged;
}

function validVisitorId(visitorId: string | undefined): string | undefined {
  if (visitorId === undefined) return undefined;
  const normalizedVisitorId = visitorId.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(normalizedVisitorId) ? normalizedVisitorId : undefined;
}
