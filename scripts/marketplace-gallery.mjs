const DEFAULT_MARKETPLACE_URL = 'https://marketplace.visualstudio.com';
const EXTENSION_NAME_FILTER = 7;
const INCLUDE_VERSIONS_FLAG = 1;

export function normalizeMarketplaceUrl(value = DEFAULT_MARKETPLACE_URL) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Marketplace URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Marketplace URL must not contain credentials or use another protocol');
  }
  return url.toString().replace(/\/$/, '');
}

export function buildGalleryRequest(publisher, name) {
  const extensionId = `${publisher}.${name}`;
  return {
    urlPath: '/_apis/public/gallery/extensionquery',
    headers: {
      Accept: 'application/json;api-version=3.0-preview.1',
      'Content-Type': 'application/json',
    },
    body: {
      filters: [{
        pageNumber: 1,
        pageSize: 100,
        criteria: [{ filterType: EXTENSION_NAME_FILTER, value: extensionId }],
      }],
      flags: INCLUDE_VERSIONS_FLAG,
    },
  };
}

export async function queryGallery({ marketplaceUrl, publisher, name, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const request = buildGalleryRequest(publisher, name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${normalizeMarketplaceUrl(marketplaceUrl)}${request.urlPath}`, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) throw new GalleryRequestError(`Marketplace query failed with HTTP ${response.status}`, response.status);
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new GalleryRequestError(`Marketplace query returned invalid JSON: ${errorMessage(error)}`);
    }
    return summarizeGalleryResponse(payload, publisher, name);
  } catch (error) {
    if (error?.name === 'AbortError') throw new GalleryRequestError('Marketplace query timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function pollGalleryVersion({ marketplaceUrl, publisher, name, version, timeoutMs, intervalMs, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const result = await queryGallery({ marketplaceUrl, publisher, name, fetchImpl });
      const versionPresent = result.versions.some(
        (candidate) => candidate.toLowerCase() === version.toLowerCase(),
      );
      if (versionPresent) return { ...result, versionPresent, attempts: result.attempts ?? 1 };
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }
  if (lastError !== undefined) throw lastError;
  const result = await queryGallery({ marketplaceUrl, publisher, name, fetchImpl });
  return {
    ...result,
    versionPresent: result.versions.some(
      (candidate) => candidate.toLowerCase() === version.toLowerCase(),
    ),
  };
}

export class GalleryRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GalleryRequestError';
    this.status = status;
  }
}

function summarizeGalleryResponse(payload, publisher, name) {
  const extensions = Array.isArray(payload?.results)
    ? payload.results.flatMap((result) => Array.isArray(result?.extensions) ? result.extensions : [])
    : [];
  const extension = extensions.find((candidate) => candidate?.extensionName?.toLowerCase() === name.toLowerCase()
    && candidate?.publisher?.publisherName?.toLowerCase() === publisher.toLowerCase());
  const versions = Array.isArray(extension?.versions)
    ? extension.versions.map((entry) => entry?.version).filter((value) => typeof value === 'string')
    : [];
  return {
    extensionFound: extension !== undefined,
    versionPresent: false,
    versions,
    extension: extension === undefined ? undefined : {
      name: extension.extensionName,
      publisher: extension.publisher?.publisherName,
      versionCount: versions.length,
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
