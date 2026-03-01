// Split Pane - Binary tree layout for terminal split views
// Each tab can contain a tree of split panes, with leaves being terminal sessions.

import { TerminalRegistry } from './terminal';

// ============================================================================
// Types
// ============================================================================

export type SplitDirection = 'horizontal' | 'vertical';

export interface LeafNode {
  type: 'leaf';
  id: string;        // pane unique ID, e.g. 'pane-abc123'
  sessionId: string;  // backend session ID
}

export interface BranchNode {
  type: 'branch';
  id: string;
  direction: SplitDirection;  // horizontal=left/right, vertical=top/bottom
  ratio: number;              // 0~1, first child proportion
  children: [SplitNode, SplitNode];
}

export type SplitNode = LeafNode | BranchNode;

// ============================================================================
// Pure utility functions
// ============================================================================

let paneCounter = 0;

export function generatePaneId(): string {
  paneCounter += 1;
  return `pane-${Date.now().toString(36)}-${paneCounter}`;
}

export function countLeaves(node: SplitNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

export function findLeafById(node: SplitNode, paneId: string): LeafNode | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  return findLeafById(node.children[0], paneId) || findLeafById(node.children[1], paneId);
}

export function findLeafBySessionId(node: SplitNode, sessionId: string): LeafNode | null {
  if (node.type === 'leaf') return node.sessionId === sessionId ? node : null;
  return findLeafBySessionId(node.children[0], sessionId) || findLeafBySessionId(node.children[1], sessionId);
}

