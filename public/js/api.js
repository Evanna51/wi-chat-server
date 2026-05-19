const DEFAULT_API_KEY = "dev-local-key";

export function getApiKey() {
  try {
    return localStorage.getItem("apiKey") || DEFAULT_API_KEY;
  } catch {
    return DEFAULT_API_KEY;
  }
}

export async function request(method, path, { params, body } = {}) {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, v);
    }
  }
  const init = {
    method,
    headers: {
      "x-api-key": getApiKey(),
    },
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), init);
  const json = await res.json().catch(() => ({ ok: false, error: `bad_json_${res.status}` }));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `http_${res.status}`);
    err.payload = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

export const api = {
  get: (path, params) => request("GET", path, { params }),
  post: (path, body) => request("POST", path, { body }),
  patch: (path, body) => request("PATCH", path, { body }),
  del: (path) => request("DELETE", path, {}),
};
