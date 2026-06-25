import "@logseq/libs";
import "./style.css";

type StyleAction = "bold" | "italic" | "highlight" | "page";

type SelectionPayload = {
  text: string;
  start: number;
  end: number;
  point: {
    x: number;
    y: number;
  };
};

type SelectionState = {
  blockUuid: string;
  text: string;
  start: number;
  end: number;
  content: string;
};

type ToggleResult = {
  content: string;
  cursorPos: number;
};

type RangeRemovalResult = {
  content: string;
  start: number;
  end: number;
};

const TOOLBAR_WIDTH = 188;
const TOOLBAR_HEIGHT = 42;
const TOOLBAR_OFFSET_Y = 10;
const SELECTION_IGNORE_MS = 1000;
const APPLY_UNLOCK_MS = 400;
const SELECTION_GUARD_INTERVAL_MS = 300;

let selectionState: SelectionState | null = null;
let isApplyingFormat = false;
let ignoreSelectionUntil = 0;
let selectionGuardInterval: number | null = null;
let isPointerInsideToolbar = false;

const toolbar = document.getElementById(
  "logseq-format-toolbar",
) as HTMLDivElement;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeSelection(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function showMessage(message: string, type: "warning" | "error" = "warning") {
  const ui = logseq.UI as unknown as {
    showMsg?: (message: string, type?: string) => void;
  };

  if (ui.showMsg) {
    ui.showMsg(message, type);
  } else {
    console.warn(message);
  }
}

function syncThemeVariables() {
  const variableNames = [
    "--ls-primary-background-color",
    "--ls-secondary-background-color",
    "--ls-tertiary-background-color",
    "--ls-quaternary-background-color",
    "--ls-primary-text-color",
    "--ls-secondary-text-color",
    "--ls-border-color",
    "--ls-link-text-color",
    "--ls-active-primary-color",
    "--ls-selection-background-color",
    "--ls-page-properties-background-color",
  ];

  try {
    const parentWindow = window.parent;
    const parentDocument = parentWindow.document;

    const rootStyle = parentWindow.getComputedStyle(
      parentDocument.documentElement,
    );

    const bodyStyle = parentDocument.body
      ? parentWindow.getComputedStyle(parentDocument.body)
      : null;

    for (const variableName of variableNames) {
      const rootValue = rootStyle.getPropertyValue(variableName).trim();
      const bodyValue = bodyStyle?.getPropertyValue(variableName).trim() ?? "";
      const value = rootValue || bodyValue;

      if (value) {
        document.documentElement.style.setProperty(variableName, value);
      }
    }
  } catch {
    // Fallbacks in style.css keep the toolbar usable.
  }
}

function countRunBefore(
  content: string,
  indexExclusive: number,
  char: string,
): number {
  let count = 0;

  for (let i = indexExclusive - 1; i >= 0; i--) {
    if (content[i] !== char) {
      break;
    }

    count++;
  }

  return count;
}

function countRunAfter(
  content: string,
  indexInclusive: number,
  char: string,
): number {
  let count = 0;

  for (let i = indexInclusive; i < content.length; i++) {
    if (content[i] !== char) {
      break;
    }

    count++;
  }

  return count;
}

function hasAround(
  content: string,
  start: number,
  end: number,
  left: string,
  right: string,
): boolean {
  return (
    start >= left.length &&
    end + right.length <= content.length &&
    content.slice(start - left.length, start) === left &&
    content.slice(end, end + right.length) === right
  );
}

function removeAroundSelection(
  content: string,
  start: number,
  end: number,
  leftLength: number,
  rightLength: number,
): ToggleResult {
  const selectedText = content.slice(start, end);

  const updatedContent =
    content.slice(0, start - leftLength) +
    selectedText +
    content.slice(end + rightLength);

  return {
    content: updatedContent,
    cursorPos: start - leftLength + selectedText.length,
  };
}

function removeInsideSelection(
  content: string,
  start: number,
  end: number,
  leftLength: number,
  rightLength: number,
): ToggleResult {
  const selectedText = content.slice(start, end);
  const unwrappedText = selectedText.slice(
    leftLength,
    selectedText.length - rightLength,
  );

  const updatedContent =
    content.slice(0, start) + unwrappedText + content.slice(end);

  return {
    content: updatedContent,
    cursorPos: start + unwrappedText.length,
  };
}

function wrapSelection(
  content: string,
  start: number,
  end: number,
  left: string,
  right: string,
): ToggleResult {
  const selectedText = content.slice(start, end);

  const updatedContent =
    content.slice(0, start) +
    left +
    selectedText +
    right +
    content.slice(end);

  return {
    content: updatedContent,
    cursorPos: start + left.length + selectedText.length + right.length,
  };
}

function isBoldActive(content: string, start: number, end: number): boolean {
  const selectedText = content.slice(start, end);

  if (
    selectedText.startsWith("**") &&
    selectedText.endsWith("**") &&
    selectedText.length >= 4
  ) {
    return true;
  }

  return (
    countRunBefore(content, start, "*") >= 2 &&
    countRunAfter(content, end, "*") >= 2
  );
}

function isItalicActive(content: string, start: number, end: number): boolean {
  const selectedText = content.slice(start, end);

  const selectedStartsWithStars = countRunAfter(selectedText, 0, "*");
  const selectedEndsWithStars = countRunBefore(
    selectedText,
    selectedText.length,
    "*",
  );

  if (
    selectedStartsWithStars >= 1 &&
    selectedEndsWithStars >= 1 &&
    selectedStartsWithStars % 2 === 1 &&
    selectedEndsWithStars % 2 === 1
  ) {
    return true;
  }

  const starRunBefore = countRunBefore(content, start, "*");
  const starRunAfter = countRunAfter(content, end, "*");

  return (
    starRunBefore >= 1 &&
    starRunAfter >= 1 &&
    starRunBefore % 2 === 1 &&
    starRunAfter % 2 === 1
  );
}

function isHighlightActive(content: string, start: number, end: number): boolean {
  const selectedText = content.slice(start, end);

  if (
    selectedText.startsWith("==") &&
    selectedText.endsWith("==") &&
    selectedText.length >= 4
  ) {
    return true;
  }

  return hasAround(content, start, end, "==", "==");
}

function isPageActive(content: string, start: number, end: number): boolean {
  const selectedText = content.slice(start, end);

  if (
    selectedText.startsWith("[[") &&
    selectedText.endsWith("]]") &&
    selectedText.length >= 4
  ) {
    return true;
  }

  return hasAround(content, start, end, "[[", "]]");
}

function toggleBold(content: string, start: number, end: number): ToggleResult {
  const selectedText = content.slice(start, end);

  if (
    selectedText.startsWith("**") &&
    selectedText.endsWith("**") &&
    selectedText.length >= 4
  ) {
    return removeInsideSelection(content, start, end, 2, 2);
  }

  if (
    countRunBefore(content, start, "*") >= 2 &&
    countRunAfter(content, end, "*") >= 2
  ) {
    return removeAroundSelection(content, start, end, 2, 2);
  }

  return wrapSelection(content, start, end, "**", "**");
}

function toggleItalic(content: string, start: number, end: number): ToggleResult {
  const selectedText = content.slice(start, end);

  const selectedStartsWithStars = countRunAfter(selectedText, 0, "*");
  const selectedEndsWithStars = countRunBefore(
    selectedText,
    selectedText.length,
    "*",
  );

  if (
    selectedStartsWithStars >= 1 &&
    selectedEndsWithStars >= 1 &&
    selectedStartsWithStars % 2 === 1 &&
    selectedEndsWithStars % 2 === 1
  ) {
    return removeInsideSelection(content, start, end, 1, 1);
  }

  const starRunBefore = countRunBefore(content, start, "*");
  const starRunAfter = countRunAfter(content, end, "*");

  if (
    starRunBefore >= 1 &&
    starRunAfter >= 1 &&
    starRunBefore % 2 === 1 &&
    starRunAfter % 2 === 1
  ) {
    return removeAroundSelection(content, start, end, 1, 1);
  }

  return wrapSelection(content, start, end, "*", "*");
}

function toggleHighlight(
  content: string,
  start: number,
  end: number,
): ToggleResult {
  const selectedText = content.slice(start, end);

  if (
    selectedText.startsWith("==") &&
    selectedText.endsWith("==") &&
    selectedText.length >= 4
  ) {
    return removeInsideSelection(content, start, end, 2, 2);
  }

  if (hasAround(content, start, end, "==", "==")) {
    return removeAroundSelection(content, start, end, 2, 2);
  }

  return wrapSelection(content, start, end, "==", "==");
}

function togglePage(content: string, start: number, end: number): ToggleResult {
  const selectedText = content.slice(start, end);

  if (
    selectedText.startsWith("[[") &&
    selectedText.endsWith("]]") &&
    selectedText.length >= 4
  ) {
    return removeInsideSelection(content, start, end, 2, 2);
  }

  if (hasAround(content, start, end, "[[", "]]")) {
    return removeAroundSelection(content, start, end, 2, 2);
  }

  const cleanedText = selectedText.replace(/\s+/g, " ").trim();

  if (!cleanedText) {
    return {
      content,
      cursorPos: end,
    };
  }

  const safePageName = cleanedText.replace(/\]\]/g, "］］");

  const updatedContent =
    content.slice(0, start) + `[[${safePageName}]]` + content.slice(end);

  return {
    content: updatedContent,
    cursorPos: start + safePageName.length + 4,
  };
}