export function getAllLeaves(node: SplitNode): LeafNode[] {
  if (node.type === 'leaf') return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

export function getFirstLeaf(node: SplitNode): LeafNode {
  if (node.type === 'leaf') return node;
  return getFirstLeaf(node.children[0]);
}

/**
 * Split a leaf node into a branch with the original leaf and a new leaf.
 * Returns a new tree (immutable).
 */
export function splitLeaf(
  root: SplitNode,
  targetPaneId: string,
  direction: SplitDirection,
  newSessionId: string,
): SplitNode {
  function recurse(node: SplitNode): SplitNode {
    if (node.type === 'leaf') {
      if (node.id !== targetPaneId) return node;
      const newBranch: BranchNode = {
        type: 'branch',
        id: generatePaneId(),
        direction,
        ratio: 0.5,
        children: [
          { ...node },
          { type: 'leaf', id: generatePaneId(), sessionId: newSessionId },
        ],
      };
      return newBranch;
    }
    return {
      ...node,
      children: [recurse(node.children[0]), recurse(node.children[1])],
    };
  }
  return recurse(root);
}

/**
 * Remove a leaf node from the tree. Returns the new tree root, or null if tree is empty.
 * When a branch has only one child left, it collapses to that child.
 */
export function removeLeaf(root: SplitNode, targetPaneId: string): SplitNode | null {
  if (root.type === 'leaf') {
    return root.id === targetPaneId ? null : root;
  }

  function recurse(node: SplitNode): SplitNode | null {
    if (node.type === 'leaf') {
      return node.id === targetPaneId ? null : node;
    }
    const left = recurse(node.children[0]);
    const right = recurse(node.children[1]);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    return { ...node, children: [left, right] };
  }

  return recurse(root);
}

export function updateRatio(root: SplitNode, branchId: string, newRatio: number): SplitNode {
  if (root.type === 'leaf') return root;
  if (root.id === branchId) {
    return { ...root, ratio: newRatio };
  }
  return {
    ...root,
    children: [
      updateRatio(root.children[0], branchId, newRatio),
      updateRatio(root.children[1], branchId, newRatio),
    ],
  };
}

/**
 * Get the adjacent leaf in a given direction for keyboard navigation.
 */
export function getAdjacentLeaf(
  root: SplitNode,
  currentPaneId: string,
  direction: 'left' | 'right' | 'up' | 'down',
): LeafNode | null {
  const leaves = getAllLeaves(root);
  const currentIdx = leaves.findIndex((l) => l.id === currentPaneId);
  if (currentIdx < 0) return null;

  // Simple linear navigation: left/up = previous, right/down = next
  if (direction === 'left' || direction === 'up') {
    return currentIdx > 0 ? leaves[currentIdx - 1] : null;
  }
  return currentIdx < leaves.length - 1 ? leaves[currentIdx + 1] : null;
}

// ============================================================================
// SplitPaneManager - DOM rendering + resize handles + focus management
// ============================================================================

class SplitPaneManagerClass {
  private focusedPaneId: string | null = null;

  /**
   * Render a split tree into a container element.
   * Creates the DOM structure with flex containers and resize handles.
   */
  render(root: SplitNode, container: HTMLElement): void {
    // Clear existing split DOM
    const existingSplitRoot = container.querySelector('.split-root');
    if (existingSplitRoot) existingSplitRoot.remove();

    const splitRoot = document.createElement('div');
    splitRoot.className = 'split-root';
    this.renderNode(root, splitRoot);
    container.appendChild(splitRoot);
  }

  private renderNode(node: SplitNode, parent: HTMLElement): void {
    if (node.type === 'leaf') {
      const paneEl = document.createElement('div');
      paneEl.className = 'split-pane';
      paneEl.dataset.paneId = node.id;
      paneEl.dataset.sessionId = node.sessionId;

      if (node.id === this.focusedPaneId) {
        paneEl.classList.add('focused');
      }

      // Focus on mousedown
      paneEl.addEventListener('mousedown', () => {
        this.focusPane(node.id);
      });

      parent.appendChild(paneEl);
      return;
    }

    // Branch node
    const containerEl = document.createElement('div');
    containerEl.className = `split-container ${node.direction === 'horizontal' ? 'split-horizontal' : 'split-vertical'}`;
    containerEl.dataset.branchId = node.id;

    // First child
    const firstChild = document.createElement('div');
    firstChild.className = 'split-child';
    firstChild.style.flexBasis = `${node.ratio * 100}%`;
    firstChild.style.flexGrow = '0';
    firstChild.style.flexShrink = '1';
    firstChild.style.minHeight = '0';
    firstChild.style.minWidth = '0';
    firstChild.style.overflow = 'hidden';
    this.renderNode(node.children[0], firstChild);

    // Resize handle
    const handle = document.createElement('div');
    handle.className = `split-resize-handle ${node.direction === 'horizontal' ? 'split-resize-horizontal' : 'split-resize-vertical'}`;
    this.attachResizeHandler(handle, node, containerEl, firstChild);

    // Second child
    const secondChild = document.createElement('div');
    secondChild.className = 'split-child';
    secondChild.style.flexBasis = `${(1 - node.ratio) * 100}%`;
    secondChild.style.flexGrow = '0';
    secondChild.style.flexShrink = '1';
    secondChild.style.minHeight = '0';
    secondChild.style.minWidth = '0';
    secondChild.style.overflow = 'hidden';
    this.renderNode(node.children[1], secondChild);

    containerEl.appendChild(firstChild);
    containerEl.appendChild(handle);
    containerEl.appendChild(secondChild);
    parent.appendChild(containerEl);
  }

  private attachResizeHandler(
    handle: HTMLElement,
    node: BranchNode,
    _containerEl: HTMLElement,
    firstChild: HTMLElement,
  ): void {
    let startPos = 0;
    let startRatio = node.ratio;
    let containerSize = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = node.direction === 'horizontal'
        ? e.clientX - startPos
        : e.clientY - startPos;

      if (containerSize <= 0) return;

      const newRatio = Math.min(0.85, Math.max(0.15, startRatio + delta / containerSize));

      // Update DOM directly for instant visual feedback
      firstChild.style.flexBasis = `${newRatio * 100}%`;
      const secondChild = handle.nextElementSibling as HTMLElement;
      if (secondChild) {
        secondChild.style.flexBasis = `${(1 - newRatio) * 100}%`;
      }

      // Store the new ratio on the handle for later retrieval
      handle.dataset.currentRatio = String(newRatio);
      // NOTE: Terminal resize is suppressed during drag (body.split-resizing)
      // to prevent scroll position instability from rapid reflow. Only resize on mouseup.
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.classList.remove('split-resizing');

      // Trigger resize for all terminals now that drag is complete
      TerminalRegistry.resizeAll();

      // Dispatch event with final ratio
      const finalRatio = Number.parseFloat(handle.dataset.currentRatio || String(startRatio));
      document.dispatchEvent(new CustomEvent('split-ratio-changed', {
        detail: { branchId: node.id, ratio: finalRatio },
      }));
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startPos = node.direction === 'horizontal' ? e.clientX : e.clientY;
      startRatio = Number.parseFloat(handle.dataset.currentRatio || String(node.ratio));

      const parentEl = handle.parentElement;
      if (parentEl) {
        const rect = parentEl.getBoundingClientRect();
        containerSize = node.direction === 'horizontal' ? rect.width : rect.height;
      }

      document.body.classList.add('split-resizing');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Store initial ratio
    handle.dataset.currentRatio = String(node.ratio);
  }

  /**
   * Remove all split DOM from a container.
   */
  destroy(container: HTMLElement): void {
    const splitRoot = container.querySelector('.split-root');
    if (splitRoot) splitRoot.remove();
  }

  /**
   * Set focus on a specific pane.
   */
  focusPane(paneId: string): void {
    if (this.focusedPaneId === paneId) return;

    // Remove old focus
    const oldFocused = document.querySelector('.split-pane.focused');
    if (oldFocused) oldFocused.classList.remove('focused');

    // Add new focus
    this.focusedPaneId = paneId;
    const newFocused = document.querySelector(`.split-pane[data-pane-id="${paneId}"]`);
    if (newFocused) newFocused.classList.add('focused');

    // Get session ID from pane
    const sessionId = (newFocused as HTMLElement)?.dataset.sessionId;

    // Dispatch focus change event
    document.dispatchEvent(new CustomEvent('split-pane-focus-changed', {
      detail: { paneId, sessionId },
    }));
  }

  getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  setFocusedPaneId(paneId: string): void {
    this.focusedPaneId = paneId;
  }
}

export const SplitPaneManager = new SplitPaneManagerClass();
