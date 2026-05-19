// ─── 自定义 select（vis-combo）───────────────────────────────────────
// 替代原生 <select>：可控 option 高度、可显示中文释义。返回 {root, getValue, setValue}。
export function makeCombo({ value, options, placeholder = "(unset)", onChange }) {
  // options: [{ value, label, zh? }]
  const root = document.createElement("div");
  root.className = "vis-combo";
  let current = value || "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "vis-combo__trigger";
  const panel = document.createElement("div");
  panel.className = "vis-combo__panel";
  panel.hidden = true;
  root.appendChild(trigger);
  root.appendChild(panel);

  function renderTrigger() {
    if (!current) {
      trigger.innerHTML = `<span class="vis-combo__placeholder">${placeholder}</span>`;
      return;
    }
    const opt = options.find((o) => o.value === current);
    if (!opt) {
      trigger.textContent = current;
      return;
    }
    trigger.innerHTML = "";
    const v = document.createElement("span");
    v.className = "vis-combo__val";
    v.textContent = opt.value;
    const z = document.createElement("span");
    z.className = "vis-combo__zh";
    z.textContent = opt.zh || "";
    trigger.appendChild(v);
    if (opt.zh) trigger.appendChild(z);
  }
  function renderPanel() {
    panel.innerHTML = "";
    // unset / 占位也算一个选项
    const unsetItem = document.createElement("div");
    unsetItem.className = "vis-combo__opt" + (!current ? " is-active" : "");
    unsetItem.dataset.val = "";
    unsetItem.textContent = placeholder;
    panel.appendChild(unsetItem);

    for (const o of options) {
      const item = document.createElement("div");
      item.className = "vis-combo__opt" + (o.value === current ? " is-active" : "");
      item.dataset.val = o.value;
      const v = document.createElement("span");
      v.className = "vis-combo__val";
      v.textContent = o.value;
      item.appendChild(v);
      if (o.zh) {
        const z = document.createElement("span");
        z.className = "vis-combo__zh";
        z.textContent = o.zh;
        item.appendChild(z);
      }
      panel.appendChild(item);
    }
  }
  function close() {
    panel.hidden = true;
    root.classList.remove("is-open");
  }
  function open() {
    closeAllCombos(root);
    panel.hidden = false;
    root.classList.add("is-open");
  }
  trigger.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (panel.hidden) open();
    else close();
  });
  panel.addEventListener("click", (ev) => {
    const item = ev.target.closest(".vis-combo__opt");
    if (!item) return;
    current = item.dataset.val;
    renderTrigger();
    renderPanel();
    close();
    onChange?.(current);
  });

  renderTrigger();
  renderPanel();

  return {
    root,
    getValue: () => current,
    setValue: (v) => { current = v || ""; renderTrigger(); renderPanel(); },
  };
}

// 全局：点击其它地方关闭所有 open combo
export function closeAllCombos(except) {
  document.querySelectorAll(".vis-combo.is-open").forEach((c) => {
    if (c !== except) {
      c.classList.remove("is-open");
      c.querySelector(".vis-combo__panel").hidden = true;
    }
  });
}

document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".vis-combo")) closeAllCombos(null);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeAllCombos(null);
});