function toggleFormat(
  action: StyleAction,
  content: string,
  start: number,
  end: number,
): ToggleResult {
  switch (action) {
    case "bold":
      return toggleBold(content, start, end);

    case "italic":
      return toggleItalic(content, start, end);

    case "highlight":
      return toggleHighlight(content, start, end);

    case "page":
      return togglePage(content, start, end);

    default:
      return {
        content,
        cursorPos: end,
      };
  }
}

function updateActiveButtons(content: string, start: number, end: number) {
  const activeByAction: Record<StyleAction, boolean> = {
    bold: isBoldActive(content, start, end),
    italic: isItalicActive(content, start, end),
    highlight: isHighlightActive(content, start, end),
    page: isPageActive(content, start, end),
  };

  toolbar.querySelectorAll<HTMLButtonElement>("button[data-style]").forEach(
    (button) => {
      const action = button.dataset.style as StyleAction;
      button.classList.toggle("active", activeByAction[action]);
    },
  );
}

function findSelectionRange(
  state: SelectionState,
  latestContent: string,
): { start: number; end: number } | null {
  const directSelection = latestContent.slice(state.start, state.end);

  if (directSelection === state.text) {
    return {
      start: state.start,
      end: state.end,
    };
  }

  const nearbyStart = Math.max(0, state.start - 80);
  const nearbyEnd = Math.min(latestContent.length, state.end + 80);
  const nearbyContent = latestContent.slice(nearbyStart, nearbyEnd);
  const nearbyIndex = nearbyContent.indexOf(state.text);

  if (nearbyIndex >= 0) {
    const start = nearbyStart + nearbyIndex;

    return {
      start,
      end: start + state.text.length,
    };
  }

  const globalIndex = latestContent.indexOf(state.text);

  if (globalIndex >= 0) {
    return {
      start: globalIndex,
      end: globalIndex + state.text.length,
    };
  }

  return null;
}

