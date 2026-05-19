export const root = () => document.getElementById("app-root");

export function clearRoot() {
  const node = root();
  node.innerHTML = "";
  return node;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== false && v !== null && v !== undefined) {
      node.setAttribute(k, v);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

export function showToast(message, kind = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  container.appendChild(node);
  setTimeout(() => {
    node.classList.add("toast--leaving");
    setTimeout(() => node.remove(), 300);
  }, 2200);
}

export function startHealthPing() {
  const dot = document.getElementById("health-indicator");
  if (!dot) return;
  let active = true;
  async function tick() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (j && j.ok) {
        dot.className = "health-dot health-dot--ok";
        dot.title = `up | ts=${j.ts}`;
      } else {
        dot.className = "health-dot health-dot--bad";
      }
    } catch {
      dot.className = "health-dot health-dot--bad";
    }
    if (active) setTimeout(tick, 1000);
  }
  tick();
}
