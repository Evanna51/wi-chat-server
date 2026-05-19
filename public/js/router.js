export function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return { route: "home" };
  if (parts[0] === "search") return { route: "search" };
  if (parts[0] === "plans") return { route: "plans" };
  if (parts[0] === "character" && parts[1]) {
    return {
      route: "character",
      assistantId: decodeURIComponent(parts[1]),
      tab: parts[2] || "overview",
    };
  }
  return { route: "home" };
}

export async function dispatch() {
  const r = parseHash();
  if (r.route === "home") {
    const m = await import("./pages/home.js");
    return m.viewHome();
  }
  if (r.route === "search") {
    const m = await import("./pages/search.js");
    return m.viewSearch();
  }
  if (r.route === "plans") {
    const m = await import("./pages/plans.js");
    return m.viewPlans();
  }
  if (r.route === "character") {
    const m = await import("./pages/character.js");
    return m.viewCharacter(r.assistantId, r.tab);
  }
  const m = await import("./pages/home.js");
  return m.viewHome();
}