function stopSelectionGuard() {
  if (selectionGuardInterval !== null) {
    window.clearInterval(selectionGuardInterval);
    selectionGuardInterval = null;
  }
}

function getParentSelectionText(): string | null {
  try {
    const selection = window.parent.getSelection?.();

    if (!selection) {
      return "";
    }

    return selection.toString();
  } catch {
    return null;
  }
}

function startSelectionGuard() {
  stopSelectionGuard();

  selectionGuardInterval = window.setInterval(async () => {
    if (isApplyingFormat || !selectionState || isPointerInsideToolbar) {
      return;
    }

    const state = selectionState;
    const parentSelectionText = getParentSelectionText();

    if (parentSelectionText !== null) {
      const normalizedParentSelection = normalizeSelection(parentSelectionText);
      const normalizedStoredSelection = normalizeSelection(state.text);

      if (!normalizedParentSelection) {
        hideToolbar(false, true);
        return;
      }

      if (
        normalizedStoredSelection &&
        normalizedParentSelection !== normalizedStoredSelection
      ) {
        hideToolbar(false, true);
        return;
      }
    }

    try {
      const currentBlock = await logseq.Editor.getCurrentBlock();

      if (!currentBlock?.uuid || currentBlock.uuid !== state.blockUuid) {
        hideToolbar(false, true);
      }
    } catch {
      // Ignore transient editor-state errors.
    }
  }, SELECTION_GUARD_INTERVAL_MS);
}

function hideToolbar(restoreEditingCursor = false, clearSelectionState = true) {
  toolbar.classList.add("hidden");
  stopSelectionGuard();

  if (clearSelectionState) {
    selectionState = null;
  }

  try {
    logseq.hideMainUI({
      restoreEditingCursor,
    });
  } catch {
    logseq.hideMainUI();
  }
}

