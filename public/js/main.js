import { startHealthPing } from "./el.js";
import { dispatch } from "./router.js";

window.addEventListener("hashchange", dispatch);
window.addEventListener("DOMContentLoaded", () => {
  startHealthPing();
  dispatch();
});
