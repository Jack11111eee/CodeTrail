/**
 * Progressive enhancement for the server-rendered learning UI (architecture
 * §15, §18.2). This is the only file in `ui/` that touches the DOM.
 *
 * Everything it does is optional: without JavaScript the pages are still
 * readable, the forms simply do not submit. It never renders untrusted text as
 * HTML (`textContent` only) and never evaluates a string.
 */

interface JsonResult {
  ok: boolean;
  body: unknown;
}

async function requestJson(
  url: string,
  method: string,
  body?: unknown,
): Promise<JsonResult> {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { ok: response.ok, body: parsed };
}

function setStatus(form: HTMLElement, message: string): void {
  let status = form.querySelector<HTMLElement>("[data-form-status]");
  if (status === null) {
    status = document.createElement("p");
    status.setAttribute("data-form-status", "true");
    form.appendChild(status);
  }
  status.textContent = message;
}

function valueOf(form: HTMLFormElement, name: string): string {
  const data = new FormData(form);
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function wireProjectForms(): void {
  const forms = document.querySelectorAll<HTMLFormElement>(
    "form[data-project-kind]",
  );
  forms.forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const kind = form.getAttribute("data-project-kind");
      let payload: Record<string, unknown>;
      if (kind === "local") {
        payload = { localPath: valueOf(form, "localPath") };
      } else {
        payload = { githubUrl: valueOf(form, "githubUrl") };
        // `ref` is optional on the API; an empty string fails validation.
        const ref = valueOf(form, "ref");
        if (ref !== "") payload.ref = ref;
      }
      void requestJson("/api/projects", "POST", payload).then((result) => {
        if (result.ok) {
          window.location.assign("/");
          return;
        }
        setStatus(form, "添加失败，请检查路径或 URL。");
      });
    });
  });
}

function wireRemoval(): void {
  const panel = document.querySelector<HTMLElement>(
    "[data-testid='project-dependents']",
  );
  const form = document.querySelector<HTMLFormElement>("[data-remove-project]");
  if (panel === null || form === null) return;

  document
    .querySelectorAll<HTMLElement>("[data-select-project]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const projectId = button.getAttribute("data-select-project") ?? "";
        form.setAttribute("data-project-id", projectId);
        panel.setAttribute("data-project-id", projectId);
        void requestJson(
          `/api/projects/${encodeURIComponent(projectId)}/dependents`,
          "GET",
        ).then((result) => {
          const list = panel.querySelector<HTMLElement>(".dependent-list");
          if (list === null) return;
          list.textContent = "";
          if (
            !result.ok ||
            typeof result.body !== "object" ||
            result.body === null
          ) {
            setStatus(panel, "无法读取依赖。");
            return;
          }
          const dependents = result.body as Record<string, unknown>;
          for (const key of [
            "conversations",
            "lessons",
            "generations",
            "changeEvents",
          ]) {
            const entry = dependents[key];
            const rawCount =
              typeof entry === "object" && entry !== null && "count" in entry
                ? (entry as { count?: unknown }).count
                : undefined;
            const count = typeof rawCount === "number" ? String(rawCount) : "0";
            const item = document.createElement("li");
            item.textContent = `${key}: ${count}`;
            list.appendChild(item);
          }
          const confirm = form.querySelector<HTMLInputElement>(
            "input[type='checkbox']",
          );
          const submit = form.querySelector<HTMLButtonElement>("button");
          if (confirm !== null) confirm.disabled = false;
          if (submit !== null) submit.disabled = false;
        });
      });
    });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectId = form.getAttribute("data-project-id") ?? "";
    if (projectId === "") {
      setStatus(form, "请先选择一个项目。");
      return;
    }
    void requestJson(
      `/api/projects/${encodeURIComponent(projectId)}?confirm=true`,
      "DELETE",
    ).then((result) => {
      if (result.ok) {
        window.location.assign("/");
        return;
      }
      setStatus(form, "移除失败。");
    });
  });
}

function wireDiagramSelection(): void {
  const input = document.querySelector<HTMLTextAreaElement>(
    "[data-testid='qa-input']",
  );
  const sourceField = document.querySelector<HTMLInputElement>(
    "[data-qa-selection-source]",
  );
  const commitField = document.querySelector<HTMLInputElement>(
    "[data-qa-selection-commit]",
  );
  const sourceIdsField = document.querySelector<HTMLInputElement>(
    "[data-qa-selection-source-ids]",
  );
  if (
    input === null ||
    sourceField === null ||
    commitField === null ||
    sourceIdsField === null
  ) {
    return;
  }

  const select = (node: Element): void => {
    const sourceIds = (node.getAttribute("data-evidence-ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    sourceField.value = sourceIds[0] ?? "";
    sourceIdsField.value = sourceIds.join(",");
    commitField.value = node.getAttribute("data-commit-sha") ?? "";
    document.querySelectorAll("[data-diagram-node]").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === node));
    });
    input.focus();
  };

  document.querySelectorAll("[data-diagram-node]").forEach((node) => {
    node.addEventListener("click", () => {
      select(node);
    });
    node.addEventListener("keydown", (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        select(node);
      }
    });
  });
}