function positionToolbar(point: { x: number; y: number }) {
  syncThemeVariables();

  const left = Math.max(8, point.x - TOOLBAR_WIDTH / 2);
  const top = Math.max(8, point.y - TOOLBAR_HEIGHT - TOOLBAR_OFFSET_Y);

  logseq.setMainUIInlineStyle({
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    width: `${TOOLBAR_WIDTH}px`,
    height: `${TOOLBAR_HEIGHT}px`,
    zIndex: 999999,
    background: "transparent",
    border: "none",
    boxShadow: "none",
    overflow: "visible",
  });

  toolbar.classList.remove("hidden");

  logseq.showMainUI({
    autoFocus: false,
  });

  startSelectionGuard();
}

async function getBestAvailableContent(state: SelectionState): Promise<string> {
  try {
    const editingContent = await logseq.Editor.getEditingBlockContent();

    if (typeof editingContent === "string" && editingContent.length > 0) {
      return editingContent;
    }
  } catch {
    // The block may no longer be actively edited.
  }

  try {
    const block = await logseq.Editor.getBlock(state.blockUuid);

    if (block?.content) {
      return block.content;
    }
  } catch {
    // Fallback below.
  }

  return state.content;
}

/**
 * Removes every active format except `keepAction` from the given selection
 * range and returns the updated content together with the adjusted start/end
 * positions of the bare text.  This guarantees that only one format is applied
 * at a time: clicking "italic" while "bold" is active first strips the bold
 * markers before the italic markers are added.
 */
function stripActiveFormats(
  keepAction: StyleAction,
  content: string,
  start: number,
  end: number,
): RangeRemovalResult {
  let c = content;
  let s = start;
  let e = end;

  const actionsToCheck: StyleAction[] = ["bold", "italic", "highlight", "page"];

  for (const action of actionsToCheck) {
    if (action === keepAction) continue;

    const selected = c.slice(s, e);

    if (action === "bold") {
      // Inside selection: **text** is selected
      if (selected.startsWith("**") && selected.endsWith("**") && selected.length >= 4) {
        const inner = selected.slice(2, -2);
        c = c.slice(0, s) + inner + c.slice(e);
        e = s + inner.length;
        continue;
      }
      // Around selection: ** sits outside the selected range
      if (countRunBefore(c, s, "*") >= 2 && countRunAfter(c, e, "*") >= 2) {
        c = c.slice(0, s - 2) + selected + c.slice(e + 2);
        s -= 2;
        e -= 2;
        continue;
      }
    }

    if (action === "italic") {
      const starsBefore = countRunAfter(selected, 0, "*");
      const starsAfter = countRunBefore(selected, selected.length, "*");
      // Inside selection: *text* is selected (odd number of stars on each side)
      if (starsBefore >= 1 && starsAfter >= 1 && starsBefore % 2 === 1 && starsAfter % 2 === 1) {
        const inner = selected.slice(1, -1);
        c = c.slice(0, s) + inner + c.slice(e);
        e = s + inner.length;
        continue;
      }
      // Around selection: single * sits outside the selected range
      const runBefore = countRunBefore(c, s, "*");
      const runAfter = countRunAfter(c, e, "*");
      if (runBefore >= 1 && runAfter >= 1 && runBefore % 2 === 1 && runAfter % 2 === 1) {
        c = c.slice(0, s - 1) + selected + c.slice(e + 1);
        s -= 1;
        e -= 1;
        continue;
      }
    }

    if (action === "highlight") {
      if (selected.startsWith("==") && selected.endsWith("==") && selected.length >= 4) {
        const inner = selected.slice(2, -2);
        c = c.slice(0, s) + inner + c.slice(e);
        e = s + inner.length;
        continue;
      }
      if (hasAround(c, s, e, "==", "==")) {
        c = c.slice(0, s - 2) + selected + c.slice(e + 2);
        s -= 2;
        e -= 2;
        continue;
      }
    }

    if (action === "page") {
      if (selected.startsWith("[[") && selected.endsWith("]]") && selected.length >= 4) {
        const inner = selected.slice(2, -2);
        c = c.slice(0, s) + inner + c.slice(e);
        e = s + inner.length;
        continue;
      }
      if (hasAround(c, s, e, "[[", "]]")) {
        c = c.slice(0, s - 2) + selected + c.slice(e + 2);
        s -= 2;
        e -= 2;
        continue;
      }
    }
  }

  return { content: c, start: s, end: e };
}

