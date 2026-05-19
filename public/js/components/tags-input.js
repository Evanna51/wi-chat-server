// ─── 多标签输入（vis-tags）─────────────────────────────────────────
// 已选 tag 一行 + 输入框（Enter 或 ; 触发添加）+ 推荐项一行（点击加进去）。
// API: makeTagsInput({ values, suggestions, suggestionsZhMap, onChange }) → {root, getValues}
export function makeTagsInput({ values = [], suggestions = [], suggestionsZhMap = null, allowCustom = true }) {
  const root = document.createElement("div");
  root.className = "vis-tags";
  const list = document.createElement("div");
  list.className = "vis-tags__list";
  const input = document.createElement("input");
  input.className = "vis-tags__input";
  input.type = "text";
  input.placeholder = allowCustom ? "输入自定义内容，按 ; 或 Enter 添加" : "点击下方推荐项添加";
  list.appendChild(input);
  root.appendChild(list);

  // 推荐项区：默认折叠，点开显示。用 <details> 自带的展开/收起。
  const suggestRow = document.createElement("div");
  suggestRow.className = "vis-tags__suggest";
  let suggestWrap = null;
  if (suggestions.length) {
    suggestWrap = document.createElement("details");
    suggestWrap.className = "vis-tags__suggest-wrap";
    const sum = document.createElement("summary");
    sum.className = "vis-tags__suggest-summary";
    sum.textContent = `推荐 ${suggestions.length} 项（点击展开）`;
    suggestWrap.appendChild(sum);
    for (const s of suggestions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "vis-tags__suggest-chip";
      chip.dataset.val = s;
      const zh = suggestionsZhMap?.[s];
      chip.innerHTML = zh ? `${s}<span class="vis-tags__chip-zh">${zh}</span>` : s;
      suggestRow.appendChild(chip);
    }
    suggestWrap.appendChild(suggestRow);
    root.appendChild(suggestWrap);
  }

  let current = [...values];
  function renderTags() {
    // 清掉已渲染的 tag（保留 input）
    list.querySelectorAll(".vis-tags__tag").forEach((n) => n.remove());
    for (const v of current) {
      const tag = document.createElement("span");
      tag.className = "vis-tags__tag";
      const txt = document.createElement("span");
      txt.textContent = v;
      const zh = suggestionsZhMap?.[v];
      if (zh) {
        const zhSpan = document.createElement("span");
        zhSpan.className = "vis-tags__chip-zh";
        zhSpan.textContent = zh;
        tag.appendChild(txt);
        tag.appendChild(zhSpan);
      } else {
        tag.appendChild(txt);
      }
      const x = document.createElement("button");
      x.type = "button";
      x.className = "vis-tags__remove";
      x.textContent = "×";
      x.title = "移除";
      x.dataset.val = v;
      tag.appendChild(x);
      list.insertBefore(tag, input);
    }
    // 已选过的推荐项：高亮
    suggestRow.querySelectorAll(".vis-tags__suggest-chip").forEach((c) => {
      c.classList.toggle("is-picked", current.includes(c.dataset.val));
    });
  }
  function add(v) {
    const trimmed = String(v || "").trim().replace(/[;；]+$/, "").trim();
    if (!trimmed) return;
    if (current.includes(trimmed)) return;
    current.push(trimmed);
    renderTags();
  }
  function remove(v) {
    current = current.filter((x) => x !== v);
    renderTags();
  }
  // input: Enter / ; / ；触发提交
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === ";" || ev.key === "；") {
      ev.preventDefault();
      add(input.value);
      input.value = "";
    } else if (ev.key === "Backspace" && !input.value && current.length) {
      // 空输入框 + Backspace → 删最后一个
      current.pop();
      renderTags();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) {
      add(input.value);
      input.value = "";
    }
  });
  list.addEventListener("click", (ev) => {
    const x = ev.target.closest(".vis-tags__remove");
    if (x) remove(x.dataset.val);
  });
  suggestRow.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".vis-tags__suggest-chip");
    if (chip) add(chip.dataset.val);
  });

  renderTags();
  return {
    root,
    getValues: () => [...current],
  };
}
