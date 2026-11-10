// Mirrors the app's navigation depth into the browser history so the system back
// gesture (Android WebView) and hardware Back walk the app instead of exiting it.
// One extra history entry exists per "layer" (detail route, open overlay); when no
// layer is left, Back falls through to the platform default (exit).

/** Everything the sync needs to read from / close in the app. */
export interface HistoryTarget {
  /** Number of layers currently open above the base screen. */
  layers(): number;
  /** Closes the topmost layer (menu, sheet, now playing, queue, then route). */
  closeTop(): void;
}

export class HistorySync {
  private pushed = 0;
  /** A history.go(-n) is in flight; its popstate must not close anything. */
  private traversing = false;
  private want = 0;

  constructor(
    private readonly target: HistoryTarget,
    private readonly win: Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'> = window,
  ) {}

  /** Starts listening; returns the stop function. */
  attach(): () => void {
    const on = () => this.onPop();
    this.win.addEventListener('popstate', on);
    return () => this.win.removeEventListener('popstate', on);
  }

  /** Call whenever the layer count may have changed. */
  update(layers: number = this.target.layers()): void {
    this.want = layers;
    if (this.traversing) return;
    this.reconcile();
  }

  private reconcile(): void {
    const { history } = this.win;
    while (this.pushed < this.want) {
      history.pushState({ rayla: ++this.pushed }, '');
    }
    if (this.pushed > this.want) {
      const n = this.pushed - this.want;
      this.pushed = this.want;
      this.traversing = true;
      history.go(-n);
    }
  }

  private onPop(): void {
    if (this.traversing) {
      this.traversing = false;
      this.reconcile();
      return;
    }
    if (this.pushed === 0) return;
    // The browser already moved back one entry.
    this.pushed -= 1;
    this.target.closeTop();
    this.want = this.target.layers();
    this.reconcile();
  }
}