function wireQaForm(): void {
  const form = document.querySelector<HTMLFormElement>("[data-qa-form]");
  if (form === null) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = form.querySelector<HTMLTextAreaElement>(
      "[data-testid='qa-input']",
    );
    const text = input === null ? "" : input.value.trim();
    if (text === "") {
      setStatus(form, "请先输入问题。");
      return;
    }
    const sourceField = form.querySelector<HTMLInputElement>(
      "[data-qa-selection-source]",
    );
    const sourceIdsField = form.querySelector<HTMLInputElement>(
      "[data-qa-selection-source-ids]",
    );
    const commitField = form.querySelector<HTMLInputElement>(
      "[data-qa-selection-commit]",
    );
    const sourceId = sourceField?.value ?? "";
    const sourceIds = (sourceIdsField?.value ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const commitSha = commitField?.value ?? "";
    const body: Record<string, unknown> = { text };
    // A diagram click submits the full evidence list and the commit the
    // generation was analysed at — never the repository's latest head.
    if (sourceId !== "") {
      const selection: Record<string, unknown> = { sourceId };
      if (sourceIds.length > 0) selection.sourceIds = sourceIds;
      if (commitSha !== "") selection.commitSha = commitSha;
      body.selection = selection;
    }

    const conversationId = form.getAttribute("data-conversation-id") ?? "";
    const send = (id: string): void => {
      void requestJson(
        `/api/conversations/${encodeURIComponent(id)}/messages`,
        "POST",
        body,
      ).then((result) => {
        if (result.ok) {
          window.location.reload();
          return;
        }
        setStatus(form, "发送失败。");
      });
    };

    if (conversationId !== "") {
      send(conversationId);
      return;
    }
    const generationId = form.getAttribute("data-generation-id") ?? "";
    if (generationId === "") {
      setStatus(form, "请先选择一个生成版本。");
      return;
    }
    void requestJson("/api/conversations", "POST", {
      generationIds: [generationId],
    }).then((result) => {
      const created =
        typeof result.body === "object" && result.body !== null
          ? (result.body as { conversationId?: unknown }).conversationId
          : null;
      if (!result.ok || typeof created !== "string" || created === "") {
        setStatus(form, "无法创建会话。");
        return;
      }
      send(created);
    });
  });
}

function wirePreferences(): void {
  const form = document.querySelector<HTMLFormElement>(
    "[data-preferences-form]",
  );
  if (form === null) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void requestJson("/api/preferences", "PUT", {
      explainLevel: valueOf(form, "explainLevel"),
      background: valueOf(form, "background"),
    }).then((result) => {
      setStatus(form, result.ok ? "已保存。" : "保存失败。");
    });
  });
}

function wireReadingPosition(): void {
  const form = document.querySelector<HTMLFormElement>(
    "[data-reading-position-form]",
  );
  if (form === null) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const generationId = form.getAttribute("data-generation-id") ?? "";
    const lessonId = form.getAttribute("data-lesson-id") ?? "";
    const offset = Number(valueOf(form, "offset"));
    if (generationId === "" || lessonId === "" || !Number.isFinite(offset)) {
      setStatus(form, "阅读位置无效。");
      return;
    }
    void requestJson("/api/preferences", "PUT", {
      readingPosition: { generationId, lessonId, offset },
    }).then((result) => {
      setStatus(form, result.ok ? "已保存。" : "保存失败。");
    });
  });
}

function wireWatchRefresh(): void {
  const button = document.querySelector<HTMLButtonElement>(
    "[data-testid='settings-watch-refresh']",
  );
  const toggle = document.querySelector<HTMLInputElement>(
    "[data-testid='settings-watch-toggle']",
  );
  const panel = document.querySelector<HTMLElement>("[data-watch-panel]");
  if (button === null || panel === null) return;

  const projectIdOf = (): string => panel.getAttribute("data-project-id") ?? "";

  button.addEventListener("click", () => {
    const projectId = projectIdOf();
    if (projectId === "") {
      button.textContent = "请先选择项目";
      return;
    }
    button.disabled = true;
    void requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/watch`,
      "PUT",
      { enabled: true, refreshNow: true },
    ).then((result) => {
      button.disabled = false;
      // Only claim the refresh was queued once the API accepted it.
      button.textContent = result.ok ? "手动刷新已在后台排队" : "刷新失败";
    });
  });

  if (toggle !== null && !toggle.disabled) {
    toggle.addEventListener("change", () => {
      const projectId = projectIdOf();
      if (projectId === "") {
        toggle.checked = !toggle.checked;
        return;
      }
      void requestJson(
        `/api/projects/${encodeURIComponent(projectId)}/watch`,
        "PUT",
        { enabled: toggle.checked },
      ).then((result) => {
        if (!result.ok) {
          toggle.checked = !toggle.checked;
          setStatus(panel, "保存失败。");
        }
      });
    });
  }
}

function main(): void {
  wireProjectForms();
  wireRemoval();
  wireDiagramSelection();
  wireQaForm();
  wirePreferences();
  wireReadingPosition();
  wireWatchRefresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}

export {};
