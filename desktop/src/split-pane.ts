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

/**
 * Swap the sessions of two leaves (by pane id), keeping the tree shape and
 * pane numbers fixed — only which session sits in each position changes.
 * Used for drag-to-rearrange.
 */
export function swapLeafSessions(root: SplitNode, paneA: string, paneB: string): SplitNode {
  const la = findLeafById(root, paneA);
  const lb = findLeafById(root, paneB);
  if (!la || !lb) return root;
  const sa = la.sessionId;
  const sb = lb.sessionId;
  function recurse(node: SplitNode): SplitNode {
    if (node.type === 'leaf') {
      if (node.id === paneA) return { ...node, sessionId: sb };
      if (node.id === paneB) return { ...node, sessionId: sa };
      return node;
    }
    return { ...node, children: [recurse(node.children[0]), recurse(node.children[1])] };
  }
  return recurse(root);
}

/**
 * Move a pane next to a target pane (drag-to-rearrange / insert-reorder).
 * Removes the source leaf, then replaces the target leaf with a new branch
 * splitting in `direction`, with the moved pane placed `before` or after the
 * target. The moved pane keeps its id (and therefore its pane number).
 */
export function movePaneAdjacent(
  root: SplitNode,
  sourcePaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
  before: boolean,
): SplitNode {
  if (sourcePaneId === targetPaneId) return root;
  const sourceLeaf = findLeafById(root, sourcePaneId);
  if (!sourceLeaf) return root;
  const moved: LeafNode = { type: 'leaf', id: sourceLeaf.id, sessionId: sourceLeaf.sessionId };

  const removed = removeLeaf(root, sourcePaneId);
  if (!removed) return root; // source was the only pane

  function recurse(node: SplitNode): SplitNode {
    if (node.type === 'leaf') {
      if (node.id !== targetPaneId) return node;
      const children: [SplitNode, SplitNode] = before ? [moved, node] : [node, moved];
      return { type: 'branch', id: generatePaneId(), direction, ratio: 0.5, children };
    }
    return { ...node, children: [recurse(node.children[0]), recurse(node.children[1])] };
  }
  const result = recurse(removed);
  // If the target vanished (shouldn't happen), keep the original tree.
  return findLeafById(result, sourcePaneId) ? result : root;
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

      // Drag handle (top-right) — drag onto another pane to rearrange. Hovering
      // it slides a flyout out to the LEFT showing this pane's session title
      // (panes have no title bar of their own). Only inside a split; CSS hides
      // the handle for a lone pane.
      const dragHandle = document.createElement('div');
      dragHandle.className = 'pane-drag-handle';
      dragHandle.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3" r="1.3"/><circle cx="11" cy="3" r="1.3"/><circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="5" cy="13" r="1.3"/><circle cx="11" cy="13" r="1.3"/></svg>';

      const titleFlyout = document.createElement('div');
      titleFlyout.className = 'pane-title-flyout';
      paneEl.appendChild(titleFlyout);

      dragHandle.addEventListener('mouseenter', () => {
        const mt = TerminalRegistry.get(node.sessionId);
        titleFlyout.textContent = mt?.shellTitle || mt?.title || 'Terminal';
        titleFlyout.classList.add('show');
      });
      dragHandle.addEventListener('mouseleave', () => {
        // Keep the title visible while this pane is being dragged.
        if (!document.body.classList.contains('pane-dragging')) titleFlyout.classList.remove('show');
      });
      dragHandle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mt = TerminalRegistry.get(node.sessionId);
        titleFlyout.textContent = mt?.shellTitle || mt?.title || 'Terminal';
        titleFlyout.classList.add('show'); // keep it shown for the whole drag
        this.startPaneDrag(node.id);
      });
      paneEl.appendChild(dragHandle);

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
      handle.classList.remove('split-resize-active');

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
      handle.classList.add('split-resize-active');
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

  /**
   * Begin dragging a pane by its grip handle. Highlights the pane under the
   * cursor; on release over a different pane, dispatches a 'pane-swap-request'
   * for the view layer to swap the two panes' sessions.
   */
  private startPaneDrag(sourcePaneId: string): void {
    document.body.classList.add('pane-dragging');
    let targetPaneId: string | null = null;
    let dropZone: 'center' | 'left' | 'right' | 'top' | 'bottom' | null = null;
    const clearTargets = (): void => {
      document.querySelectorAll('.split-pane.pane-drop-target').forEach((p) => {
        p.classList.remove('pane-drop-target');
        (p as HTMLElement).removeAttribute('data-drop-edge');
      });
    };
    const onMove = (ev: PointerEvent): void => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const paneEl = el?.closest('.split-pane') as HTMLElement | null;
      clearTargets();
      if (paneEl && paneEl.dataset.paneId && paneEl.dataset.paneId !== sourcePaneId) {
        // Center zone → replace (swap); near an edge → insert on that side.
        const r = paneEl.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width;
        const py = (ev.clientY - r.top) / r.height;
        const minDist = Math.min(px, 1 - px, py, 1 - py);
        if (minDist > 0.3) {
          dropZone = 'center';
        } else {
          const dist = { left: px, right: 1 - px, top: py, bottom: 1 - py };
          dropZone = (Object.keys(dist) as Array<'left' | 'right' | 'top' | 'bottom'>)
            .reduce((a, b) => (dist[a] <= dist[b] ? a : b));
        }
        paneEl.classList.add('pane-drop-target');
        paneEl.setAttribute('data-drop-edge', dropZone);
        targetPaneId = paneEl.dataset.paneId;
      } else {
        targetPaneId = null;
        dropZone = null;
      }
    };
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('pane-dragging');
      document.querySelectorAll('.pane-title-flyout.show').forEach((f) => f.classList.remove('show'));
      clearTargets();
      if (targetPaneId && dropZone && targetPaneId !== sourcePaneId) {
        document.dispatchEvent(new CustomEvent('pane-move-request', {
          detail: { sourcePaneId, targetPaneId, edge: dropZone },
        }));
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  setFocusedPaneId(paneId: string): void {
    this.focusedPaneId = paneId;
  }
}

export const SplitPaneManager = new SplitPaneManagerClass();
