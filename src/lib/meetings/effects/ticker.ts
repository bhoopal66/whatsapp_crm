// The frame clock. requestAnimationFrame stops in a hidden tab and page
// timers are throttled, and people switch tabs all through a meeting:
// colleagues would see a frozen face. A worker's timer is not throttled.

export interface Ticker {
  setFps(fps: number): void;
  stop(): void;
}

const SOURCE = `let t;onmessage=(e)=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}`;

export function createTicker(onTick: () => void, fps: number): Ticker {
  let periodMs = 1000 / fps;
  let worker: Worker | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let url: string | null = null;

  const fallBack = () => {
    worker?.terminate();
    worker = null;
    clearInterval(interval);
    interval = setInterval(onTick, periodMs);
  };

  try {
    url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = onTick;
    worker.onerror = fallBack; // a CSP refusal arrives here, not as a throw
    worker.postMessage(periodMs);
  } catch {
    fallBack();
  }

  return {
    setFps(next) {
      periodMs = 1000 / next;
      if (worker) worker.postMessage(periodMs);
      else fallBack();
    },
    stop() {
      worker?.terminate();
      worker = null;
      clearInterval(interval);
      if (url) URL.revokeObjectURL(url);
    },
  };
}