async function applyStyle(action: StyleAction) {
  if (isApplyingFormat) {
    return;
  }

  const state = selectionState;

  if (!state) {
    hideToolbar(false, true);
    return;
  }

  isApplyingFormat = true;
  isPointerInsideToolbar = true;
  ignoreSelectionUntil = Date.now() + SELECTION_IGNORE_MS;

  stopSelectionGuard();
  toolbar.classList.add("hidden");

  try {
    const baseContent = await getBestAvailableContent(state);
    const range = findSelectionRange(state, baseContent);

    if (!range) {
      showMessage("Could not find the selected text anymore.", "warning");
      return;
    }

    // Strip any conflicting active formats so that only one format is ever
    // applied at a time.  E.g. clicking italic while bold is active removes
    // the bold markers first, then adds the italic markers – preventing
    // malformed sequences like ***.
    const stripped = stripActiveFormats(action, baseContent, range.start, range.end);
    const result = toggleFormat(action, stripped.content, stripped.start, stripped.end);

    // Important:
    // Close the active editor first. Otherwise Logseq may keep the old textarea
    // content and overwrite updateBlock immediately afterwards.
    try {
      await logseq.Editor.exitEditingMode(false);
      await delay(80);
    } catch {
      // If exitEditingMode fails, still try updateBlock.
    }

    logseq.hideMainUI({
      restoreEditingCursor: false,
    });

    await logseq.Editor.updateBlock(state.blockUuid, result.content);
    await delay(80);

    await logseq.Editor.editBlock(state.blockUuid, {
      pos: result.cursorPos,
    });
  } catch (error) {
    console.error(error);
    showMessage("Could not apply formatting.", "error");
  } finally {
    selectionState = null;
    isPointerInsideToolbar = false;

    window.setTimeout(() => {
      isApplyingFormat = false;
    }, APPLY_UNLOCK_MS);
  }
}

async function captureSelection(payload: SelectionPayload) {
  if (isApplyingFormat || Date.now() < ignoreSelectionUntil) {
    return;
  }

  const selectedText = payload.text ?? "";

  if (!selectedText.trim()) {
    hideToolbar(false, true);
    return;
  }

  const currentBlock = await logseq.Editor.getCurrentBlock();

  if (!currentBlock?.uuid) {
    hideToolbar(false, true);
    return;
  }

  let content = "";

  try {
    content = await logseq.Editor.getEditingBlockContent();
  } catch {
    const block = await logseq.Editor.getBlock(currentBlock.uuid);
    content = block?.content ?? "";
  }

  selectionState = {
    blockUuid: currentBlock.uuid,
    text: selectedText,
    start: payload.start,
    end: payload.end,
    content,
  };

  updateActiveButtons(content, payload.start, payload.end);
  positionToolbar(payload.point);
}

function registerToolbarEvents() {
  toolbar.onpointerenter = () => {
    isPointerInsideToolbar = true;
  };

  toolbar.onpointerleave = () => {
    window.setTimeout(() => {
      if (!isApplyingFormat) {
        isPointerInsideToolbar = false;
      }
    }, 150);
  };

  toolbar.querySelectorAll<HTMLButtonElement>("button[data-style]").forEach(
    (button) => {
      button.onpointerdown = async (event) => {
        event.preventDefault();
        event.stopPropagation();

        isPointerInsideToolbar = true;

        const action = button.dataset.style as StyleAction;

        await applyStyle(action);
      };
    },
  );

  document.onkeydown = (event) => {
    if (event.key === "Escape") {
      hideToolbar(true, true);
    }
  };

  window.onblur = () => {
    if (!isApplyingFormat && !isPointerInsideToolbar) {
      hideToolbar(false, true);
    }
  };
}

async function main() {
  registerToolbarEvents();
  syncThemeVariables();

  logseq.setMainUIInlineStyle({
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "0px",
    height: "0px",
    zIndex: 999999,
    background: "transparent",
    border: "none",
    boxShadow: "none",
    overflow: "hidden",
  });

  logseq.hideMainUI({
    restoreEditingCursor: false,
  });

  logseq.Editor.onInputSelectionEnd(async (payload: SelectionPayload) => {
    await captureSelection(payload);
  });
}

logseq.ready(main).catch(console.error);
